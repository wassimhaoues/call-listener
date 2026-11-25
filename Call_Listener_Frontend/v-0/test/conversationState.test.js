import { describe, expect, it } from "vitest";
import {
  audioChunkDropped,
  BUDGET_REACHED_TEXT,
  conversationReducer,
  GUIDANCE_UNAVAILABLE_TEXT,
  initialConversationState,
  pauseChanged,
  serverMessageReceived,
  STATUS,
  statusChanged,
  typedQuestionSubmitted,
} from "../src/services/conversationState.js";

const reduce = (actions, state = initialConversationState) =>
  actions.reduce(conversationReducer, state);
const server = (message) => serverMessageReceived(message);

describe("conversationReducer", () => {
  it("starts connecting with an empty transcript and no guidance", () => {
    expect(initialConversationState).toMatchObject({
      status: "Connecting…",
      transcript: [],
      currentQuestion: "",
      suggestion: "",
      isThinking: false,
      isPaused: false,
      droppedAudioChunks: 0,
    });
  });

  it("appends candidate and interviewer transcripts in arrival order", () => {
    const state = reduce([
      server({ speaker: "caller", transcript: "Tell me about Redis." }),
      server({ speaker: "you", transcript: "I migrated a cluster." }),
    ]);
    expect(state.transcript).toEqual([
      { id: 1, role: "interviewer", text: "Tell me about Redis." },
      { id: 2, role: "candidate", text: "I migrated a cluster." },
    ]);
    expect(state.currentQuestion).toBe("Tell me about Redis.");
  });

  it("shows the latest interviewer utterance as the current question", () => {
    const state = reduce([
      server({ speaker: "caller", transcript: "First question?" }),
      server({ speaker: "you", transcript: "An answer." }),
      server({ speaker: "caller", transcript: "Second question?" }),
    ]);
    expect(state.currentQuestion).toBe("Second question?");
  });

  it("renders missing transcript text as empty text", () => {
    const state = reduce([server({ speaker: "you" })]);
    expect(state.transcript[0].text).toBe("");
  });

  it("hides stale guidance while the backend generates for a newer question", () => {
    const state = reduce([
      server({ ai_reply: "Old guidance" }),
      server({ speaker: "caller", transcript: "New question?" }),
      server({ generation: { state: "thinking" } }),
    ]);
    expect(state).toMatchObject({
      suggestion: "",
      isThinking: true,
      status: STATUS.THINKING,
      currentQuestion: "New question?",
    });
  });

  it("shows a reply and returns to listening", () => {
    const state = reduce([
      server({ generation: { state: "thinking" } }),
      server({ ai_reply: "Use the migration example." }),
    ]);
    expect(state).toMatchObject({
      suggestion: "Use the migration example.",
      isThinking: false,
      status: STATUS.LISTENING,
    });
  });

  it("ignores non-string or empty replies without leaving thinking", () => {
    const thinking = reduce([server({ generation: { state: "thinking" } })]);
    expect(conversationReducer(thinking, server({ ai_reply: "" }))).toBe(thinking);
    expect(
      conversationReducer(thinking, server({ ai_reply: { html: "<b>x</b>" } }))
    ).toMatchObject({ suggestion: "", isThinking: false });
  });

  it("treats a failed generation as terminal and prefers it over a reply", () => {
    const state = reduce([
      server({ generation: { state: "thinking" } }),
      server({ generation: { state: "failed" }, ai_reply: "ignored" }),
    ]);
    expect(state).toMatchObject({
      suggestion: GUIDANCE_UNAVAILABLE_TEXT,
      isThinking: false,
      status: STATUS.GUIDANCE_UNAVAILABLE,
    });
  });

  it("stops guidance when the interview budget is reached", () => {
    const state = reduce([
      server({ generation: { state: "thinking" } }),
      server({ error: "interview_budget_reached" }),
    ]);
    expect(state).toMatchObject({
      suggestion: BUDGET_REACHED_TEXT,
      isThinking: false,
      status: STATUS.BUDGET_REACHED,
    });
  });

  it("ignores other errors and non-object messages", () => {
    const state = reduce([server({ ai_reply: "Keep me" })]);
    expect(conversationReducer(state, server({ error: "Invalid message" }))).toBe(state);
    expect(conversationReducer(state, server(null))).toBe(state);
    expect(conversationReducer(state, server("text"))).toBe(state);
    expect(conversationReducer(state, { type: "unknown" })).toBe(state);
  });

  it("applies the fields of one combined message in handler order", () => {
    const state = reduce([
      server({
        speaker: "caller",
        transcript: "Why us?",
        ai_reply: "Old",
        generation: { state: "thinking" },
      }),
    ]);
    expect(state).toMatchObject({
      currentQuestion: "Why us?",
      suggestion: "",
      isThinking: true,
      status: STATUS.THINKING,
    });
  });

  it("marks a typed question as current and pending", () => {
    const state = reduce([
      server({ ai_reply: "Old guidance" }),
      typedQuestionSubmitted("How did you lead the migration?"),
    ]);
    expect(state).toMatchObject({
      currentQuestion: "How did you lead the migration?",
      suggestion: "",
      isThinking: true,
      status: STATUS.THINKING,
    });
    expect(state.transcript).toEqual([]);
  });

  it("tracks pause and resume status", () => {
    const paused = reduce([pauseChanged(true)]);
    expect(paused).toMatchObject({ isPaused: true, status: STATUS.PAUSED });
    expect(conversationReducer(paused, pauseChanged(false))).toMatchObject({
      isPaused: false,
      status: STATUS.LISTENING,
    });
  });

  it("counts dropped audio and reports congestion on the 1st and every 25th drop", () => {
    let state = reduce([statusChanged(STATUS.LISTENING), audioChunkDropped()]);
    expect(state).toMatchObject({ droppedAudioChunks: 1, status: STATUS.SLOW_CONNECTION });

    state = conversationReducer(state, statusChanged(STATUS.LISTENING));
    for (let i = 0; i < 23; i++) state = conversationReducer(state, audioChunkDropped());
    expect(state).toMatchObject({ droppedAudioChunks: 24, status: STATUS.LISTENING });

    state = conversationReducer(state, audioChunkDropped());
    expect(state).toMatchObject({ droppedAudioChunks: 25, status: STATUS.SLOW_CONNECTION });
  });

  it("does not mutate the previous state", () => {
    const before = reduce([server({ speaker: "you", transcript: "Hi" })]);
    const snapshot = JSON.parse(JSON.stringify(before));
    conversationReducer(before, server({ speaker: "caller", transcript: "Q?" }));
    expect(before).toEqual(snapshot);
  });
});
