-- SYNAPSE M24: Owner-directed single-admin Production identity policy.
--
-- The launch owner requested one active administrator account only. Preserve
-- central/district counts for observability, but make the explicit bootstrap
-- identity policy depend on an active admin rather than fabricated users.

begin;

create or replace view analytics.v_production_readiness
with (security_invoker = true)
as
with environment as (
  select environment_name, project_ref, region
  from ops.environment_registry
  order by updated_at desc
  limit 1
), material_scope as (
  select count(*)::bigint as material_count
  from core.materials
  where is_vmi
), district_scope as (
  select count(*)::bigint as district_count
  from core.districts
  where is_active
), expected_scope as (
  select
    material.material_count,
    district.district_count,
    material.material_count * district.district_count
      as expected_district_material_rows
  from material_scope material
  cross join district_scope district
), actual_stock as (
  select observed_district_stock_pairs as row_count
  from analytics.v_source_observation_coverage
), actual_usage as (
  select observed_usage_pairs as row_count
  from analytics.v_source_observation_coverage
), warehouse_stock as (
  select observed_warehouse_stock_materials as row_count
  from analytics.v_source_observation_coverage
), fixture as (
  select
    (select count(*) from core.stock_snapshots
      where data_class = 'test_fixture')
    + (select count(*) from core.usage_rates
      where data_class = 'test_fixture')
    + (select count(*) from core.packaging_profiles
      where data_class = 'test_fixture')
    as row_count
), master_quality as (
  select
    count(*) filter (
      where material.weight_per_unit_kg is not null
        and material.weight_per_unit_kg > 0
    )::bigint as weighted_material_count,
    count(*) filter (
      where packaging.source_quality = 'verified'
        and packaging.data_class = 'actual'
    )::bigint as verified_packaging_count
  from core.materials material
  left join core.packaging_profiles packaging using (material_id)
  where material.is_vmi
), identities as (
  select
    count(*) filter (
      where role::text = 'admin'
    )::bigint as admin_user_count,
    count(distinct role::text) filter (
      where role::text in ('admin', 'planner', 'academic', 'picker')
    )::bigint as central_role_count,
    count(distinct district_id) filter (
      where role::text = 'district'
    )::bigint as district_user_count
  from public.user_profiles
  where is_active
), recovery as (
  select
    exists (
      select 1 from ops.backup_runs
      where backup_type = 'database' and status = 'succeeded'
    ) as backup_verified,
    exists (
      select 1 from ops.backup_runs
      where backup_type = 'restore_drill' and status = 'succeeded'
    ) as restore_drill_verified
), readiness as (
  select
    environment.environment_name,
    environment.project_ref,
    environment.region,
    controls.operational_writes_enabled,
    scope.material_count as active_vmi_material_count,
    scope.district_count as active_district_count,
    scope.expected_district_material_rows,
    stock.row_count as actual_district_stock_rows,
    usage.row_count as actual_usage_rows,
    fixture.row_count as fixture_row_count,
    quality.weighted_material_count,
    quality.verified_packaging_count,
    identities.central_role_count,
    identities.district_user_count,
    recovery.backup_verified,
    recovery.restore_drill_verified,
    (
      scope.material_count > 0
      and scope.district_count = 18
      and stock.row_count >= scope.expected_district_material_rows
      and warehouse.row_count >= scope.material_count
      and usage.row_count >= scope.expected_district_material_rows
      and fixture.row_count = 0
    ) as data_contract_ready,
    (identities.admin_user_count >= 1) as identity_ready,
    (
      recovery.backup_verified
      and recovery.restore_drill_verified
    ) as recovery_ready
  from environment
  cross join ops.environment_controls controls
  cross join expected_scope scope
  cross join actual_stock stock
  cross join actual_usage usage
  cross join warehouse_stock warehouse
  cross join fixture
  cross join master_quality quality
  cross join identities
  cross join recovery
)
select
  readiness.*,
  (
    environment_name = 'production'
    and operational_writes_enabled
    and data_contract_ready
    and identity_ready
    and recovery_ready
  ) as cutover_ready,
  case
    when environment_name <> 'production' then 'non_production'
    when operational_writes_enabled
      and data_contract_ready
      and identity_ready
      and recovery_ready then 'operational'
    else 'blocked'
  end as readiness_status,
  (
    weighted_material_count >= active_vmi_material_count
    and verified_packaging_count >= active_vmi_material_count
  ) as material_master_ready,
  'single_admin'::text as identity_policy
from readiness;

comment on view analytics.v_production_readiness is
  'Production readiness under the owner-directed single_admin identity policy. '
  'Central/district counts and material_master_ready remain observable.';

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607240024',
  'M24',
  'Owner-directed single-admin Production identity readiness policy.',
  'supabase/migrations/202607240024_single_admin_identity_policy.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
