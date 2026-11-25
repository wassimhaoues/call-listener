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
