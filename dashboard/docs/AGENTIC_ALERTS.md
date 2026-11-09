# Agentic Alerts

Proactive recommendations appear in the top-right bell before a user asks a question. Scope is warehouse plus district, with a daily summary at 07:30 Asia/Bangkok (00:30 UTC). Users can also refresh the feed from the bell.

- `app/agentic-alerts.mjs`: governed numerical evidence; unknown/fixture/stale stock produces verification tasks.
- `app/api/agentic-alert-worker.mjs`: stable candidates, related evidence reads, bounded Agent decisions, independent factual review, evidence-only fallback.
- `app/api/internal/agentic-alerts/route.ts`: secret-authenticated scheduler entry point, server-only service credential, 75-second model budget and a 120-second route limit.
- `/api/alerts`: active-profile-derived scoped feed, true open count, paginated history and acknowledgment.
- `ops.system_alerts`: stable proactive identities; absent candidates resolve automatically. Acknowledging does not resolve a condition.

Configure `AGENTIC_ALERT_SERVICE_KEY` and `CRON_SECRET` as sensitive server-only Vercel Production variables. LLM calls use `LLM_API_KEY` and `LLM_MODEL`. Never expose worker credentials with `NEXT_PUBLIC_`.

`dashboard/vercel.json` schedules a Vercel Cron for `/api/internal/agentic-alerts` at `30 0 * * *`; Vercel sends `Authorization: Bearer $CRON_SECRET` and runs crons on Production only. The Hobby plan allows one run per day, so there is no 15-minute reconciliation. Check `ops.agentic_alert_runs` and the Vercel function logs (`agentic_alert_run`): a cron call alone does not mean inference and persistence succeeded.

Stock freshness is currently 26 hours, matching the existing operational source alert threshold. Warehouse completeness also requires reconciliation of handling-unit availability against the actual latest snapshot. A verified snapshot of zero is distinct from missing stock; a warehouse shortfall against active plans is distinct from a predicted depletion date. Future procurement arrival dates and current warehouse demand must be established before promising a day of depletion or arrival.

The Agent analyzes up to six changed candidates per run, reads bounded source excerpts, and independently reviews each recommendation. Unprocessed or provider-failed candidates retain deterministic evidence and actions. Unchanged analyzed candidates reuse their analysis; queue status/quantity changes invalidate that analysis. Existing plans are grouped per plan and district to avoid one notification per material.

Verification:

```sh
npm run test:alerts
npm run test:agent
```

`supabase/tests/proactive_agentic_alerts_verify.sql` is rollback-only and verifies RPC grants, district/picker/viewer permissions, acknowledgment, worker leases, deduplication and resolution. It must not retain test alerts or profile changes. Security advisors flag authenticated security-definer feed/ack RPCs and the intentionally private RLS run table; authorization is explicit and tested, not inferred from these advisory flags.

GPT-4o-mini requests use the OpenRouter `openai` endpoint, whose model metadata advertises tools/tool_choice; the Azure endpoints currently omit tools. Other configured models keep ordinary routing. The harness executes one validated read per step. If a provider proposes multiple read-only tools, unused call IDs receive explicit deferred results and may be proposed again; duplicate IDs, more than six calls, terminal/mixed calls and unknown tools are rejected. Evidence collection for a proactive candidate uses one bounded source batch before recommendation and review. This reduces fallback options and requires a live run to verify.
