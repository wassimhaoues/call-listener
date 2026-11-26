import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AuthError, { authErrorCopy } from "../src/pages/AuthError.jsx";
import { UIProvider } from "../src/ui/UIContext.jsx";

const { AUTH_FAILURE, classifyAuthFailure } = require("../services/authFailure.js");
const { AuthManager } = require("../services/auth.js");

const withCode = (code) => Object.assign(new Error(code), { code });

afterEach(() => cleanup());

describe("classifyAuthFailure", () => {
  it("reports offline only when the OS has no network", () => {
    expect(classifyAuthFailure(withCode("ENOTFOUND"), { online: false })).toBe(
      AUTH_FAILURE.OFFLINE
    );
    expect(classifyAuthFailure(withCode("ENOTFOUND"), { online: true })).toBe(
      AUTH_FAILURE.SERVER_UNREACHABLE
    );
  });

  it("treats refused, reset, timed-out, and unknown failures as server unreachable", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", undefined]) {
      expect(classifyAuthFailure(withCode(code))).toBe(AUTH_FAILURE.SERVER_UNREACHABLE);
    }
    expect(classifyAuthFailure(new SyntaxError("bad json"))).toBe(
      AUTH_FAILURE.SERVER_UNREACHABLE
    );
    expect(classifyAuthFailure(undefined)).toBe(AUTH_FAILURE.SERVER_UNREACHABLE);
  });

  it("recognises TLS and certificate errors", () => {
    for (const code of [
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
    ]) {
      expect(classifyAuthFailure(withCode(code))).toBe(AUTH_FAILURE.TLS);
    }
  });

  it("recognises HTTP error responses", () => {
    expect(classifyAuthFailure(Object.assign(new Error("x"), { statusCode: 503 }))).toBe(
      AUTH_FAILURE.HTTP
    );
  });

  it("gets an HTTP status from AuthManager token failures", async () => {
    const requestClient = {
      request(options, onResponse) {
        const handlers = {};
        return {
          on() {},
          write() {},
          end() {
            onResponse({ statusCode: 502, on: (event, handler) => (handlers[event] = handler) });
            handlers.data("Bad gateway");
            handlers.end();
          },
        };
      },
    };
    const auth = new AuthManager({
      requestClient,
      appId: "com.coworky.calllistener",
      backendHost: "call.example.test",
      electronSession: { cookies: { set: async () => {} } },
      deviceId: "44d8a725-37db-4cc2-82ed-6d9e23c0db98",
    });
    const error = await auth.ensure().catch((err) => err);
    expect(error.statusCode).toBe(502);
    expect(classifyAuthFailure(error)).toBe(AUTH_FAILURE.HTTP);
  });
});

function renderAuthError(entry) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <UIProvider>
        <Routes>
          <Route path="/autherror" element={<AuthError />} />
        </Routes>
      </UIProvider>
    </MemoryRouter>
  );
}

describe("AuthError page", () => {
  it("keeps the offline copy when no reason is given", () => {
    renderAuthError("/autherror");
    expect(screen.getByText("You're offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("does not blame the network when the server is unreachable", () => {
    renderAuthError("/autherror?reason=server_unreachable");
    expect(screen.getByText("Can't reach the Call Listener server")).toBeInTheDocument();
    expect(screen.queryByText("You're offline")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("has specific copy for TLS and HTTP failures and falls back to offline", () => {
    expect(authErrorCopy("tls").body).toMatch(/certificate or TLS/);
    expect(authErrorCopy("http").body).toMatch(/returned an error/);
    expect(authErrorCopy("bogus").title).toBe("You're offline");
  });

  it("explains a disabled installation", () => {
    expect(classifyAuthFailure(Object.assign(new Error("device_revoked"), { code: "device_revoked", statusCode: 403 })))
      .toBe(AUTH_FAILURE.REVOKED);
    expect(authErrorCopy("revoked").title).toBe("This installation has been disabled");
  });
});
