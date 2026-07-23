-- Manual rollback for M07. Run only after rolling back M08.
begin;
drop view if exists analytics.v_forecast_monitoring;
drop view if exists analytics.v_latest_forecasts;
drop function if exists analytics.queue_forecast_run(date,integer,date);
drop function if exists ops.fail_background_job(uuid,text,integer);
drop function if exists ops.complete_background_job(uuid,jsonb);
drop function if exists ops.claim_background_job(text,text[]);
drop table if exists analytics.forecast_drift_events;
drop table if exists analytics.forecast_metrics;
drop table if exists analytics.forecast_results;
drop table if exists analytics.forecast_runs;
drop table if exists analytics.demand_monthly_features;
drop table if exists analytics.forecast_model_versions;
drop table if exists ops.background_jobs;
delete from ops.schema_migrations where version='202607150005';
commit;
