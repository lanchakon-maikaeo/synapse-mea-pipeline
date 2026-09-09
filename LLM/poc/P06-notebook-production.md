# P06 — Notebook patterns in the production Agent pipeline

Date: 2026-09-09. This work is local only: **do not push or deploy** under the current instruction. “Production pipeline” means the existing application's production code path, not a claim of production acceptance.

## Reference and decisions

Reference inspected: `/Users/lanchakon-maikaeo/Downloads/Agent_(Super_AI_Level_2).ipynb`, title **Agent Walkthrough**, 57 cells; SHA-256 `2eb5c99934959dca1d1ad45c5f4455bc5cc0a93f17d5e0d8a304fc4e4b941d40`. No notebook existed inside this repository when work started. This relevant Agent notebook was selected from Downloads; the user can replace the reference if a different notebook was intended. Notebook code/outputs are not executed or copied into the server.

| Notebook section / cell (zero-based) | Application in SYNAPSE |
|---|---|
| 1 chat, cells 6–7 | Keep the existing conversation branch for greetings, thanks, goodbye and capabilities. A greeting plus a business question still requires data tools. |
| 2 function calling, cells 8–9 | Preserve native Gemini schemas and server validation. Continue returning tool evidence to the model. No switch to Typhoon or OpenAI SDK is needed. |
| 5 generic loop, cells 26–27 | Existing bounded planner/read loop remains; model proposals never directly execute arbitrary code. |
| 6 file-based search, cells 28–32 | Transfer discover → read → answer to the existing authorized source catalog. Do not give the web agent arbitrary filesystem access. |
| 7 structured/substring/aggregate search, cells 33–45 | Keep SQL filters, literal text search, whole-set aggregates and reranking. Totals come from DB aggregates, not from counting a displayed sample. |
| 9 validator/report, cells 52–54 | New bounded answer writer plus separate reviewer using current tool evidence, followed by deterministic fallback. |
| 3 EXA web search | Not enabled: this project answers internal database questions and has no configured EXA integration. |
| 4/7c Python REPL and 8 file editing | Not enabled: a persistent in-process REPL/path concatenation is not a production isolation boundary; chat remains read-only. |
| 9 parallel research subagents | No new agents/framework: the existing single orchestrator and budgets cover the current database workflow. |

## Implemented request flow

Authenticated web message + bounded history → DB admission → Gemini planner → conversation/clarify/unsupported **or** discover → candidate retrieval → source reranking/top-k → validated query → optional row reranking → evidence feedback → finish → answer writer → answer reviewer → response.

`dashboard/app/api/chat/answer.mjs` takes the **actual current-request evidence**, excluding discovery metadata. History is supplied only to resolve follow-ups; historical assistant messages are not authoritative facts. The writer proposes natural Thai prose and numeric evidence IDs. Server checks the exact response shape, bounded text, unique IDs and that every ID exists. A separate model call reviews factual support, relevance to the latest question and whether the cited evidence supports the claims. All three booleans must be true.

The server appends source identifiers from cited tool envelopes and preserves truncation notices, read timestamps and warnings. It never accepts a model-invented source identifier. Null-versus-zero, exact units, time scope, ordered results, sampled-versus-total counts and recommendations-versus-executed actions are explicit writer/reviewer rules.

If either stage fails, times out, produces malformed data, cites missing evidence or is rejected, return the existing deterministic answer. Partial, denied, unavailable and conversation results bypass writing/review. Combined input over 40,000 characters also bypasses it. The fallback is a normal result, with `answer_mode=evidence`; it is not mislabeled as a reviewed answer.

The same server-only Gemini configuration and fetch path is reused. Planning/retrieval allows at most 12 model calls and six DB reads. Writing/review adds at most two calls (14 total), within the existing 90-second request deadline and per-call timeout. No business queries or elevated credentials are added by the writer/reviewer. Safe logs/API metadata include `answer_mode` (`synthesized`/`evidence`) and `answer_validation` (`accepted`, `rejected`, `invalid_draft`, `unavailable`, `deadline`, `context_limit`, `not_applicable`). Logs exclude question text, drafts and business rows.

## Verification and remaining release gate

Additional production hardening: optional reranking failure/empty selection preserves authorized candidates with explicit fallback metadata; aggregates and explicit SQL order remain unchanged. Planner rejects multiple candidate responses so that the executed function call and preserved thought-signature turn cannot come from different candidates. Success logs include duration and provider-reported total token count; agent failures log safe status/call-count/duration metadata without error text or business data.

References checked 2026-09-09: [Google function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling?authuser=0&hl=en) and [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) support preserving the model turn across sequential tools. [OWASP prompt injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) informs separation of instructions/data, output checks, least-privilege tools and monitoring. Application decisions: keep server validation/JWT scope as the authority, treat retrieved text as untrusted, render answers as escaped text, and regard the model reviewer as an additional check rather than a security boundary.

Run from the repository root:

```sh
npm --prefix dashboard run test:agent
npm --prefix dashboard run lint
npm --prefix dashboard run db:check
npm --prefix dashboard test
```

`chat-answer.test.mjs` exercises the complete discover/read/finish/write/review sequence with injected model responses, rejects nonexistent/duplicate citations and extra fields, rejects negative or nonboolean reviews, preserves denied/partial results, enforces context/cancellation handling, falls back on provider/budget errors, and retains server-owned truncation/warnings. It is registered in both Agent and full dashboard suites.

These tests prove control flow, not live Gemini accuracy. The model reviewer is probabilistic and can share the writer's mistakes; it is not mathematical proof of factual correctness. The subsequent [live verification](P06-live-evidence.md) records ten authenticated browser cases, independently checked business answers and real-provider fixtures. No held-out score, latency/cost improvement or universal production-readiness claim is made. Before a later authorized rollout, retain the recorded baselines, test changed scenarios and measure repeated-trial quality/fallback rates under expected load. Do not silently retune and reuse development cases as a held-out benchmark.

No database migration, credential change, commit, push or deployment is required for this local change. Existing v3 DB gates remain historical evidence for the unchanged database boundary. To disable the new stage before a future release, remove the `composeAnswer` invocation in the chat route; deterministic rendering remains in the harness.

## Completion audit

| Requested outcome | Current authoritative evidence | State |
|---|---|---|
| Apply notebook knowledge | Inspected notebook hash above; section-to-implementation mapping; writer/reviewer in `answer.mjs` invoked by the actual chat route | Implemented locally |
| Adapt the existing production pipeline | Existing native Gemini/JWT/read loop retained; new writer/reviewer, ranking fallback, bounded calls and safe operational metadata | Implemented locally |
| Update documents in poc | README/CONTEXT/P02/P05 point to current P06; STATE separates historical/live/local evidence | Updated |
| Verify implementation | Optimized production build, 27 Agent/71 dashboard tests; rejection/fallback/source-warning cases and local HTTP boundaries | Passed locally |
| Verify real provider/data flow | Ten v4 authenticated browser cases, independently checked factual scenarios and controlled real-Gemini writer fixtures; see live evidence | Smoke passed; broader benchmark/rollout separate |
| Do not push/deploy | Changes remain uncommitted; local HEAD and origin/dev remain `dbc568624c5e3879cb24ce6c03db412623d3eee2` | Preserved |

The local model key is configured and the authenticated browser-to-database verification is complete for the ten recorded scenarios. See STATE and live evidence for precise scope and remaining benchmark limits. Changes remain local and are not the older deployed version.
