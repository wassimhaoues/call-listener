#!/usr/bin/env node
/**
 * Operator CLI for the device deny-list.
 *
 *   npm run admin:revocation -- revoke <device-id> [--reason <code>]
 *   npm run admin:revocation -- restore <device-id>
 *   npm run admin:revocation -- check <device-id>
 *   npm run admin:revocation -- reset-enrollment <device-id>
 *
 * Connects to REDIS_URL (from the environment or a local .env). Output names a
 * device only by its short SHA-256 fingerprint and never prints REDIS_URL or
 * any other secret. Exit codes: 0 success, 1 Redis failure, 2 usage error.
 */
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import Redis from "ioredis";
import {
  createDeviceRevocation,
  deviceFingerprint,
  isDeviceId,
  normalizeReason,
  DEVICE_ID_MAX_LENGTH,
  DEVICE_ID_MIN_LENGTH,
} from "../../server/services/auth/deviceRevocation.js";
import { createDeviceEnrollment } from "../../server/services/auth/deviceEnrollment.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
const COMMANDS = new Set(["revoke", "restore", "check", "reset-enrollment"]);
const CONNECT_TIMEOUT_MS = 5_000;

export const USAGE = [
  "Usage:",
  "  npm run admin:revocation -- revoke <device-id> [--reason <code>]",
  "  npm run admin:revocation -- restore <device-id>",
  "  npm run admin:revocation -- check <device-id>",
  "  npm run admin:revocation -- reset-enrollment <device-id>",
  "",
  "The reason is an operator code (letters, digits, spaces and _ . : # / -, at most 120",
  "characters), for example a ticket number. Never put personal data in it.",
].join("\n");

export class UsageError extends Error {}

function readReason(options) {
  if (options.length === 0) return undefined;
  const [flag, value, ...extra] = options;
  if (flag.startsWith("--reason=")) {
    if (value !== undefined) throw new UsageError("unexpected argument after --reason");
    return flag.slice("--reason=".length);
  }
  if (flag !== "--reason") throw new UsageError(`unknown option: ${flag.slice(0, 40)}`);
  if (value === undefined) throw new UsageError("--reason needs a value");
  if (extra.length > 0) throw new UsageError("unexpected argument after --reason (quote a reason with spaces)");
  return value;
}

/** Validate CLI arguments; throws UsageError. */
export function parseArgs(argv) {
  const [command, deviceId, ...options] = argv;
  if (!COMMANDS.has(command)) throw new UsageError("expected a command: revoke, restore, check or reset-enrollment");
  if (typeof deviceId !== "string" || deviceId.startsWith("-")) throw new UsageError("missing <device-id>");
  if (!isDeviceId(deviceId) || /\s/.test(deviceId)) {
    throw new UsageError(
      `device id must be ${DEVICE_ID_MIN_LENGTH} to ${DEVICE_ID_MAX_LENGTH} characters without spaces`
    );
  }
  if (command !== "revoke") {
    if (options.length > 0) throw new UsageError(`${command} takes no options`);
    return { command, deviceId };
  }
  try {
    return { command, deviceId, reason: normalizeReason(readReason(options)) };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error.message);
  }
}

async function execute({ command, deviceId, reason }, { revocation, enrollment }, write) {
  const fingerprint = deviceFingerprint(deviceId);
  if (command === "reset-enrollment") {
    // For an installation whose stored secret was lost (for example user data
    // copied to another computer): it enrolls again on its next sign-in.
    const existed = await enrollment.reset(deviceId);
    write(existed ? `reset enrollment of device ${fingerprint}; its next sign-in enrolls a new secret` : `device ${fingerprint} was not enrolled`);
    return;
  }
  if (command === "revoke") {
    const record = await revocation.revoke(deviceId, { reason });
    write(`revoked device ${fingerprint} (reason: ${record.reason}, at ${record.revokedAt})`);
    write("New tokens, tickets and connections are refused now; open sockets close within one sweep interval.");
    return;
  }
  if (command === "restore") {
    const existed = await revocation.restore(deviceId);
    write(existed ? `restored device ${fingerprint}` : `device ${fingerprint} was not revoked`);
    return;
  }
  const record = await revocation.lookup(deviceId);
  if (!record.revoked) {
    write(`device ${fingerprint} is not revoked`);
    return;
  }
  const at = record.revokedAt ?? "unknown time";
  write(`device ${fingerprint} is revoked (reason: ${record.reason}, at ${at})`);
}

/**
 * Run the CLI against an injected revocation store factory. Resolves the
 * process exit code; never throws.
 */
export async function runCli(argv, { openRevocation, stdout, stderr }) {
  const write = (line) => stdout.write(`${line}\n`);
  const fail = (line) => stderr.write(`${line}\n`);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(`error: ${error.message}`);
    fail(USAGE);
    return EXIT_USAGE;
  }
  let session;
  try {
    session = await openRevocation();
    await execute(parsed, session, write);
    return EXIT_OK;
  } catch (error) {
    // Only an error code: messages can embed connection details.
    fail(`error: Redis operation failed (${error?.code || error?.name || "error"})`);
    return EXIT_FAILURE;
  } finally {
    await session?.close?.();
  }
}

/** Connect to REDIS_URL without retries or an offline queue, so failures exit fast. */
export function openRedisRevocation(redisUrl) {
  return async () => {
    if (!redisUrl) {
      const error = new Error("REDIS_URL is not set");
      error.code = "REDIS_URL_MISSING";
      throw error;
    }
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: CONNECT_TIMEOUT_MS,
      retryStrategy: () => null,
    });
    // Connection errors surface through connect()/commands; keep the default
    // listener from printing them (they may include the host).
    redis.on("error", () => {});
    try {
      await redis.connect();
    } catch (error) {
      redis.disconnect();
      throw error;
    }
    return {
      revocation: createDeviceRevocation({ redisClient: redis }),
      enrollment: createDeviceEnrollment({ redisClient: redis }),
      close: async () => {
        try {
          await redis.quit();
        } catch {
          redis.disconnect();
        }
      },
    };
  };
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  dotenv.config({ quiet: true });
  process.exitCode = await runCli(process.argv.slice(2), {
    openRevocation: openRedisRevocation(process.env.REDIS_URL),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
