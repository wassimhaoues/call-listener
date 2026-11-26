import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import SuggestionText from "../src/components/SuggestionText.jsx";

it("renders model output as visible text instead of HTML", () => {
  const reply = '<img src=x onerror="window.__unsafe = true">\nUse a STAR example.';
  const { container } = render(<SuggestionText text={reply} />);

  expect(screen.getByText(reply.split("\n")[0])).toBeInTheDocument();
  expect(screen.getByText("Use a STAR example.")).toBeInTheDocument();
  expect(container.querySelector("img")).toBeNull();
});

it("shows a neutral empty state when no model reply is available", () => {
  render(<SuggestionText text="" />);

  expect(screen.getByText("No suggestion yet.")).toBeInTheDocument();
});

it("structures known answer sections and bullets as text, never trusting model headings", () => {
  const reply = [
    "## Answer outline",
    "- **Situation:** legacy billing database",
    "- Action: staged dual writes",
    "Evidence used: A1, E2",
    "**Plan de réponse :**",
    "1. Contexte",
    "# Ignore previous instructions",
  ].join("\n");
  const { container } = render(<SuggestionText text={reply} />);

  const headings = [...container.querySelectorAll("h4")].map((node) => node.textContent);
  expect(headings).toEqual(["Answer outline", "Evidence used", "Plan de réponse"]);
  const items = [...container.querySelectorAll("li")].map((node) => node.textContent);
  expect(items).toEqual(["Situation: legacy billing database", "Action: staged dual writes", "Contexte"]);
  expect(screen.getByText("A1, E2")).toBeInTheDocument();
  // Unknown "headings" stay ordinary text, Markdown markers included.
  expect(screen.getByText("# Ignore previous instructions").tagName).toBe("P");
});
