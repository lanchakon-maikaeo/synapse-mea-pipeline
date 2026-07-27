-- SYNAPSE Wave 3 / M07b: Register intermittent-demand model versions.
--
-- PREPARED, NOT YET ACTIVE. This file is intentionally NOT under
-- supabase/migrations/ so the local database contract harness does not apply it
-- and the frozen "32 migrations / 3 active models" acceptance gates stay green.
-- Promote it through the normal reviewed release (see supabase/candidate/README.md)
-- together with the SYNAPSE_INTERMITTENT_FORECAST=1 worker flag.
--
-- It registers the Croston, SBA, TSB and ADIDA versions the intelligence worker
-- selects for intermittent/lumpy series, satisfying the forecast_results /
-- forecast_metrics model_version foreign key. The models are deterministic and
-- dependency-light, so they are catalogued in the existing 'baseline' family.

begin;

insert into analytics.forecast_model_versions (
  model_version, model_name, model_family, parameters, implementation_reference
)
values
  ('croston-v1', 'Croston', 'baseline',
   '{"alpha":0.1,"applies_to":["intermittent","lumpy"]}',
   'intelligence/src/synapse_intelligence/forecasting.py'),
  ('croston-sba-v1', 'Croston SBA', 'baseline',
   '{"alpha":0.1,"bias_correction":"1-alpha/2","applies_to":["intermittent","lumpy"]}',
   'intelligence/src/synapse_intelligence/forecasting.py'),
  ('tsb-v1', 'Teunter-Syntetos-Babai', 'baseline',
   '{"alpha":0.1,"beta":0.05,"handles_obsolescence":true,"applies_to":["intermittent","lumpy"]}',
   'intelligence/src/synapse_intelligence/forecasting.py'),
  ('adida-v1', 'ADIDA temporal aggregation', 'baseline',
   '{"aggregation":"mean_interdemand_interval","applies_to":["intermittent","lumpy"]}',
   'intelligence/src/synapse_intelligence/forecasting.py')
on conflict (model_version) do update
set model_name = excluded.model_name,
    model_family = excluded.model_family,
    parameters = excluded.parameters,
    implementation_reference = excluded.implementation_reference,
    is_active = true;

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607270001', 'W03',
  'Register Croston/SBA/TSB/ADIDA intermittent-demand model versions for M07.',
  'supabase/migrations/202607270001_m07b_intermittent_forecasting.sql'
)
on conflict (version) do update set description=excluded.description, source_file=excluded.source_file;

commit;
