import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { randomBytes } from "node:crypto";
import {
  parseArgs,
  runCli,
  UsageError,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
} from "../scripts/admin/deviceRevocation.js";
import { createDeviceRevocation, deviceFingerprint } from "../server/services/auth/deviceRevocation.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../scripts/admin/deviceRevocation.js", import.meta.url));
const DEVICE = "6f1c9a52-0d4b-4c43-9a57-2f7f1d1c0a01";

function sink() {
  const chunks = [];
  return { chunks, write: (chunk) => chunks.push(chunk), text: () => chunks.join("") };
}

function harness({ redisClient = createMemoryRedis(), openError } = {}) {
  const stdout = sink();
  const stderr = sink();
  const revocation = createDeviceRevocation({ redisClient });
  let closed = 0;
  const openRevocation = async () => {
    if (openError) throw openError;
    return {
      revocation,
      close: async () => {
        closed += 1;
      },
    };
  };
  const run = (argv) => runCli(argv, { openRevocation, stdout, stderr });
  return { run, stdout, stderr, revocation, closedCount: () => closed };
}

test("parseArgs accepts the three commands and an optional reason", () => {
  assert.deepEqual(parseArgs(["revoke", DEVICE]), { command: "revoke", deviceId: DEVICE, reason: "operator" });
  assert.deepEqual(parseArgs(["revoke", DEVICE, "--reason", "ticket 142"]), {
    command: "revoke",
    deviceId: DEVICE,
    reason: "ticket 142",
  });
  assert.deepEqual(parseArgs(["revoke", DEVICE, "--reason=abuse"]).reason, "abuse");
  assert.deepEqual(parseArgs(["restore", DEVICE]), { command: "restore", deviceId: DEVICE });
  assert.deepEqual(parseArgs(["check", DEVICE]), { command: "check", deviceId: DEVICE });
});

test("parseArgs rejects bad commands, device IDs, options and reasons", () => {
  const cases = [
    [[], /expected a command/],
    [["eval", DEVICE], /expected a command/],
    [["revoke"], /missing <device-id>/],
    [["revoke", "--reason", "x"], /missing <device-id>/],
    [["revoke", "short"], /device id must be/],
    [["revoke", "x".repeat(257)], /device id must be/],
    [["revoke", "has spaces in it"], /device id must be/],
    [["revoke", DEVICE, "--reason"], /needs a value/],
    [["revoke", DEVICE, "--reason", "two", "words"], /unexpected argument/],
    [["revoke", DEVICE, "--force"], /unknown option/],
    [["revoke", DEVICE, "--reason", "mail me at a@b.example"], /may only use/],
    [["revoke", DEVICE, "--reason", "x".repeat(121)], /at most 120/],
    [["restore", DEVICE, "--reason", "x"], /takes no options/],
    [["check", DEVICE, "extra"], /takes no options/],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseArgs(argv), (error) => error instanceof UsageError && pattern.test(error.message), argv.join(" "));
  }
});

test("revoke, check and restore round-trip and print only the fingerprint", async () => {
  const { run, stdout, stderr, revocation, closedCount } = harness();
  const fingerprint = deviceFingerprint(DEVICE);

  assert.equal(await run(["check", DEVICE]), EXIT_OK);
  assert.equal(await run(["revoke", DEVICE, "--reason", "ticket 142"]), EXIT_OK);
  assert.equal(await revocation.isRevoked(DEVICE), true);
  assert.equal(await run(["check", DEVICE]), EXIT_OK);
  assert.equal(await run(["restore", DEVICE]), EXIT_OK);
  assert.equal(await revocation.isRevoked(DEVICE), false);
  assert.equal(await run(["restore", DEVICE]), EXIT_OK);

  const out = stdout.text();
  for (const expected of [
    `device ${fingerprint} is not revoked`,
    `revoked device ${fingerprint} (reason: ticket 142, at `,
    `device ${fingerprint} is revoked (reason: ticket 142`,
    `restored device ${fingerprint}`,
    `device ${fingerprint} was not revoked`,
  ]) {
    assert.ok(out.includes(expected), expected);
  }
  assert.ok(!out.includes(DEVICE), "the raw device ID is not echoed");
  assert.equal(stderr.text(), "");
  assert.equal(closedCount(), 5, "the connection is closed after every command");
});

test("a usage error exits 2 without connecting to Redis", async () => {
  const { run, stderr, closedCount } = harness({ openError: new Error("must not connect") });
  assert.equal(await run(["revoke", "short"]), EXIT_USAGE);
  assert.match(stderr.text(), /error: device id must be/);
  assert.match(stderr.text(), /Usage:/);
  assert.equal(closedCount(), 0);
});

test("a Redis failure exits 1 and prints only the error code", async () => {
  // Generated per run: the message mimics a driver error that embeds the URL.
  const secret = randomBytes(8).toString("hex");
  const failure = Object.assign(new Error("connect ECONNREFUSED redis://:" + secret + "@redis.internal:6379"), {
    code: "ECONNREFUSED",
  });
  const { run, stderr } = harness({ openError: failure });
  assert.equal(await run(["check", DEVICE]), EXIT_FAILURE);
  assert.equal(stderr.text(), "error: Redis operation failed (ECONNREFUSED)\n");
});

test("the script exits non-zero and never prints REDIS_URL or its password", async () => {
  const secret = randomBytes(8).toString("hex");
  const env = { PATH: process.env.PATH, REDIS_URL: "redis://:" + secret + "@127.0.0.1:1" };
  const options = { cwd: os.tmpdir(), env, timeout: 20_000 };

  const usage = await execFileAsync(process.execPath, [cliPath, "revoke"], options).catch((error) => error);
  assert.equal(usage.code, EXIT_USAGE);
  assert.match(usage.stderr, /missing <device-id>/);

  const unreachable = await execFileAsync(process.execPath, [cliPath, "check", DEVICE], options).catch((error) => error);
  assert.equal(unreachable.code, EXIT_FAILURE);
  assert.match(unreachable.stderr, /^error: Redis operation failed \(/);
  const output = unreachable.stdout + unreachable.stderr;
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes("127.0.0.1"));

  const missingUrl = await execFileAsync(process.execPath, [cliPath, "check", DEVICE], {
    ...options,
    env: { PATH: process.env.PATH },
  }).catch((error) => error);
  assert.equal(missingUrl.code, EXIT_FAILURE);
  assert.match(missingUrl.stderr, /REDIS_URL_MISSING/);
});

test("reset-enrollment forgets an enrolled secret and prints only the fingerprint", async () => {
  const { createDeviceEnrollment } = await import("../server/services/auth/deviceEnrollment.js");
  const redisClient = createMemoryRedis();
  const enrollment = createDeviceEnrollment({ redisClient });
  await enrollment.check(DEVICE, randomBytes(32).toString("base64url"));
  const stdout = sink();
  const stderr = sink();
  const openRevocation = async () => ({ revocation: createDeviceRevocation({ redisClient }), enrollment, close: async () => {} });
  assert.equal(await runCli(["reset-enrollment", DEVICE], { openRevocation, stdout, stderr }), EXIT_OK);
  assert.match(stdout.text(), new RegExp(`reset enrollment of device ${deviceFingerprint(DEVICE)}`));
  assert.ok(!stdout.text().includes(DEVICE));
  assert.equal(await enrollment.isEnrolled(DEVICE), false);
  assert.equal(await runCli(["reset-enrollment", DEVICE, "--reason", "x"], { openRevocation, stdout, stderr }), EXIT_USAGE);
});
