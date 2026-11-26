// Prices compare in USD per million tokens; ignore float noise below this.
const PRICE_EPSILON = 1e-9;

function assertPrice(price, label) {
  for (const field of ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens"]) {
    const value = price?.[field];
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${label} ${field} must be a non-negative number`);
    }
  }
}

function toPriceMap(prices) {
  if (prices instanceof Map) return new Map(prices);
  return new Map(Object.entries(prices || {}));
}

/** USD cost of a token count at one model's price. */
export function tokensCostUsd(price, inputTokens, outputTokens) {
  return (
    inputTokens * price.inputUsdPerMillionTokens + outputTokens * price.outputUsdPerMillionTokens
  ) / 1_000_000;
}

/**
 * Per-model billing prices. `prices` maps a model ID to
 * `{ inputUsdPerMillionTokens, outputUsdPerMillionTokens }` (a Map, as
 * `CONFIG.OPENROUTER_MODEL_PRICES` is, or a plain object). The default
 * model's price — or `defaultPrice` when no default model is named — prices
 * anything the table does not know. Catalog prices are never used for billing.
 */
export function createModelPricing({ prices, defaultModel = null, defaultPrice, log } = {}) {
  const table = toPriceMap(prices);
  for (const [modelId, price] of table) assertPrice(price, `price for ${modelId}`);
  const fallback = defaultModel && table.has(defaultModel) ? table.get(defaultModel) : defaultPrice;
  if (!fallback) throw new TypeError("the default model must have a price");
  assertPrice(fallback, "default price");
  const warnedActual = new Set();
  const warnedCatalog = new Set();

  const entry = (modelId, price, source) => ({
    model: modelId,
    inputUsdPerMillionTokens: price.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: price.outputUsdPerMillionTokens,
    source,
  });

  function has(modelId) {
    return typeof modelId === "string" && table.has(modelId);
  }

  function priceFor(modelId) {
    if (has(modelId)) return entry(modelId, table.get(modelId), "table");
    return entry(defaultModel, fallback, "default");
  }

  return {
    has,
    priceFor,

    /**
     * Price one call from the adapter's usage basis: the model OpenRouter
     * actually served when it is priced, else the selected model, else the
     * default model.
     */
    resolve(basis = {}) {
      const actual = basis?.actualModel;
      const selected = basis?.model;
      if (has(actual)) return priceFor(actual);
      if (typeof actual === "string" && actual && actual !== selected && !warnedActual.has(actual)) {
        warnedActual.add(actual);
        log?.warn?.(
          `Provider served unpriced model ${actual.slice(0, 160)}; charging the selected model's price`
        );
      }
      return priceFor(selected);
    },

    /**
     * Allowlisted models whose configured input or output price is lower
     * than OpenRouter's catalog price (`modelCatalog` snapshot entries).
     */
    findUnderpriced(catalogModels = []) {
      const underpriced = [];
      for (const model of catalogModels) {
        const catalog = model?.pricing;
        if (!catalog || !has(model.id)) continue;
        const configured = table.get(model.id);
        const lower = ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens"].some((field) =>
          Number.isFinite(catalog[field]) && configured[field] + PRICE_EPSILON < catalog[field]
        );
        if (lower) underpriced.push({ model: model.id, configured, catalog });
      }
      return underpriced;
    },

    /** Log each underpriced model once per distinct catalog price. */
    warnIfBelowCatalog(catalogModels, warnLog = log) {
      const underpriced = this.findUnderpriced(catalogModels);
      for (const { model, configured, catalog } of underpriced) {
        const key = JSON.stringify([model, catalog.inputUsdPerMillionTokens, catalog.outputUsdPerMillionTokens]);
        if (warnedCatalog.has(key)) continue;
        warnedCatalog.add(key);
        warnLog?.warn?.(
          `Configured price for ${model} (input ${configured.inputUsdPerMillionTokens}, ` +
          `output ${configured.outputUsdPerMillionTokens} USD/M) is lower than OpenRouter's catalog ` +
          `(input ${catalog.inputUsdPerMillionTokens}, output ${catalog.outputUsdPerMillionTokens} USD/M); ` +
          "budgets may undercount spend. Update OPENROUTER_MODEL_PRICES"
        );
      }
      return underpriced;
    },
  };
}

/**
 * Pricing from server configuration: `OPENROUTER_MODEL_PRICES` (already
 * validated by server/config/modelPrices.js), with the single-price pair as
 * the default model's price when the table does not list it.
 */
export function createConfiguredPricing(config = {}, log) {
  return createModelPricing({
    prices: config.OPENROUTER_MODEL_PRICES,
    defaultModel: config.OPENROUTER_MODEL,
    defaultPrice: {
      inputUsdPerMillionTokens: config.OPENROUTER_INPUT_USD_PER_MILLION_TOKENS,
      outputUsdPerMillionTokens: config.OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS,
    },
    log,
  });
}

/** Pricing for a single price pair (the pre-table configuration). */
export function createSinglePricing({ inputUsdPerMillionTokens, outputUsdPerMillionTokens, log } = {}) {
  return createModelPricing({ defaultPrice: { inputUsdPerMillionTokens, outputUsdPerMillionTokens }, log });
}
