# Candidate migrations (prepared, not auto-applied)

Files here are **reviewed, ready-to-apply database changes that are deliberately
excluded from the automated contract**. The local contract harness only globs
`supabase/migrations/*.sql`, so nothing in this directory runs in
`make database-contract-local`, and the frozen acceptance gates
("32 migrations", "3 active models") stay green until an owner promotes a file
through the normal reviewed release.

This mirrors how the rest of SYNAPSE ships intelligence features: the schema and
code land first and stay fail-closed, then activation happens as a discrete,
attested release step.

## `202607270004_m07b_intermittent_forecasting.sql`

Registers the Croston, SBA, TSB and ADIDA model versions that
`intelligence/src/synapse_intelligence/forecasting.py` selects for
intermittent/lumpy demand. Required before the worker can persist those models
(the `forecast_results` / `forecast_metrics` `model_version` foreign key).

The version `202607270004` is the next free slot after the M14/M14b/M14c batch
already on `main` (`202607270001`–`202607270003`).

### Activation checklist

1. `git mv supabase/candidate/202607270004_m07b_intermittent_forecasting.sql
   supabase/migrations/` and move the `_rollback.sql` into `supabase/rollbacks/`.
2. Update the exact-count acceptance gates so the contract stays consistent
   (set them to the **actual** counts, do not assume the doc's old numbers —
   `main` already carries migrations beyond the historical 32):
   - `supabase/tests/local_schema_contract_verify.sql`:
     `all_migrations_registered` `count(*) = <N>` -> `<N + 1>`.
   - `supabase/tests/non_ai_completion_verify.sql`:
     `wave3_models_preserved` `count(*)=3` -> `7` (3 existing + 4 new).
3. Set `SYNAPSE_INTERMITTENT_FORECAST=1` for the forecast worker so
   `forecast_best_available(..., allow_intermittent=True)` is used. The flag and
   this migration must ship together: enabling the flag without the migration
   violates the `model_version` foreign key.
4. Run `make database-contract-local` (needs Docker) and `make intelligence-test`
   before release.

> Note: as of this branch, `main`'s `local_schema_contract_verify.sql` still
> asserts `count(*) = 32` while `supabase/migrations/` already holds 35 files, so
> that gate is failing independently of this candidate. Resolve that count first.

See `docs/RESEARCH_DRIVEN_IMPROVEMENTS.md` for the rationale and research basis.
