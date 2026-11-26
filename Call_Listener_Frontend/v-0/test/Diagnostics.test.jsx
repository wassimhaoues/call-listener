import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Diagnostics from "../src/pages/Diagnostics.jsx";
import Connecting from "../src/pages/Connecting.jsx";
import { UIProvider } from "../src/ui/UIContext.jsx";

const { buildDiagnostics } = require("../services/diagnostics.js");
const { getPlatformCapabilities } = require("../services/platformCapabilities.js");
const { createPlatformAudio } = require("../services/platformAudio/index.js");

afterEach(() => {
  cleanup();
  delete window.callApi;
});

function renderAt(path, element) {
  return render(
    <UIProvider>
      <MemoryRouter initialEntries={["/", path]} initialIndex={1}>
        <Routes>
          <Route path="/" element={<p>Home page</p>} />
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </UIProvider>
  );
}

function linuxSnapshot() {
  const capabilities = getPlatformCapabilities({ platform: "linux" });
  return buildDiagnostics({
    platform: "linux",
    arch: "x64",
    env: { XDG_SESSION_TYPE: "x11" },
    capabilities,
    audio: createPlatformAudio({ platform: "linux", capabilities }).describe(),
    appVersion: "1.0.0",
    electronVersion: "44.4.5",
  });
}

it("shows platform, capture strategy, versions, and actionable issues", async () => {
  window.callApi = { getDiagnostics: vi.fn(async () => linuxSnapshot()) };
  renderAt("/diagnostics", <Diagnostics />);

  expect(await screen.findByText("Linux (x64)")).toBeInTheDocument();
  expect(screen.getByText("X11")).toBeInTheDocument();
  expect(screen.getByText("Microphone only")).toBeInTheDocument();
  expect(screen.getByText("Not available")).toBeInTheDocument();
  expect(screen.getByText("linux-app-streams · idle")).toBeInTheDocument();
  expect(screen.getByText("1.0.0")).toBeInTheDocument();
  expect(screen.getByText("44.4.5")).toBeInTheDocument();
  expect(screen.getByText(/type the interviewer's questions/i)).toBeInTheDocument();
  // Linux never routes OS audio, so no routing row.
  expect(screen.queryByText("System audio routing")).not.toBeInTheDocument();
});

it("shows the routing row and errors for Windows", async () => {
  window.callApi = {
    getDiagnostics: vi.fn(async () =>
      buildDiagnostics({
        platform: "win32",
        arch: "x64",
        capabilities: getPlatformCapabilities({ platform: "win32" }),
        audio: {
          kind: "windows-vb-cable",
          controlsOsRouting: true,
          captureStrategy: "system-and-microphone",
          systemAudioAvailable: false,
          state: "error",
          routingActive: false,
          lastErrorCode: "startup-failed",
        },
        appVersion: "1.0.0",
        electronVersion: "44.4.5",
      })
    ),
  };
  renderAt("/diagnostics", <Diagnostics />);

  expect(await screen.findByText("System audio and microphone (VB-Cable)")).toBeInTheDocument();
  expect(screen.getByText("n/a")).toBeInTheDocument();
  expect(screen.getByText("Inactive")).toBeInTheDocument();
  expect(screen.getByText(/Error: Audio routing could not be prepared/)).toBeInTheDocument();
});

it("reports unavailable diagnostics and can refresh", async () => {
  const getDiagnostics = vi
    .fn()
    .mockRejectedValueOnce(new Error("ipc down"))
    .mockResolvedValueOnce(linuxSnapshot());
  window.callApi = { getDiagnostics };
  renderAt("/diagnostics", <Diagnostics />);

  expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/i);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Linux (x64)")).toBeInTheDocument();
  expect(getDiagnostics).toHaveBeenCalledTimes(2);
});

it("handles a missing preload bridge and navigates back", async () => {
  renderAt("/diagnostics", <Diagnostics />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByText("Home page")).toBeInTheDocument();
});

it("renders a neutral connecting screen", () => {
  renderAt("/connecting", <Connecting />);
  expect(screen.getByRole("status")).toHaveTextContent(/Signing in/);
});
