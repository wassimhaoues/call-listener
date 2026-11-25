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
