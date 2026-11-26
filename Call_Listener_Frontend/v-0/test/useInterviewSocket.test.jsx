import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInterviewSocket } from "../src/hooks/useInterviewSocket.js";
import { MAX_WEBSOCKET_BUFFERED_BYTES } from "../src/services/audioBackpressure.js";
import {
  audioChunkDropped,
  serverMessageReceived,
  STATUS,
  statusChanged,
} from "../src/services/conversationState.js";
import { FakeWebSocket } from "./helpers/fakes.js";

let paused;

function setup(options = {}) {
  const dispatch = vi.fn();
  const getWsUrl = vi.fn(async () => "wss://example.test/ws");
  const hook = renderHook(() =>
    useInterviewSocket({
      dispatch,
      isPaused: () => paused,
      getWsUrl,
      ...options,
    })
  );
  return { dispatch, getWsUrl, ...hook };
}

async function connectOpen(result) {
  await act(() => result.current.connect());
  const ws = FakeWebSocket.latest();
  act(() => ws.serverOpen());
  return ws;
}

beforeEach(() => {
  paused = false;
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useInterviewSocket", () => {
  it("opens the preload URL and sends stored context once connected", async () => {
    const { result, dispatch, getWsUrl } = setup({
      getContext: () => ({ version: 1 }),
    });
    const ws = await connectOpen(result);

    expect(getWsUrl).toHaveBeenCalledTimes(1);
    expect(ws.url).toBe("wss://example.test/ws");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(dispatch).toHaveBeenCalledWith(statusChanged(STATUS.CONNECTED));
    expect(ws.sentMessages).toEqual([{ context: { version: 1 } }]);
  });

  it("defaults to window.callApi.getWsUrl", async () => {
    window.callApi = { getWsUrl: vi.fn(async () => "wss://preload.test/ws") };
    const dispatch = vi.fn();
    const { result } = renderHook(() => useInterviewSocket({ dispatch }));
    await act(() => result.current.connect());
    expect(FakeWebSocket.latest().url).toBe("wss://preload.test/ws");
    delete window.callApi;
  });

  it("does not send context when none is stored", async () => {
    const { result } = setup();
    const ws = await connectOpen(result);
    expect(ws.sent).toEqual([]);
  });

  it("reports a failed URL lookup", async () => {
    const { result, dispatch } = setup({
      getWsUrl: vi.fn(async () => {
        throw new Error("no token");
      }),
    });
    await act(() => result.current.connect());
    expect(dispatch).toHaveBeenCalledWith(statusChanged(STATUS.FAILED_TO_CONNECT));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("dispatches parsed server messages and ignores malformed frames", async () => {
    const { result, dispatch } = setup();
    const ws = await connectOpen(result);
    dispatch.mockClear();

    act(() => ws.serverSend({ ai_reply: "Hello" }));
    act(() => ws.serverSend("not json"));

    expect(dispatch.mock.calls).toEqual([[serverMessageReceived({ ai_reply: "Hello" })]]);
  });

  it("reports close and error events", async () => {
    const { result, dispatch } = setup();
    const ws = await connectOpen(result);
    act(() => ws.onerror());
    act(() => ws.serverClose());
    expect(dispatch).toHaveBeenCalledWith(statusChanged(STATUS.CONNECTION_ERROR));
    expect(dispatch).toHaveBeenCalledWith(statusChanged(STATUS.DISCONNECTED));
  });

  it("sends audio only while open, unpaused, and under the buffer limit", async () => {
    const { result, dispatch } = setup();
    const chunk = new Int16Array([1, 2]).buffer;

    result.current.sendAudioChunk("mic", chunk); // no socket yet
    const ws = await connectOpen(result);
    dispatch.mockClear();

    result.current.sendAudioChunk("mic", chunk);
    expect(ws.sentMessages).toEqual([
      { source: "mic", chunk: Buffer.from(chunk).toString("base64") },
    ]);

    paused = true;
    result.current.sendAudioChunk("system", chunk);
    expect(ws.sent).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops and reports audio when the send buffer is congested", async () => {
    const { result, dispatch } = setup();
    const ws = await connectOpen(result);
    dispatch.mockClear();

    ws.bufferedAmount = MAX_WEBSOCKET_BUFFERED_BYTES + 1;
    result.current.sendAudioChunk("mic", new Int16Array([1]).buffer);

    expect(ws.sent).toEqual([]);
    expect(dispatch).toHaveBeenCalledWith(audioChunkDropped());
  });

  it("sends a typed interviewer question only on an open socket", async () => {
    const { result } = setup();
    expect(result.current.sendInterviewerQuestion("Why?")).toBe(false);
    expect(result.current.isOpen()).toBe(false);

    const ws = await connectOpen(result);
    expect(result.current.isOpen()).toBe(true);
    expect(result.current.sendInterviewerQuestion("Why?")).toBe(true);
    expect(ws.sentMessages).toEqual([{ interviewer_question: "Why?" }]);
  });

  it("ends the session idempotently", async () => {
    const { result } = setup();
    const ws = await connectOpen(result);

    act(() => result.current.end());
    act(() => result.current.end());

    expect(ws.sentMessages).toEqual([{ end: true }]);
    expect(ws.closeCalls).toBe(1);
    expect(result.current.isOpen()).toBe(false);
    expect(result.current.sendInterviewerQuestion("Late?")).toBe(false);
  });

  it("still closes when end cannot be sent on a connecting socket", async () => {
    const { result } = setup();
    await act(() => result.current.connect());
    const ws = FakeWebSocket.latest();

    act(() => result.current.end());
    expect(ws.sent).toEqual([]);
    expect(ws.closeCalls).toBe(1);
  });

  it("ends and closes the socket on unmount", async () => {
    const { result, unmount } = setup();
    const ws = await connectOpen(result);
    unmount();
    expect(ws.sentMessages).toEqual([{ end: true }]);
    expect(ws.closeCalls).toBe(1);
  });
});
