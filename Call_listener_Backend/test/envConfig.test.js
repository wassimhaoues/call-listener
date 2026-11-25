import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);
const envModuleUrl = new URL("../server/config/env.js", import.meta.url).href;

test("OpenRouter configuration does not require a Groq key", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(CONFIG.AI_PROVIDER);`,
    ],
    {
      cwd: os.tmpdir(),
      env: {
        PATH: process.env.PATH,
        AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "test-openrouter-key",
        DEEPGRAM_API_KEY: "test-deepgram-key",
        REDIS_URL: "redis://127.0.0.1:6379",
        APP_ID: "com.coworky.calllistener",
        JWT_SECRET: "test-jwt-secret",
        JWT_TTL_SECONDS: "900",
      },
    }
  );

  assert.equal(stdout, "openrouter");
});
