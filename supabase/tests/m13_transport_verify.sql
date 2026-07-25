\set ON_ERROR_STOP on

begin;

create temporary table m13_transport_checks (
  check_name text primary key,
  passed boolean not null
);

insert into m13_transport_checks (check_name, passed)
values
  ('transport_migration_registered',
    exists (
      select 1 from ops.schema_migrations where version = '202607250001'
    )),
  ('transport_master_tables_exist',
    to_regclass('core.transport_warehouses') is not null
    and to_regclass('core.transport_district_geo') is not null
    and to_regclass('core.transport_vehicles') is not null
    and to_regclass('core.transport_route_legs') is not null),
  ('transport_trips_table_exists',
    to_regclass('ops.transport_trips') is not null),
  ('transport_trips_rls_enabled',
    (select relrowsecurity from pg_class where oid = 'ops.transport_trips'::regclass)),
  ('transport_analytics_views_exist',
    to_regclass('analytics.v_transport_vehicle_status') is not null
    and to_regclass('analytics.v_transport_route_matrix') is not null
    and to_regclass('analytics.v_transport_trip_summary') is not null),
  ('transport_dispatch_authenticated_only',
    has_function_privilege(
      'authenticated',
      'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('transport_masters_locked_from_authenticated',
    not has_table_privilege('authenticated', 'core.transport_vehicles', 'select')
    and not has_table_privilege('authenticated', 'ops.transport_trips', 'insert')),
  ('transport_seed_warehouses',
    (select count(*) = 3 from core.transport_warehouses)),
  ('transport_seed_geo_nodes',
    (select count(*) = 19 from core.transport_district_geo)),
  ('transport_seed_vehicles',
    (select count(*) = 6 from core.transport_vehicles)),
  ('transport_seed_route_legs',
    (select count(*) = 54 from core.transport_route_legs)),
  ('transport_route_leg_totals_positive',
    (select bool_and(distance_km > 0 and travel_minutes > 0)
       from core.transport_route_legs));

table m13_transport_checks;

do $$
begin
  if exists(select 1 from m13_transport_checks where not passed) then
    raise exception 'M13 transport contract failed: %',
      (select string_agg(check_name, ', ' order by check_name)
       from m13_transport_checks
       where not passed);
  end if;
end
$$;

rollback;
