\set ON_ERROR_STOP on

begin;

create temporary table local_schema_checks (
  check_name text primary key,
  passed boolean not null
);

insert into local_schema_checks (check_name, passed)
values
  ('all_migrations_registered',
    (select count(*) = 17 from ops.schema_migrations)),
  ('migration_versions_unique',
    (select count(*) = count(distinct version) from ops.schema_migrations)),
  ('environment_is_test',
    exists(select 1 from ops.environment_registry where environment_name = 'test')),
  ('auth_profile_trigger',
    exists(
      select 1
      from pg_trigger
      where tgname = 'on_auth_user_created'
        and tgrelid = 'auth.users'::regclass
        and not tgisinternal
    )),
  ('contracts_rls',
    (select relrowsecurity from pg_class where oid = 'public.contracts'::regclass)),
  ('profiles_rls',
    (select relrowsecurity from pg_class where oid = 'public.user_profiles'::regclass)),
  ('raw_source_rows',
    to_regclass('raw.source_rows') is not null),
  ('staging_contract_rows',
    to_regclass('staging.contract_rows') is not null),
  ('core_materials',
    to_regclass('core.materials') is not null),
  ('stock_snapshots',
    to_regclass('core.stock_snapshots') is not null),
  ('replenishment_plans',
    to_regclass('core.replenishment_plans') is not null),
  ('production_roles',
    exists (
      select 1
      from unnest(enum_range(null::public.app_role)) role
      where role::text = 'academic'
    )
    and exists (
      select 1
      from unnest(enum_range(null::public.app_role)) role
      where role::text = 'picker'
    )),
  ('khlong_toei_scope',
    exists (
      select 1
      from core.warehouses
      where warehouse_id = 'WH-KT'
        and sap_plant_code = '2401'
        and storage_location = '0001'
        and is_active
    )),
  ('receipt_lots',
    to_regclass('core.receipt_lots') is not null),
  ('packaging_profiles',
    to_regclass('core.packaging_profiles') is not null),
  ('handling_units',
    to_regclass('core.handling_units') is not null),
  ('inventory_movements',
    to_regclass('core.inventory_movements') is not null),
  ('quantity_recommendations',
    to_regclass('ops.quantity_recommendations') is not null),
  ('district_change_requests',
    to_regclass('ops.district_change_requests') is not null),
  ('plan_approvals',
    to_regclass('ops.plan_approvals') is not null),
  ('fifo_allocations',
    to_regclass('ops.fifo_allocations') is not null),
  ('ad_hoc_issues',
    to_regclass('ops.ad_hoc_issues') is not null),
  ('fifo_queue',
    to_regclass('analytics.v_fifo_queue') is not null),
  ('traceback_view',
    to_regclass('analytics.v_issue_traceback') is not null),
  ('append_only_movements',
    exists (
      select 1
      from pg_trigger
      where tgname = 'inventory_movements_append_only'
        and tgrelid = 'core.inventory_movements'::regclass
        and not tgisinternal
    )),
  ('sequential_approval_function',
    to_regprocedure('core.approve_replenishment_plan(uuid)') is not null),
  ('ad_hoc_issue_function',
    to_regprocedure('core.create_ad_hoc_issue(text,text,numeric,text,text,text)') is not null),
  ('operations_health',
    to_regclass('analytics.v_operations_health') is not null),
  ('m09_dispatch',
    to_regprocedure('public.m09_dispatch(text,text,jsonb,jsonb,text)') is not null),
  ('m09_dispatch_impl_protected',
    not has_function_privilege(
      'authenticated',
      'public.m09_dispatch_impl(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('m09_dispatch_v14_protected',
    not has_function_privilege(
      'authenticated',
      'public.m09_dispatch_v14(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('m10_dispatch',
    to_regprocedure('public.m10_input_dispatch(text,text,jsonb,jsonb,text)') is not null),
  ('m11_dispatch',
    to_regprocedure('public.m11_legacy_dispatch(text,text,jsonb,jsonb,text)') is not null),
  ('anon_cannot_m09_dispatch',
    not has_function_privilege(
      'anon',
      'public.m09_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('authenticated_can_m09_dispatch',
    has_function_privilege(
      'authenticated',
      'public.m09_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('anon_cannot_m10_dispatch',
    not has_function_privilege(
      'anon',
      'public.m10_input_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('authenticated_can_m10_dispatch',
    has_function_privilege(
      'authenticated',
      'public.m10_input_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('anon_cannot_m11_dispatch',
    not has_function_privilege(
      'anon',
      'public.m11_legacy_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('authenticated_can_m11_dispatch',
    has_function_privilege(
      'authenticated',
      'public.m11_legacy_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('web_input_staging_rls',
    (select relrowsecurity from pg_class where oid = 'staging.vmi_input_rows'::regclass)),
  ('legacy_material_staging_rls',
    (select relrowsecurity from pg_class where oid = 'staging.legacy_material_rows'::regclass)),
  ('legacy_stock_staging_rls',
    (select relrowsecurity from pg_class where oid = 'staging.legacy_stock_rows'::regclass)),
  ('legacy_usage_staging_rls',
    (select relrowsecurity from pg_class where oid = 'staging.legacy_usage_rows'::regclass)),
  ('signed_adjustment_quality_rule',
    exists(
      select 1
      from ops.data_quality_rules
      where rule_code = 'LEGACY_NEGATIVE_DEMAND_ADJUSTMENT'
        and is_active
    ));

table local_schema_checks;

do $$
begin
  if exists(select 1 from local_schema_checks where not passed) then
    raise exception 'local Supabase schema contract failed: %',
      (select string_agg(check_name, ', ' order by check_name)
       from local_schema_checks
       where not passed);
  end if;
end
$$;

rollback;
