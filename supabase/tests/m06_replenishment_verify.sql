-- M06 acceptance checks. Expected: every row has passed = true.
with checks as (
  select 'm06_migration_registered' as check_name, exists (
    select 1 from ops.schema_migrations where version = '202607150004'
  ) as passed, 'migration registered' as detail

  union all select 'policy_active', count(*) = 1, count(*)::text || ' active policy'
  from ops.calculation_policies where is_active

  union all select 'rounding_tiers',
    core.round_replenishment(-1) = 0 and core.round_replenishment(55) = 55
    and core.round_replenishment(83) = 100 and core.round_replenishment(350) = 400
    and core.round_replenishment(1300) = 1500 and core.round_replenishment(12500) = 13000,
    format('55=%s, 83=%s, 350=%s, 1300=%s, 12500=%s', core.round_replenishment(55), core.round_replenishment(83), core.round_replenishment(350), core.round_replenishment(1300), core.round_replenishment(12500))

  union all select 'wave1_core_preserved', count(*) = 6305, count(*)::text || ' items'
  from core.contract_items where is_current

  union all select 'm06_tables_rls_enabled', count(*) = 6, count(*)::text || '/6 tables'
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where (
    (n.nspname = 'core' and c.relname in ('usage_rates', 'replenishment_plans', 'replenishment_items'))
    or (n.nspname = 'ops' and c.relname in ('calculation_policies', 'replenishment_runs', 'replenishment_adjustments'))
  ) and c.relrowsecurity

  union all select 'anon_m06_access_blocked', count(*) = 0, count(*)::text || ' exposed tables'
  from information_schema.tables
  where table_schema in ('core', 'ops')
    and table_name in ('usage_rates', 'replenishment_plans', 'replenishment_items', 'calculation_policies', 'replenishment_runs', 'replenishment_adjustments')
    and has_table_privilege('anon', format('%I.%I', table_schema, table_name), 'select')
)
select check_name, passed, detail from checks order by check_name;
