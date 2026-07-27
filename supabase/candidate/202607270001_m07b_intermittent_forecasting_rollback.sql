-- Rollback for M07b intermittent-demand model registration.
-- Safe only when no forecast_results / forecast_metrics rows reference these
-- versions (the foreign key is ON ... references without cascade).

begin;

delete from analytics.forecast_model_versions
where model_version in ('croston-v1', 'croston-sba-v1', 'tsb-v1', 'adida-v1');

delete from ops.schema_migrations where version = '202607270001';

commit;
