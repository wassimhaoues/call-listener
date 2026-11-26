# Provider Retries and Request Idempotency

Status: implemented in `Call_listener_Backend/server/services/ai/openRouterService.js` (2026-11-26).

This page defines when the OpenRouter adapter may send a model request again. A model request is paid and may already be visible to the candidate, so the adapter cannot treat it as an ordinary idempotent HTTP call. OpenRouter has no idempotency key that would deduplicate a retried completion. The adapter therefore makes a retry safe by sending one only when the failed attempt cannot have produced a billed completion or any candidate-visible text.

## Rules

A failed attempt is retried only when all of these hold:

1. **Nothing was billed.** The attempt reported no token usage (`usage_metadata` or `response_metadata.usage`).
2. **Nothing was shown.** No streamed text delta was forwarded to `onToken`. Once the first delta reaches the candidate, a failure surfaces as an error. A stream never restarts mid-answer, because a second answer would contradict or duplicate the first.
3. **The failure means "no completion was produced."** Only these failures qualify:
   - HTTP `429` (rate limited), `502`, `503`, or `504` (gateway or upstream unavailable), received before any streamed token.
   - A connection failure raised before the request reached the provider: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, or `UND_ERR_CONNECT_TIMEOUT`.
4. **The caller still wants the answer.** The request is not aborted. Supersede by a newer question, session end or close, and the request deadline all abort the request, and no attempt starts afterwards. An abort during the backoff wait ends the wait at once.
5. **Attempts remain.** At most `OPENROUTER_MAX_RETRIES` retries (integer `0`–`2`, default `1`) follow the first attempt.
6. **The deadline fits.** The wait plus a minimum useful attempt time (1 second) must fit in what is left of the request deadline.

These failures are never retried:

- `400` (unsupported parameters), `401`/`403` (invalid key or forbidden), `404` (removed or unknown model), and other `4xx` statuses. Repeating the request gives the same answer.
- `ECONNRESET` and other mid-connection failures. The request may already have been sent, so the provider may be generating and billing.
- Errors raised inside a stream that has no HTTP status (for example a malformed or truncated event stream). An incomplete stream that ends without an error is returned as it is.
- Any attempt that already reported usage, even when its status would qualify.
- `unsupported_model` (rejected by the allowlist before any request).

## Timing

- **Single deadline.** Every attempt and every backoff wait shares the request deadline (`OPENROUTER_REQUEST_TIMEOUT_MS`, or the per-request `timeoutMs` used by preparation and the debrief). A retry never extends it. When the deadline fires during an attempt or a wait, the request fails with `provider_timeout`.
- **Backoff.** The adapter waits a random delay of 250–1,000 ms (uniform jitter, so simultaneous sessions do not retry in step).
- **Retry-After.** When the failure carries `Retry-After` (delta-seconds or an HTTP date), the wait is at least that long. When `Retry-After` plus the minimum attempt time does not fit in the remaining deadline, the adapter does not retry. It surfaces the original failure at once instead of waiting until the deadline fires.

## LangChain's built-in retries

`ChatOpenRouter` inherits LangChain's `AsyncCaller`, which by default retries failed requests up to six times with exponential backoff. Before this change those hidden retries were active and bounded only by the request deadline. The adapter now constructs every client with `maxRetries: 0`, so the policy on this page is the only retry logic.

## Budget and accounting

- `onUsage` is called at most once per request. It is called for the successful attempt, or for a failed attempt that reported usage. Because the rules never retry an attempt that reported usage, at most one attempt per request can be billed.
- A failed attempt that reported usage is now charged (previously it was dropped). Its `outputChars` is the text streamed before the failure. If accounting itself fails, the error is logged and the provider error is still returned.
- The usage basis gains `attempts`: `onUsage(usage, { inputChars, outputChars, model, actualModel, attempts })`. Budgets ignore it. It is not sent to the client.
- Failed attempts without usage cost nothing and are not estimated. The estimate fallback applies only to the charged attempt.

## Logging

Each retried attempt logs one warning with the attempt number, the HTTP status or connection code, and the wait, for example `OpenRouter attempt 1 failed (status 503); retrying in 412 ms`. It never logs provider messages, prompts, or transcript text. The final error log records the normalized code and the attempt count.

## Contract

- Normalized errors are unchanged: `provider_timeout`, `provider_aborted`, `provider_request_failed`, and `unsupported_model`. `error.cause` is the last attempt's error.
- The WebSocket and HTTP protocols are unchanged. A retry is invisible to the client except as extra latency within the same deadline.
- Configuration: `OPENROUTER_MAX_RETRIES` (default `1`; `0` disables retries; startup rejects values outside `0`–`2`). It applies to live suggestions, the debrief, and the preparation brief. The offline evaluation runner always uses `0`.

## Tests

`Call_listener_Backend/test/providerRetries.test.js` and the shared cases in `test/fixtures/providerResponses.json` (run by `test/providerFixtures.test.js`) cover:

- 429 then success
- 503 on every attempt, failing after the maximum
- the `0` and `2` retry bounds
- 401, 404, and 400 without retry (invoke and stream)
- a refused connection retried and a reset connection not retried
- an abort during the backoff wait, and an abort during an attempt
- a deadline too short for a retry, and a retry that times out within the original deadline
- a stream failure before the first token (retried) and after it (not retried)
- `Retry-After` honoured, or skipped when it exceeds the deadline
- budget charging for a retried request and for a failed attempt that reported usage
- LangChain retries disabled

## Revisit when

- OpenRouter offers request idempotency keys or generation lookup, so a retry could reuse a completion already billed.
- Live measurements show 429/5xx rates or latency that justify a different maximum or backoff window.
