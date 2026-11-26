#!/usr/bin/env node
/**
 * Post-deploy smoke test against a running backend. It never prints tokens,
 * tickets, or secrets, and it never calls a model or Deepgram (no audio and
 * no interviewer question are sent).
 *
 * Usage: node scripts/deploy/smoke.mjs https://caller.example.com [--app-id com.coworky.calllistener]
 *
 * Checks: TLS + /health, /ready (Redis), /auth/token with a fresh synthetic
 * installation (enrolls a random secret), a wrong secret is refused,
 * /ws-ticket, and a WebSocket handshake with that ticket (no context is sent,
 * so no model is called), then a reused ticket is refused.
 */
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";

const args = process.argv.slice(2);
const base = args.find((arg) => /^https?:\/\//.test(arg));
const appIdIndex = args.indexOf("--app-id");
const appId = appIdIndex >= 0 ? args[appIdIndex + 1] : "com.coworky.calllistener";
if (!base) {
  console.error("usage: node scripts/deploy/smoke.mjs https://<domain> [--app-id <id>]");
  process.exit(2);
}
const origin = new URL(base).origin;
const wsOrigin = origin.replace(/^http/, "ws");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

async function json(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const health = await fetch(`${origin}/health`).catch((error) => ({ ok: false, status: error.code || error.message }));
check("GET /health over TLS", health.ok, `status ${health.status}`);

const ready = await fetch(`${origin}/ready`).catch(() => null);
if (ready && ready.status !== 404) check("GET /ready (Redis)", ready.ok, `status ${ready.status}`);

// A synthetic installation: random ID and secret, used only by this run.
const deviceId = `smoke-${randomUUID()}`;
const secret = randomBytes(32).toString("base64url");
const tokenRequest = (deviceSecret) =>
  fetch(`${origin}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, device_id: deviceId, device_secret: deviceSecret }),
  });

const token = await tokenRequest(secret);
const cookie = token.headers.get("set-cookie")?.split(";")[0] ?? "";
check("POST /auth/token enrolls a new installation", token.status === 200 && cookie.startsWith("call_token="), `status ${token.status}`);

const wrong = await tokenRequest(randomBytes(32).toString("base64url"));
const wrongBody = await json(wrong);
check("a wrong installation secret is refused", wrong.status === 401 && wrongBody?.error === "device_secret_invalid", `status ${wrong.status}`);

const me = await fetch(`${origin}/auth/me`, { headers: { Cookie: cookie } });
check("GET /auth/me with the cookie", me.status === 200, `status ${me.status}`);

const ticketResponse = await fetch(`${origin}/ws-ticket`, { method: "POST", headers: { Cookie: cookie } });
const ticket = (await json(ticketResponse))?.ticket;
check("POST /ws-ticket", ticketResponse.status === 200 && typeof ticket === "string", `status ${ticketResponse.status}`);

function openSocket(withTicket) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${wsOrigin}/ws?ticket=${encodeURIComponent(withTicket)}`);
    const messages = [];
    const timer = setTimeout(() => {
      socket.terminate();
      resolve({ opened: false, closeCode: "timeout", messages });
    }, 10_000);
    let opened = false;
    let stillOpen = false;
    socket.on("open", () => {
      opened = true;
      // No context, audio, or question is sent: a context would start the
      // (paid) introductory suggestion. A socket that is still open after a
      // second passed authentication (a bad ticket closes at once with 4001).
      setTimeout(() => {
        stillOpen = socket.readyState === WebSocket.OPEN;
        socket.close(1000, "smoke done");
      }, 1_500);
    });
    socket.on("message", (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {}
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve({ opened, stillOpen, closeCode: code, messages });
    });
    socket.on("error", () => {});
  });
}

if (ticket) {
  const first = await openSocket(ticket);
  check("WebSocket handshake with the ticket stays open", first.opened && first.stillOpen, `close ${first.closeCode}`);
  const reused = await openSocket(ticket);
  check("a reused ticket is refused", reused.closeCode === 4001, `close ${reused.closeCode}`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
