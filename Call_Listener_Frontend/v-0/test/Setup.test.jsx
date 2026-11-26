import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  cleanup();
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

const LINUX_CAPABILITIES = {
  appSupported: true,
  systemAudio: {
    supported: false,
    strategy: "unavailable",
    fallback: "monitor-source",
    selectableSource: "monitor-source",
    requiresCandidateConsent: true,
  },
};

const MIC = { kind: "audioinput", deviceId: "mic-1", label: "Built-in Audio Analog Stereo" };
const MONITOR = {
  kind: "audioinput",
  deviceId: "mon-1",
  label: "Monitor of Built-in Audio Analog Stereo",
};
const USB_MONITOR = { kind: "audioinput", deviceId: "mon-2", label: "Monitor of USB Headset" };

function fakeStream() {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track] } };
}

function setupLinux({ enumerations, getUserMedia } = {}) {
  window.callApi = {
    getPlatformCapabilities: vi.fn().mockResolvedValue(LINUX_CAPABILITIES),
  };
  const enumerateDevices = vi.fn();
  for (const list of enumerations) enumerateDevices.mockResolvedValueOnce(list);
  enumerateDevices.mockResolvedValue(enumerations.at(-1));
  const media = {
    getUserMedia: getUserMedia || vi.fn().mockResolvedValue(fakeStream().stream),
    enumerateDevices,
  };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
  render(
    <MemoryRouter>
      <UIProvider>
        <Setup />
      </UIProvider>
    </MemoryRouter>
  );
  return media;
}

const interviewerSelect = () => screen.getByRole("combobox", { name: "Interviewer source" });

it("asks for audio access explicitly before listing Linux monitor sources", async () => {
  const { stream, track } = fakeStream();
  const media = setupLinux({
    enumerations: [
      [
        { kind: "audioinput", deviceId: "mic-1", label: "" },
        { kind: "audioinput", deviceId: "mon-1", label: "" },
      ],
      [MIC, MONITOR],
    ],
    getUserMedia: vi.fn().mockResolvedValue(stream),
  });

  const allow = await screen.findByRole("button", { name: "Allow audio access" });
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox", { name: "Interviewer source" })).toBeNull();

  fireEvent.click(allow);

  await waitFor(() => expect(interviewerSelect()).toBeInTheDocument());
  expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
  // The permission stream only reveals labels; it is released immediately.
  expect(track.stop).toHaveBeenCalled();
  expect(interviewerSelect()).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Allow audio access" })).toBeNull();
});

it("lists monitors separately, never auto-selects one, and saves an explicit choice", async () => {
  localStorage.setItem("sysId", "mon-1");
  setupLinux({ enumerations: [[MONITOR, MIC]] });

  await waitFor(() => expect(interviewerSelect()).toBeInTheDocument());
  const mic = screen.getByRole("combobox", { name: "Microphone" });
  expect(mic).toHaveValue("mic-1");
  expect(Array.from(mic.options).map((o) => o.value)).toEqual(["mic-1"]);
  // A previously saved monitor is not restored automatically.
  expect(interviewerSelect()).toHaveValue("");
  expect(Array.from(interviewerSelect().options).map((o) => o.textContent)).toEqual([
    "None — type the interviewer’s questions",
    "Monitor of Built-in Audio Analog Stereo",
  ]);

  fireEvent.change(interviewerSelect(), { target: { value: "mon-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  expect(localStorage.getItem("micId")).toBe("mic-1");
  expect(localStorage.getItem("systemAudioEnabled")).toBe("true");
  expect(localStorage.getItem("sysId")).toBe("mon-1");
  expect(localStorage.getItem("sysLabel")).toBe("Interviewer audio (system output)");
  expect(localStorage.getItem("interviewerSource")).toBe("monitor-source");
});

it("defaults Linux to microphone-only with typed questions", async () => {
  setupLinux({ enumerations: [[MIC, MONITOR]] });
  await waitFor(() => expect(interviewerSelect()).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  expect(localStorage.getItem("systemAudioEnabled")).toBe("false");
  expect(localStorage.getItem("sysId")).toBeNull();
  expect(localStorage.getItem("sysLabel")).toBe("Interviewer audio unavailable");
  expect(localStorage.getItem("interviewerSource")).toBe("none");
});

it("refreshes monitor sources and drops a choice whose device is gone", async () => {
  const media = setupLinux({
    enumerations: [
      [MIC, MONITOR],
      [MIC, USB_MONITOR],
    ],
  });
  await waitFor(() => expect(interviewerSelect()).toBeInTheDocument());
  fireEvent.change(interviewerSelect(), { target: { value: "mon-1" } });

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

  await screen.findByRole("option", { name: "Monitor of USB Headset" });
  expect(
    screen.queryByRole("option", { name: "Monitor of Built-in Audio Analog Stereo" })
  ).toBeNull();
  expect(interviewerSelect()).toHaveValue("");
  expect(media.getUserMedia).not.toHaveBeenCalled();
});

it("explains when no monitor source is found", async () => {
  setupLinux({ enumerations: [[MIC]] });

  expect(await screen.findByText(/No system output monitor sources are visible/)).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Interviewer source" })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(localStorage.getItem("systemAudioEnabled")).toBe("false");
});

it("explains a denied audio permission and stays in microphone-only mode", async () => {
  const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  setupLinux({
    enumerations: [[{ kind: "audioinput", deviceId: "mic-1", label: "" }]],
    getUserMedia: vi.fn().mockRejectedValue(denied),
  });

  fireEvent.click(await screen.findByRole("button", { name: "Allow audio access" }));

  expect(await screen.findByText(/Audio access was not granted/)).toBeInTheDocument();
  const mic = screen.getByRole("combobox", { name: "Microphone" });
  expect(mic).toHaveValue("mic-1");
  expect(mic.options[0].textContent).toBe("Microphone 1");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(localStorage.getItem("systemAudioEnabled")).toBe("false");
});

it("keeps the Windows VB-Cable picker and records its source kind", async () => {
  window.callApi = {
    getPlatformCapabilities: vi.fn().mockResolvedValue({
      appSupported: true,
      systemAudio: { supported: true, strategy: "vb-cable", requiresCandidateConsent: false },
    }),
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream().stream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: "audioinput", deviceId: "mic-1", label: "Headset" },
        { kind: "audioinput", deviceId: "vb-1", label: "CABLE Output (VB-Audio Virtual Cable)" },
      ]),
    },
  });
  render(
    <MemoryRouter>
      <UIProvider>
        <Setup />
      </UIProvider>
    </MemoryRouter>
  );

  await screen.findByText(/System Audio \(VB-Cable/);
  await waitFor(() => expect(screen.getAllByRole("combobox")[1]).toHaveValue("vb-1"));
  expect(screen.queryByText(/Interviewer audio \(system output\)/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(localStorage.getItem("systemAudioEnabled")).toBe("true");
  expect(localStorage.getItem("sysId")).toBe("vb-1");
  expect(localStorage.getItem("interviewerSource")).toBe("vb-cable");
});
