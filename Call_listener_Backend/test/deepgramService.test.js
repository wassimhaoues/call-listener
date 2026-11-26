import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { DeepgramService } from "../server/services/transcription/deepgramService.js";

test("emits completed utterances without writing their content to default logs", async () => {
  const connection = new EventEmitter();
  connection.send = () => {};
  connection.finish = async () => {};
  const info = [];
  let options;
  const service = new DeepgramService("system", {
    deepgramClient: { listen: { live: (value) => { options = value; return connection; } } },
    language: "en",
    log: { info: (message) => info.push(message), debug() {}, warn() {}, error() {} },
  });
  const utterances = [];
  service.on("utterance", (utterance) => utterances.push(utterance));

  await service.start();
  assert.equal(options.language, "en");
  connection.emit(LiveTranscriptionEvents.Transcript, {
    channel: { alternatives: [{ transcript: "My private interview answer" }] },
    is_final: true,
  });
  connection.emit(LiveTranscriptionEvents.UtteranceEnd);

  assert.deepEqual(utterances, [{ label: "system", text: "My private interview answer" }]);
  assert.match(info.at(-1), /Utterance completed \(27 chars\)/);
  assert.doesNotMatch(info.join("\n"), /My private interview answer/);
});

test("requires an explicit Deepgram client", () => {
  assert.throws(() => new DeepgramService("mic"), /deepgramClient is required/);
});

test("rejects unsupported transcription languages", () => {
  assert.throws(
    () => new DeepgramService("mic", { deepgramClient: {}, language: "other" }),
    /language must be fr or en/
  );
});

test("a flushing stop finalizes buffered audio and emits the remaining text as the last utterance", async () => {
  const { createFakeDeepgramClient } = await import("./helpers/fakeDeepgram.js");
  const client = createFakeDeepgramClient();
  const info = [];
  const service = new DeepgramService("mic", {
    deepgramClient: client,
    language: "en",
    log: { info: (message) => info.push(message), debug() {}, warn() {}, error() {} },
  });
  const utterances = [];
  service.on("utterance", (utterance) => utterances.push(utterance));
  await service.start();
  const [connection] = client.connections;
  // Finalized speech that has not seen UtteranceEnd yet, plus audio Deepgram
  // still holds and returns in answer to Finalize.
  connection.emitTranscript("I would measure the result");
  connection.onFinalize = "and share it with the team.";

  await service.stop({ flush: true });

  assert.equal(connection.finalizeCalls, 1);
  assert.equal(connection.finishCalls, 1);
  assert.deepEqual(utterances, [{ label: "mic", text: "I would measure the result and share it with the team." }]);
  assert.doesNotMatch(info.join("\n"), /measure the result/);
});

test("a flushing stop gives up waiting for Finalize after the bound and a plain stop never finalizes", async (t) => {
  const { createFakeDeepgramClient } = await import("./helpers/fakeDeepgram.js");
  const client = createFakeDeepgramClient();
  const service = new DeepgramService("system", { deepgramClient: client, language: "en", log: { info() {}, debug() {}, warn() {}, error() {} } });
  const utterances = [];
  service.on("utterance", (utterance) => utterances.push(utterance));
  await service.start();
  const [connection] = client.connections;
  connection.emitTranscript("Last question?");
  connection.onFinalize = null; // Deepgram never answers
  const started = Date.now();
  await service.flush({ waitMs: 30 });
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(utterances, [{ label: "system", text: "Last question?" }]);

  const plain = new DeepgramService("mic", { deepgramClient: client, language: "en", log: { info() {}, debug() {}, warn() {}, error() {} } });
  await plain.start();
  await plain.stop();
  assert.equal(client.connections[1].finalizeCalls, undefined);
  t.diagnostic("plain stop sends no Finalize");
});
