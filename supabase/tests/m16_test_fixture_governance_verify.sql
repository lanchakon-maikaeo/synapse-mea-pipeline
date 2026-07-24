\set ON_ERROR_STOP on

begin;

create temporary table m16_checks (
  check_name text primary key,
  passed boolean not null
);

insert into m16_checks (check_name, passed)
values
  ('migration_registered',
    exists (
      select 1 from ops.schema_migrations
      where version = '202607240016'
    )),
  ('test_only_environment',
    exists (
      select 1 from ops.environment_registry
      where environment_name = 'test'
        and project_ref = 'mklnbumfwojxhqscthjd'
    )),
  ('fixture_tables_are_rls_protected',
    (select relrowsecurity
     from pg_class where oid = 'ops.test_fixture_imports'::regclass)
    and
    (select relrowsecurity
     from pg_class where oid = 'ops.test_fixture_material_overrides'::regclass)),
  ('anon_cannot_import_fixture',
    not has_function_privilege(
      'anon',
      'public.m16_import_test_fixture(text,text,jsonb,jsonb)',
      'execute'
    )),
  ('authenticated_can_call_guarded_fixture_rpc',
    has_function_privilege(
      'authenticated',
      'public.m16_import_test_fixture(text,text,jsonb,jsonb)',
      'execute'
    )),
  ('stock_health_exposes_fixture_provenance',
    exists (
      select 1 from information_schema.columns
      where table_schema = 'analytics'
        and table_name = 'v_stock_health'
        and column_name = 'stock_data_class'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'analytics'
        and table_name = 'v_stock_health'
        and column_name = 'usage_data_class'
    ));

table m16_checks;

do $$
begin
  if exists (select 1 from m16_checks where not passed) then
    raise exception 'M16 fixture governance verification failed: %',
      (select string_agg(check_name, ', ' order by check_name)
       from m16_checks where not passed);
  end if;
end
$$;

rollback;
