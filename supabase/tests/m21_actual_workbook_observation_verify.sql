\set ON_ERROR_STOP on

begin;

create temporary table m21_checks (
  check_name text primary key,
  passed boolean not null
);

insert into raw.import_batches (
  batch_id,
  source_system,
  source_file,
  source_sheet,
  source_checksum,
  row_count,
  status,
  imported_at
)
values (
  '21000000-0000-4000-8000-000000000001',
  'm21_contract_test',
  'm21_contract_test.xlsx',
  'Check CMP',
  repeat('c', 64),
  1,
  'succeeded',
  now()
);

insert into core.materials (
  material_id,
  sap_material_id,
  material_name,
  unit,
  is_vmi,
  master_source,
  source_batch_id
)
values (
  '999999999999',
  '999999999999',
  'M21 CMP TEST',
  'EA',
  true,
  'material_master',
  '21000000-0000-4000-8000-000000000001'
);

insert into analytics.demand_monthly_features (
  material_id,
  district_id,
  period_start,
  demand_quantity,
  source_batch_id,
  feature_version
)
values (
  '999999999999',
  '5501',
  date '2026-01-01',
  99,
  '21000000-0000-4000-8000-000000000001',
  'monthly-demand-v1'
);

insert into core.usage_rates (
  material_id,
  district_id,
  as_of_date,
  cmp_monthly,
  avg_ly,
  avg_12m,
  avg_6m,
  avg_4m,
  source_batch_id,
  data_class,
  source_quality
)
values (
  '999999999999',
  '5501',
  date '2026-04-30',
  0,
  1,
  2,
  3,
  4,
  '21000000-0000-4000-8000-000000000001',
  'actual',
  'source_observed'
);

insert into m21_checks (check_name, passed)
values
  ('migration_registered',
    exists (
      select 1
      from ops.schema_migrations
      where version = '202607240021'
    )),
  ('monthly_usage_fact',
    to_regclass('core.monthly_usage_observations') is not null),
  ('stock_evidence_import_lineage',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'reference_data'
        and table_name = 'stock_observation_evidence'
        and column_name = 'actual_workbook_import_id'
        and is_nullable = 'NO'
    )),
  -- M14 (project-sheet incremental) allows usage evidence to originate from
  -- either an actual-workbook import or a project-sheet import, so
  -- actual_workbook_import_id is now nullable and lineage is guaranteed by the
  -- exclusive-source constraint num_nonnulls(actual_workbook_import_id,
  -- project_sheet_import_id) = 1. Verify that constraint rather than the old
  -- NOT NULL, which enforces the same "every row has exactly one import
  -- lineage" invariant under the new model.
  ('usage_evidence_import_lineage',
    exists (
      select 1
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'reference_data'
        and rel.relname = 'usage_observation_evidence'
        and con.conname = 'usage_observation_import_exclusive_check'
        and con.contype = 'c'
    )),
  ('signed_usage_summaries',
    (
      select count(*) = 5
      from information_schema.columns
      where table_schema = 'staging'
        and table_name = 'actual_usage_rows'
        and column_name in (
          'calculated_cmp_raw',
          'avg_ly_raw',
          'avg_12m_raw',
          'avg_6m_raw',
          'avg_4m_raw'
        )
    )),
  ('negative_summary_rule',
    exists (
      select 1
      from ops.data_quality_rules
      where rule_code = 'ACTUAL_USAGE_NEGATIVE_SUMMARY'
        and severity = 'warning'
        and is_active
    )),
  ('environment_preflight_rpc',
    to_regprocedure(
      'public.m21_assert_actual_import_environment(text,boolean)'
    ) is not null),
  ('environment_preflight_service_only',
    has_function_privilege(
      'service_role',
      'public.m21_assert_actual_import_environment(text,boolean)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'public.m21_assert_actual_import_environment(text,boolean)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.m21_assert_actual_import_environment(text,boolean)',
      'execute'
    )),
  ('coverage_scoped_to_latest_import',
    pg_get_viewdef(
      'analytics.v_source_observation_coverage'::regclass,
      true
    ) like '%latest_successful_import%'
    and pg_get_viewdef(
      'analytics.v_source_observation_coverage'::regclass,
      true
    ) like '%actual_workbook_import_id%'),
  ('stock_health_scoped_to_latest_import',
    pg_get_viewdef('analytics.v_stock_health'::regclass, true)
      like '%latest_successful_import%'
    and pg_get_viewdef('analytics.v_stock_health'::regclass, true)
      like '%actual_workbook_import_id%'),
  ('readiness_not_hardcoded_false',
    pg_get_functiondef(
      'public.m21_promote_actual_workbooks(text,text,text,text,text,text,text)'::regprocedure
    ) like '%select data_contract_ready%'
    and pg_get_functiondef(
      'public.m21_promote_actual_workbooks(text,text,text,text,text,text,text)'::regprocedure
    ) like '%''data_contract_ready'', v_data_contract_ready%'),
  ('checksum_rerun_is_idempotent',
    pg_get_functiondef(
      'public.m21_promote_actual_workbooks(text,text,text,text,text,text,text)'::regprocedure
    ) like '%already_imported%'),
  ('failed_import_returns_persistable_status',
    pg_get_functiondef(
      'public.m21_promote_actual_workbooks(text,text,text,text,text,text,text)'::regprocedure
    ) like '%''status'', ''failed''%'
    and pg_get_functiondef(
      'public.m21_promote_actual_workbooks(text,text,text,text,text,text,text)'::regprocedure
    ) like '%error_message = left(sqlerrm, 1000)%'),
  ('usage_stock_relations_scoped_to_current_import',
    pg_get_functiondef(
      'public.m21_rebuild_actual_relations()'::regprocedure
    ) like '%current_import%'
    and pg_get_functiondef(
      'public.m21_rebuild_actual_relations()'::regprocedure
    ) like '%stock_artifact.source_checksum = import.stock_checksum%'),
  ('monthly_usage_rls',
    (
      select relrowsecurity
      from pg_class
      where oid = 'core.monthly_usage_observations'::regclass
    )),
  ('actual_cmp_ignores_stale_forecast_feature',
    exists (
      select 1
      from core.usage_rates
      where material_id = '999999999999'
        and district_id = '5501'
        and as_of_date = date '2026-04-30'
        and avg_ly = 1
        and avg_12m = 2
        and avg_6m = 3
        and avg_4m = 4
        and cmp_monthly = 3
    ));

do $$
declare
  v_result jsonb;
  v_blocked boolean := false;
begin
  v_result := public.m21_assert_actual_import_environment(
    'STAGING_ONLY',
    true
  );
  if not coalesce((v_result ->> 'allowed')::boolean, false)
     or v_result ->> 'environment' <> 'test' then
    raise exception 'Test environment should allow the staging-only package';
  end if;

  perform ops.configure_environment(
    'production',
    'aaaaaaaaaaaaaaaaaaaa',
    'ap-southeast-2',
    'M21_ENVIRONMENT_GUARD_VERIFY'
  );

  begin
    perform public.m21_assert_actual_import_environment(
      'STAGING_ONLY',
      true
    );
  exception
    when others then
      v_blocked := sqlerrm like
        'Package environment % prohibits import into Production project %';
  end;

  if not v_blocked then
    raise exception 'Production did not reject a staging-only package';
  end if;
end
$$;

table m21_checks;

do $$
declare
  failed text;
begin
  select string_agg(check_name, ', ' order by check_name)
  into failed
  from m21_checks
  where not passed;

  if failed is not null then
    raise exception 'M21 Actual workbook checks failed: %', failed;
  end if;
end
$$;

rollback;
