# SPAI → SYNAPSE Agent

Source folder: `LLM/SPAI ` (the folder name has a trailing space).

The course documents teach AI engineering, not MEA inventory policy. Existing database business rules remain authoritative for CMP, health bands, suggested quantities and approval states.

| Source | Applied behavior |
| --- | --- |
| LLMs and Tool Use (SuperAI Level 2), pp. 14–16 | Send bounded recent conversation context so follow-up questions can identify the previous SKU or district. |
| LLMs and Tool Use, pp. 36–37 | Return actual tool results to Gemini for the next tool decision. Preserve the original Gemini model turn. |
| LLMs and Tool Use, pp. 41, 54–57 | Describe tool scope clearly, validate enum/identifier arguments, keep a small tool set, derive permissions in database code. |
| Agentic AI (Super AI Level 2), pp. 3, 14, 19 | Bounded tool feedback loop: discover risk, inspect replenishment evidence, inspect source warehouse stock when relevant. |
| Agentic AI, pp. 28–45, 51–56 | Six recent messages, bounded tool results, at most three reads per question; instructions in tool data are untrusted. |
| Agentic AI, pp. 60–62 | Human verifies business actions. Chat provides evidence and recommendations; existing approval and dispatch workflow executes them. |
| Super AI Engineer Database, pp. 18–27 | SQL relations, constraints and existing views supply structured inventory truth; no new vector store is needed for numeric inventory queries. |

The overview excludes missing stock/usage evidence from shortage classification. It returns critical/watch districts and, for delivery questions, active plan quantities with separate suggested/confirmed/final states. It does not imply source stock availability or approval from a destination shortage.

Verification must cover broad risk questions, SKU/district filters, district isolation, inactive accounts, missing data, numeric null handling, multi-turn context and bounded tool calls. The remaining foundation PDFs (attention, Gen AI/NLP, engineering stack) are background references rather than sources of inventory rules.

## Research-informed harness

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (2026-01-09): evaluate the model and its execution loop together. SYNAPSE records safe step metadata and tests actual tool execution/stop outcomes, not a model's claim of success.
- [τ-bench](https://arxiv.org/abs/2406.12045) (2024-06-17): domain rules and repeated conversation trials matter. Our tests cover the warehouse task and permission outcomes; these are local scenario tests, not a τ-bench score.
- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (2025-11-26): explicit progress and verifiable completion. This short web interaction uses bounded evidence plus an explicit finish step rather than a long-running autonomous job.
- [Google: Function calling](https://ai.google.dev/gemini-api/docs/function-calling): preserve model turns, return function results and validate before execution.

`dashboard/app/api/chat/harness.mjs` owns execution: three DB reads, four model calls, 90-second request timeout, repeated-call detection, 40,000-character tool response limit, six history messages, and explicit partial results on interruption. Vercel logs contain request ID, model, harness version, stop reason and tool status/timing, excluding prompts, keys, JWTs and business rows.

Run `npm --prefix dashboard run test:agent`. Scripted provider responses verify harness behavior deterministically; live Gemini trials remain a separate acceptance gate and must not be reported as passed based on these mocks.

Live smoke runner: set `CHAT_EVAL_URL` to an accessible deployed/local app and `CHAT_EVAL_TOKEN` to a normal user's session JWT, then run `node dashboard/scripts/eval-agent.mjs`. It checks five real-model task outcomes (discovery, delivery, follow-up, write refusal and clarification), prints no prompts/answers/tokens, and exits nonzero on failure. Run after deployment with a fresh rate-limit window. It does not bypass Vercel protection, measure quantity correctness against independent fixtures, or establish a statistical accuracy score.

Verified 2026-09-08: full Next.js build, lint and 60 tests passed; managed Test overview SQL passed 11 assertions; main DB overview role smoke returned `ok` with 15 delivery rows. SQL role tests do not substitute for live user login and Gemini execution.
