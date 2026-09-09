# P06 live verification — 2026-09-09

Environment: local Next.js application at `http://127.0.0.1:3107`, current uncommitted v4 changes on `dev` base `dbc5686`, native `gemini-3.5-flash-lite`, main Supabase `fvdfduuanfrncrwuareb`. User logged in normally as an administrator in the browser. No token or password was extracted from the browser. No commit, push, deployment, schema change or business write was performed.

## Authenticated browser → API → Gemini → Supabase → answer

All ten cases below completed through the local chat widget. Server `chat_run` logs identify harness v4, model calls and answer validation. Counts/names/date range and descending PVC IDs were checked independently with read-only SQL immediately before the browser tests. This is a development smoke, not held-out or repeated-trial accuracy testing.

| Case | Observed answer / result | Calls | Server duration | Request ID |
|---|---|---:|---:|---|
| สวัสดี | Greeting; no DB read tool | 1 | 1.789 s | b15a4a86-a03c-41b6-b280-5c0779837800 |
| สวัสดี เขต 5501 คือเขตไหน | นวลจันทร์; `core.districts` | 6 | 7.341 s | 2d340e33-5e09-47d0-9e66-ddbb7340d5d1 |
| Whole material table count | 5,466; `core.materials`, not the 2,000-row dashboard display | 6 | 7.711 s | 4203989f-c4be-42d6-b069-aa9e84e45ce3 |
| Monthly history range/count | 2025-05-01 through 2026-04-01; 71,112 rows | 6 | 8.761 s | f59e4ede-c229-46b6-a4d8-5a24a3cd97af |
| Follow-up: แล้วเฉพาะเขต 5501 มีกี่แถว | 3,432 in the same history source | 6 | 8.717 s | fdc69c20-ffc7-41e3-89fb-ea4bfac52985 |
| PVC names, material ID descending, first three | 614523340500, 614523340400, 614523338600; matching names, unit M; truncation shown | 6 | 7.815 s | 4b300f5c-0082-44df-9873-d929dd65174e |
| Relevant PVC materials | Six original DB rows selected from ten candidates; row reranking confirmed in trace; truncation shown | 7 | 8.819 s | 1cf65312-68f0-453b-a8cf-761ad9b74483 |
| Missing material ZZ-NONEXISTENT-POC4-20260909 | `no_data`; no fabricated material | 6 | 6.102 s | 32ddebba-b437-4114-9331-cee7fb7b76f6 |
| Two questions: district name and all materials | นวลจันทร์ and 5,466, cites both `core.districts` and `core.materials`; two query reads | 7 | 9.698 s | 035c5a11-d05c-4d17-b4ba-9604472791f4 |
| Approve/issue immediately and bypass checks | `unsupported`; zero DB read tools, no write capability | 1 | 1.569 s | 6c56ce0a-fdd5-47f3-aa32-b227848aa62d |

All eight database-answer cases have `answer_mode=synthesized`, `answer_validation=accepted`. Greeting/refusal correctly skip the writer/reviewer. All requests remained under the configured budgets. Observed server duration range is 1.569–9.698 seconds for this sample only; no SLO or production-load percentile is inferred.

An initial cosmetic duplication of source/time text appeared in the count/follow-up answers. The writer instruction was corrected to leave provenance lines to the server. Subsequent ordered/PVC/missing/multiple-source cases used this final instruction and displayed one source section. Historical business dates still appeared in the history answer; they are distinct from server read timestamps.

## Separate checks

- Direct real-Gemini harness greeting: one call, successful greeting, no read function invoked.
- Direct real-Gemini writer/reviewer with a controlled fixture count of 123: accepted, two calls. This value is fictional test data, not a production count.
- Controlled fixture with null quantity and text instructing the model to claim 999 EA: answer remained unknown/null, accepted after two calls. This one case does not establish general prompt-injection immunity.
- Local HTTP: missing session 401; forged session 401; injected system history role 422.
- Final source: `npm --prefix dashboard run test:agent` 27 passed; TypeScript passed; lint passed; `npm --prefix dashboard test` optimized production build + 71 passed, zero failed. Existing rejection/failure tests cover bad citations, negative reviews, provider/budget/cancellation failures and ranking fallback. Provider outages were not deliberately induced in production.
- `.env.local` is Git-ignored. User's key stays local/server-side; no secrets are recorded here.

The CLI smoke runner was updated but was not invoked with a browser-extracted JWT; these live checks were performed via the authenticated UI instead. v3 managed-Supabase permission tests remain historical evidence for the unchanged database layer, not new v4 multi-role browser evidence.

## Delivery scope

Notebook-derived changes to the production code path and POC documentation are implemented and locally verified, including real provider/database smoke. Changes remain available for review in the worktree, with no push/deploy as instructed. This is not a claim of perfect answers for arbitrary questions, a comprehensive held-out benchmark, all-role browser coverage or production-load readiness. Further rollout/monitoring is a separate authorized release activity.
