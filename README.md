# SYNAPSE — MEA VMI Operations

Production-oriented, open-source pipeline for MEA stock, replenishment,
warehouse issue and traceability operations. The active production release
implements the frozen `Business Rules v1`. A road-aware smart-logistics
candidate is now part of the repository, but remains fail-closed until its
database migration, controlled routing/tiles services and verified facility
coordinates are promoted through the production release gates.

## Modules

- `pipeline/` — source connectors, ingestion, checksum and idempotency
- `dashboard/` — Next.js Web App and Supabase Auth; its API paths are listed in
  `dashboard/app/m09-openapi.ts` (SYNAPSE API `1.3.0`). It also holds the AI
  layer described below (`app/api/chat/`, `app/api/agentic-alert-worker.mjs`,
  `evals/`)
- `supabase/` — ordered database migrations, RLS, audit, backup evidence and
  acceptance SQL
- `api/` — optional self-host compatibility adapter; not the Vercel runtime
- `deploy/` and `scripts/` — containers, monitoring, backup and restore drill
- `intelligence/` — tested Valhalla/OR-Tools worker for the gated smart-logistics
  deployment profile; it is not scheduled by the current Vercel-only release

## AI layer

- **SYNAPSE Agent chat** (`/api/chat`, widget `app/chat-widget.tsx`): answers
  signed-in users from the database with the caller's own Supabase JWT, so a
  user only reads what their role allows. Production runs Typhoon
  (`LLM_PROVIDER=typhoon`, `typhoon-v2.5-30b-a3b-instruct`) under harness v6:
  at most six reads and two corrections, a finish backed only by what was read,
  then a writer and an independent reviewer. Setup, variables and database
  functions are in [dashboard/docs/CHAT_KNOWLEDGE.md](dashboard/docs/CHAT_KNOWLEDGE.md).
- **Masking** ([ADR 0001](docs/adr/0001-mask-personal-data-before-every-ai-call.md)):
  every request to an AI provider passes one masker that swaps personal data
  and secrets for per-run labels and restores them in tool arguments and
  answers. There is no switch to turn it off.
- **Search** ([ADR 0002](docs/adr/0002-rank-rows-in-postgres-by-near-match-and-meaning.md)):
  Postgres ranks rows, not the model. A material search with no exact hit
  returns near matches ranked by text (pg_trgm), by meaning (BGE-M3 embeddings
  on Cloudflare Workers AI, stored in pgvector) and by the SAP English terms of
  Thai words ("หม้อแปลง 3 เฟส" → `trans 3p`), fused with Reciprocal Rank
  Fusion; the chat shows each score as its confidence. pg_cron embeds new or
  renamed material names daily. Import rows in `staging.*` and `raw.*` are left
  out of business questions.
- **Agentic alerts** ([dashboard/docs/AGENTIC_ALERTS.md](dashboard/docs/AGENTIC_ALERTS.md)):
  an hourly worker turns stock and plan evidence into alerts behind the bell;
  the model's advice must pass an independent factual review, otherwise the
  alert keeps its deterministic evidence and action.
- **Evals** (`dashboard/evals/`): locked sets `chat-heldout-v1`,
  `chat-redteam-v1`, `source-ranking-v1` and `alerts-replay-v1` run against the
  real provider through `dashboard/evals/run.mjs`; `live.sh` runs the chat and
  alert sets, reads the key hidden and keeps it in memory only. An AI change merges at ≥85% grounded on two
  heldout runs, no worse than `main`, with zero red-team leaks.
- Research notes behind these choices:
  [docs/RESEARCH_CHAT_PIPELINE.md](docs/RESEARCH_CHAT_PIPELINE.md) and
  [docs/RESEARCH_AGENT_HARNESS.md](docs/RESEARCH_AGENT_HARNESS.md).

Start with the
[current end-to-end pipeline](SYNAPSE_CURRENT_PIPELINE.md). It consolidates the
active scope, Business Rules v1, architecture, data flow, API, deployment,
operations, backup, rollback and current readiness in one document. Older Wave
documents are historical implementation records and do not expand the active
release scope.

## Deployment topology

- Canonical source: `lanchakon-maikaeo/synapse-mea-pipeline`, branch `main`.
- Web release target: Vercel Production URL
  <https://mea-synapse-web.vercel.app>.
- Vercel Git source: the canonical repository above, with Root Directory
  `dashboard` and Production branch `main`.
- Database/Auth target: managed Supabase Production project
  `fvdfduuanfrncrwuareb` (`synapse-01`, `ap-southeast-1`).
- Release code contains the ordered additive migrations in
  `supabase/migrations/` (68 files, `202607140000` to `202611270002` on 27
  November 2026). Which of them are live is
  recorded in `ops.schema_migrations` of the Production database; check there
  rather than in this file. Transport schema and API are deployed. Owner-attested depot and partial fleet evidence makes the transport
  input readiness gate report `ready`, but real route planning remains blocked
  until controlled routing services, a locked replenishment plan, packaging
  evidence and route-plan activation are available. The approved
  `PRODUCTION_APPROVED` import, isolated restore drill and owner-directed
  single-admin policy are verified in Production; no synthetic district users
  are created.
- Guarded cutover `SYNAPSE-PROD-20260724` is complete. Production reports
  `cutover_ready=true` and `readiness_status=operational`.
- The browser uses only the Supabase publishable key. Database credentials and
  `service_role` must remain in the deployment secret store.

The prior ChatGPT Sites metadata is inactive; Vercel is the only active web
release target.
The former `lanchakon-maikaeo/synapse-mea-dashboard` deployment mirror is
retained only as an archived migration record and is not connected to Vercel.

Run `make workspace-ci` before release. The database contract
(`scripts/test_supabase_migrations_local.sh`) starts a clean PostgreSQL 17
instance, applies every working-tree migration and runs each verify script in
`supabase/tests/`. `make migration-check` rejects a migration that is not named
`<12-digit version>_<name>.sql` (the release script needs that) or that patches
a function's text; write the whole function with `create or replace`. The
dashboard gate runs lint, TypeScript, a production Next.js build, rendered
screen/API tests and the Drizzle database contract. Local success is not live
deployment evidence.

The smart-logistics architecture, research basis, geographic-data approval
workflow, map/routing configuration and staging-to-production gates are in
[Smart Logistics and Inventory — production design](docs/SMART_LOGISTICS_PRODUCTION.md).
The owner-designated transport source is guarded by
`python3 scripts/verify_transport_geocodes.py`; any checksum change requires a
reviewed coordinate migration rather than silent replacement. That one
`districts.csv` file is intentionally included in Git so the same checksum gate
runs in a clean CI checkout; the remaining generated production CSV exports
stay excluded.
