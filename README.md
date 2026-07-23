# SYNAPSE — MEA Supply Chain Intelligence

Open-source, data-gated supply-chain pipeline for MEA VMI operations. Release `1.0.0-non-ai` delivers Waves 0–3, API, dashboard and operations; Wave 4 / M11 AI is intentionally excluded.

## Modules

- `pipeline/` — source connectors, ingestion, checksum and idempotency
- `supabase/` — versioned database migrations, rollbacks and acceptance SQL
- `intelligence/` — deterministic forecast comparison and route optimization worker
- `api/` — role-aware FastAPI contract
- `deploy/` and `scripts/` — containers, monitoring, backup and restore drill

Start with [the end-to-end project pipeline](docs/PROJECT_PIPELINE.md), [module status](docs/MODULE_STATUS.md), [completion record](docs/NON_AI_COMPLETION.md) and [operations runbook](docs/OPERATIONS_RUNBOOK.md).

Hosted Web App: <https://mea-synapse-staging.vercel.app>. The public shell does not require a Vercel account; operational data and governed actions still require SYNAPSE Supabase Auth.

The deployed dashboard source is maintained in the independent private repository
`lanchakon-maikaeo/synapse-mea-dashboard` (`main`, mirrored to
`vercel-staging`) and published to the Vercel project
`synapse-mea/mea-synapse-staging`. A local nested `dashboard/` checkout is
ignored by this pipeline repository so the two release histories cannot drift
silently. The current verified dashboard production revision is `804c6f0`.

`https://synapse-mea-dashboard.lanchakon0.chatgpt.site` is a separate
ChatGPT Sites-hosted snapshot, served through Cloudflare rather than the Vercel
project. It currently exposes the same 29-path API contract, but its dashboard
bundle predates revision `804c6f0` and lacks the complete replenishment,
approval and route-job orchestration. Treat Vercel as the release target and
do not use the Sites URL as deployment evidence for this Git pipeline.

Run the complete pipeline verification suite with `make ci`. It includes Python
module tests, OpenAPI and delivery checks, and a clean PostgreSQL 17 run of all
15 Supabase migrations, 29 schema/RLS/privilege checks, 17 authenticated
dispatcher workflow checks and 10 real worker execution checks. When the
independent dashboard checkout is present locally, `make workspace-ci` adds its
native Next.js verification. The dashboard repository also runs that
verification in its own GitHub Actions workflow.
