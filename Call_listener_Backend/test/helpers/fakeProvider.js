/**
 * Fixture-driven stand-in for `ChatOpenRouter`, injected into the real
 * OpenRouter adapter. Each `invoke` consumes the next scripted response name.
 *
 * Response kinds:
 * - `success`: returns `content` with optional `usage_metadata` / `response_metadata`.
 * - `error`: rejects with an Error carrying `status` and `name`.
 * - `hang`: settles only when the request signal aborts (caller abort or deadline).
 * - `deferred`: resolves with `content` when the test calls `call.release()`.
 */
export function createFakeChatOpenRouter({ responses, script = [] }) {
  const queue = [...script];
  const calls = [];

  function respond(spec, signal, call) {
    if (spec.kind === "success") {
      return Promise.resolve({
        content: spec.content,
        usage_metadata: spec.usage_metadata,
        response_metadata: spec.response_metadata || {},
      });
    }
    if (spec.kind === "error") {
      const error = new Error(spec.message);
      error.name = spec.name || "Error";
      error.status = spec.status;
      return Promise.reject(error);
    }
    if (spec.kind === "hang" || spec.kind === "deferred") {
      return new Promise((resolve, reject) => {
        if (spec.kind === "deferred") {
          call.release = () => resolve({ content: spec.content, response_metadata: {} });
        }
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return Promise.reject(new Error(`Unknown fake provider response kind: ${spec.kind}`));
  }

  class FakeChatOpenRouter {
    constructor(options) {
      this.options = options;
    }

    async invoke(messages, { signal } = {}) {
      const name = queue.shift();
      const call = {
        name: name ?? null,
        system: messages[0]?.content,
        history: messages[1]?.content,
        status: "pending",
      };
      calls.push(call);
      try {
        if (!name) throw new Error("Unexpected provider call: no scripted response left");
        const spec = responses[name];
        if (!spec) throw new Error(`Unknown provider fixture: ${name}`);
        const result = await respond(spec, signal, call);
        call.status = "resolved";
        return result;
      } catch (error) {
        call.status = "rejected";
        call.error = error;
        throw error;
      }
    }
  }

  return {
    ChatOpenRouterClass: FakeChatOpenRouter,
    calls,
    enqueue: (...names) => queue.push(...names),
    remaining: () => queue.length,
    pendingCount: () => calls.filter((call) => call.status === "pending").length,
  };
}
