# Incident: Dashboard and Supabase contract out of sync

- Date: 23 July 2026
- User-visible error: `API path not found`
- Example request ID:
  `e4a0b9c0-5b11-4df1-8f5e-a0d71846baa2`
- Affected web target: <https://mea-synapse-staging.vercel.app>
- Supabase project: `mklnbumfwojxhqscthjd`
- Status: resolved

## Impact

The deployed dashboard requested the Production Operations v1 read model while
the managed Supabase project was still registered at migration
`202607160013`. Existing endpoints continued to return `200`, but these eight
new authenticated GET paths returned `404`:

- `/v1/traceability`
- `/v1/ad-hoc/issues`
- `/v1/inventory/fifo`
- `/v1/inventory/handling-units`
- `/v1/inventory/receipt-options`
- `/v1/replenishment/change-requests`
- `/v1/replenishment/recommendations`
- `/v1/replenishment/approvals`

Because the dashboard loads its operational read model concurrently, one
missing path raised the shared “ไม่สามารถซิงก์ข้อมูลบางส่วน” message.

## Root cause

Vercel correctly deployed canonical commit `06fe319` from
`lanchakon-maikaeo/synapse-mea-pipeline`, branch `main`, Root Directory
`dashboard`. The application and OpenAPI contract expected managed migration
`202607230014`, but that migration had not yet been applied to Supabase.

The preflight query proved:

- `migration_014_registered = false`;
- latest registered migration was `202607160013`;
- `core.handling_units`, `ops.ad_hoc_issues`, and `ops.plan_approvals` did not
  exist.

## Recovery

The Supabase project is on the Free plan and therefore has no scheduled
database backups. Before applying the additive migration, a protected
database-native snapshot was created in schema
`synapse_backup_20260723_pre014`. Its manifest captured the previous migration
state and row counts for the existing tables modified by migration 014:

| Object | Rows captured |
|---|---:|
| `core.warehouses` | 1 |
| `core.usage_rates` | 5,926 |
| `core.replenishment_plans` | 11 |
| `core.replenishment_items` | 0 |
| `ops.calculation_policies` | 1 |
| `ops.schema_migrations` | 15 |

The snapshot also stores the previous definitions of affected analytics views
and `public.m09_dispatch`. RLS was enabled on the snapshot tables. This
same-database snapshot protects migration data but is not a substitute for an
encrypted off-project `pg_dump` or managed point-in-time recovery.

Canonical migration
`supabase/migrations/202607230014_production_operations_v1.sql` was then applied
through the Supabase SQL Editor as the `postgres` role. The exact source file
used had SHA-256:

`131296d83a584ca751ca09a33edab4f050185afd5dbb5c717849c83f302ed751`

Release evidence was recorded in `ops.release_versions` as
`production-operations-v1-20260723`, Git SHA
`06fe3191f6b515573f4e5346405ced9b588385c6`, status `deployed`, profile `test`.

## Verification

Post-migration verification proved:

- migration `202607230014` is registered and is the latest migration;
- Handling Unit, ad-hoc issue, and approval objects exist;
- RLS is enabled on the new protected operational tables;
- `public.m09_dispatch` contains all eight formerly missing paths;
- an authenticated admin-context dispatcher test returned `200` for all eight
  paths.

No access token, database password, service-role credential, or user identifier
was copied into this repository.

## Prevention

1. Apply and verify the managed database migration before promoting a web
   revision that consumes its API contract.
2. Run authenticated deployment smoke checks; public checks stop at the
   authorization boundary and cannot prove database dispatch compatibility.
3. Compare `max(ops.schema_migrations.version)` with the release manifest in
   every deployment window.
4. Preserve a reviewed backup or snapshot before schema changes. For a durable
   production target, use a plan with managed backups/PITR or provide an
   encrypted off-project `pg_dump`.
