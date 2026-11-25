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
