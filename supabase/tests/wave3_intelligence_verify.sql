-- Wave 3 acceptance checks. Expected: every row has passed = true.
with checks as (
  select 'wave3_migrations_registered' as check_name,
         count(*) = 3 as passed, count(*)::text || '/3 migrations' as detail
  from ops.schema_migrations where version in ('202607150005','202607150006','202607150007')

  union all select 'forecast_models_registered', count(*) = 3, count(*)::text || '/3 active models'
  from analytics.forecast_model_versions
  where model_version in ('seasonal-naive-v1','moving-average-v1','autoets-v1') and is_active

  union all select 'wave3_tables_rls_enabled', count(*) = 17, count(*)::text || '/17 tables'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relrowsecurity and (
    (n.nspname='ops' and c.relname in ('background_jobs','route_jobs')) or
    (n.nspname='analytics' and c.relname in (
      'forecast_model_versions','demand_monthly_features','forecast_runs','forecast_results',
      'forecast_metrics','forecast_drift_events','route_matrices'
    )) or
    (n.nspname='core' and c.relname in (
      'location_geocodes','material_packaging','vehicles','drivers','route_plans',
      'route_plan_vehicles','route_stops','route_unserved_stops'
    ))
  )

  union all select 'anonymous_wave3_access_blocked', count(*) = 0, count(*)::text || ' exposed tables'
  from information_schema.tables
  where (
    (table_schema='ops' and table_name in ('background_jobs','route_jobs')) or
    (table_schema='analytics' and table_name in (
      'forecast_model_versions','demand_monthly_features','forecast_runs','forecast_results',
      'forecast_metrics','forecast_drift_events','route_matrices'
    )) or
    (table_schema='core' and table_name in (
      'location_geocodes','material_packaging','vehicles','drivers','route_plans',
      'route_plan_vehicles','route_stops','route_unserved_stops'
    ))
  ) and has_table_privilege('anon', format('%I.%I', table_schema, table_name), 'select')

  union all select 'wave3_views_available', count(*) = 5, count(*)::text || '/5 views'
  from information_schema.views
  where table_schema='analytics' and table_name in (
    'v_latest_forecasts','v_forecast_monitoring','v_route_plan_geojson',
    'v_route_plan_summary','v_wave3_readiness'
  )

  union all select 'background_job_contract', count(*) = 3, count(*)::text || '/3 job functions'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='ops' and p.proname in ('claim_background_job','complete_background_job','fail_background_job')

  union all select 'forecast_workflow_contract', count(*) = 2, count(*)::text || '/2 forecast functions'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='analytics' and p.proname in ('queue_forecast_run','refresh_forecast_drift_events')

  union all select 'route_workflow_contract', count(*) = 2, count(*)::text || '/2 route functions'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='core' and p.proname in ('queue_route_job','review_route_plan')

  union all select 'readiness_signal_returns_one_row', count(*) = 1, count(*)::text || ' readiness rows'
  from analytics.v_wave3_readiness

  union all select 'documented_vehicle_source_preserved',
    count(*) = 2 and bool_and(source_reference='synapse/ALGORITHM.md section 6'),
    count(*)::text || '/2 source-traced vehicles'
  from core.vehicles where vehicle_id in ('707','708') and is_active

  union all select 'no_mock_drivers', count(*) = 0, count(*)::text || ' placeholder drivers'
  from core.drivers
  where lower(employee_reference) ~ '(mock|dummy|test)' or lower(display_name) ~ '(mock|dummy|test)'

  union all select 'prior_waves_preserved',
    (select count(*) from core.contract_items where is_current)=6305
      and (select count(*) from ops.calculation_policies where is_active)=1,
    '6305 contract items; 1 active replenishment policy'
)
select check_name, passed, detail from checks order by check_name;
