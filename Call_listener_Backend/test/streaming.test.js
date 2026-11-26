import test from "node:test";
import assert from "node:assert/strict";
import { createAiReplyGenerator } from "../server/services/ai/aiService.js";
import { createInterviewWorkflow } from "../server/services/interview/interviewWorkflow.js";
import { StreamManager, createDeltaBatcher } from "../server/services/transcription/streamManager.js";
import { createMessageHandler } from "../server/websocket/handlers/messageHandler.js";
import {
  parseClientCapabilities,
  parseInterviewContext,
} from "../server/contracts/interviewContext.js";

const silentLog = { info() {}, debug() {}, warn() {}, error() {} };

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function untilAborted(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Minimal fake LangChain chat model. `chunks` are yielded one per event-loop
 * turn; `hangAfter` keeps the stream open (until abort) after that many chunks.
 */
function createFakeStreamingModel({ chunks = [], hangAfter, failInvoke = true } = {}) {
  const state = { streamCalls: 0, invokeCalls: 0, yielded: 0, streamOptions: null, constructed: [] };
  class FakeModel {
    constructor(options) {
      state.constructed.push(options);
    }

    async invoke() {
      state.invokeCalls += 1;
      if (failInvoke) throw new Error("invoke must not be used when streaming");
      return { content: chunks.map((chunk) => chunk.content ?? "").join(""), response_metadata: {} };
    }

    async stream(_messages, options) {
      state.streamCalls += 1;
      state.streamOptions = options;
      const { signal } = options;
      return (async function* generate() {
        for (const [index, chunk] of chunks.entries()) {
          if (hangAfter === index) await untilAborted(signal);
          await nextTurn();
          state.yielded += 1;
          yield chunk;
        }
        if (hangAfter === chunks.length) await untilAborted(signal);
      })();
    }
  }
  return { FakeModel, state };
}

function openRouterGenerator(FakeModel, { requestTimeoutMs } = {}) {
  return createAiReplyGenerator({
    provider: "openrouter",
    openRouterApiKey: "openrouter-test-key",
    openRouterModel: "test/model",
    openRouterMaxOutputTokens: 600,
    openRouterRequestTimeoutMs: requestTimeoutMs,
    log: silentLog,
    dependencies: { openrouter: { ChatOpenRouterClass: FakeModel } },
  });
}

// --- OpenRouter adapter -----------------------------------------------------

test("adapter streams text deltas and derives usage and model from the chunks", async () => {
  const { FakeModel, state } = createFakeStreamingModel({
    chunks: [
      { content: "  Lead with ", response_metadata: {} },
      { content: [{ type: "text", text: "the migration." }], response_metadata: {} },
      { content: "", additional_kwargs: { reasoning_content: "hidden" }, response_metadata: {} },
      {
        content: " ",
        usage_metadata: { input_tokens: 40, output_tokens: 6, total_tokens: 46 },
        response_metadata: { model_name: "test/model-2026" },
      },
    ],
  });
  const generateReply = openRouterGenerator(FakeModel);
  const tokens = [];
  const usage = [];
  const models = [];

  const text = await generateReply("system", "history", {
    onToken: (token) => tokens.push(token),
    onUsage: (value, basis) => usage.push([value, basis]),
    onModel: (info) => models.push(info),
  });

  assert.equal(text, "Lead with the migration.");
  assert.deepEqual(tokens, ["  Lead with ", "the migration.", " "], "only text deltas, in order");
  assert.equal(state.streamCalls, 1);
  assert.equal(state.invokeCalls, 0);
  assert.equal(state.constructed[0].streamUsage, true, "usage is requested on streamed responses");
  assert.deepEqual(usage, [[
    { input_tokens: 40, output_tokens: 6, total_tokens: 46 },
    { inputChars: "system".length + "history".length, outputChars: text.length },
  ]]);
  assert.deepEqual(models, [{ selected: "test/model", actual: "test/model-2026" }]);
});

test("adapter sums usage reported across several chunks", async () => {
  const { FakeModel } = createFakeStreamingModel({
    chunks: [
      { content: "A", usage_metadata: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
      { content: "B", usage_metadata: { input_tokens: 0, output_tokens: 2, total_tokens: 2 } },
    ],
  });
  let usage;
  await openRouterGenerator(FakeModel)("s", "h", { onToken() {}, onUsage: (value) => { usage = value; } });
  assert.deepEqual(usage, { input_tokens: 10, output_tokens: 3, total_tokens: 13 });
});

test("adapter reports missing streamed usage so the budget charges an estimate", async () => {
  const { FakeModel } = createFakeStreamingModel({
    chunks: [{ content: "No usage ", response_metadata: { usage: {} } }, { content: "here." }],
  });
  const calls = [];
  const text = await openRouterGenerator(FakeModel)("sys", "hist", {
    onToken() {},
    onUsage: (value, basis) => calls.push([value, basis]),
  });
  assert.equal(text, "No usage here.");
  assert.deepEqual(calls, [[undefined, { inputChars: 7, outputChars: 14 }]]);
});

test("adapter falls back to raw response_metadata usage on streamed chunks", async () => {
  const { FakeModel } = createFakeStreamingModel({
    chunks: [{ content: "Hi", response_metadata: { usage: { prompt_tokens: 5, completion_tokens: 1 } } }],
  });
  let usage;
  await openRouterGenerator(FakeModel)("s", "h", { onToken() {}, onUsage: (value) => { usage = value; } });
  assert.deepEqual(usage, { prompt_tokens: 5, completion_tokens: 1 });
});

test("adapter stops forwarding deltas when the caller aborts mid-stream", async () => {
  const { FakeModel, state } = createFakeStreamingModel({
    chunks: [{ content: "first " }, { content: "second " }, { content: "third" }],
    hangAfter: 1,
  });
  const controller = new AbortController();
  const tokens = [];
  const usage = [];
  const request = openRouterGenerator(FakeModel)("s", "h", {
    signal: controller.signal,
    onToken: (token) => tokens.push(token),
    onUsage: (value) => usage.push(value),
  });
  while (state.yielded < 1) await nextTurn();
  await nextTurn();
  controller.abort(new Error("superseded"));

  await assert.rejects(request, (error) => error.code === "provider_aborted");
  assert.deepEqual(tokens, ["first "]);
  assert.deepEqual(usage, [], "an aborted stream records no usage");
  assert.notEqual(state.streamOptions.signal, controller.signal, "the deadline signal wraps the caller's");
});

test("adapter applies the request deadline to the whole stream", async () => {
  const { FakeModel } = createFakeStreamingModel({ chunks: [{ content: "partial" }], hangAfter: 1 });
  const tokens = [];
  await assert.rejects(
    openRouterGenerator(FakeModel, { requestTimeoutMs: 5 })("s", "h", { onToken: (token) => tokens.push(token) }),
    (error) => error.code === "provider_timeout"
  );
  assert.deepEqual(tokens, ["partial"]);
});

test("adapter keeps the single invoke call when no onToken is given", async () => {
  const { FakeModel, state } = createFakeStreamingModel({
    chunks: [{ content: "Final only." }],
    failInvoke: false,
  });
  assert.equal(await openRouterGenerator(FakeModel)("s", "h", {}), "Final only.");
  assert.equal(state.invokeCalls, 1);
  assert.equal(state.streamCalls, 0);
});

test("the Groq rollback adapter ignores onToken and returns the final reply", async () => {
  class FakeGroq {
    constructor() {
      this.chat = { completions: { create: async () => ({ choices: [{ message: { content: " Groq. " } }] }) } };
    }
  }
  const generateReply = createAiReplyGenerator({
    provider: "groq",
    groqApiKey: "groq-test-key",
    log: silentLog,
    dependencies: { groq: { GroqClient: FakeGroq } },
  });
  const tokens = [];
  assert.equal(await generateReply("s", "h", { onToken: (token) => tokens.push(token) }), "Groq.");
  assert.deepEqual(tokens, []);
});

test("the LangGraph workflow forwards onToken to the reply generator", async () => {
  const seen = [];
  const workflow = createInterviewWorkflow({
    buildPrompt: () => "prompt",
    generateReply: async (_prompt, _history, { onToken }) => {
      onToken("Hel");
      onToken("lo");
      return "Hello";
    },
  });
  const result = await workflow.invoke({ context: "", history: "caller: Hi?", onToken: (token) => seen.push(token) });
  assert.equal(result.suggestion, "Hello");
  assert.deepEqual(seen, ["Hel", "lo"]);
});

// --- Capability negotiation -------------------------------------------------

test("parses client capabilities, ignoring unknown names and rejecting malformed lists", () => {
  assert.deepEqual(parseClientCapabilities({ version: 1 }), { stream: false });
  assert.deepEqual(parseClientCapabilities(undefined), { stream: false });
  assert.deepEqual(parseClientCapabilities({ capabilities: [] }), { stream: false });
  assert.deepEqual(parseClientCapabilities({ capabilities: ["stream"] }), { stream: true });
  assert.deepEqual(parseClientCapabilities({ capabilities: ["future", " stream "] }), { stream: true });
  for (const capabilities of ["stream", [1], [""], ["x".repeat(33)], Array(9).fill("stream"), { stream: true }]) {
    assert.throws(() => parseClientCapabilities({ capabilities }), undefined, JSON.stringify(capabilities));
  }
});

test("capabilities are stripped from the stored context", () => {
  const parsed = parseInterviewContext({
    version: 1,
    capabilities: ["stream"],
    candidate: { name: "Ada" },
    jobOffer: { title: "Engineer" },
    settings: {},
  });
  assert.equal("capabilities" in parsed, false);
  const legacy = parseInterviewContext({ caller: { name: "Bob" }, capabilities: ["stream"] });
  assert.equal("capabilities" in legacy, false);
});

function createHandlerHarness() {
  const stored = [];
  const outbound = [];
  const capabilityCalls = [];
  const handleMessage = createMessageHandler({
    ChatHistory: { toPrompt: async () => "" },
    ContextStore: { set: async (_id, context) => stored.push(context) },
    generateReply: async () => "Intro.",
    buildPrompt: () => "intro prompt",
    parseContext: parseInterviewContext,
    log: silentLog,
  });
  const wsClient = { OPEN: 1, readyState: 1, send: (payload) => outbound.push(JSON.parse(payload)) };
  const streamManager = { setClientCapabilities: (value) => capabilityCalls.push(value) };
  const send = (message) => handleMessage({
    wsClient,
    sessionId: "s1",
    data: Buffer.from(JSON.stringify(message)),
    streamManager,
  });
  return { stored, outbound, capabilityCalls, send };
}

test("the message handler negotiates streaming from each accepted context", async () => {
  const harness = createHandlerHarness();
  await harness.send({ context: { caller: { name: "Bob" }, capabilities: ["stream"] } });
  await harness.send({ context: { caller: { name: "Bob" } } });

  assert.deepEqual(harness.capabilityCalls, [{ stream: true }, { stream: false }]);
  assert.ok(harness.stored.every((context) => !("capabilities" in context)));
  assert.deepEqual(harness.outbound, [{ ai_reply: "Intro." }, { ai_reply: "Intro." }], "intros stay non-streamed");
});

test("a malformed capability list rejects the context without storing it", async () => {
  const harness = createHandlerHarness();
  await harness.send({ context: { caller: { name: "Bob" }, capabilities: "stream" } });
  assert.deepEqual(harness.outbound, [{ error: "Invalid message" }]);
  assert.deepEqual(harness.stored, []);
  assert.deepEqual(harness.capabilityCalls, []);
});

// --- Stream manager ---------------------------------------------------------

/**
 * A stream manager whose workflow is driven by the test: each generation
 * registers a controllable entry in `runs` exposing `token(text)`,
 * `resolve(text)`, and the request `signal`.
 */
function createStreamingManager({ stream = true, flushMs = 50 } = {}) {
  const runs = [];
  const history = [];
  const outbound = [];
  const manager = new StreamManager("session-stream", {
    createTranscriptionStream: () => { throw new Error("no audio in these tests"); },
    ChatHistory: {
      push: async (...entry) => history.push(entry),
      toPrompt: async () => "caller: question",
    },
    ContextStore: { get: async () => ({ candidate: "Ada" }) },
    generateReply: async () => { throw new Error("unused"); },
    buildPrompt: () => "prompt",
    runInterviewWorkflow: ({ signal, onToken, onModel }) => new Promise((resolve, reject) => {
      runs.push({
        signal,
        onToken,
        token: (text) => onToken?.(text),
        resolve: (text) => {
          onModel({ selected: "test/model", actual: null });
          resolve(text);
        },
        reject,
      });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    log: silentLog,
  });
  manager.REPLY_COOLDOWN_MS = 0;
  manager.STREAM_FLUSH_MS = flushMs;
  manager.setClientCapabilities({ stream });
  manager.wsClient = { OPEN: 1, readyState: 1, send: (payload) => outbound.push(JSON.parse(payload)) };
  const ask = async (text) => {
    const before = runs.length;
    await manager.submitInterviewerQuestion(text);
    while (runs.length === before) await nextTurn();
    return runs[runs.length - 1];
  };
  const settle = async () => {
    for (let turn = 0; turn < 10; turn += 1) await nextTurn();
  };
  const generationMessages = () => outbound.filter((message) => !message.speaker);
  return { manager, runs, history, outbound, ask, settle, generationMessages };
}

test("streams thinking, coalesced deltas, then a final done reply with one generation ID", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ask, settle, generationMessages } = createStreamingManager();
  const run = await ask("Tell me about a migration?");

  run.token("Lead ");
  run.token("with ");
  assert.deepEqual(generationMessages(), [{ generation: { id: "g1", state: "thinking" } }], "tokens are buffered");
  t.mock.timers.tick(49);
  assert.equal(generationMessages().length, 1, "no flush before the batching interval");
  t.mock.timers.tick(1);
  run.token("the ");
  run.token("migration.");
  t.mock.timers.tick(50);
  run.token(" ");
  run.resolve("Lead with the migration. ");
  await settle();

  assert.deepEqual(generationMessages(), [
    { generation: { id: "g1", state: "thinking" } },
    { generation: { id: "g1", state: "streaming" }, delta: "Lead with " },
    { generation: { id: "g1", state: "streaming" }, delta: "the migration." },
    { generation: { id: "g1", state: "streaming" }, delta: " " },
    {
      ai_reply: "Lead with the migration.",
      model: { selected: "test/model", actual: null },
      generation: { id: "g1", state: "done" },
    },
  ]);
  t.mock.timers.tick(1_000);
  assert.equal(generationMessages().length, 5, "nothing is sent after done");
});

test("a superseded generation sends no further deltas and the newer one gets a new ID", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ask, settle, generationMessages, history } = createStreamingManager();
  const first = await ask("How did you keep it safe?");
  first.token("Old ");
  t.mock.timers.tick(50);
  first.token("buffered tail");

  const second = await ask("What would you change?");
  first.token("token after supersede");
  t.mock.timers.tick(200);
  second.token("New answer.");
  second.resolve("New answer.");
  await settle();

  assert.equal(first.signal.aborted, true);
  assert.deepEqual(generationMessages(), [
    { generation: { id: "g1", state: "thinking" } },
    { generation: { id: "g1", state: "streaming" }, delta: "Old " },
    { generation: { id: "g2", state: "thinking" } },
    { generation: { id: "g2", state: "streaming" }, delta: "New answer." },
    {
      ai_reply: "New answer.",
      model: { selected: "test/model", actual: null },
      generation: { id: "g2", state: "done" },
    },
  ]);
  assert.deepEqual(history.filter(([, role]) => role === "assistant").map(([, , text]) => text), ["New answer."]);
});

