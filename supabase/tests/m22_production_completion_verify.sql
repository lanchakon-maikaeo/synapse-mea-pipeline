\set ON_ERROR_STOP on

begin;

create temporary table m22_checks (
  check_name text primary key,
  passed boolean not null
);

insert into m22_checks (check_name, passed)
values
  (
    'migration_registered',
    exists (
      select 1 from ops.schema_migrations
      where version = '202607240022'
    )
  ),
  (
    'attestation_table',
    to_regclass('ops.production_completion_attestations') is not null
  ),
  (
    'attestation_rpc',
    to_regprocedure(
      'public.m22_attest_production_completion(uuid,text,text,text,text)'
    ) is not null
  ),
  (
    'rpc_service_role_only',
    has_function_privilege(
      'service_role',
      'public.m22_attest_production_completion(uuid,text,text,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.m22_attest_production_completion(uuid,text,text,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'public.m22_attest_production_completion(uuid,text,text,text,text)',
      'execute'
    )
  ),
  (
    'coverage_exposes_attested_counts',
    (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'analytics'
        and table_name = 'v_source_observation_coverage'
        and column_name in (
          'owner_attested_zero_district_stock_pairs',
          'owner_attested_zero_warehouse_stock_materials',
          'owner_attested_zero_usage_pairs'
        )
    )
  ),
  (
    'stock_evidence_nullable_source_row',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'reference_data'
        and table_name = 'stock_observation_evidence'
        and column_name = 'source_row_id'
        and is_nullable = 'YES'
    )
  ),
  (
    'usage_evidence_nullable_source_row',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'reference_data'
        and table_name = 'usage_observation_evidence'
        and column_name = 'source_row_id'
        and is_nullable = 'YES'
    )
  );

table m22_checks;

do $$
begin
  if exists (select 1 from m22_checks where not passed) then
    raise exception 'M22 Production completion contract failed';
  end if;
end
$$;

rollback;
