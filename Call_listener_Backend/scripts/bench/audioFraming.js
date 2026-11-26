#!/usr/bin/env node
/**
 * Synthetic audio-framing benchmark (no network, no providers, no recordings).
 *
 * Compares the current JSON frame `{ source, chunk: <base64 PCM16> }` with a
 * hypothetical binary frame (1-byte source tag + raw PCM16) for 20/40/60 ms
 * batches of 48 kHz mono linear16 audio: bytes on the wire per second,
 * WebSocket messages per second, and CPU time to encode (client) and decode
 * (server) one minute of two-channel audio.
 *
 * Usage: node scripts/bench/audioFraming.js [--minutes 1] [--json]
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const SAMPLE_RATE = 48_000;
export const BYTES_PER_SAMPLE = 2;
// Per-message WebSocket framing cost, client to server (masked): 2-byte
// header + 4-byte mask, plus 2 bytes of extended length for 126..65535 bytes.
const wsOverhead = (payloadBytes) => 6 + (payloadBytes >= 126 ? 2 : 0);

export function pcmBytesFor(batchMs) {
  return Math.round((SAMPLE_RATE * batchMs) / 1000) * BYTES_PER_SAMPLE;
}

/** Wire sizes of one frame, both encodings, for a batch length and source. */
export function frameSizes(batchMs, source = "system") {
  const pcm = Buffer.alloc(pcmBytesFor(batchMs));
  const json = Buffer.byteLength(JSON.stringify({ source, chunk: pcm.toString("base64") }));
  const binary = 1 + pcm.length;
  return {
    batchMs,
    pcmBytes: pcm.length,
    jsonBytes: json + wsOverhead(json),
    binaryBytes: binary + wsOverhead(binary),
  };
}

function syntheticPcm(bytes, seed) {
  // Deterministic pseudo-audio so base64 cannot benefit from zeros.
  const buffer = Buffer.alloc(bytes);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < bytes; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    buffer[index] = state >>> 24;
  }
  return buffer;
}

function timeIt(run) {
  const start = performance.now();
  const result = run();
  return { ms: performance.now() - start, result };
}

/** Encode + decode cost for `seconds` of two-channel audio in `batchMs` frames. */
export function measure(batchMs, seconds) {
  const framesPerChannel = Math.round((seconds * 1000) / batchMs);
  const frames = [];
  for (let index = 0; index < framesPerChannel; index += 1) {
    for (const source of ["mic", "system"]) frames.push({ source, pcm: syntheticPcm(pcmBytesFor(batchMs), index * 2 + source.length) });
  }

  const jsonEncode = timeIt(() => frames.map(({ source, pcm }) => JSON.stringify({ source, chunk: pcm.toString("base64") })));
  const jsonDecode = timeIt(() => {
    let total = 0;
    for (const text of jsonEncode.result) total += Buffer.from(JSON.parse(text).chunk, "base64").length;
    return total;
  });
  const binaryEncode = timeIt(() => frames.map(({ source, pcm }) => Buffer.concat([Buffer.from([source === "mic" ? 0 : 1]), pcm])));
  const binaryDecode = timeIt(() => {
    let total = 0;
    for (const frame of binaryEncode.result) total += frame.subarray(1).length;
    return total;
  });
  if (jsonDecode.result !== binaryDecode.result) throw new Error("decoded byte counts differ");

  return {
    batchMs,
    messagesPerSecond: 2 * (1000 / batchMs),
    jsonEncodeMs: jsonEncode.ms,
    jsonDecodeMs: jsonDecode.ms,
    binaryEncodeMs: binaryEncode.ms,
    binaryDecodeMs: binaryDecode.ms,
  };
}

function parseArgs(argv) {
  const options = { minutes: 1, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") options.json = true;
    else if (argv[index] === "--minutes") options.minutes = Number(argv[(index += 1)]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isFinite(options.minutes) || options.minutes <= 0 || options.minutes > 30) {
    throw new Error("--minutes must be between 0 and 30");
  }
  return options;
}

function main() {
  const { minutes, json } = parseArgs(process.argv.slice(2));
  const seconds = minutes * 60;
  measure(20, 2); // warm up the JIT
  const rows = [20, 40, 60].map((batchMs) => {
    const sizes = frameSizes(batchMs);
    const perSecond = 1000 / batchMs;
    return {
      ...sizes,
      ...measure(batchMs, seconds),
      // Two channels (mic + system).
      jsonKiBps: (2 * sizes.jsonBytes * perSecond) / 1024,
      binaryKiBps: (2 * sizes.binaryBytes * perSecond) / 1024,
    };
  });
  if (json) {
    process.stdout.write(`${JSON.stringify({ minutes, node: process.version, rows }, null, 2)}\n`);
    return;
  }
  const fixed = (value, digits = 1) => value.toFixed(digits);
  console.log(`Synthetic audio framing, ${minutes} min of two-channel 48 kHz PCM16, Node ${process.version}`);
  console.log("| Batch | Msgs/s | JSON frame B | Binary frame B | JSON KiB/s | Binary KiB/s | JSON enc+dec ms | Binary enc+dec ms |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    console.log(
      `| ${row.batchMs} ms | ${fixed(row.messagesPerSecond)} | ${row.jsonBytes} | ${row.binaryBytes} | ${fixed(row.jsonKiBps)} | ` +
      `${fixed(row.binaryKiBps)} | ${fixed(row.jsonEncodeMs + row.jsonDecodeMs)} | ${fixed(row.binaryEncodeMs + row.binaryDecodeMs)} |`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