test("session end drops buffered deltas and sends nothing further", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, ask, settle, generationMessages } = createStreamingManager();
  const run = await ask("Any questions for us?");
  run.token("Ask about ");
  await manager.closeAll();
  run.token("the team.");
  t.mock.timers.tick(500);
  await settle();

  assert.deepEqual(generationMessages(), [{ generation: { id: "g1", state: "thinking" } }]);
});

test("a failed streamed generation reports failure with its ID and the legacy reply", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ask, settle, generationMessages } = createStreamingManager();
  const run = await ask("Why this team?");
  run.token("Partial ");
  run.reject(new Error("provider failed"));
  await settle();
  t.mock.timers.tick(500);

  assert.deepEqual(generationMessages(), [
    { generation: { id: "g1", state: "thinking" } },
    { generation: { id: "g1", state: "failed" }, ai_reply: "[Erreur du modèle]" },
  ]);
});

test("an empty streamed reply is a failure, never a done message", async () => {
  const { ask, settle, generationMessages } = createStreamingManager({ flushMs: 60_000 });
  const run = await ask("Why this team?");
  run.token("   ");
  run.resolve("   ");
  await settle();
  assert.deepEqual(generationMessages(), [
    { generation: { id: "g1", state: "thinking" } },
    { generation: { id: "g1", state: "failed" }, ai_reply: "[Erreur du modèle]" },
  ]);
});

