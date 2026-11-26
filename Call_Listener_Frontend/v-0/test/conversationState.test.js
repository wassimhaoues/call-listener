import { describe, expect, it } from "vitest";
import {
  audioChunkDropped,
  BUDGET_REACHED_TEXT,
  captureFailed,
  captureStarted,
  CONNECTION,
  connectionChanged,
  conversationReducer,
  GUIDANCE_UNAVAILABLE_TEXT,
  initialConversationState,
  MAX_TRANSCRIPT_ENTRIES,
  noticeShown,
  pauseChanged,
  serverMessageReceived,
  STATUS,
  typedQuestionSubmitted,
  UNSUPPORTED_MODEL_TEXT,
} from "../src/services/conversationState.js";

const reduce = (actions, state = initialConversationState) =>
  actions.reduce(conversationReducer, state);
const server = (message) => serverMessageReceived(message);
// A live session: socket open and capture running.
const live = () => reduce([connectionChanged(CONNECTION.OPEN), captureStarted()]);

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
    ], live());
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
    ], live());
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
    ], live());
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
    ], live());
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
    ], live());
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
    ], live());
    expect(state).toMatchObject({
      currentQuestion: "How did you lead the migration?",
      suggestion: "",
      isThinking: true,
      status: STATUS.THINKING,
    });
    expect(state.transcript).toEqual([]);
  });

  it("tracks pause and resume status", () => {
    const paused = reduce([pauseChanged(true)], live());
    expect(paused).toMatchObject({ isPaused: true, status: STATUS.PAUSED });
    expect(conversationReducer(paused, pauseChanged(false))).toMatchObject({
      isPaused: false,
      status: STATUS.LISTENING,
    });
  });

  it("counts dropped audio and reports congestion on the 1st and every 25th drop", () => {
    let state = reduce([audioChunkDropped()], live());
    expect(state).toMatchObject({ droppedAudioChunks: 1, status: STATUS.SLOW_CONNECTION });

    state = conversationReducer(state, server({ ai_reply: "Clears the notice." }));
    for (let i = 0; i < 23; i++) state = conversationReducer(state, audioChunkDropped());
    expect(state).toMatchObject({ droppedAudioChunks: 24, status: STATUS.LISTENING });

    state = conversationReducer(state, audioChunkDropped());
    expect(state).toMatchObject({ droppedAudioChunks: 25, status: STATUS.SLOW_CONNECTION });
  });

  it("keeps Paused when a reply arrives while paused", () => {
    const state = reduce(
      [pauseChanged(true), server({ ai_reply: "Late guidance." })],
      live()
    );
    expect(state).toMatchObject({ suggestion: "Late guidance.", status: STATUS.PAUSED });
    expect(conversationReducer(state, pauseChanged(false)).status).toBe(STATUS.LISTENING);
  });

  it("derives status from connection and capture state regardless of event order", () => {
    const openFirst = reduce([connectionChanged(CONNECTION.OPEN), captureStarted()]);
    const captureFirst = reduce([captureStarted(), connectionChanged(CONNECTION.OPEN)]);
    expect(openFirst.status).toBe(STATUS.LISTENING);
    expect(captureFirst.status).toBe(STATUS.LISTENING);
    expect(reduce([captureStarted()]).status).toBe(STATUS.CONNECTING);
    expect(reduce([connectionChanged(CONNECTION.OPEN)]).status).toBe(STATUS.CONNECTED);
    expect(reduce([connectionChanged(CONNECTION.CLOSED)], live()).status).toBe(
      STATUS.DISCONNECTED
    );
    expect(reduce([connectionChanged(CONNECTION.ERROR)], live()).status).toBe(
      STATUS.CONNECTION_ERROR
    );
    expect(reduce([connectionChanged(CONNECTION.FAILED)]).status).toBe(
      STATUS.FAILED_TO_CONNECT
    );
  });

  it("shows transient notices until the next lifecycle change", () => {
    const state = reduce([noticeShown(STATUS.CONNECTION_UNAVAILABLE)], live());
    expect(state.status).toBe(STATUS.CONNECTION_UNAVAILABLE);
    expect(conversationReducer(state, typedQuestionSubmitted("Q?")).status).toBe(
      STATUS.THINKING
    );
    const paused = reduce([pauseChanged(true), noticeShown(STATUS.PAUSED_TYPED_QUESTION)], live());
    expect(paused.status).toBe(STATUS.PAUSED_TYPED_QUESTION);
  });

  it("keeps a capture failure visible after the socket closes", () => {
    const state = reduce(
      [captureFailed("Microphone access was denied."), connectionChanged(CONNECTION.CLOSED)],
      reduce([connectionChanged(CONNECTION.OPEN)])
    );
    expect(state).toMatchObject({
      captureError: "Microphone access was denied.",
      isCapturing: false,
      status: STATUS.CAPTURE_FAILED,
    });
  });

  it("stores the model reported with a reply and clears it for the next question", () => {
    const state = reduce([
      server({ ai_reply: "Answer.", model: { selected: "openai/gpt-4o-mini", actual: null } }),
    ], live());
    expect(state.model).toEqual({ selected: "openai/gpt-4o-mini", actual: null });

    const thinking = conversationReducer(state, server({ generation: { state: "thinking" } }));
    expect(thinking.model).toBeNull();
    expect(
      conversationReducer(thinking, server({ ai_reply: "No model field." })).model
    ).toBeNull();
  });

  it("ignores malformed model metadata", () => {
    for (const model of ["gpt", { selected: 42 }, { selected: "a", actual: { x: 1 } }, null]) {
      expect(reduce([server({ ai_reply: "Answer.", model })]).model).toBeNull();
    }
    expect(
      reduce([server({ ai_reply: "Answer.", model: { selected: "a", actual: "b" } })]).model
    ).toEqual({ selected: "a", actual: "b" });
  });

  it("flags an unsupported model choice without hiding later guidance", () => {
    let state = reduce([server({ error: "unsupported_model" })], live());
    expect(state).toMatchObject({ modelUnavailable: true, status: STATUS.MODEL_UNAVAILABLE });
    expect(UNSUPPORTED_MODEL_TEXT).toMatch(/Interview Settings/);
    state = conversationReducer(state, server({ ai_reply: "Default model reply." }));
    expect(state).toMatchObject({ modelUnavailable: true, suggestion: "Default model reply." });
  });

  it("caps the transcript, keeping the newest entries", () => {
    let state = initialConversationState;
    for (let i = 1; i <= MAX_TRANSCRIPT_ENTRIES + 5; i++) {
      state = conversationReducer(state, server({ speaker: "you", transcript: `t${i}` }));
    }
    expect(state.transcript).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(state.transcript[0].text).toBe("t6");
    expect(state.transcript.at(-1)).toMatchObject({
      id: MAX_TRANSCRIPT_ENTRIES + 5,
      text: `t${MAX_TRANSCRIPT_ENTRIES + 5}`,
    });
  });

  it("does not mutate the previous state", () => {
    const before = reduce([server({ speaker: "you", transcript: "Hi" })]);
    const snapshot = JSON.parse(JSON.stringify(before));
    conversationReducer(before, server({ speaker: "caller", transcript: "Q?" }));
    expect(before).toEqual(snapshot);
  });
});
