export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const DEFAULT_CATALOG_TTL_MS = 10 * 60_000;
export const DEFAULT_CATALOG_FETCH_TIMEOUT_MS = 3_000;
const FAILURE_RETRY_MS = 60_000;

function perMillion(value) {
  const perToken = Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  return Math.round(perToken * 1_000_000 * 1_000_000) / 1_000_000;
}

function describeModel(id, upstream) {
  if (!upstream) return { id, name: id, contextLength: null, pricing: null };
  return {
    id,
    name: typeof upstream.name === "string" && upstream.name ? upstream.name.slice(0, 160) : id,
    contextLength: Number.isFinite(upstream.context_length) ? upstream.context_length : null,
    pricing: upstream.pricing
      ? {
        inputUsdPerMillionTokens: perMillion(upstream.pricing.prompt),
        outputUsdPerMillionTokens: perMillion(upstream.pricing.completion),
      }
      : null,
  };
}

/**
 * Serve the allowlisted model catalog. OpenRouter's public model list only
 * enriches the allowlist (names, prices, availability); it never adds models.
 * A failed or slow lookup returns the allowlist with `availability: "unknown"`
 * so the picker never blocks on the provider.
 */
export function createModelCatalog({
  provider = "openrouter",
  allowedModels = [],
  defaultModel,
  fetchImpl = globalThis.fetch,
  modelsUrl = OPENROUTER_MODELS_URL,
  ttlMs = DEFAULT_CATALOG_TTL_MS,
  fetchTimeoutMs = DEFAULT_CATALOG_FETCH_TIMEOUT_MS,
  now = () => Date.now(),
  onRefresh,
  log,
} = {}) {
  const enabled = provider === "openrouter";
  const allowlist = enabled ? [...new Set(allowedModels)] : [];
  const allowed = new Set(allowlist);
  if (enabled && (!defaultModel || !allowed.has(defaultModel))) {
    throw new TypeError("defaultModel must be in allowedModels");
  }

  let cache = null; // { upstream: Map<id, model>, fetchedAt }
  let lastFailureAt = null;
  let inFlight = null;

  async function fetchUpstream() {
    const response = await fetchImpl(modelsUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!response.ok) throw new Error(`OpenRouter model list HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error("OpenRouter model list has no data array");
    const upstream = new Map();
    for (const model of body.data) {
      if (typeof model?.id === "string" && allowed.has(model.id)) upstream.set(model.id, model);
    }
    return upstream;
  }

  // `onRefresh` sees each fresh snapshot (the server checks configured
  // prices against catalog prices). A failing observer never breaks the catalog.
  function notifyRefresh() {
    if (typeof onRefresh !== "function") return;
    try {
      onRefresh(snapshot().models);
    } catch (error) {
      log?.warn?.("Model catalog refresh observer failed: %s", error?.message || "unknown error");
    }
  }

  function refresh() {
    if (!inFlight) {
      inFlight = fetchUpstream()
        .then((upstream) => {
          cache = { upstream, fetchedAt: now() };
          lastFailureAt = null;
          notifyRefresh();
        })
        .catch((error) => {
          lastFailureAt = now();
          log?.warn?.("Model catalog refresh failed: %s", error?.message || "unknown error");
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  function snapshot() {
    return {
      provider,
      defaultModel: enabled ? defaultModel : null,
      source: cache ? "openrouter" : "allowlist",
      fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
      models: allowlist.map((id) => {
        const upstream = cache?.upstream.get(id);
        const availability = !cache ? "unknown" : upstream ? "available" : "unavailable";
        return { ...describeModel(id, upstream), availability, isDefault: id === defaultModel };
      }),
    };
  }

  return {
    /** Synchronous allowlist check used to reject unsupported selections. */
    isAllowed(modelId) {
      return typeof modelId === "string" && allowed.has(modelId);
    },
    async getCatalog() {
      if (!enabled || !fetchImpl) return snapshot();
      const fresh = cache && now() - cache.fetchedAt < ttlMs;
      const recentlyFailed = lastFailureAt !== null && now() - lastFailureAt < FAILURE_RETRY_MS;
      if (!fresh && !recentlyFailed) {
        // Serve stale data immediately; only the first lookup waits (bounded by the timeout).
        if (cache) void refresh();
        else await refresh();
      }
      return snapshot();
    },
  };
}
