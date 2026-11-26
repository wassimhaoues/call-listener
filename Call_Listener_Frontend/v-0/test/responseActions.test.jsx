import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LiveGuidancePanel, {
  RESPONSE_ACTIONS,
  shortcutAction,
} from "../src/components/LiveGuidancePanel.jsx";
import Conversation from "../src/pages/Conversation.jsx";
import { UIProvider } from "../src/ui/UIContext.jsx";
import {
  ACTION_REJECTED_FALLBACK_TEXT,
  ACTION_REJECTION_TEXT,
  BUDGET_REACHED_TEXT,
  canRequestResponseAction,
  captureStarted,
  CONNECTION,
  connectionChanged,
  conversationReducer,
  initialConversationState,
  pauseChanged,
  responseActionSent,
  serverMessageReceived,
  STATUS,
  typedQuestionSubmitted,
} from "../src/services/conversationState.js";
import {
  encodeResponseActionMessage,
  RESPONSE_ACTION_TYPES,
} from "../src/services/interviewMessages.js";
import { FakeWebSocket, installFakeAudio } from "./helpers/fakes.js";

afterEach(cleanup);

const reduce = (actions, state = initialConversationState) =>
  actions.reduce(conversationReducer, state);
const server = (message) => serverMessageReceived(message);
const live = () => reduce([connectionChanged(CONNECTION.OPEN), captureStarted()]);
const thinking = (id, kind = "answer") => server({ generation: { id, kind, state: "thinking" } });
const done = (id, text, kind = "answer") =>
  server({ ai_reply: text, generation: { id, kind, state: "done" } });
// A live session showing the completed answer of generation g1.
const answered = () => reduce([thinking("g1"), done("g1", "Use the Redis migration.")], live());

describe("response actions in the conversation reducer", () => {
  it("makes a completed live suggestion actionable and records its kind", () => {
    const state = answered();
    expect(state).toMatchObject({ finalGenerationId: "g1", generationKind: "answer" });
    expect(canRequestResponseAction(state)).toBe(true);
  });

  it("never offers actions on the introductory or legacy reply", () => {
    const state = reduce([server({ ai_reply: "Intro." })], live());
    expect(state).toMatchObject({ finalGenerationId: null, generationKind: null });
    expect(canRequestResponseAction(state)).toBe(false);
  });

  it("waits for the server after sending, then follows the new generation's kind", () => {
    let state = reduce([responseActionSent("shorten")], answered());
    expect(state.pendingAction).toBe("shorten");
    expect(state.suggestion).toBe("Use the Redis migration.");
    expect(state.status).toBe(STATUS.THINKING);
    expect(canRequestResponseAction(state)).toBe(false);

    state = reduce([thinking("g2", "shorten")], state);
    expect(state).toMatchObject({
      pendingAction: null,
      generationKind: "shorten",
      finalGenerationId: null,
      suggestion: "",
    });
    state = reduce([
      server({ generation: { id: "g2", kind: "shorten", state: "streaming" }, delta: "Short" }),
      done("g2", "Short answer.", "shorten"),
    ], state);
    expect(state).toMatchObject({ suggestion: "Short answer.", generationKind: "shorten", finalGenerationId: "g2" });
  });

  it("ignores unknown kinds", () => {
    const state = reduce([thinking("g2", "translate")], answered());
    expect(state.generationKind).toBeNull();
  });

  it("explains rejected actions and keeps the suggestion unless it went stale", () => {
    let state = reduce([
      responseActionSent("regenerate"),
      server({ error: "action_rejected", reason: "rate_limited" }),
    ], answered());
    expect(state).toMatchObject({
      pendingAction: null,
      actionError: ACTION_REJECTION_TEXT.rate_limited,
      finalGenerationId: "g1",
    });
    expect(canRequestResponseAction(state)).toBe(true);

    state = reduce([server({ error: "action_rejected", reason: "stale_generation" })], state);
    expect(state.finalGenerationId).toBeNull();
    state = reduce([server({ error: "action_rejected", reason: { html: "<b>x</b>" } })], state);
    expect(state.actionError).toBe(ACTION_REJECTED_FALLBACK_TEXT);
    // The next generation clears the explanation.
    expect(reduce([thinking("g2")], state).actionError).toBe("");
  });

  it("disables actions while generating, paused, disconnected, failed, or after the budget", () => {
    expect(canRequestResponseAction(reduce([thinking("g2", "expand")], answered()))).toBe(false);
    expect(canRequestResponseAction(reduce([pauseChanged(true)], answered()))).toBe(false);
    expect(canRequestResponseAction(reduce([pauseChanged(true), pauseChanged(false)], answered()))).toBe(true);
    expect(canRequestResponseAction(reduce([connectionChanged(CONNECTION.RECONNECTING)], answered()))).toBe(false);
    const failed = reduce([
      thinking("g2", "regenerate"),
      server({ generation: { id: "g2", kind: "regenerate", state: "failed" }, ai_reply: "[Erreur du modèle]" }),
    ], answered());
    expect(failed.finalGenerationId).toBeNull();
    const budget = reduce([server({ error: "interview_budget_reached" })], answered());
    expect(budget.suggestion).toBe(BUDGET_REACHED_TEXT);
    expect(canRequestResponseAction(budget)).toBe(false);
    expect(canRequestResponseAction(reduce([typedQuestionSubmitted("Why?")], answered()))).toBe(false);
  });

  it("stops waiting on a reconnect and forgets old IDs when the session is replaced", () => {
    let state = reduce([server({ session: { id: "s1" } }), thinking("g1"), done("g1", "A.")], live());
    state = reduce([responseActionSent("clarify"), connectionChanged(CONNECTION.RECONNECTING)], state);
    expect(state.pendingAction).toBeNull();
    state = reduce([connectionChanged(CONNECTION.OPEN)], state);
    expect(state.finalGenerationId).toBe("g1");
    state = reduce([server({ session: { id: "s2" } })], state);
    expect(state.finalGenerationId).toBeNull();
    const lost = reduce([connectionChanged(CONNECTION.LOST)], answered());
    expect(lost.finalGenerationId).toBeNull();
  });
});

