import { performance } from "node:perf_hooks";
import { createSpendGuard, EvalConfigError, estimateCallCostUsd, usageCost } from "./costGuard.js";
import { toInterviewContext } from "./fixtures.js";
import { aggregateVariant, failedChecks, scoreAnswer } from "./metrics.js";
import { createHangingReplyGenerator, FAKE_MODEL_ID } from "./providers.js";
import { createVariant } from "./variants.js";

export const HARNESS_VERSION = 1;

/**
 * Proposed, adjustable thresholds for comparing the graph against the chain.
 * They are product decisions recorded here so every report applies the same
 * rule; see docs/plan/evaluation.md.
 */
export const GATE_THRESHOLDS = Object.freeze({
  latencyRatio: 1.25,
  latencySlackMs: 100,
  costRatio: 1.25,
  cancellationTimeoutMs: 1_000,
});

const SPEAKER_ROLES = Object.freeze({ interviewer: "caller", candidate: "you" });

/** The history string ChatHistory.toPrompt would produce, ending with the question. */
export function buildHistory(question) {
  return question.history
    .map((turn) => [SPEAKER_ROLES[turn.speaker], ": ", turn.text].join(""))
    .concat(["caller: ", question.text].join(""))
    .join("\n");
}

function evidenceKey(item) {
  return [item.requirement, item.evidence].join("\u0000");
}

function evidenceIdsFor(caseDef, items) {
  const ids = new Map(caseDef.evidence.map((item) => [evidenceKey(item), item.id]));
  return (items || []).map((item) => ids.get(evidenceKey(item)) || "unknown");
}

/** Every (variant, case, question) call with its planned prompt size. */
export function planJobs(cases, variants) {
  const jobs = [];
  for (const variant of variants) {
    for (const caseDef of cases) {
      const contextJson = JSON.stringify(toInterviewContext(caseDef));
      const foreignEvidence = cases.filter((other) => other !== caseDef).flatMap((other) => other.evidence);
      for (const question of caseDef.questions) {
        const history = buildHistory(question);
        const plannedPrompt = variant.planPrompt(contextJson, history);
        jobs.push({
          variant,
          caseDef,
          question,
          contextJson,
          history,
          foreignEvidence,
          inputChars: plannedPrompt.length + history.length,
        });
      }
    }
  }
  return jobs;
}

/** Worst-case cost of the planned jobs (ceil(chars / 4) input + output cap). */
export function estimateRunCostUsd(jobs, { maxOutputTokens, prices }) {
  return jobs.reduce(
    (total, job) => total + estimateCallCostUsd({ inputChars: job.inputChars, maxOutputTokens, prices }),
    0
  );
}

async function runJob(job, { generateReply, providerConfig, now }) {
  let usage;
  let basis;
  let route = null;
  const started = now();
  const result = await job.variant.run({
    contextJson: job.contextJson,
    history: job.history,
    generateReply,
    signal: new AbortController().signal,
    model: providerConfig.live ? providerConfig.model : undefined,
    onUsage: (reported, estimateBasis) => {
      usage = reported;
      basis = estimateBasis;
    },
    onModel: (info) => {
      route = info?.actual || info?.selected || null;
    },
  });
  const latencyMs = now() - started;
  const fallbackBasis = { inputChars: job.inputChars, outputChars: result.suggestion.length };
  const cost = usageCost({ usage, basis: basis || fallbackBasis, prices: providerConfig.prices });
  const promptEvidenceIds = evidenceIdsFor(job.caseDef, result.promptEvidence);
  const score = scoreAnswer({
    answer: result.suggestion,
    caseDef: job.caseDef,
    question: job.question,
    promptEvidenceIds,
    promptText: [result.prompt, job.history].join("\n"),
    foreignEvidence: job.foreignEvidence,
  });
  return {
    status: "ok",
    answer: result.suggestion,
    route,
    latencyMs,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    costUsd: cost.costUsd,
    usageEstimated: cost.estimated,
    score,
    failedChecks: failedChecks(score),
  };
}

function baseRecord(job) {
  return {
    variant: job.variant.name,
    caseId: job.caseDef.id,
    questionId: job.question.id,
    questionType: job.question.type,
    language: job.caseDef.expectations.language,
    answerLength: job.caseDef.expectations.answerLength,
    expectedEvidenceIds: job.question.expectedEvidenceIds,
  };
}

/**
 * Cancellation is pipeline behavior, so it is always checked with a
 * generator that only settles on abort: the variant must reject promptly and
 * produce no suggestion. No provider is called.
 */
export async function checkCancellation(variant, job, timeoutMs = GATE_THRESHOLDS.cancellationTimeoutMs) {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const generateReply = createHangingReplyGenerator(() => markStarted());
  const run = variant.run({
    contextJson: job.contextJson,
    history: job.history,
    generateReply,
    signal: controller.signal,
  });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const reached = await Promise.race([started.then(() => "started"), timeout]);
    if (reached !== "started") return { passed: false, reason: "generator_not_called" };
    controller.abort(new Error("superseded by a newer question"));
    const outcome = await Promise.race([
      run.then(() => "resolved", () => "rejected"),
      timeout,
    ]);
    return { passed: outcome === "rejected", reason: outcome };
  } finally {
    clearTimeout(timer);
    run.catch(() => {});
    if (!controller.signal.aborted) controller.abort(new Error("cancellation check finished"));
  }
}

