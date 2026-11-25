import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Context from "../src/pages/Context.jsx";
import { UIProvider } from "../src/ui/UIContext.jsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("stores a versioned candidate and job-offer payload before an interview", () => {
  const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
  render(
    <MemoryRouter>
      <UIProvider><Context /></UIProvider>
    </MemoryRouter>
  );

  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Platform Engineer" } });
  fireEvent.change(screen.getByLabelText(/Relevant skills/), { target: { value: "Node.js, Redis" } });
  fireEvent.change(screen.getByLabelText(/Achievements or examples/), { target: { value: "Improved deployment time\nLed migration" } });
  fireEvent.change(screen.getByLabelText("Answer language"), { target: { value: "en" } });
  fireEvent.click(screen.getByRole("button", { name: "Start Interview" }));

  expect(alert).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem("callContext"))).toMatchObject({
    version: 1,
    candidate: {
      name: "Ada",
      skills: ["Node.js", "Redis"],
      achievements: ["Improved deployment time", "Led migration"],
    },
    jobOffer: { title: "Platform Engineer" },
    settings: { language: "en" },
  });
  alert.mockRestore();
});

it("extracts editable local preparation facts without storing the pasted CV", () => {
  render(
    <MemoryRouter>
      <UIProvider><Context /></UIProvider>
    </MemoryRouter>
  );
  fireEvent.change(screen.getByLabelText("Paste CV text (kept in this screen only)"), {
    target: { value: "Skills: Node.js, Redis\nLed a Redis migration" },
  });
  fireEvent.change(screen.getByLabelText("Pasted job description or requirements"), {
    target: { value: "Requirements: Node.js and Redis experience." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Extract facts locally" }));

  expect(screen.getByLabelText(/Relevant skills/)).toHaveValue("Node.js, Redis");
  expect(screen.getByLabelText(/Achievements or examples/)).toHaveValue("Led a Redis migration");
  expect(screen.getByLabelText("Job requirements (editable, one per line)")).toHaveValue(
    "Requirements: Node.js and Redis experience."
  );
  expect(localStorage.getItem("callContext")).toBeNull();
});

it("imports legacy data only after candidate confirmation and keeps a local backup", () => {
  const legacy = {
    caller: { description: "Legacy call details", other: "Do not treat as candidate evidence" },
    me: { name: "Ada", description: "Platform engineer", objectives: "Find a new role" },
  };
  localStorage.setItem("callContext", JSON.stringify(legacy));
  render(
    <MemoryRouter>
      <UIProvider><Context /></UIProvider>
    </MemoryRouter>
  );

  expect(screen.getByText("Legacy preparation data found")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Import legacy draft" }));

  expect(screen.getByLabelText("Your name")).toHaveValue("Ada");
  expect(screen.getByLabelText("Relevant experience or profile")).toHaveValue("Platform engineer");
  expect(screen.getByLabelText(/Achievements or examples/)).toHaveValue("");
  expect(JSON.parse(localStorage.getItem("callContextLegacyBackup"))).toEqual(legacy);
});
