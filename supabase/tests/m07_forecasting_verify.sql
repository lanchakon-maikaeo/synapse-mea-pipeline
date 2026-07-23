-- M07 acceptance checks. Expected: every row has passed = true.
with checks as (
  select 'm07_migration_registered' as check_name,
         exists (select 1 from ops.schema_migrations where version='202607150005') as passed,
         'migration registered' as detail

  union all select 'baseline_models_registered', count(*) = 2, count(*)::text || '/2 models'
  from analytics.forecast_model_versions
  where model_version in ('seasonal-naive-v1','moving-average-v1') and is_active

  union all select 'm07_tables_rls_enabled', count(*) = 7, count(*)::text || '/7 tables'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relrowsecurity and (
    (n.nspname='ops' and c.relname='background_jobs') or
    (n.nspname='analytics' and c.relname in (
      'forecast_model_versions','demand_monthly_features','forecast_runs',
      'forecast_results','forecast_metrics','forecast_drift_events'
    ))
  )

  union all select 'anon_m07_access_blocked', count(*) = 0, count(*)::text || ' exposed tables'
  from information_schema.tables
  where table_name in (
    'background_jobs','forecast_model_versions','demand_monthly_features',
    'forecast_runs','forecast_results','forecast_metrics','forecast_drift_events'
  ) and has_table_privilege('anon', format('%I.%I', table_schema, table_name), 'select')

  union all select 'background_job_functions', count(*) = 3, count(*)::text || '/3 functions'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='ops' and p.proname in ('claim_background_job','complete_background_job','fail_background_job')

  union all select 'forecast_views_available', count(*) = 2, count(*)::text || '/2 views'
  from information_schema.views
  where table_schema='analytics' and table_name in ('v_latest_forecasts','v_forecast_monitoring')

  union all select 'prior_waves_preserved',
    (select count(*) from core.contract_items where is_current)=6305
      and (select count(*) from ops.calculation_policies where is_active)=1,
    '6305 contract items; 1 active replenishment policy'
)
select check_name, passed, detail from checks order by check_name;
