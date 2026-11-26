// The interview context saved by the Context page. It lives in localStorage,
// so it can be missing (first run, cleared storage) or corrupted; the live
// page must never start a session without a usable one.

export const CONTEXT_STORAGE_KEY = "callContext";

export const MISSING_CONTEXT_TEXT =
  "Add your profile and the job offer before starting the interview, so guidance can use your own experience.";

/** The stored context object, or undefined when missing or unreadable. */
export function readStoredContext(storage = globalThis.localStorage) {
  let raw;
  try {
    raw = storage?.getItem(CONTEXT_STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const context = JSON.parse(raw);
    return context && typeof context === "object" && !Array.isArray(context) ? context : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a stored context cannot start an interview, or null when it can. Only
 * the shape the Context page always writes is checked; the server validates
 * the full contract.
 */
export function storedContextError(context) {
  const name = context?.candidate?.name;
  const title = context?.jobOffer?.title;
  if (context?.version !== 1) return MISSING_CONTEXT_TEXT;
  if (typeof name !== "string" || !name.trim()) return MISSING_CONTEXT_TEXT;
  if (typeof title !== "string" || !title.trim()) return MISSING_CONTEXT_TEXT;
  return null;
}
