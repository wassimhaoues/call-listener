import React from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Conversation from "../src/pages/Conversation.jsx";
import { UIProvider, useUI } from "../src/ui/UIContext.jsx";
import { useInterviewSocket } from "../src/hooks/useInterviewSocket.js";
import { NOT_SAVED_TEXT, PREPARING_TEXT } from "../src/components/DebriefPanel.jsx";
import { FakeWebSocket, installFakeAudio } from "./helpers/fakes.js";

let audio;

const REVIEW = {
  questionsCovered: [
    {
      question: "Tell me about a migration you led.",
      candidateAnswerSummary: "You described the <b>billing</b> move.",
      evidenceUsed: ["evidence-1"],
    },
  ],
  strengths: ["Concrete example."],
  improvementTopics: [{ topic: "Results", why: "No outcome mentioned.", practiceSuggestion: "End with a number." }],
  followUpDraft: "Thank you for the conversation.",
};

function readBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function Actions() {
  return <div data-testid="actions">{useUI().actions}</div>;
}

async function renderConversation() {
  render(
    <MemoryRouter initialEntries={["/conversation"]}>
      <UIProvider>
        <Actions />
        <Routes>
          <Route path="/" element={<p>Setup page</p>} />
          <Route path="/conversation" element={<Conversation />} />
        </Routes>
      </UIProvider>
    </MemoryRouter>
  );
  await act(async () => {});
  const ws = FakeWebSocket.latest();
  act(() => ws.serverOpen());
  return ws;
}

// Click "Stop and review" and deliver the worklet's final batch.
async function stopAndReview() {
  const ws = await renderConversation();
  const [micNode] = audio.workletNodes;
  fireEvent.click(screen.getByRole("button", { name: "Stop and review" }));
  expect(micNode.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
  await act(async () => {
    micNode.port.onmessage({ data: { type: "chunk", source: "mic", buffer: new Int16Array([5]).buffer } });
    micNode.port.onmessage({ data: { type: "flushed" } });
  });
  return ws;
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  audio = installFakeAudio();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  window.callApi = { getWsUrl: vi.fn(async () => "wss://example.test/ws") };
  localStorage.setItem("micId", "mic-1");
  localStorage.setItem("systemAudioEnabled", "false");
  localStorage.setItem(
    "callContext",
    JSON.stringify({ version: 1, candidate: { name: "Ada" }, jobOffer: { title: "Engineer" }, evidence: [{ requirement: "Database migrations", evidence: "Led a billing migration" }] })
  );
});

afterEach(() => {
  cleanup();
  audio.restore();
  vi.unstubAllGlobals();
  delete window.callApi;
  localStorage.clear();
});

