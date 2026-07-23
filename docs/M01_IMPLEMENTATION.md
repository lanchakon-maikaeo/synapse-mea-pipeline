# M01 — Platform, Database and Security Foundation

**Project:** `test-synapse-mea` (`mklnbumfwojxhqscthjd`)  
**Environment:** Test  
**Implementation date:** 2026-07-14

## Existing data reconciled

- Source workbook: `รวมสัญญา.xlsx`
- Source sheet/range: `รวมสัญญา!A1:P6306`
- Workbook SHA-256: `8ea7b0e712726e6cc1990f33b0031be231a91cc01fb4f8d96e6146d83e3cf9dd`
- Workbook data rows: 6,305
- Existing Supabase rows before M01: 6,305
- Existing table retained: `public.contracts`
- Known source nulls retained as valid source facts: 2,130 rows without material code and 1,228 rows without contract number

M01 adds a baseline record in `raw.import_batches` and connects every existing contract row through `source_batch_id`, `source_file`, `source_sheet`, `source_checksum` and row metadata. No source business field is overwritten.

## Foundation delivered

- Schemas: `raw`, `staging`, `core`, `analytics`, `rag`, `ops`, `audit`
- Application roles: `admin`, `planner`, `district`, `viewer`
- Supabase Auth profile mapping in `public.user_profiles`
- Default new-user role: `viewer`
- RLS for profiles and the existing contracts table
- No anonymous access to contracts or profiles
- Admin-only contract mutations; signed-in roles can read after role assignment
- Reusable `updated_at` and row-change audit triggers
- Migration registry and non-secret environment registry
- Source lineage for all 6,305 existing contract rows
- Free-plan manual backup procedure

## Environment limitation

Only one managed Supabase project currently exists and it is registered as Test. Development and Production should be separate projects or local Supabase instances before production rollout.

## Acceptance

Run `supabase/tests/m01_verify.sql`. All 9 checks must return `passed = true`.
