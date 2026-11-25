import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Context from "../src/pages/Context.jsx";
import { UIProvider } from "../src/ui/UIContext.jsx";

const catalog = {
  provider: "openrouter",
  defaultModel: "openai/gpt-5.6-luna",
  models: [
    { id: "openai/gpt-5.6-luna", name: "Luna", availability: "available", isDefault: true },
    { id: "anthropic/claude-test", name: "Claude Test", availability: "unknown", isDefault: false },
    { id: "removed/model", name: "removed/model", availability: "unavailable", isDefault: false },
  ],
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.callApi;
});

function renderContext() {
  return render(
    <MemoryRouter>
      <UIProvider><Context /></UIProvider>
    </MemoryRouter>
  );
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Platform Engineer" } });
}

it("lists allowlisted models, disables unavailable ones and persists the choice", async () => {
  window.callApi = { getModels: vi.fn(async () => catalog) };
  renderContext();

  const picker = await screen.findByLabelText("AI model");
  expect(screen.getByRole("option", { name: "Server default (openai/gpt-5.6-luna)" })).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "Claude Test (anthropic/claude-test) — availability unknown" })
  ).not.toBeDisabled();
  expect(screen.getByRole("option", { name: "removed/model — unavailable" })).toBeDisabled();

  fireEvent.change(picker, { target: { value: "anthropic/claude-test" } });
  fillRequiredFields();
  fireEvent.click(screen.getByRole("button", { name: "Start Interview" }));

  expect(JSON.parse(localStorage.getItem("callContext")).settings.model).toBe("anthropic/claude-test");
});

it("omits the model when the server default is kept", async () => {
  window.callApi = { getModels: vi.fn(async () => catalog) };
  renderContext();
  await screen.findByLabelText("AI model");
  fillRequiredFields();
  fireEvent.click(screen.getByRole("button", { name: "Start Interview" }));

  expect(JSON.parse(localStorage.getItem("callContext")).settings).not.toHaveProperty("model");
});

it("tells the candidate when a saved model is no longer offered", async () => {
  localStorage.setItem("callContext", JSON.stringify({
    version: 1,
    candidate: { name: "Ada" },
    jobOffer: { title: "Platform Engineer" },
    settings: { language: "en", model: "retired/model" },
  }));
  window.callApi = { getModels: vi.fn(async () => catalog) };
  renderContext();

  expect(await screen.findByRole("status")).toHaveTextContent("retired/model is no longer offered");
  expect(screen.getByLabelText("AI model")).toHaveValue("");
});

it("falls back to the server default when the catalog cannot be loaded", async () => {
  window.callApi = { getModels: vi.fn(async () => null) };
  renderContext();

  expect(await screen.findByText(/server default model will be used/)).toBeInTheDocument();
  expect(screen.queryByLabelText("AI model")).toBeNull();
});
