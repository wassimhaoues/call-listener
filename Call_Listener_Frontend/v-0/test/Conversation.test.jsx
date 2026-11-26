import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Conversation from "../src/pages/Conversation.jsx";
import { UIProvider, useUI } from "../src/ui/UIContext.jsx";
import { FakeWebSocket, installFakeAudio } from "./helpers/fakes.js";

let audio;

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
          <Route path="/autherror" element={<p>Auth error page</p>} />
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
    JSON.stringify({ version: 1, evidence: [{ requirement: "Redis", evidence: "Led a Redis migration" }] })
  );
});

afterEach(() => {
  cleanup();
  audio.restore();
  delete window.callApi;
  localStorage.clear();
});

it("composes capture, socket, and guidance state into the live workspace", async () => {
  const ws = await renderConversation();

  expect(ws.sentMessages).toEqual([
    {
      context: {
        version: 1,
        evidence: [{ requirement: "Redis", evidence: "Led a Redis migration" }],
        capabilities: ["stream", "resume"],
      },
    },
  ]);
  // Status derives from state: socket open + capture running is Listening,
  // whichever of the two events happened last.
  expect(screen.getByText("Listening")).toBeInTheDocument();
  expect(screen.getByText("Led a Redis migration")).toBeInTheDocument();

  act(() => ws.serverSend({ speaker: "you", transcript: "Hello there" }));
  expect(screen.getByText("Hello there")).toBeInTheDocument();

  act(() => ws.serverSend({ ai_reply: "Mention the migration." }));
  expect(screen.getByText("Mention the migration.")).toBeInTheDocument();
});

