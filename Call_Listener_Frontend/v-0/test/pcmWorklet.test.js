import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

it("batches worklet PCM into 20 ms chunks and supports a final flush", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../src/worklets/pcm-processor.js"),
    "utf8"
  );
  expect(source).toContain("this.batchDurationSeconds = 0.02");
  expect(source).toContain('event.data?.type === "flush"');
  expect(source).toContain("while (offset < out.length)");
});

it("emits the partial batch and then acknowledges a flush request", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../src/worklets/pcm-processor.js"),
    "utf8"
  );
  let Processor;
  class FakeProcessor {
    constructor() {
      this.posted = [];
      this.port = { postMessage: (data) => this.posted.push(data), onmessage: null };
    }
  }
  // Evaluate the worklet module with AudioWorkletGlobalScope stand-ins.
  const load = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    "currentTime",
    source
  );
  load(FakeProcessor, (name, cls) => (Processor = cls), 48000, 0);

  const node = new Processor({ processorOptions: { source: "system" } });
  node.process([[new Float32Array([0.5, -0.5])]]);
  node.port.onmessage({ data: { type: "flush" } });
  node.port.onmessage({ data: { type: "flush" } }); // nothing pending: ack only

  const types = node.posted.map((message) => message.type).filter((type) => type !== "meter");
  expect(types).toEqual(["chunk", "flushed", "flushed"]);
  const chunk = node.posted.find((message) => message.type === "chunk");
  expect(Array.from(new Int16Array(chunk.buffer))).toEqual([16383, -16383]);
  expect(node.posted.at(-1)).toEqual({ type: "flushed", source: "system" });
});
