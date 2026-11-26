import { describe, expect, it } from "vitest";
import {
  captureFailed,
  captureStarted,
  CONNECTION,
  connectionChanged,
  conversationReducer,
  initialConversationState,
  MAX_INTERIM_CHARS,
  pauseChanged,
  serverMessageReceived,
} from "../src/services/conversationState.js";

const reduce = (actions, state = initialConversationState) =>
  actions.reduce(conversationReducer, state);
const server = (message) => serverMessageReceived(message);
const live = () => reduce([connectionChanged(CONNECTION.OPEN), captureStarted()]);
const interim = (speaker, text, extra = {}) => server({ interim: { speaker, text }, ...extra });

describe("interim transcript lines", () => {
  it("starts with no in-progress line", () => {
    expect(initialConversationState.interim).toEqual({ candidate: "", interviewer: "" });
  });

  it("holds one in-progress line per speaker, replaced by each update", () => {
    const state = reduce(
      [
        interim("caller", "Tell me"),
        interim("you", "Mm"),
        interim("caller", "Tell me about a time"),
      ],
      live()
    );
    expect(state.interim).toEqual({ interviewer: "Tell me about a time", candidate: "Mm" });
    expect(state.transcript).toEqual([]);
    expect(state.currentQuestion, "interim text is never the current question").toBe("");
  });

  it("replaces only that speaker's line with the final transcript", () => {
    const state = reduce(
      [
        interim("caller", "Tell me about"),
        interim("you", "Mm"),
        server({ speaker: "caller", transcript: "Tell me about a time you led a migration." }),
      ],
      live()
    );
    expect(state.interim).toEqual({ interviewer: "", candidate: "Mm" });
    expect(state.transcript).toEqual([
      { id: 1, role: "interviewer", text: "Tell me about a time you led a migration." },
    ]);
    expect(state.currentQuestion).toBe("Tell me about a time you led a migration.");
  });

  it("shows a suppressed duplicate final as nothing: one transcript entry and a cleared line", () => {
    // The server's sequence for a duplicate final (see en-interim.json).
    const question = "Tell me about a time you led a migration.";
    const state = reduce(
      [
        interim("caller", question),
        server({ speaker: "caller", transcript: question }),
        interim("caller", question),
        interim("caller", ""),
      ],
      live()
    );
    expect(state.transcript).toHaveLength(1);
    expect(state.interim.interviewer).toBe("");
  });

  it("clears in-progress lines on pause and ignores interim frames while paused", () => {
    let state = reduce([interim("caller", "Tell me"), interim("you", "So")], live());
    state = reduce([pauseChanged(true), interim("caller", "Tell me more")], state);
    expect(state.interim).toEqual({ interviewer: "", candidate: "" });
    state = reduce([pauseChanged(false), interim("caller", "Next")], state);
    expect(state.interim.interviewer).toBe("Next");
  });

  it("clears in-progress lines on any connection change and on capture failure", () => {
    for (const connection of [CONNECTION.CLOSED, CONNECTION.RECONNECTING, CONNECTION.LOST, CONNECTION.ERROR]) {
      const state = reduce([interim("caller", "Tell me"), connectionChanged(connection)], live());
      expect(state.interim.interviewer, connection).toBe("");
    }
    const failed = reduce([interim("you", "So"), captureFailed("Microphone unavailable")], live());
    expect(failed.interim.candidate).toBe("");
  });

  it("clears in-progress lines when a new session replaces the old one", () => {
    const state = reduce(
      [server({ session: { id: "s1" } }), interim("caller", "Tell me"), server({ session: { id: "s2" } })],
      live()
    );
    expect(state.interim.interviewer).toBe("");
  });

  it("ignores malformed interim frames and bounds the text", () => {
    const before = live();
    for (const message of [
      { interim: null },
      { interim: "Tell me" },
      { interim: { speaker: "host", text: "Tell me" } },
      { interim: { speaker: "caller", text: 42 } },
      { interim: { speaker: "caller" } },
    ]) {
      expect(conversationReducer(before, server(message))).toBe(before);
    }
    const long = `${"a".repeat(MAX_INTERIM_CHARS)} newest words`;
    const state = reduce([interim("caller", long)], before);
    expect(state.interim.interviewer.length).toBeLessThanOrEqual(MAX_INTERIM_CHARS);
    expect(state.interim.interviewer.endsWith("newest words")).toBe(true);
  });

  it("applies sequenced interim frames once and never treats them as transcript entries", () => {
    const state = reduce(
      [
        server({ session: { id: "s1" } }),
        interim("caller", "Tell me", { seq: 1 }),
        server({ speaker: "caller", transcript: "Tell me more.", seq: 2 }),
        // A stale frame (seq already applied) does not bring the line back.
        interim("caller", "Tell me", { seq: 1 }),
      ],
      live()
    );
    expect(state.lastSeq).toBe(2);
    expect(state.interim.interviewer).toBe("");
    expect(state.transcript).toHaveLength(1);
  });
});
