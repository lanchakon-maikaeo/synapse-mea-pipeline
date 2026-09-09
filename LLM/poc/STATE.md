# Current POC 2 state

Updated: 2026-09-09. Branch `dev` uses main Supabase `synapse-01` (`fvdfduuanfrncrwuareb`) with explicit user authorization. Historical P00/P01 Test evidence remains valid for its original fixture scope.

## Active work: v4 notebook / production hardening

Status: **implemented; local build and authenticated live smoke verified**. User explicitly requested no push/deploy. Work is uncommitted on top of `dbc5686`; no Git remote, schema or business-data changes in this task. [Live evidence](P06-live-evidence.md) records ten browser cases and their request IDs.

- Reference and full mapping: [P06](P06-notebook-production.md). Current architecture: [AGENT_PIPELINE](../AGENT_PIPELINE.md).
- Changed production path: evidence-based answer writer, independent support/relevance/citation reviewer, strict citation IDs, deterministic fallback; optional ranking failure retains authorized candidates; planner rejects ambiguous multi-candidate replies; safe latency/token/call-count/answer-validation telemetry.
- Checks: `npm --prefix dashboard run test:agent` **27 passed**; `npm --prefix dashboard run db:check` passed; `npm --prefix dashboard run lint` passed; `npm --prefix dashboard test` optimized production build + **71 passed, 0 failed**. No SQL changed; previous SQL passes below are not rerun or relabeled as v4 live verification.
- `dashboard/scripts/eval-agent.mjs` extended with greeting, thanks, greeting-plus-business question, district name assertions and v4/call-budget metadata. This is a smoke script, not a held-out accuracy benchmark; it has not been run against v4 with a live provider.
- Local `LLM_API_KEY` is configured and verified against `gemini-3.5-flash-lite`. Supabase public URL/key were added for the existing main database; secrets remain in the ignored `.env.local`. Local app: `http://127.0.0.1:3107`. User logged in normally; the browser end-to-end run passed. No permission to deploy is implied.
- Live provider checks: greeting returns the correct conversation response in one call; writer/reviewer accepts a fixture count of 123 in two calls; a fixture with null quantity and an injected instruction to say 999 remains unknown (two calls, accepted). These are real Gemini calls with controlled fixtures, not database end-to-end evidence or a broad prompt-injection benchmark.
- Local HTTP boundary checks: no session → 401, forged session → 401, forged system history role → 422. Fresh SQL baseline for the upcoming browser test: district 5501 = นวลจันทร์; materials = 5,466; monthly history = 71,112 rows, district 5501 = 3,432, period 2025-05-01 through 2026-04-01. These SQL reads are independent reference checks, not proof the chat selected the correct queries.
- Live browser checks now cover greetings, mixed greeting/data intent, totals, historical range/count, follow-ups, ordering, top-k, missing data, two sources and write refusal. All eight database answers were synthesized/accepted and their known numeric/name/date results matched independent SQL. Broader held-out accuracy, repeated-trial fallback rates, all-role browser testing and production-load performance remain unmeasured; no deployment or unrestricted correctness claim is made.

## Historical v3/v2 evidence

Current extension: [Database Agent v3](../AGENT_PIPELINE.md) adds authorized source discovery, Gemini reranking/top-k, and structured read/aggregate queries across the business catalog. Build/lint and 65 tests pass; 17 new SQL checks pass on Test, with all 125 Test sources successfully queried. v2 details below record the preceding release.

- Harness v2: six read tools, bounded multi-step Gemini feedback, recent history, deterministic evidence answers, explicit partial/finish, safe execution traces.
- SPAI course and research mappings: [SPAI_APPLICATION.md](../SPAI_APPLICATION.md).
- Build and 60 dashboard tests pass; 11 overview SQL assertions pass on managed Test (rolled back).
- Main migrations: original read RPCs, admission and operations overview applied. Authenticated-role overview smoke: `ok`, 15 delivery rows, not truncated. This SQL smoke simulates DB JWT claims; it is not an end-to-end browser login test.
- Deployment and live Gemini smoke evidence will be recorded after verification. P05 held-out accuracy, repeated live trials and cost/latency benchmark remain unmeasured.

The historical five-tool, single-call design is extended by the user's operations-agent request. Tool results now go to Gemini for subsequent decisions; no business writes are executed by chat.