describe("Stop and review", () => {
  it("is a keyboard-reachable button next to Stop", async () => {
    await renderConversation();
    const actions = screen.getByTestId("actions");
    const buttons = [...actions.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Pause", "Stop and review", "Stop"]);
    const review = screen.getByRole("button", { name: "Stop and review" });
    review.focus();
    expect(document.activeElement).toBe(review);
  });

  it("flushes audio, sends the debrief end, waits, and renders the review as plain text", async () => {
    const ws = await stopAndReview();
    const messages = ws.sentMessages;
    expect(messages.at(-2)).toEqual({ source: "mic", chunk: Buffer.from(new Int16Array([5]).buffer).toString("base64") });
    expect(messages.at(-1)).toEqual({ end: { debrief: true } });
    expect(messages.filter((message) => message.end)).toHaveLength(1);
    expect(ws.closeCalls).toBe(0);
    expect(audio.contexts[0].close).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(PREPARING_TEXT);
    expect(screen.getByText(NOT_SAVED_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    // Late live messages are ignored; only the debrief answer matters.
    await act(async () => ws.serverSend({ speaker: "you", transcript: "late" }));
    expect(screen.getByRole("status")).toHaveTextContent(PREPARING_TEXT);
    await act(async () => ws.serverSend({ debrief: { status: "ready", review: REVIEW }, seq: 9 }));

    expect(ws.closeCalls).toBe(1);
    expect(screen.getByText("Tell me about a migration you led.")).toBeInTheDocument();
    expect(screen.getByText("What you said: You described the <b>billing</b> move.")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("Evidence used: Database migrations")).toBeInTheDocument();
    expect(screen.getByText("Concrete example.")).toBeInTheDocument();
    expect(screen.getByText("Results")).toBeInTheDocument();
    expect(screen.getByText("Practice: End with a number.")).toBeInTheDocument();
    const draft = screen.getByLabelText("Follow-up draft");
    expect(draft).toHaveValue("Thank you for the conversation.");
    fireEvent.change(draft, { target: { value: "Thanks, Sam." } });
    expect(draft).toHaveValue("Thanks, Sam.");
    // The edited draft is never sent anywhere.
    expect(ws.sent).toHaveLength(messages.length);
  });

  it("exports the edited review as a Markdown download without storing it", async () => {
    // jsdom has no object URLs; install doubles for this test only.
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    const createObjectURL = vi.fn(() => "blob:review");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const ws = await stopAndReview();
    await act(async () => ws.serverSend({ debrief: { status: "ready", review: REVIEW } }));
    fireEvent.change(screen.getByLabelText("Follow-up draft"), { target: { value: "Edited draft." } });
    const storedBefore = { ...localStorage };

    fireEvent.click(screen.getByRole("button", { name: "Export as Markdown" }));

    expect(click).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    const markdown = await readBlob(blob);
    expect(markdown).toContain("# Interview review");
    expect(markdown).toContain("~~~text\nEdited draft.\n~~~");
    expect(markdown).toContain("Evidence used: Database migrations");
    expect(markdown).toContain("\\<b\\>billing\\</b\\>");
    expect({ ...localStorage }).toEqual(storedBefore);
    expect(screen.getByText(/Export started/)).toBeInTheDocument();
    click.mockRestore();
  });

  it("discard forgets the review and returns to setup", async () => {
    const ws = await stopAndReview();
    await act(async () => ws.serverSend({ debrief: { status: "ready", review: REVIEW } }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText("Setup page")).toBeInTheDocument();
    expect(screen.queryByText("Tell me about a migration you led.")).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain("migration you led");
  });

  it.each([
    [{ status: "skipped", reason: "budget_reached" }, /budget is spent/],
    [{ status: "skipped", reason: "empty_transcript" }, /Nothing was transcribed/],
    [{ status: "failed", reason: "generation_failed" }, /could not be generated/],
  ])("explains a %j debrief", async (debrief, text) => {
    const ws = await stopAndReview();
    await act(async () => ws.serverSend({ debrief }));
    expect(screen.getByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByRole("button", { name: "Export as Markdown" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to setup" }));
    expect(screen.getByText("Setup page")).toBeInTheDocument();
  });

  it("reports a socket closed before the review arrived", async () => {
    const ws = await stopAndReview();
    await act(async () => ws.serverClose());
    expect(screen.getByRole("alert")).toHaveTextContent(/connection closed before the review was ready/);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("cancel while preparing closes the socket and returns to setup", async () => {
    const ws = await stopAndReview();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ws.closeCalls).toBe(1);
    expect(screen.getByText("Setup page")).toBeInTheDocument();
  });
});

describe("useInterviewSocket endWithReview", () => {
  async function openHook() {
    const hook = renderHook(() =>
      useInterviewSocket({ dispatch: vi.fn(), getWsUrl: async () => "wss://example.test/ws" })
    );
    await act(() => hook.result.current.connect());
    const ws = FakeWebSocket.latest();
    act(() => ws.serverOpen());
    return { ...hook, ws };
  }

  it("gives up after the wait bound with no_response", async () => {
    vi.useFakeTimers();
    try {
      const { result, ws } = await openHook();
      const pending = result.current.endWithReview({ timeoutMs: 1_000 });
      expect(ws.sentMessages).toEqual([{ end: { debrief: true } }]);
      vi.advanceTimersByTime(1_000);
      await expect(pending).resolves.toEqual({ status: "failed", reason: "no_response" });
      expect(ws.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves disconnected when there is no open socket", async () => {
    const hook = renderHook(() => useInterviewSocket({ dispatch: vi.fn(), getWsUrl: async () => "wss://x" }));
    await expect(hook.result.current.endWithReview()).resolves.toEqual({ status: "failed", reason: "disconnected" });
  });

  it("is cancelled by unmount, closing the socket", async () => {
    const { result, ws, unmount } = await openHook();
    const pending = result.current.endWithReview();
    unmount();
    await expect(pending).resolves.toEqual({ status: "failed", reason: "cancelled" });
    expect(ws.closeCalls).toBe(1);
    expect(ws.sentMessages).toEqual([{ end: { debrief: true } }]);
  });

  it("never reconnects after the review socket closes", async () => {
    const { result, ws } = await openHook();
    act(() => ws.serverSend({ session: { id: "abc" } }));
    const pending = result.current.endWithReview();
    ws.serverClose();
    await expect(pending).resolves.toEqual({ status: "failed", reason: "disconnected" });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
