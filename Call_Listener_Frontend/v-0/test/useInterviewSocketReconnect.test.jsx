import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInterviewSocket } from "../src/hooks/useInterviewSocket.js";
import {
  audioChunkDropped,
  CONNECTION,
  connectionChanged,
  noticeShown,
  serverMessageReceived,
  STATUS,
} from "../src/services/conversationState.js";
import {
  nextReconnectDelay,
  randomFraction,
  reconnectDelay,
  RECONNECT_WINDOW_MS,
} from "../src/services/reconnectPolicy.js";
import { FakeWebSocket } from "./helpers/fakes.js";

const CONTEXT = { version: 1 };
const CHUNK = new Int16Array([1, 2]).buffer;

function setup(options = {}) {
  const dispatch = vi.fn();
  let urlCount = 0;
  const getWsUrl = vi.fn(async () => {
    urlCount += 1;
    return `wss://example.test/ws?attempt=${urlCount}`;
  });
  const hook = renderHook(() =>
    useInterviewSocket({
      dispatch,
      getWsUrl,
      getContext: () => CONTEXT,
      // Upper end of the jitter range: delays are exactly 0.5, 1, 2, 4, 8, 8… s.
      random: () => 1,
      ...options,
    })
  );
  return { dispatch, getWsUrl, ...hook };
}

const flush = () => act(async () => {});
const advance = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));
const dispatched = (dispatch) => dispatch.mock.calls.map(([action]) => action);

// Connect and let the server name a resumable session, then drop it.
async function liveSession(result, { lastSeq = 3 } = {}) {
  await act(() => result.current.connect());
  const ws = FakeWebSocket.latest();
  act(() => ws.serverOpen());
  act(() => ws.serverSend({ session: { id: "sess-1" } }));
  for (let seq = 1; seq <= lastSeq; seq += 1) {
    act(() => ws.serverSend({ speaker: "caller", transcript: `Q${seq}`, seq }));
  }
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reconnect policy", () => {
  it("backs off exponentially with jitter up to an 8 s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((attempt) => reconnectDelay(attempt, () => 1))).toEqual([
      500, 1000, 2000, 4000, 8000, 8000, 8000,
    ]);
    expect([0, 1, 4].map((attempt) => reconnectDelay(attempt, () => 0))).toEqual([250, 500, 4000]);
    const jittered = reconnectDelay(2, () => 0.5);
    expect(jittered).toBe(1500);
  });

  it("draws default jitter from Web Crypto within the documented range", () => {
    for (let index = 0; index < 50; index += 1) {
      const fraction = randomFraction();
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThan(1);
      const delay = reconnectDelay(3);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(4000);
    }
  });

  it("stops scheduling once the next attempt would leave the window", () => {
    expect(nextReconnectDelay({ attempt: 6, elapsedMs: RECONNECT_WINDOW_MS - 8000, random: () => 1 })).toBe(8000);
    expect(nextReconnectDelay({ attempt: 6, elapsedMs: RECONNECT_WINDOW_MS - 7999, random: () => 1 })).toBeNull();
  });
});

