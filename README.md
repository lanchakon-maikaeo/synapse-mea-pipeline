# SYNAPSE — MEA VMI Operations

Production-oriented, open-source pipeline for MEA stock, replenishment,
warehouse issue and traceability operations. The active production release
implements the frozen `Business Rules v1`. A road-aware smart-logistics
candidate is now part of the repository, but remains fail-closed until its
database migration, controlled routing/tiles services and verified facility
coordinates are promoted through the production release gates.

## Modules

- `pipeline/` — source connectors, ingestion, checksum and idempotency
- `dashboard/` — Next.js Web App and Supabase Auth; the verified live contract
  is SYNAPSE API `1.3.0` with 48 paths, matching the working tree
- `supabase/` — ordered database migrations, RLS, audit, backup evidence and
  acceptance SQL
- `api/` — optional self-host compatibility adapter; not the Vercel runtime
- `deploy/` and `scripts/` — containers, monitoring, backup and restore drill
- `intelligence/` — tested Valhalla/OR-Tools worker for the gated smart-logistics
  deployment profile; it is not scheduled by the current Vercel-only release

Start with the
[current end-to-end pipeline](SYNAPSE_CURRENT_PIPELINE.md). It consolidates the
active scope, Business Rules v1, architecture, data flow, API, deployment,
operations, backup, rollback and current readiness in one document. Older Wave
documents are historical implementation records and do not expand the active
release scope.

## Deployment topology

- Canonical source: `lanchakon-maikaeo/synapse-mea-pipeline`, branch `main`.
- Web release target: Vercel Production URL
  <https://mea-synapse-production.vercel.app>.
- Vercel Git source: the canonical repository above, with Root Directory
  `dashboard` and Production branch `main`.
- Database/Auth target: managed Supabase Production project
  `fvdfduuanfrncrwuareb` (`synapse-01`, `ap-southeast-1`).
- Release code contains 32 ordered additive migrations. The verified live head
  is M13e (`202607250005`), applied 26 July 2026; M13–M13e
  (`202607250001`–`202607250005`) are live. Transport schema and API are
  deployed. Owner-attested depot and partial fleet evidence makes the transport
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

Run `make workspace-ci` before release. The current database contract starts a
clean PostgreSQL 17 instance and applies all 32 working-tree migrations; the 69
schema/RLS/privilege controls plus 20 authenticated workflows are the verified
M24 baseline, with additional M13/M13e contracts required for transport. The
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