function gate(name, passed, detail) {
  return { name, status: passed ? "pass" : "fail", detail };
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

/**
 * Map the aggregates onto the Phase 4 exit gate. Needs both variants; a run
 * with errors or skipped calls is reported as incomplete.
 */
export function evaluateGates(aggregates, cancellation) {
  const graph = aggregates.graph;
  const chain = aggregates.chain;
  if (!graph || !chain) return { status: "incomplete", reason: "both graph and chain variants are required", gates: [] };
  const latencyLimit = chain.latencyP95Ms * GATE_THRESHOLDS.latencyRatio + GATE_THRESHOLDS.latencySlackMs;
  const costLimit = chain.costUsd * GATE_THRESHOLDS.costRatio;
  const relevanceGain = graph.relevanceRate > chain.relevanceRate;
  const cheaperAtParity = graph.relevanceRate === chain.relevanceRate && graph.costUsd < chain.costUsd;
  const gates = [
    gate("grounding", graph.groundingRate === 1, `graph ${percent(graph.groundingRate)} grounded (target 100%)`),
    gate(
      "question relevance",
      graph.relevanceRate >= chain.relevanceRate,
      `graph ${percent(graph.relevanceRate)} vs chain ${percent(chain.relevanceRate)}`
    ),
    gate("cancellation", cancellation.graph?.passed === true, `graph abort ${cancellation.graph?.reason ?? "not run"}`),
    gate("context isolation", graph.isolationRate === 1, `graph ${percent(graph.isolationRate)} isolated (target 100%)`),
    gate(
      "latency",
      graph.latencyP95Ms <= latencyLimit,
      `graph p95 ${graph.latencyP95Ms?.toFixed(1)} ms vs limit ${latencyLimit.toFixed(1)} ms`
    ),
    gate("cost", graph.costUsd <= costLimit, `graph $${graph.costUsd.toFixed(6)} vs limit $${costLimit.toFixed(6)}`),
    gate(
      "usefulness proxy",
      relevanceGain || cheaperAtParity,
      "graph must beat the chain on relevance, or match it at lower cost; human review is still required"
    ),
  ];
  const incomplete = graph.completed < graph.questions || chain.completed < chain.questions;
  let status = gates.every((entry) => entry.status === "pass") ? "pass" : "fail";
  if (incomplete) status = "incomplete";
  return { status, gates };
}

/**
 * Run every selected variant over every fixture question, sequentially.
 * Live runs check the up-front worst-case estimate against the cap before
 * the first call and stop before any call whose worst case would exceed it.
 */
export async function runEvaluation({
  cases,
  fixtureFiles = [],
  variantNames,
  providerConfig,
  generateReply,
  now = () => performance.now(),
  clock = () => new Date(),
  write = () => {},
}) {
  const variants = variantNames.map(createVariant);
  const jobs = planJobs(cases, variants);
  const estimateUsd = estimateRunCostUsd(jobs, providerConfig);
  if (providerConfig.live) {
    write(
      `Live run: ${jobs.length} calls to ${providerConfig.model}; worst-case estimate ` +
      `$${estimateUsd.toFixed(6)} (cap $${providerConfig.maxUsd}).\n`
    );
    if (estimateUsd > providerConfig.maxUsd) {
      throw new EvalConfigError(
        `Estimated worst-case cost $${estimateUsd.toFixed(6)} exceeds --max-usd ${providerConfig.maxUsd}; no request was sent`
      );
    }
  }
  const guard = createSpendGuard(providerConfig.live ? providerConfig.maxUsd : Infinity);
  const records = [];
  let stopped = null;
  for (const job of jobs) {
    const base = baseRecord(job);
    const worstCase = estimateCallCostUsd({
      inputChars: job.inputChars,
      maxOutputTokens: providerConfig.maxOutputTokens,
      prices: providerConfig.prices,
    });
    if (stopped || !guard.canAfford(worstCase)) {
      stopped = stopped || "max_usd_cap";
      records.push({ ...base, status: "skipped", reason: stopped });
      continue;
    }
    try {
      const record = await runJob(job, { generateReply, providerConfig, now });
      guard.record(record.costUsd);
      records.push({ ...base, ...record });
    } catch (error) {
      // Only the error code: provider messages are never copied into reports.
      records.push({ ...base, status: "error", errorCode: error?.code || "error" });
    }
  }

  const aggregates = {};
  const cancellation = {};
  for (const variant of variants) {
    aggregates[variant.name] = aggregateVariant(records.filter((record) => record.variant === variant.name));
    const firstJob = jobs.find((job) => job.variant === variant);
    cancellation[variant.name] = await checkCancellation(variant, firstJob);
  }

  return {
    harnessVersion: HARNESS_VERSION,
    generatedAt: clock().toISOString(),
    provider: providerConfig.provider,
    model: providerConfig.live ? providerConfig.model : FAKE_MODEL_ID,
    live: providerConfig.live,
    prices: providerConfig.prices,
    maxOutputTokens: providerConfig.maxOutputTokens,
    maxUsd: providerConfig.live ? providerConfig.maxUsd : null,
    estimatedWorstCaseUsd: estimateUsd,
    spentUsd: providerConfig.live ? guard.spentUsd : 0,
    stoppedReason: stopped,
    fixtures: fixtureFiles,
    variants: variantNames,
    aggregates,
    cancellation,
    gate: evaluateGates(aggregates, cancellation),
    failures: records
      .filter((record) => record.status !== "ok" || record.failedChecks.length > 0)
      .map((record) => ({
        variant: record.variant,
        caseId: record.caseId,
        questionId: record.questionId,
        questionType: record.questionType,
        status: record.status,
        failed: record.failedChecks || [record.errorCode || record.reason],
      })),
    results: records,
  };
}
