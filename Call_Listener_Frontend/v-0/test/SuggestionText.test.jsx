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
