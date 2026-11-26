import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvalConfigError, resolveProviderConfig } from "../scripts/eval/lib/costGuard.js";
import { FixtureError, loadFixtures, QUESTION_TYPES, validateCase, validateSuite } from "../scripts/eval/lib/fixtures.js";
import { checkCancellation, planJobs, runEvaluation } from "../scripts/eval/lib/harness.js";
import { createFakeReplyGenerator, fakeAnswer, parsePromptEvidence } from "../scripts/eval/lib/providers.js";
import { buildChainPrompt, createChainVariant, createGraphVariant } from "../scripts/eval/lib/variants.js";
import { DEFAULT_FIXTURES_DIR, main } from "../scripts/eval/runEval.js";

const FAKE_KEY = "sk-or-test-not-a-real-key";
const LIVE_ENV = Object.freeze({ OPENROUTER_API_KEY: FAKE_KEY });
const { cases, files } = await loadFixtures(DEFAULT_FIXTURES_DIR);
const clone = (value) => structuredClone(value);

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-harness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function capture() {
  const chunks = [];
  return { chunks, write: (text) => chunks.push(text), text: () => chunks.join("") };
}

/** A ChatOpenRouter stand-in that records construction and calls; never touches the network. */
function recordingChatClass({ usage = { input_tokens: 400, output_tokens: 60 } } = {}) {
  const record = { constructed: 0, calls: 0, options: [] };
  class FakeChatOpenRouter {
    constructor(options) {
      record.constructed += 1;
      record.options.push(options);
    }

    async invoke() {
      record.calls += 1;
      return { content: "I would mention my Kafka pipeline.", usage_metadata: usage, response_metadata: { model_name: "test/model" } };
    }
  }
  return { FakeChatOpenRouter, record };
}

test("the shipped evaluation fixtures satisfy the schema and suite rules", () => {
  const questions = cases.flatMap((caseDef) => caseDef.questions);
  assert.ok(questions.length >= 20 && questions.length <= 30, `${questions.length} questions`);
  assert.deepEqual(new Set(cases.map((caseDef) => caseDef.expectations.language)), new Set(["en", "fr"]));
  assert.ok(new Set(cases.map((caseDef) => caseDef.context.candidate.name)).size >= 2);
  assert.deepEqual(new Set(questions.map((question) => question.type)), new Set(QUESTION_TYPES));
  assert.equal(files.length, cases.length);
  for (const entry of files) assert.match(entry.sha256, /^[0-9a-f]{64}$/);
});

