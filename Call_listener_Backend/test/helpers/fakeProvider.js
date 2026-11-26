/**
 * Fixture-driven stand-in for `ChatOpenRouter`, injected into the real
 * OpenRouter adapter. Each `invoke` consumes the next scripted response name.
 *
 * Response kinds:
 * - `success`: returns `content` with optional `usage_metadata` / `response_metadata`.
 * - `error`: rejects with an Error carrying `status`, `name`, and optional
 *   `headers` (e.g. `retry-after`). A `connectionCode` instead models a fetch
 *   connection failure (no status, `cause.code` such as `ECONNREFUSED`).
 * - `hang`: settles only when the request signal aborts (caller abort or deadline).
 * - `deferred`: resolves with `content` when the test calls `call.release()`.
 * - `stream`: (for `stream` calls) yields `chunks` one per event-loop turn; the
 *   last chunk carries `usage_metadata` when given. With `thenHang`, the stream
 *   stays open after the chunks until the request signal aborts. With
 *   `thenError` (an `error` spec), the stream fails after its chunks.
 *
 * `stream(messages, { signal })` plays any kind back as a chunk stream: a
 * `stream` spec yields its chunks, other kinds yield their single response
 * (or reject) exactly as `invoke` would. `invoke` rejects a `stream` spec.
 *
 * `failFirst: { times, error }` makes the first `times` calls fail with the
 * inline `error` spec (same fields as an `error` response) before the script
 * is consumed, to exercise the adapter's retries. `instances` records each
 * constructed client's options.
 */
function providerError(spec) {
  const error = new Error(spec.message || `synthetic provider error ${spec.status ?? spec.connectionCode}`);
  error.name = spec.name || "Error";
  if (spec.status !== undefined) error.status = spec.status;
  if (spec.headers) error.headers = { ...spec.headers };
  if (spec.connectionCode) error.cause = { code: spec.connectionCode };
  return error;
}

export function createFakeChatOpenRouter({ responses, script = [], failFirst } = {}) {
  const queue = [...script];
  const calls = [];
  const instances = [];
  let failuresLeft = failFirst?.times ?? 0;

  function untilAborted(signal) {
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  async function* streamChunks(spec, signal, call) {
    if (spec.kind !== "stream") {
      yield await respond(spec, signal, call);
      return;
    }
    for (const [index, content] of spec.chunks.entries()) {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) throw signal.reason;
      const last = index === spec.chunks.length - 1;
      call.chunksYielded = index + 1;
      yield {
        content,
        usage_metadata: last ? spec.usage_metadata : undefined,
        response_metadata: last && spec.response_metadata ? spec.response_metadata : {},
      };
    }
    if (spec.thenHang) await untilAborted(signal);
    if (spec.thenError) throw providerError(spec.thenError);
  }

  function respond(spec, signal, call) {
    if (spec.kind === "success") {
      return Promise.resolve({
        content: spec.content,
        usage_metadata: spec.usage_metadata,
        response_metadata: spec.response_metadata || {},
      });
    }
    if (spec.kind === "error") return Promise.reject(providerError(spec));
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

  function startCall(messages, mode) {
    const failure = failuresLeft > 0 ? failFirst.error : null;
    if (failure) failuresLeft -= 1;
    const name = failure ? null : queue.shift();
    const call = {
      name: name ?? null,
      mode,
      system: messages[0]?.content,
      history: messages[1]?.content,
      status: "pending",
      failure: failure ? { kind: "error", ...failure } : null,
    };
    calls.push(call);
    return call;
  }

  function specFor(call) {
    if (call.failure) return call.failure;
    if (!call.name) throw new Error("Unexpected provider call: no scripted response left");
    const spec = responses[call.name];
    if (!spec) throw new Error(`Unknown provider fixture: ${call.name}`);
    return spec;
  }

  class FakeChatOpenRouter {
    constructor(options) {
      this.options = options;
      instances.push(options);
    }

    async stream(messages, { signal } = {}) {
      const call = startCall(messages, "stream");
      let spec;
      try {
        spec = specFor(call);
      } catch (error) {
        call.status = "rejected";
        call.error = error;
        throw error;
      }
      return (async function* tracked() {
        try {
          yield* streamChunks(spec, signal, call);
          call.status = "resolved";
        } catch (error) {
          call.status = "rejected";
          call.error = error;
          throw error;
        } finally {
          // An abandoned iterator (consumer stopped early) is not pending.
          if (call.status === "pending") call.status = "rejected";
        }
      })();
    }

    async invoke(messages, { signal } = {}) {
      const call = startCall(messages, "invoke");
      try {
        const spec = specFor(call);
        if (spec.kind === "stream") throw new Error(`Fixture ${call.name} is stream-only`);
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
    instances,
    enqueue: (...names) => queue.push(...names),
    remaining: () => queue.length,
    pendingCount: () => calls.filter((call) => call.status === "pending").length,
  };
}
