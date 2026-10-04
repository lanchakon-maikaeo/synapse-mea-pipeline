# Agentic Alerts

Proactive recommendations appear in the top-right bell before a user asks a question. Scope is warehouse plus district, with daily summary at 07:30 Asia/Bangkok (00:30 UTC), and reconciliation every 15 minutes.

- `app/agentic-alerts.mjs`: governed numerical evidence; unknown/fixture/stale stock produces verification tasks.
- `app/api/agentic-alert-worker.mjs`: stable candidates, related evidence reads, bounded Agent decisions, independent factual review, evidence-only fallback.
- `app/api/internal/agentic-alerts/route.ts`: secret-authenticated scheduler entry point, server-only service credential, 75-second model budget and a 120-second route limit.
- `/api/alerts`: active-profile-derived scoped feed, true open count, paginated history and acknowledgment.
- `ops.system_alerts`: stable proactive identities; absent candidates resolve automatically. Acknowledging does not resolve a condition.

Configure `AGENTIC_ALERT_SERVICE_KEY` and `AGENTIC_ALERT_CRON_SECRET` as sensitive server-only Vercel Preview/dev variables. LLM calls use existing `LLM_API_KEY` and `LLM_MODEL`; these do not change the Codex model. Never expose worker credentials with `NEXT_PUBLIC_`.

The dev scheduler calls `ops.invoke_agentic_alert_dev()`, whose HTTP URL is fixed to the dev alias and whose invocation secret is `synapse-agentic-dev-cron` in Supabase Vault. The automation protection bypass is encrypted separately as `synapse-agentic-dev-bypass` and sent through the `x-vercel-protection-bypass` header; Preview authentication stays enabled. Install jobs only after the Preview endpoint is ready:

```sql
select cron.schedule('synapse-agentic-dev-daily','30 0 * * *','select ops.invoke_agentic_alert_dev();');
select cron.schedule('synapse-agentic-dev-refresh','*/15 * * * *','select ops.invoke_agentic_alert_dev();');
```

Check `cron.job_run_details`, `net._http_response` (status and request id only), and `ops.agentic_alert_runs`. Scheduler success alone means an HTTP request was queued, not that inference and persistence succeeded. No unrelated Vercel deployments should be canceled.

Stock freshness is currently 26 hours, matching the existing operational source alert threshold. Warehouse completeness also requires reconciliation of handling-unit availability against the actual latest snapshot. A verified snapshot of zero is distinct from missing stock; a warehouse shortfall against active plans is distinct from a predicted depletion date. Future procurement arrival dates and current warehouse demand must be established before promising a day of depletion or arrival.

The Agent analyzes up to six changed candidates per run, reads bounded source excerpts, and independently reviews each recommendation. Unprocessed or provider-failed candidates retain deterministic evidence and actions. Unchanged analyzed candidates reuse their analysis; queue status/quantity changes invalidate that analysis. Existing plans are grouped per plan and district to avoid one notification per material.

Verification:

```sh
npm run test:alerts
npm run test:agent
```

`supabase/tests/proactive_agentic_alerts_verify.sql` is rollback-only and verifies RPC grants, district/picker/viewer permissions, acknowledgment, worker leases, deduplication and resolution. It must not retain test alerts or profile changes. Security advisors flag authenticated security-definer feed/ack RPCs and the intentionally private RLS run table; authorization is explicit and tested, not inferred from these advisory flags.
