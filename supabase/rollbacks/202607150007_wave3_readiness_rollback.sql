-- Manual rollback for the Wave 3 completion migration only.

begin;
drop view if exists analytics.v_wave3_readiness;
drop function if exists analytics.refresh_forecast_drift_events(numeric, numeric, numeric, integer);
delete from analytics.forecast_model_versions where model_version='autoets-v1';
delete from ops.schema_migrations where version='202607150007';
commit;
