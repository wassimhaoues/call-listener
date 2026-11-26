import { describe, expect, it } from "vitest";
import {
  captureStarted,
  CONNECTION,
  connectionChanged,
  conversationReducer,
  GUIDANCE_UNAVAILABLE_TEXT,
  initialConversationState,
  noticeShown,
  serverMessageReceived,
  STATUS,
} from "../src/services/conversationState.js";
import { shouldSendAudio } from "../src/services/audioBackpressure.js";
import { encodeResumeMessage } from "../src/services/interviewMessages.js";

const reduce = (actions, state = initialConversationState) => actions.reduce(conversationReducer, state);
const server = (message) => serverMessageReceived(message);
const live = () =>
  reduce([connectionChanged(CONNECTION.OPEN), captureStarted(), server({ session: { id: "s1" } })]);

describe("resumable session state", () => {
  it("records the session ID without changing the visible state", () => {
    const state = live();
    expect(state.sessionId).toBe("s1");
    expect(state.lastSeq).toBe(0);
    expect(state.status).toBe(STATUS.LISTENING);
  });

  it("applies each sequenced message once, ignoring replayed duplicates", () => {
    const transcript = { speaker: "caller", transcript: "Why us?", seq: 1 };
    const state = reduce(
      [server(transcript), server(transcript), server({ ai_reply: "Because.", seq: 2 }), server(transcript)],
      live()
    );
    expect(state.transcript.map((entry) => entry.text)).toEqual(["Why us?"]);
    expect(state.suggestion).toBe("Because.");
    expect(state.lastSeq).toBe(2);
  });

  it("keeps applying unsequenced messages from servers without resume", () => {
    const message = { speaker: "you", transcript: "Hello" };
    const state = reduce([server(message), server(message)], reduce([connectionChanged(CONNECTION.OPEN)]));
    expect(state.transcript).toHaveLength(2);
    expect(state.lastSeq).toBe(0);
  });

  it("shows Reconnecting… and returns to the live status once resumed", () => {
    const reconnecting = reduce([connectionChanged(CONNECTION.RECONNECTING)], live());
    expect(reconnecting.status).toBe(STATUS.RECONNECTING);
    expect(STATUS.RECONNECTING).toBe("Reconnecting…");
    const resumed = reduce([connectionChanged(CONNECTION.OPEN)], reconnecting);
    expect(resumed.status).toBe(STATUS.LISTENING);
  });

  it("shows the audio gap notice after a resume until the next lifecycle change", () => {
    const state = reduce([connectionChanged(CONNECTION.OPEN), server({ notice: "audio_gap" })], live());
    expect(state.status).toBe(STATUS.AUDIO_GAP);
    expect(reduce([server({ generation: { state: "thinking" }, seq: 1 })], state).status).toBe(STATUS.THINKING);
  });

  it("reports a generation interrupted by the disconnect as unavailable", () => {
    const state = reduce(
      [
        server({ generation: { id: "g1", state: "thinking" }, seq: 1 }),
        connectionChanged(CONNECTION.RECONNECTING),
        server({ generation: { id: "g1", state: "failed", reason: "disconnected" }, ai_reply: "[Erreur du modèle]", seq: 2 }),
        connectionChanged(CONNECTION.OPEN),
      ],
      live()
    );
    expect(state.suggestion).toBe(GUIDANCE_UNAVAILABLE_TEXT);
    expect(state.isThinking).toBe(false);
  });

  it("a new session ID resets the sequence and any in-flight generation", () => {
    const state = reduce(
      [
        server({ ai_reply: "Old intro.", seq: 7 }),
        server({ generation: { id: "g1", state: "thinking" }, seq: 8 }),
        connectionChanged(CONNECTION.OPEN),
        noticeShown(STATUS.SESSION_RESTARTED),
        server({ session: { id: "s2" } }),
        server({ ai_reply: "New intro.", seq: 1 }),
      ],
      live()
    );
    expect(state.sessionId).toBe("s2");
    expect(state.lastSeq).toBe(1);
    expect(state.isThinking).toBe(false);
    expect(state.suggestion).toBe("New intro.");
  });

  it("a lost connection clears an unfinished generation", () => {
    const state = reduce(
      [server({ generation: { id: "g1", state: "streaming" } }), server({ generation: { id: "g1", state: "thinking" }, seq: 1 }), connectionChanged(CONNECTION.LOST)],
      live()
    );
    expect(state.status).toBe(STATUS.CONNECTION_LOST);
    expect(state.isThinking).toBe(false);
    expect(state.isStreaming).toBe(false);
    const idle = reduce([connectionChanged(CONNECTION.LOST)], live());
    expect(idle.status).toBe(STATUS.CONNECTION_LOST);
  });

  it("never sends audio while the session is not connected", () => {
    const open = { paused: false, readyState: 1, openState: 1, bufferedAmount: 0 };
    expect(shouldSendAudio(open)).toBe(true);
    expect(shouldSendAudio({ ...open, connected: false })).toBe(false);
  });

  it("encodes the resume request", () => {
    expect(JSON.parse(encodeResumeMessage("s1", 4))).toEqual({ resume: { sessionId: "s1", lastSeq: 4 } });
  });
});
