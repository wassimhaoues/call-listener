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
    { context: { version: 1, evidence: [{ requirement: "Redis", evidence: "Led a Redis migration" }] } },
  ]);
  // Status shows the latest lifecycle event; here the socket opened last.
  expect(screen.getByText("Connected")).toBeInTheDocument();
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

it("stop ends the socket, releases capture, and returns to setup", async () => {
  const ws = await renderConversation();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));

  expect(ws.sentMessages.at(-1)).toEqual({ end: true });
  expect(ws.closeCalls).toBe(1);
  expect(audio.streams[0].tracks[0].stop).toHaveBeenCalled();
  expect(audio.contexts[0].close).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Setup page")).toBeInTheDocument();
});
