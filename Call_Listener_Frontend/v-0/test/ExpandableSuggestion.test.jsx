import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import LiveGuidancePanel from "../src/components/LiveGuidancePanel.jsx";

afterEach(cleanup);

const LONG_SUGGESTION = [
  "Situation: a legacy billing database.",
  "Task: migrate it without downtime.",
  "Action: staged dual writes.",
  "Result: zero data loss.",
].join("\n");

it("collapses a long suggestion behind a keyboard-accessible Show more toggle", () => {
  const { rerender } = render(<LiveGuidancePanel question="Q" suggestion={LONG_SUGGESTION} />);
  expect(screen.getByText("Situation: a legacy billing database.")).toBeInTheDocument();
  expect(screen.getByText("Action: staged dual writes.")).toBeInTheDocument();
  expect(screen.queryByText("Result: zero data loss.")).toBeNull();

  const toggle = screen.getByRole("button", { name: "Show more" });
  expect(toggle).toHaveAttribute("type", "button");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(document.getElementById(toggle.getAttribute("aria-controls"))).not.toBeNull();
  toggle.focus();
  expect(toggle).toHaveFocus();
  fireEvent.click(toggle);
  expect(screen.getByText("Result: zero data loss.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");

  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(screen.queryByText("Result: zero data loss.")).toBeNull();

  // A new suggestion starts collapsed again.
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  rerender(<LiveGuidancePanel question="Q" suggestion={`${LONG_SUGGESTION}\nFollow-up: rehearse it.`} />);
  expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Follow-up: rehearse it.")).toBeNull();
});

it("shows short and still-streaming suggestions in full without a toggle", () => {
  const { rerender } = render(<LiveGuidancePanel question="Q" suggestion="Use the migration example." />);
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  rerender(<LiveGuidancePanel isStreaming question="Q" suggestion={LONG_SUGGESTION} />);
  expect(screen.getByText("Result: zero data loss.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

it("renders collapsed suggestions as plain text and keeps Alt shortcuts working", () => {
  const onResponseAction = vi.fn();
  const { container } = render(
    <LiveGuidancePanel
      actionsEnabled
      generationKind="expand"
      onResponseAction={onResponseAction}
      question="Q"
      suggestion={`<img src=x onerror=alert(1)> One. Two. Three. Four.\n${LONG_SUGGESTION}`}
    />
  );
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("<img src=x onerror=alert(1)> One. Two. Three.")).toBeInTheDocument();
  expect(screen.queryByText(/Four\./)).toBeNull();
  expect(screen.getByText("Detailed answer (STAR)")).toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Show more" });
  toggle.focus();
  fireEvent.keyDown(toggle, { code: "KeyE", key: "e", altKey: true });
  expect(onResponseAction).toHaveBeenCalledWith("expand");
  fireEvent.keyDown(toggle, { code: "KeyS", key: "s", altKey: true });
  expect(onResponseAction).toHaveBeenLastCalledWith("shorten");
});
