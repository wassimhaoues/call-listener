# Prompt growth, context trimming and prompt caching

Roadmap Phase 6 asks for a benchmark of context trimming, prompt caching where supported, and optional summary scheduling, without losing evidence or candidate corrections. This page records a synthetic measurement and the decision.

## Method

`npm run bench:prompts` (backend, `scripts/bench/promptGrowth.js`) replays a 60-question synthetic interview through the real `buildPrompt`, evidence selector and bounded chat history (in-memory Redis). It needs no network, provider or real CV. The synthetic context is a typical mid-sized one: about 7.7 KB of JSON, 10 skills, 8 achievements, 8 requirements and 8 evidence references. Each question adds three history entries: the interviewer question, the candidate's spoken answer, and the suggestion. Tokens are estimated as characters / 4, the same conservative rule the budget uses when a provider omits usage.

For caching, it measures how much of each request repeats the previous request byte for byte from the start. Implicit prefix caching (the default `openai/*` model family on OpenRouter) can reuse that part once at least 1024 tokens match. Two layouts are compared:

- **current:** the system prompt (instructions, candidate, job, the evidence selected for this question, settings, format), then the history.
- **evidence-last** (not used in production): the same text, with the per-question evidence moved after the history.

## Results (2026-11-26, 60 questions)

| History entries | Last request (tokens) | Largest request | Total input (60 questions) | Reusable prefix, current | Reusable prefix, evidence-last |
| --- | --- | --- | --- | --- | --- |
| 20 | 3205 | 3205 | 186562 | 95813 (51%) | 99542 (53%) |
| 40 (production) | 4571 | 4577 | 254757 | 99443 (39%) | 112963 (44%) |
| 80 | 7460 | 7460 | 369281 | 107364 (29%) | 165776 (45%) |

Reading the table:

- **Growth is bounded.** With the production limit of 40 entries (about 13 questions of history), a request levels off near 4,600 input tokens however long the interview runs. A 60-question interview sends about 255,000 input tokens in total: about $0.05 at the default model's configured $0.20 per million, or about $0.76 at $3 per million. Both are far below `MAX_INTERVIEW_COST_USD=5`.
- **Trimming further saves little and costs context.** 20 entries saves about 27% of input but keeps only about 6 questions of history. That gives the model less of the earlier conversation to stay consistent with (evidence selection itself only looks back 6 lines). 80 entries adds about 45% for history the classifier and evidence selector do not need.
- **The current layout is already cache-friendly.** The stable part (instructions, candidate and job data) comes first, so about 39% of all input tokens are an exact repeat of the previous request's prefix. Moving the evidence after the history would add only 5 points at 40 entries. Once the history is full, trimming its oldest entry changes the start of the history on every request, so the history rarely extends the shared prefix.

## Decision

- Keep the 40-entry history bound and the current prompt layout. A layout change would need a new offline evaluation run (prompt text changes) for about 5 points of cache reuse.
- Do not add summary scheduling. Prompts are already bounded, and a summary would be an extra model call per interview. It could also drop candidate corrections, which the roadmap requires keeping.
- Prompt caching needs no code: the default model family caches eligible prefixes automatically. The budget still charges every input token at full price, so reported spend is an upper bound when caching applies. Explicit caching (for example Anthropic `cache_control`) is only worth adding if a pilot model without implicit caching becomes the default.
- **Revisit** if pilot contexts are much larger than this synthetic one (long CVs and job descriptions near the 12–16 KB field limits), or if a live run shows real cached-token reporting very different from this estimate.
