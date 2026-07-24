# MEA Synapse — Supabase Staging Database Package

Environment: **Staging only — never link or push this package to Production.**

## Contents

- `supabase/migrations/20260722000100_mea_synapse_foundation.sql`
- `supabase/migrations/20260722000200_mea_synapse_views_guards.sql`
- `supabase/migrations/20260722000300_mea_synapse_decision_intelligence.sql`
- `reference/schema.ts`
- business rules and master requirements under `reference/`

The migrations create 24 tables, 8 Analytics views, 22 triggers, RLS foundation on 24 tables and privacy-safe baseline records. No SAP operational data or credentials are included.

## Recommended CLI Workflow

Run these commands from the extracted package root:

```powershell
supabase init
supabase login
supabase link --project-ref <STAGING_PROJECT_REF>
supabase db push --dry-run
supabase db push
```

Before `db push`, verify that the linked project is the dedicated Staging project. Do not use `db reset --linked`; it is destructive.

If the repository already has a Supabase project, copy the three migration files into its `supabase/migrations/` directory and preserve their timestamp order.

## Security State

- RLS is enabled as a safe foundation.
- Role-specific policies and grants are not yet implemented.
- Custom schemas are not exposed through the Data API by default.
- Do not expose `raw`, `core`, `ops`, `audit` or `analytics` until authenticated role/district policies are reviewed and tested.
- Do not place the service-role key or database password in repository files.

## Post-Push Verification

Confirm that the database contains:

- 24 tables across `raw`, `core`, `ops` and `audit`
- 8 views in `analytics`
- Business Rules policy `BR-V1`
- Khlong Toei warehouse Plant `2401`, Storage Location `0001`
- dummy supplier alias `SUP-UNKNOWN`

Official documentation:

- https://supabase.com/docs/guides/local-development/overview
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/api/using-custom-schemas