describe("useInterviewSocket reconnection", () => {
  it("reconnects on the backoff schedule with a fresh URL per attempt", async () => {
    const { result, dispatch, getWsUrl } = setup();
    const first = await liveSession(result);
    dispatch.mockClear();

    act(() => first.serverClose());
    expect(dispatched(dispatch)).toEqual([connectionChanged(CONNECTION.RECONNECTING)]);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const openedAt = [];
    for (const delay of [500, 1000, 2000, 4000]) {
      await advance(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(openedAt.length + 1);
      await advance(1);
      expect(FakeWebSocket.instances).toHaveLength(openedAt.length + 2);
      openedAt.push(delay);
      // The attempt fails before opening (server still unreachable).
      act(() => FakeWebSocket.latest().onerror?.());
      act(() => FakeWebSocket.latest().serverClose());
    }

    expect(getWsUrl).toHaveBeenCalledTimes(5);
    expect(FakeWebSocket.instances.map((ws) => ws.url).slice(1)).toEqual([
      "wss://example.test/ws?attempt=2",
      "wss://example.test/ws?attempt=3",
      "wss://example.test/ws?attempt=4",
      "wss://example.test/ws?attempt=5",
    ]);
    expect(dispatched(dispatch)).not.toContainEqual(connectionChanged(CONNECTION.ERROR));
    expect(dispatched(dispatch)).not.toContainEqual(connectionChanged(CONNECTION.CLOSED));
  });

  it("sends resume first, then applies the replay and goes live again", async () => {
    const { result, dispatch } = setup();
    const first = await liveSession(result, { lastSeq: 3 });
    act(() => first.serverClose());
    await advance(500);
    const second = FakeWebSocket.latest();
    act(() => second.serverOpen());

    expect(second.sentMessages).toEqual([{ resume: { sessionId: "sess-1", lastSeq: 3 } }]);
    expect(result.current.isOpen()).toBe(false);
    result.current.sendAudioChunk("mic", CHUNK);
    // No audio before the resume is acknowledged.
    expect(second.sent).toHaveLength(1);

    dispatch.mockClear();
    act(() => second.serverSend({ ai_reply: "Answer.", seq: 5 }));
    act(() => second.serverSend({ resumed: { sessionId: "sess-1", seq: 6 } }));
    act(() => second.serverSend({ notice: "audio_gap" }));
    expect(dispatched(dispatch)).toEqual([
      serverMessageReceived({ ai_reply: "Answer.", seq: 5 }),
      connectionChanged(CONNECTION.OPEN),
      serverMessageReceived({ notice: "audio_gap" }),
    ]);
    expect(result.current.isOpen()).toBe(true);
    result.current.sendAudioChunk("mic", CHUNK);
    expect(second.sentMessages[1]).toMatchObject({ source: "mic" });
    expect(second.sentMessages.some((message) => message.context)).toBe(false);

    // A second drop resumes from the newest sequence number.
    act(() => second.serverClose());
    await advance(500);
    act(() => FakeWebSocket.latest().serverOpen());
    expect(FakeWebSocket.latest().sentMessages).toEqual([{ resume: { sessionId: "sess-1", lastSeq: 6 } }]);
  });

  it("drops audio while disconnected instead of queueing it", async () => {
    const { result, dispatch } = setup();
    const first = await liveSession(result);
    act(() => first.serverClose());
    dispatch.mockClear();

    result.current.sendAudioChunk("mic", CHUNK);
    result.current.sendAudioChunk("system", CHUNK);
    await advance(500);
    act(() => FakeWebSocket.latest().serverOpen());
    act(() => FakeWebSocket.latest().serverSend({ resumed: { sessionId: "sess-1", seq: 3 } }));

    expect(FakeWebSocket.latest().sentMessages).toEqual([{ resume: { sessionId: "sess-1", lastSeq: 3 } }]);
    expect(dispatched(dispatch)).not.toContainEqual(audioChunkDropped());
    expect(result.current.sendInterviewerQuestion("Still there?")).toBe(true);
  });

  it("starts a new session with the stored context when the old one expired", async () => {
    const { result, dispatch } = setup();
    const first = await liveSession(result);
    act(() => first.serverClose());
    await advance(500);
    const second = FakeWebSocket.latest();
    act(() => second.serverOpen());
    dispatch.mockClear();

    act(() => second.serverSend({ error: "resume_expired" }));
    expect(second.sentMessages).toEqual([
      { resume: { sessionId: "sess-1", lastSeq: 3 } },
      { context: { version: 1, capabilities: ["stream", "resume"] } },
    ]);
    expect(dispatched(dispatch)).toEqual([
      connectionChanged(CONNECTION.OPEN),
      noticeShown(STATUS.SESSION_RESTARTED),
    ]);
    expect(result.current.isOpen()).toBe(true);

    // The new session's ID is used for the next resume.
    act(() => second.serverSend({ session: { id: "sess-2" } }));
    act(() => second.serverSend({ ai_reply: "Intro.", seq: 1 }));
    act(() => second.serverClose());
    await advance(500);
    act(() => FakeWebSocket.latest().serverOpen());
    expect(FakeWebSocket.latest().sentMessages).toEqual([{ resume: { sessionId: "sess-2", lastSeq: 1 } }]);
  });

  it("treats a rejected resume like an expired one", async () => {
    const { result } = setup();
    const first = await liveSession(result);
    act(() => first.serverClose());
    await advance(500);
    const second = FakeWebSocket.latest();
    act(() => second.serverOpen());
    act(() => second.serverSend({ error: "resume_rejected" }));
    expect(second.sentMessages.at(-1)).toEqual({ context: { version: 1, capabilities: ["stream", "resume"] } });
  });

  it("Stop cancels a pending reconnect", async () => {
    const { result, getWsUrl } = setup();
    const first = await liveSession(result);
    act(() => first.serverClose());
    act(() => result.current.end());
    await advance(RECONNECT_WINDOW_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(getWsUrl).toHaveBeenCalledTimes(1);
  });

  it("Stop during an attempt's URL lookup opens no socket", async () => {
    let resolveUrl;
    const getWsUrl = vi.fn(async () => "wss://example.test/ws");
    const { result } = setup({ getWsUrl });
    const first = await liveSession(result);
    getWsUrl.mockImplementationOnce(() => new Promise((resolve) => (resolveUrl = resolve)));
    act(() => first.serverClose());
    await advance(500);
    act(() => result.current.end());
    await act(async () => resolveUrl("wss://example.test/ws"));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("retries when the URL lookup fails during reconnection", async () => {
    const getWsUrl = vi.fn(async () => "wss://example.test/ws");
    const { result } = setup({ getWsUrl });
    const first = await liveSession(result);
    getWsUrl.mockRejectedValueOnce(new Error("token refresh failed"));
    act(() => first.serverClose());
    await advance(500);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await advance(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("gives up after the resume window and offers a manual new session", async () => {
    const { result, dispatch } = setup();
    const first = await liveSession(result);
    act(() => first.serverClose());

    // Every attempt fails until the window is exhausted.
    for (let elapsed = 0; elapsed <= RECONNECT_WINDOW_MS; elapsed += 500) {
      await advance(500);
      const latest = FakeWebSocket.latest();
      if (latest !== first && latest.readyState !== FakeWebSocket.CLOSED) {
        act(() => latest.serverClose());
      }
    }
    const attempts = FakeWebSocket.instances.length - 1;
    expect(attempts).toBe(18);
    expect(dispatched(dispatch).at(-1)).toEqual(connectionChanged(CONNECTION.LOST));
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(attempts + 1);

    dispatch.mockClear();
    await act(() => result.current.startNewSession());
    const fresh = FakeWebSocket.latest();
    act(() => fresh.serverOpen());
    expect(fresh.sentMessages).toEqual([{ context: { version: 1, capabilities: ["stream", "resume"] } }]);
    expect(dispatched(dispatch)).toEqual([
      connectionChanged(CONNECTION.CONNECTING),
      connectionChanged(CONNECTION.OPEN),
    ]);
  });

  it("does not reconnect when the server never named a session", async () => {
    const { result, dispatch } = setup();
    await act(() => result.current.connect());
    const ws = FakeWebSocket.latest();
    act(() => ws.serverOpen());
    act(() => ws.serverClose());
    await advance(10_000);
    expect(dispatched(dispatch).at(-1)).toEqual(connectionChanged(CONNECTION.CLOSED));
    expect(FakeWebSocket.instances).toHaveLength(1);
    await flush();
  });
});
