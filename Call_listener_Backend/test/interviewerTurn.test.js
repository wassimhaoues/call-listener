import test from "node:test";
import assert from "node:assert/strict";
import {
  INTERVIEWER_TURN_WINDOW_MS,
  MAX_INTERVIEWER_TURN_CHARS,
  MAX_INTERVIEWER_TURN_PARTS,
  StreamManager,
} from "../server/services/transcription/streamManager.js";

const silentLog = { info() {}, debug() {}, warn() {}, error() {} };

function createManager() {
  const prompts = [];
  const manager = new StreamManager("session-turn", {
    createTranscriptionStream: () => { throw new Error("no audio in these tests"); },
    ChatHistory: { push: async () => {}, toPrompt: async () => "" },
    ContextStore: { get: async () => ({}) },
    generateReply: async () => "unused",
    buildPrompt: () => "prompt",
    // Never resolves: these tests only look at which question was queued.
    runInterviewWorkflow: ({ question, signal }) => {
      prompts.push(question);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    log: silentLog,
  });
  let clock = 1_000_000;
  manager.now = () => clock;
  manager.REPLY_COOLDOWN_MS = 0;
  manager.wsClient = { OPEN: 1, readyState: 1, send() {} };
  const advance = (ms) => { clock += ms; };
  const say = (label, text) => manager.handleUtterance(label, text, manager.generation);
  return { manager, advance, say, prompts };
}

test("interviewer utterances before a question join it as one multipart question", async () => {
  const { manager, advance, say } = createManager();
  await say("system", "I'd like to hear about your time at Acme.");
  assert.equal(manager.currentQuestion.text, "", "a preamble alone queues nothing");
  advance(3_000);
  await say("system", "What was the hardest part?");
  assert.equal(manager.currentQuestion.text, "I'd like to hear about your time at Acme. What was the hardest part?");
  advance(2_000);
  await say("system", "And what would you change?");
  assert.equal(
    manager.currentQuestion.text,
    "I'd like to hear about your time at Acme. What was the hardest part? And what would you change?"
  );
  await manager.closeAll();
});

test("the candidate speaking, a long pause, or a typed question starts a new turn", async () => {
  const { manager, advance, say } = createManager();
  await say("system", "Tell me about Acme?");
  await say("mic", "Sure, I led the billing team.");
  await say("system", "Why did you leave?");
  assert.equal(manager.currentQuestion.text, "Why did you leave?");

  advance(INTERVIEWER_TURN_WINDOW_MS + 1);
  await say("system", "What are you looking for next?");
  assert.equal(manager.currentQuestion.text, "What are you looking for next?");

  advance(1_000);
  await manager.submitInterviewerQuestion("How do you handle conflict?");
  assert.equal(manager.currentQuestion.text, "How do you handle conflict?");
  await manager.closeAll();
});

test("a turn keeps at most the latest parts and characters", async () => {
  const { manager, say } = createManager();
  for (let index = 1; index <= MAX_INTERVIEWER_TURN_PARTS + 2; index += 1) {
    await say("system", `Part ${index}?`);
  }
  assert.equal(manager.currentQuestion.text.split("?").filter(Boolean).length, MAX_INTERVIEWER_TURN_PARTS);
  assert.ok(manager.currentQuestion.text.endsWith(`Part ${MAX_INTERVIEWER_TURN_PARTS + 2}?`));
  await say("system", `${"x".repeat(MAX_INTERVIEWER_TURN_CHARS)} final question?`);
  assert.equal(manager.currentQuestion.text.length, MAX_INTERVIEWER_TURN_CHARS);
  assert.ok(manager.currentQuestion.text.endsWith("final question?"));
  await manager.closeAll();
});

test("an utterance before any client is attached is stored without throwing", async () => {
  const { manager, say } = createManager();
  manager.wsClient = null;
  assert.equal(await say("system", "What brings you here?"), true);
  assert.equal(manager.currentQuestion.text, "What brings you here?");
  await manager.closeAll();
});
