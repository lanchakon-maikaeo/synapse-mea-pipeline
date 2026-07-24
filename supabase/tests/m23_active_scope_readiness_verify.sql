\set ON_ERROR_STOP on

begin;

create temporary table m23_checks (
  check_name text primary key,
  passed boolean not null
);

insert into m23_checks (check_name, passed)
values
  (
    'migration_registered',
    exists (
      select 1 from ops.schema_migrations
      where version = '202607240023'
    )
  ),
  (
    'material_master_ready_is_explicit',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'analytics'
        and table_name = 'v_production_readiness'
        and column_name = 'material_master_ready'
        and data_type = 'boolean'
    )
  ),
  (
    'active_data_gate_uses_source_coverage',
    position(
      'stock.row_count >= scope.expected_district_material_rows'
      in pg_get_viewdef(
        'analytics.v_production_readiness'::regclass,
        true
      )
    ) > 0
  ),
  (
    'health_contract_remains_available',
    to_regprocedure('public.m09_health()') is not null
  );

table m23_checks;

do $$
begin
  if exists (select 1 from m23_checks where not passed) then
    raise exception 'M23 active scope readiness contract failed';
  end if;
end
$$;

rollback;
