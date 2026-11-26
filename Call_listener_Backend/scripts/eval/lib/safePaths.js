import path from "node:path";
import { fileURLToPath } from "node:url";

/** The backend project root (`Call_listener_Backend/`). */
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Letters, digits, dot, underscore, and hyphen only; no separators or "..".
const SAFE_FILE_NAME = /^[\w-][\w.-]{0,199}$/;

/** A file name the harness refuses to read or write. */
export class UnsafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/** Throws unless `name` is a plain file name (no directory parts, no ".."). */
export function assertSafeFileName(name) {
  const value = String(name ?? "");
  if (!SAFE_FILE_NAME.test(value) || value.includes("..")) {
    throw new UnsafePathError(`Unsafe file name: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Join a directory and a checked file name, and re-check containment. */
export function safeJoin(directory, name) {
  const root = path.resolve(directory);
  const target = path.resolve(root, assertSafeFileName(name));
  if (path.dirname(target) !== root) throw new UnsafePathError(`Unsafe path: ${target}`);
  return target;
}
