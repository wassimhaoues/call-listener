#!/usr/bin/env node
/**
 * Synthetic prompt-growth benchmark (no network, no providers, no real CVs).
 *
 * Replays a long synthetic interview through the real prompt builder,
 * evidence selector and bounded chat history, and reports per request:
 * input size, how much of it repeats the previous request byte-for-byte from
 * the start (what implicit provider prefix caching can reuse), and the total
 * input over the interview for different history bounds.
 *
 * Two prompt layouts are compared for caching:
 * - "current": system prompt (instructions, candidate, job, selected
 *   evidence, settings, format) + user message (history).
 * - "evidence-last": the same text with the per-question evidence block moved
 *   after the history, so the stable part plus the append-only history form
 *   the shared prefix. This layout is NOT used in production; it is measured
 *   to decide whether a prompt change is worth an evaluation run.
 *
 * Usage: node scripts/bench/promptGrowth.js [--questions 60] [--json]
 */
import { pathToFileURL } from "node:url";

// The server modules log to files by default; this benchmark only needs their
// pure functions. Set before the (lazy) imports below, then silence them.
process.env.LOG_TO_FILE ??= "0";

async function loadServerModules() {
  const [logger, prompt, budget, evidence, chat, redis] = await Promise.all([
    import("../../server/core/logger/index.js"),
    import("../../server/services/ai/promptBuilder.js"),
    import("../../server/services/ai/interviewBudget.js"),
    import("../../server/services/interview/evidenceSelector.js"),
    import("../../server/services/chat/chatHistory.js"),
    import("../../test/helpers/memoryRedis.js"),
  ]);
  for (const instance of Object.values(logger.loggers)) instance.silent = true;
  return {
    buildPrompt: prompt.buildPrompt,
    estimateTokens: budget.estimateTokens,
    selectRelevantEvidence: evidence.selectRelevantEvidence,
    createChatHistory: chat.createChatHistory,
    createMemoryRedis: redis.createMemoryRedis,
  };
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const TOPICS = ["Redis", "Kubernetes", "PostgreSQL", "incident", "mentoring", "migration", "latency", "testing", "stakeholders", "budget"];

const repeat = (sentence, times) => Array.from({ length: times }, (_, index) => `${sentence} (${index + 1}).`).join(" ");

/** A typical, mid-sized candidate context (about 9 KB of JSON). */
export function syntheticContext() {
  return {
    version: 1,
    candidate: {
      name: "Alex Candidate",
      profile: repeat("Backend engineer with eight years building payment and data platforms in small product teams", 18),
      skills: ["Node.js", "TypeScript", "PostgreSQL", "Redis", "Kubernetes", "AWS", "Kafka", "Terraform", "Observability", "Testing"],
      achievements: TOPICS.slice(0, 8).map((topic) => `Led a ${topic} initiative that reduced operational toil and improved reliability for the payments team over two quarters.`),
    },
    jobOffer: {
      title: "Senior Backend Engineer",
      company: "Example Corp",
      description: repeat("You will own critical backend services, improve reliability, and mentor engineers across squads", 25),
      requirements: TOPICS.slice(0, 8).map((topic) => `Hands-on experience with ${topic} in production systems.`),
    },
    evidence: TOPICS.slice(0, 8).map((topic) => ({
      requirement: `Hands-on experience with ${topic} in production systems.`,
      evidence: `Led a ${topic} initiative that reduced operational toil and improved reliability for the payments team.`,
    })),
    settings: { language: "en", stage: "technical", answerLength: "standard" },
  };
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

function evidenceBlock(system) {
  const start = system.indexOf("\nCandidate evidence references:\n");
  const end = system.indexOf("\nInterview settings:\n");
  return start === -1 || end === -1 ? null : { start, end };
}

/** The request text in both layouts. */
function layouts(system, history) {
  const current = `${system}\n\n${history}`;
  const block = evidenceBlock(system);
  if (!block) return { current, evidenceLast: current };
  const evidence = system.slice(block.start, block.end);
  const stable = system.slice(0, block.start) + system.slice(block.end);
  return { current, evidenceLast: `${stable}\n\n${history}\n${evidence}` };
}

/** Replay `questions` interviewer questions with history bounded to `maxEntries`. */
export async function replay({ questions = 60, maxEntries = 40 } = {}) {
  const { buildPrompt, estimateTokens, selectRelevantEvidence, createChatHistory, createMemoryRedis } =
    await loadServerModules();
  const context = syntheticContext();
  const contextString = JSON.stringify(context);
  const history = createChatHistory({ redisClient: createMemoryRedis(), maxEntries, log: silentLog });
  const sessionId = "bench";
  const rows = [];
  let previous = null;
  for (let index = 0; index < questions; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    await history.push(sessionId, "caller", `Can you tell me about a time you worked on ${topic} under pressure, and what you would do differently today?`);
    const historyString = await history.toPrompt(sessionId);
    const system = buildPrompt(contextString, "reply", selectRelevantEvidence(contextString, historyString));
    const request = layouts(system, historyString);
    const row = {
      question: index + 1,
      inputTokens: estimateTokens(request.current.length),
      cachedCurrent: previous ? estimateTokens(commonPrefixLength(previous.current, request.current)) : 0,
      cachedEvidenceLast: previous ? estimateTokens(commonPrefixLength(previous.evidenceLast, request.evidenceLast)) : 0,
    };
    rows.push(row);
    previous = request;
    // The candidate's spoken answer and the suggestion both join the history.
    await history.push(sessionId, "me", repeat(`I worked on ${topic} with my team and measured the outcome`, 4));
    await history.push(sessionId, "assistant", repeat(`Outline: situation, task, action and result for ${topic}, citing the approved evidence`, 5));
  }
  return rows;
}

export function summarize(rows) {
  const total = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  // Implicit prefix caching (OpenAI-family models) only applies once at
  // least 1024 tokens match; count reusable tokens accordingly.
  const reusable = (key) => rows.reduce((sum, row) => sum + (row[key] >= 1024 ? row[key] : 0), 0);
  return {
    questions: rows.length,
    totalInputTokens: total,
    lastInputTokens: rows.at(-1).inputTokens,
    maxInputTokens: Math.max(...rows.map((row) => row.inputTokens)),
    reusableCurrent: reusable("cachedCurrent"),
    reusableEvidenceLast: reusable("cachedEvidenceLast"),
  };
}

function parseArgs(argv) {
  const options = { questions: 60, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") options.json = true;
    else if (argv[index] === "--questions") options.questions = Number(argv[(index += 1)]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(options.questions) || options.questions < 2 || options.questions > 500) {
    throw new Error("--questions must be an integer between 2 and 500");
  }
  return options;
}

async function main() {
  const { questions, json } = parseArgs(process.argv.slice(2));
  const results = [];
  for (const maxEntries of [20, 40, 80]) {
    results.push({ maxEntries, ...summarize(await replay({ questions, maxEntries })) });
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ questions, results }, null, 2)}\n`);
    return;
  }
  const percent = (part, whole) => `${((100 * part) / whole).toFixed(0)}%`;
  console.log(`Synthetic interview: ${questions} questions, estimated tokens (chars / 4)`);
  console.log("| History entries | Last request | Largest request | Total input | Reusable prefix (current) | Reusable prefix (evidence-last) |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const row of results) {
    console.log(
      `| ${row.maxEntries}${row.maxEntries === 40 ? " (production)" : ""} | ${row.lastInputTokens} | ${row.maxInputTokens} | ` +
      `${row.totalInputTokens} | ${row.reusableCurrent} (${percent(row.reusableCurrent, row.totalInputTokens)}) | ` +
      `${row.reusableEvidenceLast} (${percent(row.reusableEvidenceLast, row.totalInputTokens)}) |`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
