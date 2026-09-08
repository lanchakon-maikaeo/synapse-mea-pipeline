# P01 evidence — Supabase data, permissions and audit

Verified 2026-09-08 against Supabase Test only: `test-synapse-mea` / `vtwtfgocokuktxfumjuz` / `ap-northeast-1`. Production ref `fvdfduuanfrncrwuareb` was not used.

- Migration head: `20260908111808`; 40 Supabase migration-history rows and 39 `ops.schema_migrations` rows.
- Fixture: `vmi-chat-test-v1`, batch `00000000-0000-4000-8000-00000000b001`, workbook SHA-256 `c81b39b1aded306716da5808cff6c7fbeb479c46e06f4bba29f360be5cac6db9`. Live counts: batch 1, stock 5, usage 4, plans 3, ISSUE movement 1.
- Auth: all 8 P00 actor aliases exist in Test. UUIDs, passwords, API keys and JWTs are not committed or printed.
- Managed Test: `node scripts/test_p01_managed_jwt.mjs` passed 42/42. This covers all 20 eval cases plus all five reads, same/cross-district behavior, inactive profile, profile escalation, direct table/view/audit denial, missing/wrong-project/expired JWT rejection, invalid date input and the 10 requests/minute limit.
- Audit: append-only metadata rows were present after repeated smoke runs; all actor IDs matched the authenticated profiles. Columns are only `audit_id, request_id, actor_id, tool, tool_version, status, latency_ms, created_at`.
- Local: `make database-contract-local` passed. P01 SQL acceptance passed 27/27, including filter-before-limit reads, a runtime 20-row truncation case, CMP-zero evidence, exact plan issue reference, fixed timeout, caller-derived audit, append-only enforcement and rate limiting.
- Cleanup: `supabase/tests/p01_managed_test_cleanup.sql` completed successfully when run with its final `commit` replaced by `rollback`; fixture data remained present. Run the committed file to retire data, then `node scripts/test_p01_managed_jwt.mjs --cleanup-actors` to remove Test actors. Audit history remains append-only.

The existing dashboard RPCs and business-rule implementations were not changed. `public.vmi_chat_read` is the only new read surface.
