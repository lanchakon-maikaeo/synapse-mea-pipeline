# SYNAPSE — MEA Supply Chain Intelligence

Open-source, data-gated supply-chain pipeline for MEA VMI operations. Release `1.0.0-non-ai` delivers Waves 0–3, API, dashboard and operations; Wave 4 / M11 AI is intentionally excluded.

## Modules

- `pipeline/` — source connectors, ingestion, checksum and idempotency
- `dashboard/` — Next.js Web App, Supabase Auth and same-origin API
- `supabase/` — versioned database migrations, rollbacks and acceptance SQL
- `intelligence/` — deterministic forecast comparison and route optimization worker
- `api/` — role-aware FastAPI contract
- `deploy/` and `scripts/` — containers, monitoring, backup and restore drill

Start with [the end-to-end project pipeline](docs/PROJECT_PIPELINE.md), [module status](docs/MODULE_STATUS.md), [completion record](docs/NON_AI_COMPLETION.md) and [operations runbook](docs/OPERATIONS_RUNBOOK.md).

Hosted Web App: <https://mea-synapse-staging.vercel.app>. The public shell does not require a Vercel account; operational data and governed actions still require SYNAPSE Supabase Auth.

This repository is the canonical monorepo for both the data pipeline and the
tracked `dashboard/` source. The existing private repository
`lanchakon-maikaeo/synapse-mea-dashboard` remains a Vercel deployment mirror
for `synapse-mea/mea-synapse-staging`; its imported source head is `8336631`
(`638ac56` contains the latest source change and `8336631` is the no-op
deployment trigger).

`https://synapse-mea-dashboard.lanchakon0.chatgpt.site` is a separate
ChatGPT Sites-hosted snapshot, served through Cloudflare rather than the Vercel
project. It currently exposes the same 29-path API contract, but its dashboard
bundle predates revision `804c6f0` and lacks the complete replenishment,
approval and route-job orchestration. Treat Vercel as the release target and
do not use the Sites URL as deployment evidence for this Git pipeline.

Run the database and pipeline verification suite with `make ci`, and run
`make workspace-ci` for that suite plus the tracked dashboard verification. The
GitHub Actions workflow always verifies both parts of the monorepo. The suites
include Python
module tests, OpenAPI and delivery checks, and a clean PostgreSQL 17 run of all
15 Supabase migrations, 29 schema/RLS/privilege checks, 17 authenticated
dispatcher workflow checks, 10 real worker execution checks and the dashboard's
native Next.js verification.
