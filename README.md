# SYNAPSE — MEA VMI Operations

Production-oriented, open-source pipeline for MEA stock, replenishment,
warehouse issue and traceability operations. The active release implements the
frozen `Business Rules v1`; forecasting, routing and RAG are explicitly
excluded.

## Modules

- `pipeline/` — source connectors, ingestion, checksum and idempotency
- `dashboard/` — production Next.js Web App, Supabase Auth and 36-path
  same-origin operational API
- `supabase/` — ordered database migrations, RLS, audit, backup evidence and
  acceptance SQL
- `api/` — optional self-host compatibility adapter; not the Vercel runtime
- `deploy/` and `scripts/` — containers, monitoring, backup and restore drill
- `intelligence/` — retained historical experimental source; not built,
  scheduled or deployed by the active release

Start with the [production operations contract](docs/PRODUCTION_OPERATIONS_V1.md),
[Business Rules v1](dashboard/docs/BUSINESS_RULES_V1.md) and the
[operations runbook](docs/OPERATIONS_RUNBOOK.md). Older Wave documents are
historical implementation records and do not expand the active release scope.

## Deployment topology

- Canonical source: `lanchakon-maikaeo/synapse-mea-pipeline`, branch `main`.
- Web release target: Vercel workspace/project
  `synapse-mea/mea-synapse-staging`, URL
  <https://mea-synapse-staging.vercel.app>.
- Vercel Git source: the canonical repository above, with Root Directory
  `dashboard` and Production branch `main`.
- Database/Auth target: managed Supabase project
  `mklnbumfwojxhqscthjd`.
- Managed database status: migration `202607230015` applied and verified on
  23 July 2026. See the
  [contract-sync incident record](docs/incidents/2026-07-23-supabase-contract-sync.md).
- The browser uses only the Supabase publishable key. Database credentials and
  `service_role` must remain in the deployment secret store.

`https://synapse-mea-dashboard.lanchakon0.chatgpt.site` is a separate
ChatGPT Sites-hosted snapshot, served through Cloudflare rather than the Vercel
project. It is not a release target or deployment evidence for this repository.
The former `lanchakon-maikaeo/synapse-mea-dashboard` deployment mirror is
retained only as an archived migration record and is not connected to Vercel.

Run `make workspace-ci` before release. The production database contract starts
a clean PostgreSQL 17 instance, applies all 17 migrations and verifies 44
schema/RLS/privilege controls plus 20 authenticated workflow checks. The
dashboard gate runs lint, TypeScript, a production Next.js build, rendered
screen/API tests and the Drizzle database contract.
