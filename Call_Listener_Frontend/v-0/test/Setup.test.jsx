import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Setup from "../src/pages/Setup.jsx";
import { UIProvider } from "../src/ui/UIContext.jsx";

const originalMediaDevices = navigator.mediaDevices;
const originalCallApi = window.callApi;

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({}),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: "audioinput", deviceId: "mic-1", label: "Candidate microphone" },
      ]),
    },
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
  window.callApi = originalCallApi;
});

it("allows microphone-only setup when system audio is unavailable", async () => {
  window.callApi = {
    getPlatformCapabilities: vi.fn().mockResolvedValue({
      systemAudio: { supported: false, strategy: "unavailable" },
    }),
  };

  render(
    <MemoryRouter>
      <UIProvider>
        <Setup />
      </UIProvider>
    </MemoryRouter>
  );

  await screen.findByText(/microphone-only mode/i);
  await waitFor(() => {
    expect(screen.getByRole("combobox")).toHaveValue("mic-1");
  });
  expect(screen.queryByText(/System Audio \(VB-Cable/i)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  expect(localStorage.getItem("micId")).toBe("mic-1");
  expect(localStorage.getItem("systemAudioEnabled")).toBe("false");
  expect(localStorage.getItem("sysId")).toBeNull();
});
