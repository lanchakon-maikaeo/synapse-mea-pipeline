# Proactive alert evidence and Preview scheduling

Use stock and governed replenishment calculations as authoritative evidence; let the Agent choose related reads and produce an independently reviewed explanation. Warehouse inventory and district usage represent different locations, so warehouse recommendations compare allocatable stock with outstanding plans rather than borrowing district consumption to invent warehouse depletion dates. The user confirmed both levels, verification tasks plus supported advice when data is missing, and a daily 07:30 Asia/Bangkok summary.

Persist stable event identities in the existing operational alert ledger, preserving acknowledgment until an event resolves or becomes materially more severe. Scoped RPCs derive identity from active profiles and retain private table access. Their security-definer execution is intentional, explicitly bounded and covered by rollback-only authorization tests.

Use Supabase pg_cron/pg_net to call the dev Preview directly, keeping the invocation secret and Vercel automation bypass in Vault. Send the bypass only in its dedicated header while retaining Preview authentication protection. Native Vercel Cron invokes Production, while this release is authorized for dev; changing the deployment target to enable scheduling would change the authorized environment. Keep a daily 00:30 UTC job plus reconciliation every 15 minutes, and a database lease to reject overlapping runs. Production activation requires its own scheduler target and secret configuration.

**Superseded on main (2026-11-10):** the port to `main` drops the pg_cron/pg_net/Vault invoker and uses a daily Vercel Cron on Production with `CRON_SECRET` (see `dashboard/docs/AGENTIC_ALERTS.md`).
