import { describe, expect, it } from "vitest";
import {
  captureStarted,
  CONNECTION,
  connectionChanged,
  conversationReducer,
  GUIDANCE_UNAVAILABLE_TEXT,
  initialConversationState,
  MAX_STREAMED_SUGGESTION_CHARS,
  serverMessageReceived,
  STATUS,
  typedQuestionSubmitted,
} from "../src/services/conversationState.js";

const server = (message) => serverMessageReceived(message);
const reduce = (messages, state = live()) =>
  messages.reduce(
    (current, message) =>
      conversationReducer(current, message.type ? message : server(message)),
    state
  );
const live = () =>
  [connectionChanged(CONNECTION.OPEN), captureStarted()].reduce(
    conversationReducer,
    initialConversationState
  );
const thinking = (id) => ({ generation: { id, state: "thinking" } });
const delta = (id, text) => ({ generation: { id, state: "streaming" }, delta: text });
const done = (id, text, extra = {}) => ({ ai_reply: text, ...extra, generation: { id, state: "done" } });
const failed = (id) => ({ generation: { id, state: "failed" }, ai_reply: "[Erreur du modèle]" });

describe("streamed generations", () => {
  it("tracks the generation ID and appends its deltas as partial text", () => {
    const state = reduce([
      { ai_reply: "Old guidance" },
      thinking("g1"),
      delta("g1", "Lead with "),
      delta("g1", "the migration."),
    ]);
    expect(state).toMatchObject({
      generationId: "g1",
      suggestion: "Lead with the migration.",
      isThinking: false,
      isStreaming: true,
      model: null,
      status: STATUS.THINKING,
    });
  });

  it("replaces streamed text with the final reply and its model", () => {
    const model = { selected: "openai/gpt-4o-mini", actual: null };
    const state = reduce([
      thinking("g1"),
      delta("g1", "Lead with the migr"),
      done("g1", "Lead with the migration.", { model }),
    ]);
    expect(state).toMatchObject({
      suggestion: "Lead with the migration.",
      isStreaming: false,
      isThinking: false,
      generationId: null,
      model,
      status: STATUS.LISTENING,
    });
  });

  it("ignores deltas and finals for any other generation ID", () => {
    const current = reduce([thinking("g1"), delta("g1", "Old "), thinking("g2"), delta("g2", "New ")]);
    const after = reduce(
      [delta("g1", "stale delta"), done("g1", "stale final"), failed("g1"), delta("g3", "future")],
      current
    );
    expect(after).toBe(current);
    expect(after.suggestion).toBe("New ");
  });

  it("ignores a duplicate completion and late deltas after done", () => {
    const completed = reduce([thinking("g1"), delta("g1", "A"), done("g1", "Answer.")]);
    expect(reduce([done("g1", "Duplicate."), delta("g1", "late")], completed)).toBe(completed);
  });

  it("clears streamed text when the generation fails", () => {
    const state = reduce([thinking("g1"), delta("g1", "Partial answer"), failed("g1")]);
    expect(state).toMatchObject({
      suggestion: GUIDANCE_UNAVAILABLE_TEXT,
      isStreaming: false,
      generationId: null,
      status: STATUS.GUIDANCE_UNAVAILABLE,
    });
  });

  it("hides streamed text for the old question as soon as a typed question is submitted", () => {
    const streaming = reduce([thinking("g1"), delta("g1", "Answer to the old question")]);
    const typed = conversationReducer(streaming, typedQuestionSubmitted("A newer question?"));
    expect(typed).toMatchObject({ suggestion: "", isThinking: true, isStreaming: false, generationId: null });
    // In-flight output for the superseded generation never reappears.
    expect(reduce([delta("g1", "late"), done("g1", "late final")], typed)).toBe(typed);
    const next = reduce([thinking("g2"), delta("g2", "Fresh.")], typed);
    expect(next.suggestion).toBe("Fresh.");
  });

  it("rejects malformed streaming messages", () => {
    const current = reduce([thinking("g1")]);
    for (const message of [
      { generation: { state: "streaming" }, delta: "no id" },
      { generation: { id: 1, state: "streaming" }, delta: "numeric id" },
      { generation: { id: "g1", state: "streaming" }, delta: { html: "<b>x</b>" } },
      { generation: { id: "g1", state: "streaming" }, delta: "" },
      { generation: { id: "", state: "done" }, ai_reply: "empty id" },
    ]) {
      expect(conversationReducer(current, server(message))).toBe(current);
    }
  });

  it("bounds streamed text", () => {
    const chunk = "x".repeat(MAX_STREAMED_SUGGESTION_CHARS);
    const state = reduce([thinking("g1"), delta("g1", chunk), delta("g1", "overflow")]);
    expect(state.suggestion).toHaveLength(MAX_STREAMED_SUGGESTION_CHARS);
  });

  it("keeps the legacy message sequence working unchanged", () => {
    const state = reduce([
      { generation: { state: "thinking" } },
      { ai_reply: "Legacy answer." },
    ]);
    expect(state).toMatchObject({ suggestion: "Legacy answer.", generationId: null, isStreaming: false });
    const failure = reduce([{ generation: { state: "thinking" } }, { generation: { state: "failed" }, ai_reply: "x" }]);
    expect(failure.suggestion).toBe(GUIDANCE_UNAVAILABLE_TEXT);
  });

  it("still shows an untagged introductory reply", () => {
    const state = reduce([{ ai_reply: "Intro guidance." }]);
    expect(state.suggestion).toBe("Intro guidance.");
  });
});
