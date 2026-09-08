# P01 — Supabase data, permissions, audit foundation

Depends: P00 done. Outcome: all five reads proven under real Supabase Test user JWTs, without LLM.

Read: CONTEXT/STATE + P00's verified SQL/read sources. Test entry points: `supabase/tests/local_schema_contract_verify.sql`, `supabase/tests/local_pipeline_workflow_verify.sql`, `scripts/test_supabase_migrations_local.sh`. Read relevant Supabase skill/current docs before SQL changes.

Work:
1. Recheck project identity and migration head before writes. Reuse available Test data; create only smallest governed fixtures needed for coverage, labelled TEST. Create Test users/roles through supported Auth/admin workflows; never fabricate Production identities.
2. Prefer current VMI RPC/views. Resolve the filter-before-limit gaps listed in CONTEXT; preserve the old dashboard contracts. Query the material/plan/PO and authorized scope before applying row limits; never infer absence from a partial page. Add an additive migration only for demonstrated gaps (narrow reads or audit/rate-limit storage). Use the repo migration workflow; don't invent a timestamp in this plan or rewrite deployed history.
3. Verify row and column privileges, role/district restrictions, caller identity and profile immutability. Invoker requires safe underlying grants; existing definer dispatchers require explicit authorization/search_path/grant review. Do not broaden direct table exposure to make a test pass.
4. Enforce DB-side argument/date/row limits and query timeout on new reads. Audit: append-only request/tool/version/status/latency metadata; no raw question/results/JWT. Reuse existing audit/limiter if semantics fit. A narrow audit write must derive actor from caller identity.
5. Add executable SQL acceptance and a managed-Test JWT/API smoke check. Wire new SQL tests into the existing harness; local role emulation cannot prove managed Auth behavior.

Acceptance: same-scope reads correct; cross-district denial; absent/expired/wrong-project JWT rejected; profile privilege escalation denied; direct RPC/table/view calls disclose no more than intended; invalid arguments bounded; audit actor can't be forged; fixtures don't touch Production.

Checks: targeted SQL + managed Test JWT smoke. Run `make database-contract-local` when migrations/harness change. Store safe evidence, target ref, migration head and fixture manifest. If only local passes, STATE=`local_verified`, not done. Include Test-only fixture cleanup and a forward-fix plan; don't drop business tables.
