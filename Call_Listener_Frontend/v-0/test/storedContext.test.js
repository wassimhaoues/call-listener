import { describe, expect, it } from "vitest";
import { MISSING_CONTEXT_TEXT, readStoredContext, storedContextError } from "../src/services/storedContext.js";

const storageWith = (value) => ({ getItem: () => value });

describe("readStoredContext", () => {
  it("returns undefined for missing, corrupted, or non-object values", () => {
    expect(readStoredContext(storageWith(null))).toBeUndefined();
    expect(readStoredContext(storageWith("{not json"))).toBeUndefined();
    expect(readStoredContext(storageWith("[1,2]"))).toBeUndefined();
    expect(readStoredContext(storageWith("42"))).toBeUndefined();
    expect(readStoredContext({ getItem: () => { throw new Error("denied"); } })).toBeUndefined();
  });

  it("returns the stored object", () => {
    expect(readStoredContext(storageWith('{"version":1}'))).toEqual({ version: 1 });
  });
});

describe("storedContextError", () => {
  const valid = { version: 1, candidate: { name: "Ada" }, jobOffer: { title: "Engineer" } };

  it("accepts a context the Context page writes", () => {
    expect(storedContextError(valid)).toBeNull();
  });

  it("rejects missing, legacy, or incomplete contexts", () => {
    for (const context of [
      undefined,
      { me: { name: "Old" } },
      { ...valid, version: 2 },
      { ...valid, candidate: { name: "  " } },
      { ...valid, jobOffer: {} },
    ]) {
      expect(storedContextError(context)).toBe(MISSING_CONTEXT_TEXT);
    }
  });
});
