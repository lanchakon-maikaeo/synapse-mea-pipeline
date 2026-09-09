# P02 — Backend tool gateway, validation and deterministic answers

Historical POC 1 card. Current POC 2 uses eight DB read/discovery tools plus conversation/clarify/unsupported/finish. Deterministic rendering is retained as the fallback for the v4 writer/reviewer described in [P06](P06-notebook-production.md). Existing DB/auth contracts remain authoritative.

Depends: P01 done. Outcome: typed tool request → authorized Supabase result, tested without model/GPU.

Read: CONTEXT/STATE, `dashboard/app/api/[...path]/route.ts`, nearest auth/config helpers and one existing `dashboard/tests/*.test.mjs` pattern. Follow callers before extracting any shared helper.

Work:
1. Reuse Next.js server-side auth and JWT forwarding. Implement a small fixed map for five tools, strict argument validation, role/tool checks, time/row limits and the shared result envelope. Never accept arbitrary dispatcher path/method from model or client. Use P01 filters before truncation; a warehouse on-hand snapshot is not automatically available-to-issue quantity. Preserve existing vendor aliases.
2. Use a proposed server module such as `dashboard/app/api/chat/tools.ts` and focused tests; adapt to actual repository conventions. Reuse installed utilities/native fetch; no new agent framework or generic provider factory.
3. Implement answer templates per tool, exact numeric/unit/date rendering and clear no_data/forbidden/unavailable handling. Preserve provenance and truthful freshness. Add request IDs and server-derived audit metadata using P01's contract.
4. Enforce per-user rate limits across server instances using a suitable existing DB-backed control; validate input length, dates, bounded result size, response schema and trusted upstream origin. Don't retry with elevated credentials.
5. Test model decisions via injected fixtures/mocks at the internal function boundary; do not expose a production-accessible endpoint that accepts arbitrary model decisions. Set chat feature off outside the verified Test/local profile.

Acceptance: each tool returns reference values from Supabase Test; malformed/unknown fields, forged identity, unsupported tools, cross-scope access and timeouts fail safely; audit is redacted and cannot be spoofed. Cache/history cannot mix users. Unexpected result schemas fail closed.

Checks: built-in node:test for new tool/gateway logic, TypeScript (`npm --prefix dashboard run db:check`), targeted managed-Test integration; wire new tests into the existing npm test command because it names files explicitly. Do not claim mocks prove Supabase behavior.

Handoff: exported function/signatures, five tool schemas, actual new test command, result examples without PII.