test("clients without the stream capability get exactly the legacy sequence", async () => {
  const { ask, settle, generationMessages, runs } = createStreamingManager({ stream: false });
  const run = await ask("Tell me about a migration?");
  assert.equal(run.onToken, undefined, "no token callback reaches the provider");
  run.resolve("Final answer.");
  await settle();
  const failing = await ask("And then?");
  failing.reject(new Error("provider failed"));
  await settle();

  assert.equal(runs.length, 2);
  assert.deepEqual(generationMessages(), [
    { generation: { state: "thinking" } },
    { ai_reply: "Final answer.", model: { selected: "test/model", actual: null } },
    { generation: { state: "thinking" } },
    { generation: { state: "failed" }, ai_reply: "[Erreur du modèle]" },
  ]);
});

test("a capability change applies from the next generation", async () => {
  const { manager, ask, settle, generationMessages } = createStreamingManager({ stream: false, flushMs: 60_000 });
  const run = await ask("First?");
  manager.setClientCapabilities({ stream: true });
  run.resolve("One.");
  await settle();
  const next = await ask("Second?");
  next.token("Two.");
  next.resolve("Two.");
  await settle();
  manager.setClientCapabilities({});
  const last = await ask("Third?");
  last.resolve("Three.");
  await settle();

  assert.deepEqual(generationMessages(), [
    { generation: { state: "thinking" } },
    { ai_reply: "One.", model: { selected: "test/model", actual: null } },
    { generation: { id: "g2", state: "thinking" } },
    { generation: { id: "g2", state: "streaming" }, delta: "Two." },
    { ai_reply: "Two.", model: { selected: "test/model", actual: null }, generation: { id: "g2", state: "done" } },
    { generation: { state: "thinking" } },
    { ai_reply: "Three.", model: { selected: "test/model", actual: null } },
  ]);
});

test("the delta batcher coalesces, ignores empty tokens, and stops once not current", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  let current = true;
  const batcher = createDeltaBatcher({ flushMs: 50, isCurrent: () => current, send: (delta) => sent.push(delta) });
  batcher.push("a");
  batcher.push("");
  batcher.push(null);
  batcher.push("b");
  t.mock.timers.tick(50);
  batcher.push("c");
  batcher.flush();
  batcher.flush();
  batcher.push("d");
  current = false;
  t.mock.timers.tick(50);
  batcher.push("e");
  batcher.flush();
  assert.deepEqual(sent, ["ab", "c"]);
});
