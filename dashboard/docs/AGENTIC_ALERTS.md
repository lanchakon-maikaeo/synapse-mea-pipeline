# Agentic Alerts

Proactive advice appears behind the bell in the top bar before anyone asks. Scope is the central warehouse, districts and open plan workflows. The worker runs every hour at minute 30 (so 07:30 Asia/Bangkok is one of the runs).

- `app/agentic-alerts.mjs`: numerical evidence outside the model; unknown, fixture or stale stock becomes a verification task, never a stockout.
- `app/api/agentic-alert-worker.mjs`: stable candidates, one bounded evidence read, an Agent recommendation, an independent factual review, and an evidence-only fallback.
- `app/api/internal/agentic-alerts/route.ts`: secret-authenticated scheduler entry, server-only service key, 75-second model budget inside a 120-second route limit.
- `app/api/alerts/route.ts` + `app/alert-panel.tsx`: role-scoped feed (district sees its district, picker sees warehouse), true open count, history and acknowledgement. "ถาม Agent ต่อ" pre-fills the chat assistant.
- `ops.system_alerts` (`alert_type='agentic'`): stable identities; candidates that disappear resolve on the next run. Acknowledging does not resolve a condition, and a worsened alert reopens.

The Agent analyses up to six changed candidates per run. Unchanged analysed candidates reuse their analysis, so most hourly runs make no model calls. LLM calls use the chat assistant's `LLM_API_KEY` and `LLM_MODEL`; without them every alert is still saved with its deterministic evidence and action.

## Production setup (once)

The database side is `supabase/migrations/202611210001_agentic_alerts.sql`. It is safe to rerun and removes dev's preview scheduler.

1. Vercel `mea-synapse-web`, Production, sensitive: `AGENTIC_ALERT_SERVICE_KEY` (Supabase service-role key; optional, falls back to `SUPABASE_SERVICE_ROLE_KEY`) and `AGENTIC_ALERT_CRON_SECRET` (a long random string). Redeploy.
2. Supabase SQL editor, the same random string:
   ```sql
   select vault.create_secret('<AGENTIC_ALERT_CRON_SECRET>', 'synapse-agentic-prod-cron');
   ```
3. Run once by hand, then schedule:
   ```sql
   select ops.invoke_agentic_alert();
   select cron.schedule('synapse-agentic-hourly', '30 * * * *', 'select ops.invoke_agentic_alert();');
   ```

## Checking it

`cron.job_run_details` only says a request was queued. Check the result in `net._http_response` (status code) and `ops.agentic_alert_runs` (status, candidate and analysed counts). Vercel logs carry `agentic_alert_run` events; rejected recommendations are logged as `agentic_alert_review_rejected` with secrets redacted, never shown in the feed.

```sh
npm run test:alerts
```

`supabase/tests/agentic_alerts_verify.sql` runs inside the local workflow contract: RPC grants, the worker context against the current schema, district/picker/viewer scope, acknowledgement, worker leases, deduplication, resolution and reopening.

Stock freshness is 26 hours, matching the operational source alert threshold. A verified zero is different from missing stock, and a warehouse shortfall against active plans is not a predicted depletion date.
