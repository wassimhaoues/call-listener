import { describe, expect, it } from "vitest";
import { PREVIEW_MAX_SENTENCES, suggestionPreview } from "../src/services/suggestionPreview.js";

describe("suggestionPreview", () => {
  it("returns null for short suggestions", () => {
    expect(PREVIEW_MAX_SENTENCES).toBe(3);
    expect(suggestionPreview("")).toBeNull();
    expect(suggestionPreview(undefined)).toBeNull();
    expect(suggestionPreview("One. Two. Three.")).toBeNull();
    expect(suggestionPreview("Situation: billing.\nAction: dual writes.\nResult: no data loss.")).toBeNull();
  });

  it("keeps the first three sentences of a long paragraph", () => {
    expect(suggestionPreview("One. Two! Three? Four. Five.")).toBe("One. Two! Three?");
    expect(suggestionPreview('He said "go." Then we shipped. It worked. Done.')).toBe(
      'He said "go." Then we shipped. It worked.'
    );
  });

  it("keeps outline line breaks and cuts at the third sentence", () => {
    const star = [
      "Situation: a legacy billing database.",
      "Task: migrate it without downtime. It had ten years of data.",
      "Action: staged dual writes.",
      "Result: zero data loss.",
    ].join("\n");
    expect(suggestionPreview(star)).toBe(
      "Situation: a legacy billing database.\nTask: migrate it without downtime. It had ten years of data."
    );
    expect(suggestionPreview("- one\n- two\n- three\n- four")).toBe("- one\n- two\n- three");
  });
});
