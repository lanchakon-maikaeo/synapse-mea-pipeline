# PoC state

Updated: 2026-09-08. P02/P04 are implemented for POC 2; live inference waits for a Gemini API key.

| Module | Status | Evidence / blocker |
|---|---|---|
| P00 | done | [Contract and Test identity](CONTEXT.md#p00-verified-contract); [20 bound development cases](eval-dev.jsonl); [Supabase Test](https://supabase.com/dashboard/project/vtwtfgocokuktxfumjuz) |
| P01 | done | [Managed Test evidence](P01-evidence.md): 42/42 JWT/API checks, 27/27 SQL acceptance, local contract passed |
| P02 | done | Fixed five-tool boundary, validation, deterministic answers, DB-backed admission limit; local contract and Supabase Test migration passed |
| P03 | ready_for_key | Gemini 3.5 Flash-Lite native adapter implemented; user will add `LLM_API_KEY` or `GEMINI_API_KEY` later |
| P04 | local_verified | Authenticated bottom-right chat widget, minimize/cancel/error/mobile/accessibility states; browser QA passed |
| P05 | planned | Run live functional/security/latency/cost acceptance after the Gemini key is configured |

Next: add the Gemini API key in the Vercel Preview environment, redeploy `dev`, then run P05 live acceptance.

## Latest handoff

Module: POC 2 P02–P04 | status: `ready_for_key`.
Changed paths: Gemini adapter/API route, chat widget/styles, shared Supabase origin guard, P02 admission migration, P01/P02 checks and [POC 2 runbook](../POC2_COMMERCIAL_API.md).
Environment/ref: branch `dev`; Supabase Test `test-synapse-mea` / `vtwtfgocokuktxfumjuz` / `ap-northeast-1`; Production excluded.
Checks/results: 48 dashboard tests pass; lint/build pass; local database contract pass; Test migration `20260908115750` and authenticated admission smoke pass; browser widget QA pass.
Blocker: Gemini API key intentionally deferred by the user.
Next module: P05 after key configuration.
