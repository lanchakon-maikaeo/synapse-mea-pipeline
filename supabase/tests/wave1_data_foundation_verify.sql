-- Wave 1 acceptance checks for M02-M05.
-- Expected result: every row has passed = true.

with checks as (
  select 'wave1_migrations_registered' as check_name,
         count(*) = 3 as passed,
         count(*)::text || '/3 migrations' as detail
  from ops.schema_migrations
  where version in ('202607150001', '202607150002', '202607150003')

  union all

  select 'raw_contract_rows', count(*) = 6305, count(*)::text || ' rows'
  from raw.source_rows where source_entity = 'contracts'

  union all

  select 'raw_material_rows', count(*) = 203, count(*)::text || ' rows'
  from raw.source_rows where source_entity = 'materials'

  union all

  select 'raw_idempotency_keys_unique', count(*) = 0, count(*)::text || ' duplicates'
  from (
    select batch_id, source_entity, source_row_number
    from raw.source_rows
    group by batch_id, source_entity, source_row_number
    having count(*) > 1
  ) duplicates

  union all

  select 'staging_contract_rows', count(*) = 6305, count(*)::text || ' rows'
  from staging.contract_rows

  union all

  select 'staging_contract_rejected', count(*) = 0, count(*)::text || ' rejected'
  from staging.contract_rows where validation_status = 'rejected'

  union all

  select 'dq_missing_material_recorded', count(*) = 2130, count(*)::text || ' issues'
  from ops.data_quality_issues where rule_code = 'CONTRACT_MATERIAL_MISSING'

  union all

  select 'dq_material_format_recorded', count(*) = 38, count(*)::text || ' issues'
  from ops.data_quality_issues where rule_code = 'CONTRACT_MATERIAL_FORMAT'

  union all

  select 'dq_delivery_date_recorded', count(*) = 11, count(*)::text || ' issues'
  from ops.data_quality_issues where rule_code = 'CONTRACT_DELIVERY_BEFORE_DOCUMENT'

  union all

  select 'staging_material_rows', count(*) = 203, count(*)::text || ' rows'
  from staging.material_rows

  union all

  select 'staging_material_rejected', count(*) = 0, count(*)::text || ' rejected'
  from staging.material_rows where validation_status = 'rejected'

  union all

  select 'district_mapping_complete', count(*) = 18, count(*)::text || '/18 districts'
  from core.districts

  union all

  select 'locations_complete', count(*) = 19, count(*)::text || ' locations'
  from core.locations

  union all

  select 'core_contract_headers', count(*) = 2857, count(*)::text || ' contracts'
  from core.contracts where is_current

  union all

  select 'core_contract_items', count(*) = 6305, count(*)::text || ' items'
  from core.contract_items where is_current

  union all

  select 'core_material_union', count(*) = 776, count(*)::text || ' materials'
  from core.materials

  union all

  select 'vmi_material_master_coverage',
         count(*) filter (where is_vmi) = 203,
         count(*) filter (where is_vmi)::text || '/203 VMI materials'
  from core.materials

  union all

  select 'contract_item_source_trace',
         count(*) filter (where source_row_id is null or source_batch_id is null) = 0,
         count(*) filter (where source_row_id is null or source_batch_id is null)::text || ' missing links'
  from core.contract_items where is_current

  union all

  select 'reconciliation_zero_delta',
         legacy_rows = raw_rows
           and raw_rows = staging_rows
           and rejected_rows = 0
           and staging_rows = core_item_rows,
         format('legacy=%s raw=%s staging=%s core=%s rejected=%s',
           legacy_rows, raw_rows, staging_rows, core_item_rows, rejected_rows)
  from analytics.v_contract_reconciliation

  union all

  select 'core_rls_enabled', count(*) >= 10, count(*)::text || ' Core tables'
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'core'
    and c.relkind = 'r'
    and c.relrowsecurity

  union all

  select 'anon_core_access_blocked',
         count(*) filter (where has_table_privilege('anon', format('%I.%I', table_schema, table_name), 'select')) = 0,
         count(*) filter (where has_table_privilege('anon', format('%I.%I', table_schema, table_name), 'select'))::text || ' exposed tables'
  from information_schema.tables
  where table_schema = 'core' and table_type = 'BASE TABLE'
)
select check_name, passed, detail
from checks
order by check_name;
