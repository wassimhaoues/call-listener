# Offline Evaluation of Live Suggestions

This harness supports the Phase 4 roadmap item "Evaluate graph output against a simple interview-aware LangChain chain on identical fixtures". It runs the production LangGraph path and a single-prompt baseline over the same synthetic interview questions, scores every answer with deterministic checks, and writes a comparison report. **By default it costs nothing**: the default provider is a deterministic fake, and a paid run needs three explicit opt-ins (see [cost guard](#cost-guard)).

The checks are proxies. They do not replace the human usefulness review in [validation and rollout](05-validation-and-rollout.md#quality-evaluation) (at least 90% of sampled answers judged useful against a written rubric). An LLM-as-judge is out of scope.

## Layout (`Call_listener_Backend/`)

| Path | Contents |
| --- | --- |
| `scripts/eval/runEval.js` | CLI (`npm run eval`). Parses options, resolves the provider, runs, and writes the report. |
| `scripts/eval/lib/variants.js` | The `graph` and `chain` variants. |
| `scripts/eval/lib/providers.js` | The deterministic fake provider, the abort-only generator used by the cancellation check, and the live OpenRouter adapter factory. |
| `scripts/eval/lib/metrics.js` | Metric functions and per-variant aggregation. |
| `scripts/eval/lib/costGuard.js` | Provider configuration, cost estimate, and spend guard. |
| `scripts/eval/lib/fixtures.js` | Fixture schema and suite validation. |
| `scripts/eval/lib/safePaths.js` | The backend root constant and the safe file-name checks. |
| `scripts/eval/lib/harness.js`, `report.js` | The run loop, Phase 4 gate mapping, and JSON/Markdown output. |
| `test/fixtures/eval/*.json` | Evaluation cases. |
| `../eval-results/` (repository root) | Generated reports. Git-ignored. |

No production code under `server/` was changed. Both variants call the existing `generateReply(systemPrompt, history, options)` contract, and the graph variant is `createInterviewWorkflow` with the real `buildPrompt`. These existing seams were enough.

## Variants

- **`graph`** is the production path: `server/services/interview/interviewWorkflow.js` (`selectEvidence` → `generateSuggestion`) with the real `promptBuilder.js`. `selectRelevantEvidence` puts at most three evidence references in the prompt, and the report records which ones.
- **`chain`** is the rollback baseline: a LangChain `RunnableSequence` that builds one prompt and makes one model call. The prompt is `buildPrompt(context, "reply")` with its evidence section replaced by **every** approved reference. There is no selection and no three-item cap.

Both variants get the same context JSON, history string (`caller:` for the interviewer and `you:` for the candidate, as `ChatHistory.toPrompt` writes it), model, and reply generator. Calls run one at a time.

## Fixtures

Each `test/fixtures/eval/*.json` file is one synthetic interview. All names, companies, and metrics are invented.

```jsonc
{
  "version": 1,
  "id": "en-backend-maya",
  "description": "...",
  "context": { "version": 1, "candidate": {}, "jobOffer": {}, "settings": {} }, // the production context, without evidence
  "evidence": [{ "id": "MAYA-E1", "requirement": "...", "evidence": "...", "keyTerms": ["Kafka pipeline"] }],
  "expectations": { "language": "en", "answerLength": "standard", "forbiddenClaims": ["Julien Marchetti", "Google"] },
  "questions": [{
    "id": "maya-q4", "type": "follow-up", "text": "What did you change afterwards?",
    "history": [{ "speaker": "interviewer", "text": "..." }, { "speaker": "candidate", "text": "..." }],
    "expectedEvidenceIds": ["MAYA-E4"]
  }]
}
```

Evidence IDs and key terms exist only in the fixture. The harness removes them before building the context it sends, so the payload is a valid `version: 1` context. Key terms are the distinctive phrases that show an answer used that piece of evidence.

The current suite has 26 questions over 4 cases:

| Case | Language | Answer length | Questions |
| --- | --- | --- | --- |
| `en-backend-maya` | en | standard | 7 |
| `fr-data-julien` | fr | short | 7 |
| `en-product-sana` | en | detailed | 6 |
| `fr-devops-lea` | fr | standard | 6 |

Every case has behavioral, technical, multipart, follow-up, and no-evidence questions. The forbidden claims list the other candidates' names and employers, plus invented employers and metrics.

Validation fails the run before any call if any of these rules is broken:
- The schema is strict: unknown keys are rejected.
- Each context must parse with `CandidateInterviewContextSchema`.
- The expected language and answer length must match `context.settings`.
- Each key term must appear in its own evidence text.
- A forbidden claim must not appear in the case's own context.
- Expected evidence IDs must exist.
- A question has no expected evidence exactly when its type is `no-evidence`.
- A multipart question needs at least two expected IDs.
- A follow-up question needs a preceding interviewer turn.
- Across the suite: IDs are unique, there are at least two distinct candidates, both languages are covered, every question type appears, and no case's key terms appear in another case's context. The last rule keeps the isolation check meaningful.

To add a case, copy a fixture, keep the data synthetic, add the new candidate's identifying facts to the other cases' `forbiddenClaims`, and run `npm test`. Keep a held-out set outside this directory for release qualification, as the validation plan asks.

## Running

```bash
cd Call_listener_Backend
npm run eval                                   # both variants, fake provider, free
npm run eval -- --variant graph                # one variant
npm run eval -- --provider openrouter --live --max-usd 0.05            # paid, capped
npm run eval -- --provider openrouter --live --max-usd 0.05 --model <allowlisted id>
```

Each run writes `<timestamp>-<fake|openrouter>.json` (all results, answers, scores, aggregates, gate, and fixture SHA-256 fingerprints) and a matching `.md` to `eval-results/` at the repository root. The Markdown has the per-variant comparison table, the Phase 4 gate table, and the failing cases.

The fixture and output directories are fixed, derived from the script's own location, and no command-line option can change them. No command-line text ever becomes part of a filesystem path. The report file name is built only from the run's timestamp and a provider tag chosen from a fixed allowlist (`fake` or `openrouter`). Fixture and report file names may contain only letters, digits, `.`, `_`, and `-`. Tests that need temporary directories pass `fixturesDir` / `outDir` to `main()` or to the library functions directly. The exit code is `0` for a completed run and `2` for a configuration, fixture, or cost-cap refusal. A failing gate does not change the exit code.

Fake-provider runs are a harness and pipeline check, not a model-quality measurement. The fake answers from the evidence in the prompt it receives. It uses evidence that matches the latest interviewer turn, then evidence that matches earlier turns, and it states that evidence is missing when nothing matches. So it shows what each variant's prompt makes possible. Its latency is local pipeline overhead only. Its token and cost columns show what the prompts would cost at the configured prices.

## Metrics

Each answer is scored, then the scores are aggregated per variant. Errors and skipped calls are counted but excluded from the quality rates.

| Metric | Definition |
| --- | --- |
| Grounding | No forbidden claim, no other case's evidence, and no unsupported number. A number is unsupported if it has two or more characters and does not appear in the case's context or evidence; this catches invented metrics. Terms match case-insensitively on whole terms, so "Meta" does not match "metadata", and across any whitespace. |
| Context isolation | The prompt and history contain no forbidden claim or other-case evidence, and the answer mentions no other-case evidence. |
| Question relevance | Every expected evidence item is mentioned (a key term appears). For a no-evidence question, the answer must say that the evidence is missing (`MISSING_EVIDENCE_MARKERS`, for example "don't have", "je n'ai pas", "clarif"). |
| Answer evidence recall | Expected evidence mentioned in the answer ÷ expected evidence. |
| Prompt evidence recall / precision | Expected evidence the variant put in the prompt ÷ expected evidence, and ÷ evidence sent. The graph exposes its selection. The chain always sends everything, so its recall is 100% and its precision is low by construction. |
| Missing evidence handled | The relevance rule for no-evidence questions on its own. |
| Language match | A stopword-ratio heuristic over small English and French stopword lists must detect the expected answer language. |
| Length compliance | At least 5 words for every setting. `short` allows at most 80 words and 3 sentences, which matches the prompt's instruction. `standard` allows at most 180 words and `detailed` at most 380, both under the 600-token output cap. |
| Latency p50 / p95 | Nearest-rank percentiles of wall time per call, from the start of the variant to the reply. This includes evidence selection and LangGraph overhead. |
| Tokens and cost | Reported usage when the provider gives it. Otherwise `ceil(chars / 4)`, as in `interviewBudget.js`. Cost is tokens × the run model's input/output price per million: its `OPENROUTER_MODEL_PRICES` entry, or for the default model `OPENROUTER_INPUT_USD_PER_MILLION_TOKENS` / `OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS` (default 0.2 / 1.2). A live reply whose served model is in the table is charged at that model's price. |
| Cancellation | Per variant, with a generator that only settles when it is aborted (never a provider). The variant must reject after the abort and produce no suggestion within 1 second. |

## Mapping to the Phase 4 exit gate

The [roadmap](04-roadmap.md) exit gate asks for "grounding, question relevance, cancellation, context isolation, and latency gates" and for proof that "the graph demonstrably improves usefulness without an unacceptable latency/cost increase". The report evaluates the graph against the chain with these proposed thresholds (`GATE_THRESHOLDS` in `harness.js`):

| Gate | Passes when |
| --- | --- |
| grounding | graph grounding = 100% |
| question relevance | graph relevance ≥ chain relevance |
| cancellation | the graph's cancellation check passes |
| context isolation | graph isolation = 100% |
| latency | graph p95 ≤ chain p95 × 1.25 + 100 ms |
| cost | graph cost ≤ chain cost × 1.25 |
| usefulness proxy | graph relevance > chain relevance, or equal relevance at lower cost |

The overall status is `pass`, `fail`, or `incomplete` (any error or skipped call). A pass on the fake provider only shows that the pipeline can meet the gate. The gate decision needs a capped live run on the selected model, the human rubric review, and the absolute latency targets in [validation and rollout](05-validation-and-rollout.md#performance-targets). Those targets apply to live numbers only.

The fake baseline currently fails the relevance and usefulness-proxy gates: the graph gets 85% relevance and the chain 100%. All four follow-up questions fail for the graph because `selectRelevantEvidence` scores only the latest interviewer turn. A short follow-up such as "What did you change afterwards?" matches nothing, so the graph falls back to the first three references and drops the evidence the conversation was about. The chain sends everything, so it answers these. In exchange, the graph's prompts use about 22% fewer input tokens. This is the "richer multipart/follow-up interpretation" item that the roadmap still lists as open.

## Cost guard

- `--provider fake` (the default) never makes a network call. `--live` and `--model` are rejected with the fake provider.
- `--provider openrouter` is refused unless **all** of these hold:
  - `--live` is passed.
  - `--max-usd <n>` is a positive number.
  - `OPENROUTER_API_KEY` is set.
  - `OPENROUTER_MAX_OUTPUT_TOKENS` (default 600) is a positive integer.
  - The model (`--model`, else `OPENROUTER_MODEL`) is in `OPENROUTER_ALLOWED_MODELS`, parsed with the server's `parseModelAllowlist`.
  - The model has a price, read like the server (`server/config/modelPrices.js`): an `OPENROUTER_MODEL_PRICES` entry, or the single-price pair for the default model only. A malformed table is refused for every provider.
  - Both of that model's per-million prices are positive. A zero price would make any cap meaningless.
- Before any call, the run prints its worst-case estimate: for each call, `ceil(prompt and history chars / 4)` input tokens plus the full output cap, priced at the selected model's rates. If the estimate exceeds `--max-usd`, the run stops with exit code 2 and sends nothing.
- During the run, the guard adds each call's actual cost (reported usage, or the estimate when usage is missing). It checks before every call that spent plus that call's worst case still fits under the cap. Otherwise it stops, and every remaining call is marked `skipped` with `max_usd_cap`. Calls run sequentially and without retries, so a refused call is never sent.
- The API key is passed only to the production OpenRouter adapter (`createOpenRouterReplyGenerator`). It is never printed or written to a report. Provider failures are recorded by error code only, never by message. `npm run eval` reads `Call_listener_Backend/.env` through dotenv, so prices and the allowlist match the server's configuration.

Prices are per model, as in the session budget (see [backend](../backend.md#per-model-pricing)); make sure the selected model's entry matches its current rates before a live run. The chars/4 heuristic can underestimate tokens for some languages and tokenizers. The full output cap usually dominates the estimate, and the running guard uses the reported usage.

## Tests

`test/evalMetrics.test.js` covers the metric functions. `test/evalHarness.test.js` covers:
- fixture and suite validation;
- the chain and graph prompts;
- the fake provider;
- the cost guard: refusal without `--live` or `--max-usd`, refusal when the estimate exceeds the cap, and a mid-run stop;
- a capped live run through the real adapter with a stubbed `ChatOpenRouter`, checking that the key is never written;
- a full fake run that produces both report files;
- error-code-only failure records and the cancellation check;
- the absence of path options, fixed report names, and safe file names.

Both files are listed in `npm test` and `npm run test:unit`.