it("submits typed questions and blocks them while paused", async () => {
  const ws = await renderConversation();
  const ask = (question) => {
    fireEvent.change(screen.getByLabelText("Interviewer question"), {
      target: { value: question },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  };

  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(screen.getByText("Paused")).toBeInTheDocument();
  ask("Ignored while paused?");
  expect(screen.getByText("Paused — resume before submitting a question")).toBeInTheDocument();
  expect(ws.sentMessages.some((m) => "interviewer_question" in m)).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  ask("How did you lead the migration?");
  expect(ws.sentMessages).toContainEqual({ interviewer_question: "How did you lead the migration?" });
  expect(screen.getByText("How did you lead the migration?")).toBeInTheDocument();
  expect(screen.getByText("Thinking")).toBeInTheDocument();
});

it("withholds audio while paused and resumes sending after resume", async () => {
  const ws = await renderConversation();
  const [micNode] = audio.workletNodes;
  const chunk = () =>
    act(() =>
      micNode.port.onmessage({
        data: { type: "chunk", source: "mic", buffer: new Int16Array([1]).buffer },
      })
    );
  const audioCount = () => ws.sentMessages.filter((m) => m.source).length;

  chunk();
  expect(audioCount()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  chunk();
  expect(audioCount()).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  chunk();
  expect(audioCount()).toBe(2);
});

it("stop flushes the final audio batch, sends end, closes, and returns to setup", async () => {
  const ws = await renderConversation();
  const [micNode] = audio.workletNodes;
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop" })); // idempotent

  expect(micNode.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
  expect(ws.closeCalls).toBe(0); // still waiting for the final batch
  const finalBatch = new Int16Array([3, 4]).buffer;
  await act(async () => {
    micNode.port.onmessage({ data: { type: "chunk", source: "mic", buffer: finalBatch } });
    micNode.port.onmessage({ data: { type: "flushed" } });
  });

  const messages = ws.sentMessages;
  expect(messages.at(-2)).toEqual({
    source: "mic",
    chunk: Buffer.from(finalBatch).toString("base64"),
  });
  expect(messages.at(-1)).toEqual({ end: true });
  expect(messages.filter((m) => m.end)).toHaveLength(1);
  expect(ws.closeCalls).toBe(1);
  expect(audio.streams[0].tracks[0].stop).toHaveBeenCalled();
  expect(audio.contexts[0].close).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Setup page")).toBeInTheDocument();
});

it("keeps the offline redirect instead of navigating home on unmount", async () => {
  await renderConversation();
  const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  await act(async () => {});
  expect(screen.getByText("Auth error page")).toBeInTheDocument();
  expect(screen.queryByText("Setup page")).toBeNull();
  onLine.mockRestore();
});

it("closes a socket whose URL resolves after the page unmounted", async () => {
  let resolveUrl;
  window.callApi.getWsUrl = vi.fn(() => new Promise((resolve) => (resolveUrl = resolve)));
  render(
    <MemoryRouter initialEntries={["/conversation"]}>
      <UIProvider>
        <Conversation />
      </UIProvider>
    </MemoryRouter>
  );
  await act(async () => {});
  cleanup();
  await act(async () => resolveUrl("wss://example.test/ws"));
  expect(FakeWebSocket.instances.filter((ws) => ws.closeCalls === 0)).toEqual([]);
});

it.each([
  ["NotAllowedError", /Microphone access was denied/],
  ["NotFoundError", /selected microphone was not found/],
  ["AbortError", /Could not start microphone capture/],
])("explains a %s from getUserMedia and ends the session", async (name, message) => {
  let rejectMic;
  audio.getUserMedia.mockImplementationOnce(
    () => new Promise((resolve, reject) => (rejectMic = reject))
  );
  const ws = await renderConversation();
  expect(screen.getByText("Connected")).toBeInTheDocument();
  await act(async () => rejectMic(Object.assign(new Error("gum failed"), { name })));

  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(screen.getByText("Audio capture unavailable")).toBeInTheDocument();
  expect(screen.queryByText("Listening")).toBeNull();
  expect(ws.sentMessages.at(-1)).toEqual({ end: true });
  expect(ws.closeCalls).toBe(1);
  expect(audio.contexts[0].close).toHaveBeenCalled();
});

it("keeps Paused when guidance arrives while paused", async () => {
  const ws = await renderConversation();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  act(() => ws.serverSend({ ai_reply: "Late guidance." }));
  expect(screen.getByText("Paused")).toBeInTheDocument();
  expect(screen.queryByText("Listening")).toBeNull();
});

it("shows the model that produced the current suggestion", async () => {
  const ws = await renderConversation();
  act(() =>
    ws.serverSend({ ai_reply: "Answer.", model: { selected: "openai/gpt-4o-mini", actual: null } })
  );
  expect(screen.getByText("Model: openai/gpt-4o-mini")).toBeInTheDocument();
});

it("shows Reconnecting… after a drop and offers a new session once reconnection gives up", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const ws = await renderConversation();
    act(() => ws.serverSend({ session: { id: "sess-1" } }));
    act(() => ws.serverClose());
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start new session" })).toBeNull();

    // Every attempt fails until the 120 s window is exhausted.
    for (let elapsed = 0; elapsed <= 121_000; elapsed += 500) {
      await act(() => vi.advanceTimersByTimeAsync(500));
      const latest = FakeWebSocket.latest();
      if (latest !== ws && latest.readyState !== FakeWebSocket.CLOSED) act(() => latest.serverClose());
    }
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be restored/);

    const attempts = FakeWebSocket.instances.length;
    fireEvent.click(screen.getByRole("button", { name: "Start new session" }));
    await act(async () => {});
    expect(FakeWebSocket.instances).toHaveLength(attempts + 1);
    const fresh = FakeWebSocket.latest();
    act(() => fresh.serverOpen());
    expect(fresh.sentMessages[0].context.capabilities).toEqual(["stream", "resume"]);
    expect(screen.queryByRole("button", { name: "Start new session" })).toBeNull();
    expect(screen.getByText("Listening")).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("tells the candidate to pick another model when the choice is unsupported", async () => {
  const ws = await renderConversation();
  act(() => ws.serverSend({ error: "unsupported_model" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/isn.t available/);
  expect(screen.getByRole("alert")).toHaveTextContent(/Interview Settings/);
});
