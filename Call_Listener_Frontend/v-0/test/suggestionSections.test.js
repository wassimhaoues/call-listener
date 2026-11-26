import { expect, it } from "vitest";
import { suggestionBlocks } from "../src/services/suggestionSections.js";

it("recognizes heading variants in English and French", () => {
  for (const line of ["Answer outline", "**Answer outline**", "### answer outline:", "Answer outline —", "STAR detail:", "Détail STAR", "**Éléments utilisés :**"]) {
    expect(suggestionBlocks(line)[0]?.type, line).toBe("heading");
  }
});

it("keeps inline text after a heading and leaves other lines as text", () => {
  expect(suggestionBlocks("Evidence used: A1\nOutline of my week")).toEqual([
    { type: "heading", label: "Evidence used" },
    { type: "text", text: "A1" },
    { type: "text", text: "Outline of my week" },
  ]);
  expect(suggestionBlocks(42)).toEqual([]);
  expect(suggestionBlocks("snake__case stays")).toEqual([{ type: "text", text: "snake__case stays" }]);
});
