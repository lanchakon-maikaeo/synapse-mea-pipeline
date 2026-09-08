# P04 — หน้า Chat ภายใต้ Dashboard เดิม

Depends: P03 done. Outcome: authenticated users ask VMI questions and inspect trustworthy results.

Read: CONTEXT/STATE, P03 route/result type, `dashboard/app/page.tsx`, `dashboard/app/use-synapse-backend.ts`, existing UI/Auth patterns. Limit edits to chat entry point/components and necessary callers. Use applicable frontend skills when implementing.

Work:
1. Add one small Chat page/panel behind the PoC gate. Reuse the signed-in session, current styles and native controls; don't redesign dashboard/navigation or introduce a UI/chat framework.
2. Provide five example questions, input/send/loading/cancel/error/retry states. Retry is explicit user action, not automatic paid calls. Handle expired sessions through existing Auth flow.
3. Render values/tables from server data, with units, data_as_of, scope, rule version and authorized provenance link when available. Clearly show no_data, stale and owner_attested_zero. Don't manufacture source links/timestamps.
4. V1 uses self-contained questions; ambiguous follow-ups ask for missing material/district/period. Keep displayed history local to the signed-in user and clear on logout/user switch; don't send all previous results to model. No persistent shared conversation memory.
5. Keyboard access, visible labels/focus, status announcements, mobile layout and escaped text. No write tools or approve/issue buttons inside model output.

Acceptance: login → question → real Supabase/Qwen result visible; forbidden/stale/no_data/timeout look distinct; exact numeric/unit formatting; user switch clears history; unauthorized source links cannot reveal records; old dashboard flows still function.

Checks: targeted render/component tests using existing runner plus actual browser flow under two Test users, TypeScript/lint for affected scope. Run build after meaningful integration. Capture only minimal redacted evidence; no full screenshot archive.

Handoff: URL/feature gate, affected files, exact checks and remaining UX errors. UI-only mock screenshots do not prove end-to-end completion.
