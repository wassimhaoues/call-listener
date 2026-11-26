import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Docker build context excludes every local environment file", () => {
  const dockerIgnore = fs.readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(dockerIgnore, /^\.env\*$/m);
  assert.match(dockerfile, /COPY --chown=nodeusr:nodegrp \. \./);
});

test("Traefik routes only /ws and /ws/... to the WebSocket server, so POST /ws-ticket reaches Express", () => {
  const stack = fs.readFileSync(new URL("../call-listener-stack.yml", import.meta.url), "utf8");
  const rule = stack.match(/routers\.call-ws\.rule=(.*)"/)?.[1];
  assert.ok(rule, "the WebSocket router rule is present");
  assert.ok(rule.includes("Path(`/ws`)"));
  assert.ok(rule.includes("PathPrefix(`/ws/`)"));
  assert.ok(!rule.includes("PathPrefix(`/ws`)"), "a bare /ws prefix would also match /ws-ticket");
});
