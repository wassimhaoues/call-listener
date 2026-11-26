import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The backend project root (`Call_listener_Backend/`). */
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Letters, digits, dot, underscore, and hyphen only; no separators or "..".
const SAFE_FILE_NAME = /^[\w-][\w.-]{0,199}$/;

/** A path option or file name the harness refuses to read or write. */
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

function isInside(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

async function allowedRoots() {
  const roots = [BACKEND_ROOT, os.tmpdir()];
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => path.resolve(root))));
  return [...new Set([...roots.map((root) => path.resolve(root)), ...resolved])];
}

/**
 * Resolve a directory option and require it to stay under the backend root
 * or the OS temp directory. The check runs on the lexical path and, when the
 * directory exists, again on its real path so a symlink cannot escape.
 */
export async function resolveSafeDirectory(input, label) {
  const resolved = path.resolve(String(input ?? ""));
  const roots = await allowedRoots();
  if (!roots.some((root) => isInside(resolved, root))) {
    throw new UnsafePathError(`${label} must be inside ${BACKEND_ROOT} or ${os.tmpdir()}: ${resolved}`);
  }
  let real;
  try {
    real = await realpath(resolved);
  } catch {
    return resolved;
  }
  if (!roots.some((root) => isInside(real, root))) {
    throw new UnsafePathError(`${label} resolves outside ${BACKEND_ROOT} and ${os.tmpdir()}: ${real}`);
  }
  return real;
}

/** Join a checked directory and a checked file name, and re-check containment. */
export function safeJoin(directory, name) {
  const target = path.resolve(directory, assertSafeFileName(name));
  if (!isInside(target, path.resolve(directory)) || target === path.resolve(directory)) {
    throw new UnsafePathError(`Unsafe path: ${target}`);
  }
  return target;
}
