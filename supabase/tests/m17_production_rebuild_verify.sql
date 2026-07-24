\set ON_ERROR_STOP on

begin;

create temporary table m17_checks (
  check_name text primary key,
  passed boolean not null
);

insert into m17_checks (check_name, passed)
values
  ('migration_registered',
    exists (
      select 1 from ops.schema_migrations
      where version = '202607240017'
    )),
  ('contract_item_versions',
    to_regclass('core.contract_item_versions') is not null),
  ('packaging_source_quality',
    exists (
      select 1 from information_schema.columns
      where table_schema = 'core'
        and table_name = 'packaging_profiles'
        and column_name = 'source_quality'
    )),
  ('receipt_source_quality',
    exists (
      select 1 from information_schema.columns
      where table_schema = 'core'
        and table_name = 'receipt_lots'
        and column_name = 'source_quality'
    )),
  ('readiness_view',
    to_regclass('analytics.v_production_readiness') is not null),
  ('environment_configuration_function',
    to_regprocedure(
      'ops.configure_environment(text,text,text,text)'
    ) is not null),
  ('cutover_function',
    to_regprocedure(
      'ops.set_operational_writes_enabled(boolean,text,text)'
    ) is not null),
  ('dispatcher_guard',
    to_regprocedure(
      'public.m09_dispatch_pre_m17(text,text,jsonb,jsonb,text)'
    ) is not null),
  ('anon_cannot_dispatch',
    not has_function_privilege(
      'anon',
      'public.m09_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('authenticated_can_dispatch',
    has_function_privilege(
      'authenticated',
      'public.m09_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('test_control_remains_enabled',
    exists (
      select 1 from ops.environment_controls
      where singleton and operational_writes_enabled
    ));

select ops.configure_environment(
  'production',
  'aaaaaaaaaaaaaaaaaaaa',
  'ap-southeast-2',
  'M17_LOCAL_VERIFY'
);

insert into m17_checks (check_name, passed)
values
  ('production_configuration_is_singleton',
    (select count(*) = 1
     from ops.environment_registry
     where environment_name = 'production'
       and project_ref = 'aaaaaaaaaaaaaaaaaaaa')),
  ('production_starts_locked',
    exists (
      select 1 from ops.environment_controls
      where singleton and not operational_writes_enabled
    )),
  ('production_fixture_free',
    (select fixture_row_count = 0
     from analytics.v_production_readiness)),
  ('production_cutover_not_claimed',
    (select not cutover_ready
     from analytics.v_production_readiness));

table m17_checks;

do $$
declare
  failed text;
begin
  select string_agg(check_name, ', ' order by check_name)
  into failed
  from m17_checks
  where not passed;
  if failed is not null then
    raise exception 'M17 production rebuild checks failed: %', failed;
  end if;
end
$$;

rollback;
