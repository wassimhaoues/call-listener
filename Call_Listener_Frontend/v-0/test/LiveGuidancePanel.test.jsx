import React from "react";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import LiveGuidancePanel from "../src/components/LiveGuidancePanel.jsx";

it("shows the current question, safe suggestion text, and candidate evidence", () => {
  render(
    <LiveGuidancePanel
      question="How did you handle the Redis migration?"
      suggestion={'<img src=x onerror=alert(1)>\nUse the migration example.'}
      evidence={[{ requirement: "Redis experience", evidence: "Led a Redis migration" }]}
    />
  );
  expect(screen.getByText("How did you handle the Redis migration?")).toBeInTheDocument();
  expect(screen.getByText("Use the migration example.")).toBeInTheDocument();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("Led a Redis migration")).toBeInTheDocument();
});

it("submits a typed interviewer question only when the fallback is enabled", () => {
  const onSubmitTypedQuestion = vi.fn();
  render(
    <LiveGuidancePanel
      onSubmitTypedQuestion={onSubmitTypedQuestion}
      question=""
      suggestion=""
    />
  );

  fireEvent.change(screen.getByLabelText("Interviewer question"), {
    target: { value: " How did you lead the migration? " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));

  expect(onSubmitTypedQuestion).toHaveBeenCalledWith("How did you lead the migration?");
  expect(screen.getByLabelText("Interviewer question")).toHaveValue("");
});

it("does not present stale guidance while a newer answer is being prepared", () => {
  render(
    <LiveGuidancePanel
      isThinking
      question="How did you lead the migration?"
      suggestion="This is an older suggestion."
    />
  );

  expect(screen.getByRole("status")).toHaveTextContent(
    "Preparing guidance for this question…"
  );
  expect(screen.queryByText("This is an older suggestion.")).toBeNull();
});

it("shows the model subtly, and both names when the provider served another", () => {
  const { rerender } = render(
    <LiveGuidancePanel question="" suggestion="Answer." model={{ selected: "a/one", actual: "a/one" }} />
  );
  expect(screen.getByText("Model: a/one")).toBeInTheDocument();
  rerender(
    <LiveGuidancePanel question="" suggestion="Answer." model={{ selected: "a/one", actual: "b/two" }} />
  );
  expect(screen.getByText("Model: b/two (requested a/one)")).toBeInTheDocument();
  rerender(<LiveGuidancePanel question="" suggestion="Answer." model={null} />);
  expect(screen.queryByText(/^Model:/)).toBeNull();
});

it("shows streamed partial guidance as plain text while it is still being written", () => {
  const { container, rerender } = render(
    <LiveGuidancePanel
      isStreaming
      question="How did you lead the migration?"
      suggestion={'<b onclick="x()">Partial</b>\nLead with the migr'}
      model={{ selected: "a/one", actual: null }}
    />
  );
  // Earlier tests' renders stay mounted (no auto-cleanup), so scope queries.
  const view = within(container);
  expect(view.getByText("Lead with the migr")).toBeInTheDocument();
  expect(view.getByText('<b onclick="x()">Partial</b>')).toBeInTheDocument();
  expect(container.querySelector("b")).toBeNull();
  expect(view.getByRole("status")).toHaveTextContent("Still writing…");
  expect(view.queryByText(/^Model:/)).toBeNull();

  rerender(
    <LiveGuidancePanel
      question="How did you lead the migration?"
      suggestion="Lead with the migration."
      model={{ selected: "a/one", actual: null }}
    />
  );
  expect(view.getByText("Lead with the migration.")).toBeInTheDocument();
  expect(view.queryByText("Still writing…")).toBeNull();
  expect(view.getByText("Model: a/one")).toBeInTheDocument();
});

it("renders session alerts as text", () => {
  render(<LiveGuidancePanel question="" suggestion="" alerts={["<b>Blocked</b>"]} />);
  expect(screen.getByRole("alert")).toHaveTextContent("<b>Blocked</b>");
});
