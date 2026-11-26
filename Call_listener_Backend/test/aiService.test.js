import test from "node:test";
import assert from "node:assert/strict";
import { createAiReplyGenerator } from "../server/services/ai/aiService.js";

const silentLog = { info() {}, error() {} };

test("uses the existing Groq contract through the provider-neutral generator", async () => {
  let request;
  class FakeGroq {
    constructor({ apiKey }) {
      assert.equal(apiKey, "groq-test-key");
      this.chat = {
        completions: {
          create: async (payload) => {
            request = payload;
            return { choices: [{ message: { content: "  Groq answer.  " } }] };
          },
        },
      };
    }
  }

  const generateReply = createAiReplyGenerator({
    provider: "groq",
    groqApiKey: "groq-test-key",
    groqModel: "test-groq-model",
    log: silentLog,
    dependencies: { groq: { GroqClient: FakeGroq } },
  });

  assert.equal(await generateReply("system prompt", "history"), "Groq answer.");
  assert.deepEqual(request, {
    model: "test-groq-model",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "history" },
    ],
  });
});

test("uses the LangChain OpenRouter adapter without a network call in tests", async () => {
  let invokedMessages;
  let invokedOptions;
  class FakeChatOpenRouter {
    constructor({ apiKey, model, maxTokens }) {
      assert.equal(apiKey, "openrouter-test-key");
      assert.equal(model, "openai/gpt-4.1-mini");
      assert.equal(maxTokens, 600);
    }

    async invoke(messages, options) {
      invokedMessages = messages;
      invokedOptions = options;
      return {
        content: [{ text: "OpenRouter answer." }],
        usage_metadata: { input_tokens: 12, output_tokens: 4 },
      };
    }
  }

  const generateReply = createAiReplyGenerator({
    provider: "openrouter",
    openRouterApiKey: "openrouter-test-key",
    openRouterModel: "openai/gpt-4.1-mini",
    openRouterMaxOutputTokens: 600,
    log: silentLog,
    dependencies: { openrouter: { ChatOpenRouterClass: FakeChatOpenRouter } },
  });

  const controller = new AbortController();
  let usage;
  assert.equal(
    await generateReply("system prompt", "history", {
      signal: controller.signal,
      onUsage: (value) => { usage = value; },
    }),
    "OpenRouter answer."
  );
  assert.equal(invokedMessages[0].content, "system prompt");
  assert.equal(invokedMessages[1].content, "history");
  assert.notEqual(invokedOptions.signal, controller.signal);
  assert.equal(invokedOptions.signal.aborted, false);
  assert.deepEqual(usage, { input_tokens: 12, output_tokens: 4 });
});

test("pins an allowlisted per-request model and reports the provider's actual model", async () => {
  const constructed = [];
  class FakeChatOpenRouter {
    constructor({ model }) {
      constructed.push(model);
      this.model = model;
    }

    async invoke() {
      return {
        content: `answer from ${this.model}`,
        response_metadata: { model_name: `${this.model}-20260101` },
      };
    }
  }

  const generateReply = createAiReplyGenerator({
    provider: "openrouter",
    openRouterApiKey: "openrouter-test-key",
    openRouterModel: "openai/gpt-4.1-mini",
    openRouterAllowedModels: ["openai/gpt-4.1-mini", "anthropic/claude-test"],
    log: silentLog,
    dependencies: { openrouter: { ChatOpenRouterClass: FakeChatOpenRouter } },
  });

  const seen = [];
  const onModel = (info) => seen.push(info);
  assert.equal(await generateReply("s", "h", { onModel }), "answer from openai/gpt-4.1-mini");
  assert.equal(
    await generateReply("s", "h", { model: "anthropic/claude-test", onModel }),
    "answer from anthropic/claude-test"
  );
  await generateReply("s", "h", { model: "anthropic/claude-test", onModel });
  assert.deepEqual(constructed, ["openai/gpt-4.1-mini", "anthropic/claude-test"], "clients are reused per model");
  assert.deepEqual(seen, [
    { selected: "openai/gpt-4.1-mini", actual: "openai/gpt-4.1-mini-20260101" },
    { selected: "anthropic/claude-test", actual: "anthropic/claude-test-20260101" },
    { selected: "anthropic/claude-test", actual: "anthropic/claude-test-20260101" },
  ]);

  await assert.rejects(
    generateReply("s", "h", { model: "not/allowlisted" }),
    (error) => error.code === "unsupported_model"
  );
  assert.equal(constructed.length, 2);
});

test("the Groq rollback adapter ignores per-request model overrides", async () => {
  let request;
  class FakeGroq {
    constructor() {
      this.chat = {
        completions: {
          create: async (payload) => {
            request = payload;
            return { model: "groq-actual", choices: [{ message: { content: "ok" } }] };
          },
        },
      };
    }
  }
  const generateReply = createAiReplyGenerator({
    provider: "groq",
    groqApiKey: "groq-test-key",
    groqModel: "test-groq-model",
    log: silentLog,
    dependencies: { groq: { GroqClient: FakeGroq } },
  });
  let info;
  await generateReply("s", "h", { model: "other/model", onModel: (value) => { info = value; } });
  assert.equal(request.model, "test-groq-model");
  assert.deepEqual(info, { selected: "test-groq-model", actual: "groq-actual" });
});

test("normalizes an OpenRouter request deadline without retrying the request", async () => {
  let calls = 0;
  class SlowChatOpenRouter {
    async invoke(_messages, { signal }) {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  }

  const generateReply = createAiReplyGenerator({
    provider: "openrouter",
    openRouterApiKey: "openrouter-test-key",
    openRouterModel: "openai/gpt-4.1-mini",
    openRouterMaxOutputTokens: 600,
    openRouterRequestTimeoutMs: 5,
    log: silentLog,
    dependencies: { openrouter: { ChatOpenRouterClass: SlowChatOpenRouter } },
  });

  await assert.rejects(
    generateReply("system prompt", "history"),
    (error) => error.code === "provider_timeout"
  );
  assert.equal(calls, 1);
});

test("rejects unsupported providers and missing provider keys", () => {
  assert.throws(
    () => createAiReplyGenerator({ provider: "other" }),
    /Unsupported AI provider/
  );
  assert.throws(
    () => createAiReplyGenerator({ provider: "groq" }),
    /Groq apiKey is required/
  );
  assert.throws(
    () => createAiReplyGenerator({ provider: "openrouter", openRouterApiKey: "key" }),
    /OpenRouter model is required/
  );
});
