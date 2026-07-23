-- M08 acceptance checks. Expected: every row has passed = true.
with checks as (
  select 'm08_migration_registered' as check_name,
         exists (select 1 from ops.schema_migrations where version='202607150006') as passed,
         'migration registered' as detail

  union all select 'documented_vehicles_seeded',
    count(*) = 2 and min(max_weight_kg)=6000 and max(max_weight_kg)=10000,
    count(*)::text || ' vehicles; weights ' || min(max_weight_kg)::text || '-' || max(max_weight_kg)::text
  from core.vehicles where vehicle_id in ('707','708') and is_active

  union all select 'no_mock_drivers', count(*) = 0, count(*)::text || ' placeholder drivers'
  from core.drivers
  where lower(employee_reference) like '%mock%' or lower(employee_reference) like '%dummy%'
     or lower(display_name) like '%mock%' or lower(display_name) like '%dummy%'

  union all select 'm08_tables_rls_enabled', count(*) = 10, count(*)::text || '/10 tables'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relrowsecurity and (
    (n.nspname='core' and c.relname in (
      'location_geocodes','material_packaging','vehicles','drivers','route_plans',
      'route_plan_vehicles','route_stops','route_unserved_stops'
    )) or (n.nspname='analytics' and c.relname='route_matrices')
       or (n.nspname='ops' and c.relname='route_jobs')
  )

  union all select 'anon_m08_access_blocked', count(*) = 0, count(*)::text || ' exposed tables'
  from information_schema.tables
  where table_name in (
    'location_geocodes','material_packaging','vehicles','drivers','route_matrices',
    'route_jobs','route_plans','route_plan_vehicles','route_stops','route_unserved_stops'
  ) and has_table_privilege('anon', format('%I.%I', table_schema, table_name), 'select')

  union all select 'route_views_available', count(*) = 2, count(*)::text || '/2 views'
  from information_schema.views
  where table_schema='analytics' and table_name in ('v_route_plan_geojson','v_route_plan_summary')

  union all select 'route_workflow_functions', count(*) = 2, count(*)::text || '/2 functions'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='core' and p.proname in ('queue_route_job','review_route_plan')
)
select check_name, passed, detail from checks order by check_name;
