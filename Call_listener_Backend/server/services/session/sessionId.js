import { randomBytes } from "node:crypto";

/** 128 random bits, base64url-encoded without padding: 22 characters. */
export const SESSION_ID_BYTES = 16;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Create an opaque, unguessable session ID. It is safe to use in Redis key
 * names (`chat:<id>`, `context:<id>`) and in log lines, but it is not an
 * authorization secret on its own: resuming a session also requires the
 * authenticated owner that created it.
 */
export function createSessionId() {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

export function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}
