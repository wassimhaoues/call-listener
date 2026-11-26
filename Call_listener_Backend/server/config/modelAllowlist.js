const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.-]*\/[\w.:-]+$/;
export const MAX_ALLOWED_MODELS = 20;

/** Parse the comma-separated model allowlist; the default model is the fallback list. */
export function parseModelAllowlist(value, defaultModel) {
  const ids = String(value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const allowlist = ids.length ? [...new Set(ids)] : [defaultModel];
  if (allowlist.length > MAX_ALLOWED_MODELS) {
    throw new Error(`OPENROUTER_ALLOWED_MODELS accepts at most ${MAX_ALLOWED_MODELS} models`);
  }
  for (const id of allowlist) {
    if (!MODEL_ID_PATTERN.test(id) || id.length > 128) {
      throw new Error(`OPENROUTER_ALLOWED_MODELS contains an invalid model ID: ${id}`);
    }
  }
  if (!allowlist.includes(defaultModel)) {
    throw new Error("OPENROUTER_ALLOWED_MODELS must include OPENROUTER_MODEL");
  }
  return allowlist;
}
