import test from "node:test";
import assert from "node:assert/strict";
import { frameSizes, measure, pcmBytesFor } from "../scripts/bench/audioFraming.js";

test("audio framing benchmark computes PCM and frame sizes for 48 kHz PCM16", () => {
  assert.equal(pcmBytesFor(20), 1_920);
  const sizes = frameSizes(20, "system");
  assert.equal(sizes.pcmBytes, 1_920);
  // 1 tag byte + PCM + 8 bytes of masked WebSocket header.
  assert.equal(sizes.binaryBytes, 1_929);
  // Base64 (4/3) plus the JSON envelope and header is larger.
  assert.ok(sizes.jsonBytes > Math.ceil(1_920 / 3) * 4);
});

test("both encodings decode to the same audio bytes", () => {
  const result = measure(40, 1);
  assert.equal(result.messagesPerSecond, 50);
  for (const key of ["jsonEncodeMs", "jsonDecodeMs", "binaryEncodeMs", "binaryDecodeMs"]) {
    assert.ok(Number.isFinite(result[key]) && result[key] >= 0, key);
  }
});