test("fixture validation rejects inconsistent cases", () => {
  const base = cases[0];
  const mutate = (change) => {
    const copy = clone(base);
    change(copy);
    return copy;
  };
  const rejects = (raw, pattern) => assert.throws(() => validateCase(raw, "case.json"), (error) =>
    error instanceof FixtureError && pattern.test(error.message));

  rejects(mutate((copy) => { copy.questions[0].expectedEvidenceIds = ["NOPE-E1"]; }), /unknown evidence ID NOPE-E1/);
  rejects(mutate((copy) => { copy.expectations.forbiddenClaims.push(copy.context.candidate.name); }), /appears in the case's own context/);
  rejects(mutate((copy) => { copy.expectations.language = copy.expectations.language === "en" ? "fr" : "en"; }), /expectations.language/);
  rejects(mutate((copy) => { copy.evidence[0].keyTerms = ["not present anywhere"]; }), /does not appear in its evidence/);
  rejects(mutate((copy) => {
    const noEvidence = copy.questions.find((question) => question.type === "no-evidence");
    noEvidence.expectedEvidenceIds = [copy.evidence[0].id];
  }), /only no-evidence questions/);
  rejects(mutate((copy) => {
    const multipart = copy.questions.find((question) => question.type === "multipart");
    multipart.expectedEvidenceIds = multipart.expectedEvidenceIds.slice(0, 1);
  }), /multipart question needs/);
  rejects(mutate((copy) => { copy.context.evidence = []; }), /context.evidence/);
  rejects(mutate((copy) => { copy.unexpected = true; }), /unexpected|Unrecognized/i);
});

test("suite validation requires isolation-ready, bilingual, multi-candidate fixtures", () => {
  assert.throws(() => validateSuite([cases[0]]), /two distinct candidates/);
  const leaky = clone(cases[1]);
  leaky.context.candidate.profile += ` ${cases[0].evidence[0].keyTerms[0]}`;
  assert.throws(() => validateSuite([cases[0], leaky, ...cases.slice(2)]), /also appears in case/);
  const english = cases.filter((caseDef) => caseDef.expectations.language === "en");
  assert.throws(() => validateSuite(english), /at least one fr case/);
});

test("the chain prompt carries all approved evidence; the graph prompt at most three", () => {
  const caseDef = cases.find((entry) => entry.evidence.length > 3);
  const [graphJob] = planJobs([caseDef], [createGraphVariant()]);
  const chainPrompt = buildChainPrompt(graphJob.contextJson);
  const graphPrompt = createGraphVariant().planPrompt(graphJob.contextJson, graphJob.history);
  assert.equal(parsePromptEvidence(chainPrompt).length, caseDef.evidence.length);
  assert.ok(parsePromptEvidence(graphPrompt).length <= 3);
  assert.match(chainPrompt, /Interview settings:/);
});

test("the fake provider is deterministic and answers in the prompt's language", async () => {
  const caseDef = cases.find((entry) => entry.expectations.language === "fr");
  const [job] = planJobs([caseDef], [createChainVariant()]);
  const prompt = buildChainPrompt(job.contextJson);
  assert.equal(fakeAnswer(prompt, job.history), fakeAnswer(prompt, job.history));
  const usage = [];
  const reply = await createFakeReplyGenerator()(prompt, job.history, { onUsage: (value) => usage.push(value) });
  assert.match(reply, /éléments|exemple/i);
  assert.ok(usage[0].input_tokens > 0 && usage[0].output_tokens > 0);
});

test("cost guard refuses paid runs without explicit confirmation and a cap", () => {
  const refuses = (options, env, pattern) => assert.throws(() => resolveProviderConfig(options, env), (error) =>
    error instanceof EvalConfigError && pattern.test(error.message));
  refuses({ provider: "openrouter" }, LIVE_ENV, /pass --live and --max-usd/);
  refuses({ provider: "openrouter", live: true }, LIVE_ENV, /--live requires --max-usd/);
  refuses({ provider: "openrouter", live: true, maxUsd: "0" }, LIVE_ENV, /positive number/);
  refuses({ provider: "openrouter", live: true, maxUsd: "abc" }, LIVE_ENV, /positive number/);
  refuses({ provider: "openrouter", live: true, maxUsd: "1" }, {}, /OPENROUTER_API_KEY is required/);
  refuses({ provider: "openrouter", live: true, maxUsd: "1", model: "other/model" }, LIVE_ENV, /not in OPENROUTER_ALLOWED_MODELS/);
  refuses(
    { provider: "openrouter", live: true, maxUsd: "1" },
    { ...LIVE_ENV, OPENROUTER_INPUT_USD_PER_MILLION_TOKENS: "0" },
    /must be positive/
  );
  refuses({ provider: "fake", live: true }, {}, /--live only applies/);
  refuses({ provider: "groq" }, {}, /Unsupported provider/);

  const config = resolveProviderConfig(
    { provider: "openrouter", live: true, maxUsd: "0.5", model: "b/model" },
    { ...LIVE_ENV, OPENROUTER_MODEL: "a/model", OPENROUTER_ALLOWED_MODELS: "a/model,b/model" }
  );
  assert.equal(config.model, "b/model");
  assert.equal(config.maxUsd, 0.5);
  assert.equal(config.maxOutputTokens, 600);
  assert.deepEqual(config.prices, { inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2 });
});

test("the CLI refuses --live without --max-usd before building a client", async (t) => {
  const out = await tempDir(t);
  const { FakeChatOpenRouter, record } = recordingChatClass();
  const stderr = capture();
  const code = await main(["--provider", "openrouter", "--live", "--out", out], {
    env: LIVE_ENV, write: () => {}, writeError: stderr.write, ChatOpenRouterClass: FakeChatOpenRouter,
  });
  assert.equal(code, 2);
  assert.match(stderr.text(), /--live requires --max-usd/);
  assert.equal(record.constructed, 0);
  assert.deepEqual(await readdir(out), []);
});

test("the CLI stops before any request when the estimate exceeds the cap", async (t) => {
  const out = await tempDir(t);
  const { FakeChatOpenRouter, record } = recordingChatClass();
  const stdout = capture();
  const stderr = capture();
  const code = await main(["--provider", "openrouter", "--live", "--max-usd", "0.0001", "--out", out], {
    env: LIVE_ENV, write: stdout.write, writeError: stderr.write, ChatOpenRouterClass: FakeChatOpenRouter,
  });
  assert.equal(code, 2);
  assert.match(stdout.text(), /worst-case estimate \$\d+\.\d+ \(cap \$0\.0001\)/);
  assert.match(stderr.text(), /exceeds --max-usd 0\.0001; no request was sent/);
  assert.equal(record.calls, 0);
  assert.deepEqual(await readdir(out), []);
  assert.ok(!stdout.text().includes(FAKE_KEY) && !stderr.text().includes(FAKE_KEY));
});

test("a live run stops before the call whose worst case would exceed the cap", async () => {
  const providerConfig = resolveProviderConfig({ provider: "openrouter", live: true, maxUsd: "1" }, LIVE_ENV);
  let calls = 0;
  // The first reply reports far more usage than estimated, consuming the cap.
  const generateReply = async (prompt, history, { onUsage }) => {
    calls += 1;
    await onUsage({ input_tokens: 4_999_000, output_tokens: 10 });
    return "I would mention my Kafka pipeline.";
  };
  const report = await runEvaluation({ cases, variantNames: ["graph"], providerConfig, generateReply });
  assert.equal(calls, 1);
  assert.equal(report.stoppedReason, "max_usd_cap");
  assert.equal(report.aggregates.graph.completed, 1);
  assert.equal(report.aggregates.graph.skipped, report.aggregates.graph.questions - 1);
  assert.ok(report.spentUsd > 0.99 && report.spentUsd <= 1);
  assert.equal(report.gate.status, "incomplete");
});

test("a capped live run through the real adapter never writes the key", async (t) => {
  const out = await tempDir(t);
  const { FakeChatOpenRouter, record } = recordingChatClass();
  const stdout = capture();
  const code = await main(["--provider", "openrouter", "--live", "--max-usd", "1", "--variant", "chain", "--out", out], {
    env: LIVE_ENV, write: stdout.write, writeError: () => {}, ChatOpenRouterClass: FakeChatOpenRouter,
  });
  assert.equal(code, 0);
  assert.equal(record.calls, cases.flatMap((caseDef) => caseDef.questions).length);
  assert.equal(record.options[0].maxTokens, 600);
  const written = await Promise.all((await readdir(out)).map((name) => readFile(path.join(out, name), "utf8")));
  assert.equal(written.length, 2);
  for (const content of [...written, stdout.text()]) assert.ok(!content.includes(FAKE_KEY));
  const report = JSON.parse(written.find((content) => content.trimStart().startsWith("{")));
  assert.equal(report.live, true);
  assert.equal(report.results[0].route, "test/model");
  assert.ok(report.spentUsd > 0 && report.spentUsd <= 1);
});

test("a full fake-provider run writes a JSON and Markdown comparison report", async (t) => {
  const out = await tempDir(t);
  const stdout = capture();
  let tick = 0;
  const code = await main(["--out", out], {
    env: {},
    write: stdout.write,
    now: () => {
      tick += 5;
      return tick;
    },
    clock: () => new Date("2026-01-02T03:04:05.678Z"),
  });
  assert.equal(code, 0);
  assert.deepEqual((await readdir(out)).sort(), ["2026-01-02T03-04-05Z-fake.json", "2026-01-02T03-04-05Z-fake.md"]);
  const report = JSON.parse(await readFile(path.join(out, "2026-01-02T03-04-05Z-fake.json"), "utf8"));
  const markdown = await readFile(path.join(out, "2026-01-02T03-04-05Z-fake.md"), "utf8");
  const total = cases.flatMap((caseDef) => caseDef.questions).length;
  assert.equal(report.provider, "fake");
  assert.equal(report.spentUsd, 0);
  assert.deepEqual(report.variants, ["graph", "chain"]);
  for (const name of ["graph", "chain"]) {
    const aggregate = report.aggregates[name];
    assert.equal(aggregate.completed, total);
    assert.equal(aggregate.errors, 0);
    assert.equal(aggregate.groundingRate, 1);
    assert.equal(aggregate.isolationRate, 1);
    assert.equal(aggregate.languageMatchRate, 1);
    assert.equal(aggregate.lengthComplianceRate, 1);
    assert.equal(aggregate.latencyP50Ms, 5);
    assert.equal(report.cancellation[name].passed, true);
  }
  // The chain sends every approved reference, so its prompts are larger.
  assert.ok(report.aggregates.chain.inputTokens > report.aggregates.graph.inputTokens);
  assert.equal(report.aggregates.chain.meanPromptEvidenceRecall, 1);
  assert.deepEqual(report.gate.gates.map((entry) => entry.name), [
    "grounding", "question relevance", "cancellation", "context isolation", "latency", "cost", "usefulness proxy",
  ]);
  const failing = report.results.filter((record) => record.failedChecks.length);
  assert.equal(report.failures.length, failing.length);
  assert.match(markdown, /## Comparison\n\n\| Metric \| graph \| chain \|/);
  assert.match(markdown, /## Phase 4 exit gate/);
  assert.match(markdown, /## Failing cases/);
  assert.match(markdown, /nothing was spent/);
  assert.match(stdout.text(), /Phase 4 gate: /);
});

test("ungrounded answers are listed as failing cases", async () => {
  const providerConfig = resolveProviderConfig({}, {});
  const generateReply = async () => "At Google I improved everything by 99% with a 10x team.";
  const report = await runEvaluation({ cases, variantNames: ["graph", "chain"], providerConfig, generateReply });
  assert.equal(report.aggregates.graph.groundingRate, 0);
  assert.equal(report.gate.gates.find((entry) => entry.name === "grounding").status, "fail");
  assert.ok(report.failures.some((failure) => failure.failed.includes("grounded")));
  const sample = report.results.find((record) => record.caseId === "en-backend-maya");
  assert.ok(sample.score.forbiddenClaims.includes("Google"));
  assert.ok(sample.score.unsupportedNumbers.includes("99"));
});

test("provider errors are recorded by code only", async () => {
  const providerConfig = resolveProviderConfig({}, {});
  const generateReply = async () => {
    const error = new Error(`upstream said ${FAKE_KEY}`);
    error.code = "provider_request_failed";
    throw error;
  };
  const report = await runEvaluation({ cases: cases.slice(0, 2), variantNames: ["chain"], providerConfig, generateReply });
  assert.equal(report.aggregates.chain.errors, report.aggregates.chain.questions);
  assert.ok(!JSON.stringify(report).includes(FAKE_KEY));
  assert.deepEqual(report.failures[0].failed, ["provider_request_failed"]);
});

test("the cancellation check fails a variant that never reaches the provider", async () => {
  const [job] = planJobs(cases, [createGraphVariant()]);
  const passing = await checkCancellation(createGraphVariant(), job);
  assert.deepEqual(passing, { passed: true, reason: "rejected" });
  const ignoresProvider = { name: "broken", run: async () => ({ suggestion: "late", promptEvidence: [], prompt: "" }) };
  const failing = await checkCancellation(ignoresProvider, job, 20);
  assert.equal(failing.passed, false);
});