describe("response action encoding", () => {
  it("encodes the documented command shape", () => {
    expect(RESPONSE_ACTION_TYPES).toEqual(["regenerate", "shorten", "expand", "clarify"]);
    expect(JSON.parse(encodeResponseActionMessage("expand", "g4"))).toEqual({
      action: { type: "expand", generationId: "g4" },
    });
  });
});

describe("LiveGuidancePanel response actions", () => {
  function renderPanel(props = {}) {
    const onResponseAction = vi.fn();
    const utils = render(
      <LiveGuidancePanel
        question="Why Redis?"
        suggestion="Use the Redis migration."
        generationKind="answer"
        actionsEnabled
        onResponseAction={onResponseAction}
        {...props}
      />
    );
    return { onResponseAction, ...utils };
  }

  it("shows the four actions with their shortcuts and sends the clicked one", () => {
    const { onResponseAction } = renderPanel();
    const labels = RESPONSE_ACTIONS.map((action) => action.label);
    expect(labels).toEqual(["Regenerate", "Shorter", "More detail", "Clarify"]);
    for (const action of RESPONSE_ACTIONS) {
      const button = screen.getByRole("button", { name: action.label });
      expect(button).toHaveAttribute("aria-keyshortcuts", action.shortcut);
      expect(button).toBeEnabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "More detail" }));
    expect(onResponseAction).toHaveBeenCalledWith("expand");
    expect(screen.getByText(/not while typing/)).toBeInTheDocument();
  });

  it("disables every action when actions are unavailable", () => {
    const { onResponseAction } = renderPanel({ actionsEnabled: false });
    for (const action of RESPONSE_ACTIONS) {
      expect(screen.getByRole("button", { name: action.label })).toBeDisabled();
    }
    fireEvent.keyDown(window, { code: "KeyR", key: "r", altKey: true });
    expect(onResponseAction).not.toHaveBeenCalled();
  });

  it("names the kind of the shown suggestion", () => {
    const { rerender } = renderPanel({ generationKind: "shorten" });
    expect(screen.getByText("Shorter answer")).toBeInTheDocument();
    rerender(<LiveGuidancePanel question="" suggestion="Ask about scope." generationKind="clarify" />);
    expect(screen.getByText("Clarifying questions to ask")).toBeInTheDocument();
    rerender(<LiveGuidancePanel question="" suggestion="x" generationKind="toString" />);
    expect(screen.queryByText("Answer")).toBeNull();
  });

  it("shows a rejection as plain text", () => {
    renderPanel({ actionError: "<img src=x onerror=alert(1)>" });
    expect(screen.getByRole("status")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("maps Alt+R/S/E/C to the actions, by physical key", () => {
    const { onResponseAction } = renderPanel();
    fireEvent.keyDown(window, { code: "KeyR", key: "®", altKey: true });
    fireEvent.keyDown(window, { code: "KeyS", key: "s", altKey: true });
    fireEvent.keyDown(window, { code: "KeyE", key: "e", altKey: true });
    fireEvent.keyDown(window, { code: "KeyC", key: "c", altKey: true });
    expect(onResponseAction.mock.calls).toEqual([["regenerate"], ["shorten"], ["expand"], ["clarify"]]);
  });

  it("ignores shortcuts while typing, with other modifiers, and on key repeat", () => {
    const { onResponseAction } = renderPanel({ onSubmitTypedQuestion: vi.fn() });
    const input = screen.getByLabelText("Interviewer question");
    fireEvent.keyDown(input, { code: "KeyR", key: "r", altKey: true });
    fireEvent.keyDown(window, { code: "KeyR", key: "r" });
    fireEvent.keyDown(window, { code: "KeyR", key: "r", altKey: true, ctrlKey: true });
    fireEvent.keyDown(window, { code: "KeyS", key: "S", altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { code: "KeyR", key: "r", altKey: true, repeat: true });
    fireEvent.keyDown(window, { code: "KeyX", key: "x", altKey: true });
    expect(onResponseAction).not.toHaveBeenCalled();
    expect(shortcutAction({ altKey: true, code: "KeyE", target: { isContentEditable: true } })).toBeNull();
    expect(shortcutAction({ altKey: true, code: "KeyE", target: document.body })?.type).toBe("expand");
  });

  it("hides the actions when no handler is given", () => {
    render(<LiveGuidancePanel question="" suggestion="Answer." />);
    expect(screen.queryByRole("group", { name: "Response actions" })).toBeNull();
  });
});

describe("Conversation response actions", () => {
  let audio;

  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    audio = installFakeAudio();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    window.callApi = { getWsUrl: vi.fn(async () => "wss://example.test/ws") };
    localStorage.setItem("micId", "mic-1");
    localStorage.setItem("systemAudioEnabled", "false");
    localStorage.setItem("callContext", JSON.stringify({ version: 1 }));
  });

  afterEach(() => {
    cleanup();
    audio.restore();
    delete window.callApi;
    localStorage.clear();
  });

  async function renderConversation() {
    render(
      <MemoryRouter initialEntries={["/conversation"]}>
        <UIProvider>
          <Routes>
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

  const actionMessages = (ws) => ws.sentMessages.filter((message) => message.action);

  it("sends the action for the current final suggestion and disables controls until it runs", async () => {
    const ws = await renderConversation();
    const shorter = () => screen.getByRole("button", { name: "Shorter" });
    expect(shorter()).toBeDisabled();

    act(() => {
      ws.serverSend({ speaker: "caller", transcript: "Why Redis?" });
      ws.serverSend({ generation: { id: "g1", kind: "answer", state: "thinking" } });
    });
    expect(shorter()).toBeDisabled();
    act(() => ws.serverSend({ ai_reply: "Use the migration.", generation: { id: "g1", kind: "answer", state: "done" } }));
    expect(shorter()).toBeEnabled();

    fireEvent.click(shorter());
    expect(actionMessages(ws)).toEqual([{ action: { type: "shorten", generationId: "g1" } }]);
    expect(shorter()).toBeDisabled();
    // A second request while the first is pending is not sent.
    fireEvent.keyDown(window, { code: "KeyE", altKey: true });
    expect(actionMessages(ws)).toHaveLength(1);

    act(() => {
      ws.serverSend({ generation: { id: "g2", kind: "shorten", state: "thinking" } });
      ws.serverSend({ ai_reply: "Short.", generation: { id: "g2", kind: "shorten", state: "done" } });
    });
    expect(screen.getByText("Shorter answer")).toBeInTheDocument();
    fireEvent.keyDown(window, { code: "KeyC", altKey: true });
    expect(actionMessages(ws).at(-1)).toEqual({ action: { type: "clarify", generationId: "g2" } });
  });
});
