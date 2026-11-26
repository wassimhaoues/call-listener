import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Context from "../src/pages/Context.jsx";
import { UIProvider } from "../src/ui/UIContext.jsx";
import { aiPreparationErrorMessage, preparationEvidenceIndex } from "../src/services/preparation.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.callApi;
});

const aiBrief = {
  introduction: "I'm Ada, a platform engineer. <img src=x onerror=alert(1)>",
  starExamples: [{
    requirement: "Redis experience",
    evidenceIds: ["E1", "A1"],
    situation: "A service needed a Redis migration.",
    task: "Own the migration.",
    action: "Led the migration.",
    result: "No measurable result was supplied.",
  }],
  practiceTopics: ["Redis persistence"],
  questionsToAsk: ["How is on-call organized?"],
  missingEvidence: ["Kubernetes operations"],
};

function renderContext(generatePreparationBrief) {
  window.callApi = { getModels: async () => null, generatePreparationBrief };
  render(
    <MemoryRouter>
      <UIProvider><Context /></UIProvider>
    </MemoryRouter>
  );
}

function fillBasics() {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Platform Engineer" } });
  fireEvent.change(screen.getByLabelText(/Relevant skills/), { target: { value: "Docker" } });
  fireEvent.change(screen.getByLabelText(/Achievements or examples/), { target: { value: "Led a Redis migration" } });
  fireEvent.change(screen.getByLabelText("Job requirements (editable, one per line)"), {
    target: { value: "Redis experience" },
  });
  fireEvent.change(screen.getByLabelText("Paste CV text (kept in this screen only)"), {
    target: { value: "Private CV text that must not be sent" },
  });
}

it("sends nothing until the candidate clicks Improve with AI", () => {
  const generate = vi.fn();
  renderContext(generate);
  fillBasics();
  fireEvent.click(screen.getByRole("button", { name: "Extract facts locally" }));
  expect(generate).not.toHaveBeenCalled();
});

it("shows loading, renders the AI brief as text, maps evidence IDs, and returns to the local brief", async () => {
  let resolve;
  const generate = vi.fn(() => new Promise((done) => { resolve = done; }));
  renderContext(generate);
  fillBasics();
  fireEvent.click(screen.getByRole("button", { name: "Extract facts locally" }));
  fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));

  expect(screen.getByRole("status")).toHaveTextContent("Generating your AI brief");
  expect(screen.getByRole("button", { name: "Improving with AI…" })).toBeDisabled();
  expect(generate).toHaveBeenCalledTimes(1);
  const [sent] = generate.mock.calls[0];
  expect(sent).toMatchObject({
    version: 1,
    candidate: { name: "Ada", achievements: ["Led a Redis migration"] },
    evidence: [{ requirement: "Redis experience", evidence: "Led a Redis migration" }],
  });
  expect(JSON.stringify(sent)).not.toContain("Private CV text");

  resolve({ ok: true, brief: aiBrief, model: "openai/test" });
  const panel = await screen.findByTestId("ai-brief");
  expect(panel).toHaveTextContent("<img src=x onerror=alert(1)>");
  expect(panel.querySelector("img")).toBeNull();
  expect(panel).toHaveTextContent("E1: Redis experience → Led a Redis migration");
  expect(panel).toHaveTextContent("A1: Led a Redis migration");
  expect(panel).toHaveTextContent("Kubernetes operations");
  expect(screen.queryByText("Introduction outline")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show local brief" }));
  expect(screen.queryByTestId("ai-brief")).toBeNull();
  expect(screen.getByText("Introduction outline")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show AI brief" }));
  expect(screen.getByTestId("ai-brief")).toBeInTheDocument();
});

it.each([
  ["preparation_budget_reached", /budget for this installation is used up/],
  ["preparation_unavailable", /not available on this server/],
  ["preparation_failed", /could not be generated/],
])("shows a clear %s error and keeps the local brief", async (error, message) => {
  renderContext(vi.fn(async () => ({ ok: false, error })));
  fillBasics();
  fireEvent.click(screen.getByRole("button", { name: "Extract facts locally" }));
  fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.getByText("Introduction outline")).toBeInTheDocument();
  expect(screen.queryByTestId("ai-brief")).toBeNull();
});

it("asks for the basics before sending and handles a missing bridge", async () => {
  const generate = vi.fn();
  renderContext(generate);
  fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Add your name and the job title");
  expect(generate).not.toHaveBeenCalled();

  cleanup();
  renderContext(undefined);
  fillBasics();
  fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/not available on this server/);
});

it("maps evidence IDs to approved facts in context order", () => {
  const index = preparationEvidenceIndex({
    candidate: { achievements: ["First", "Second"] },
    evidence: [{ requirement: "Req", evidence: "Second" }],
  });
  expect([...index.keys()]).toEqual(["A1", "A2", "E1"]);
  expect(index.get("E1").text).toBe("Req → Second");
  expect(preparationEvidenceIndex(null).size).toBe(0);
  expect(aiPreparationErrorMessage("unknown_code")).toMatch(/could not be generated/);
});
