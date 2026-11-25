import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Docker build context excludes every local environment file", () => {
  const dockerIgnore = fs.readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(dockerIgnore, /^\.env\*$/m);
  assert.match(dockerfile, /COPY --chown=nodeusr:nodegrp \. \./);
});
