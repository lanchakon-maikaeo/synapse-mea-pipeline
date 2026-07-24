\set ON_ERROR_STOP on

select 'migration_count' as check_name, count(*)::text as result
from ops.schema_migrations
union all
select 'environment', environment_name
from ops.environment_registry
union all
select 'project_ref', project_ref
from ops.environment_registry
union all
select 'region', region
from ops.environment_registry
union all
select 'release_evidence_count', count(*)::text
from ops.release_versions
union all
select 'backup_evidence_count', count(*)::text
from ops.backup_runs;

select operational_writes_enabled
from ops.environment_controls;

select
  cutover_ready,
  operational_writes_enabled,
  data_contract_ready,
  identity_ready,
  recovery_ready,
  readiness_status,
  active_vmi_material_count,
  active_district_count,
  actual_district_stock_rows,
  actual_usage_rows
from analytics.v_production_readiness;
