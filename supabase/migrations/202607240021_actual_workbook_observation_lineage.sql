-- SYNAPSE M21: governed import of the four Actual workbooks in data/.
--
-- M20 retained a complete owner-attested derived grid, but file-level
-- attestation cannot turn gap-filled cells into source observations. M21 keeps
-- that history, imports the original Stock/Usage/Warehouse evidence, records
-- row-level relations and makes Production readiness fail closed on observed
-- evidence rather than data_class alone.

begin;

alter table core.stock_snapshots
  add column if not exists source_quality text not null default 'source_derived';
alter table core.stock_snapshots
  drop constraint if exists stock_snapshots_source_quality_check;
alter table core.stock_snapshots
  add constraint stock_snapshots_source_quality_check
  check (source_quality in (
    'source_observed',
    'source_missing_assumed_zero',
    'source_derived',
    'test_fixture'
  ));

alter table core.usage_rates
  add column if not exists source_quality text not null default 'source_derived';
alter table core.usage_rates
  drop constraint if exists usage_rates_source_quality_check;
alter table core.usage_rates
  add constraint usage_rates_source_quality_check
  check (source_quality in (
    'source_observed',
    'source_missing_assumed_zero',
    'source_derived',
    'test_fixture'
  ));

update core.stock_snapshots
set source_quality = case
  when data_class = 'test_fixture' then 'test_fixture'
  else 'source_derived'
end
where source_quality not in (
  'source_observed',
  'source_missing_assumed_zero'
);

update core.usage_rates
set source_quality = case
  when data_class = 'test_fixture' then 'test_fixture'
  else 'source_derived'
end
where source_quality not in (
  'source_observed',
  'source_missing_assumed_zero'
);

create or replace function core.enforce_cmp_business_rule()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, analytics
as $$
declare
  v_latest_period date;
begin
  if new.data_class = 'actual'
     and new.source_quality in (
       'source_observed',
       'source_missing_assumed_zero'
     ) then
    new.avg_ly := greatest(coalesce(new.avg_ly, 0), 0);
    new.avg_12m := greatest(coalesce(new.avg_12m, 0), 0);
    new.avg_6m := greatest(coalesce(new.avg_6m, 0), 0);
    new.avg_4m := greatest(coalesce(new.avg_4m, 0), 0);
    new.cmp_monthly := round(
      (
        new.avg_ly
        + new.avg_12m
        + new.avg_6m
        + new.avg_4m
      ) / 4,
      0
    );
    return new;
  end if;

  select max(period_start)
  into v_latest_period
  from analytics.demand_monthly_features
  where material_id = new.material_id
    and district_id = new.district_id
    and feature_version = 'monthly-demand-v1';

  if v_latest_period is not null then
    select round(avg(demand_quantity), 0)
    into new.avg_4m
    from (
      select demand_quantity
      from analytics.demand_monthly_features
      where material_id = new.material_id
        and district_id = new.district_id
        and feature_version = 'monthly-demand-v1'
      order by period_start desc
      limit 4
    ) q;

    select round(avg(demand_quantity), 0)
    into new.avg_6m
    from (
      select demand_quantity
      from analytics.demand_monthly_features
      where material_id = new.material_id
        and district_id = new.district_id
        and feature_version = 'monthly-demand-v1'
      order by period_start desc
      limit 6
    ) q;

    select round(avg(demand_quantity), 0)
    into new.avg_12m
    from (
      select demand_quantity
      from analytics.demand_monthly_features
      where material_id = new.material_id
        and district_id = new.district_id
        and feature_version = 'monthly-demand-v1'
      order by period_start desc
      limit 12
    ) q;

    select round(avg(demand_quantity), 0)
    into new.avg_ly
    from analytics.demand_monthly_features
    where material_id = new.material_id
      and district_id = new.district_id
      and feature_version = 'monthly-demand-v1'
      and period_start
        >= date_trunc('year', v_latest_period)::date - interval '1 year'
      and period_start < date_trunc('year', v_latest_period)::date;
  end if;

  new.cmp_monthly := round(
    (
      coalesce(new.avg_ly, 0)
      + coalesce(new.avg_12m, 0)
      + coalesce(new.avg_6m, 0)
      + coalesce(new.avg_4m, 0)
    ) / 4,
    0
  );
  return new;
end;
$$;

create table if not exists staging.actual_stock_rows (
  source_row_id bigint primary key
    references raw.source_rows (source_row_id) on delete restrict,
  reference_source_row_id bigint not null unique
    references reference_data.source_rows (source_row_id) on delete restrict,
  batch_id uuid not null
    references raw.import_batches (batch_id) on delete restrict,
  source_row_number integer not null,
  sap_plant_code text not null,
  storage_location_code text,
  material_id text not null,
  source_material_code text not null,
  material_name text,
  base_unit text,
  unrestricted_qty numeric not null check (unrestricted_qty >= 0),
  unrestricted_value numeric,
  stock_in_transfer_qty numeric not null default 0,
  district_id text references core.districts (district_id) on delete restrict,
  warehouse_id text references core.warehouses (warehouse_id) on delete restrict,
  snapshot_at timestamptz not null,
  validation_status text not null
    check (validation_status in ('valid', 'warning', 'rejected')),
  validation_messages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_messages) = 'array'),
  loaded_at timestamptz not null default now(),
  unique (batch_id, source_row_number)
);

create index if not exists actual_stock_material_location_idx
  on staging.actual_stock_rows (
    material_id, district_id, warehouse_id, snapshot_at desc
  );

create table if not exists staging.actual_usage_rows (
  source_row_id bigint primary key
    references raw.source_rows (source_row_id) on delete restrict,
  reference_source_row_id bigint not null unique
    references reference_data.source_rows (source_row_id) on delete restrict,
  batch_id uuid not null
    references raw.import_batches (batch_id) on delete restrict,
  source_row_number integer not null,
  material_id text not null,
  sap_plant_code text not null,
  district_id text references core.districts (district_id) on delete restrict,
  as_of_date date not null,
  cmp_monthly_raw numeric not null,
  cmp_monthly numeric not null check (cmp_monthly >= 0),
  calculated_cmp_raw numeric,
  avg_ly_raw numeric,
  avg_12m_raw numeric,
  avg_6m_raw numeric,
  avg_4m_raw numeric,
  avg_ly numeric check (avg_ly is null or avg_ly >= 0),
  avg_12m numeric check (avg_12m is null or avg_12m >= 0),
  avg_6m numeric check (avg_6m is null or avg_6m >= 0),
  avg_4m numeric check (avg_4m is null or avg_4m >= 0),
  monthly_history jsonb not null check (jsonb_typeof(monthly_history) = 'array'),
  dash_cell_count integer not null default 0 check (dash_cell_count >= 0),
  negative_month_count integer not null default 0
    check (negative_month_count >= 0),
  validation_status text not null
    check (validation_status in ('valid', 'warning', 'rejected')),
  validation_messages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_messages) = 'array'),
  loaded_at timestamptz not null default now(),
  unique (batch_id, source_row_number),
  unique (batch_id, material_id, sap_plant_code)
);

create index if not exists actual_usage_material_district_idx
  on staging.actual_usage_rows (material_id, district_id, as_of_date desc);

alter table staging.actual_usage_rows
  add column if not exists calculated_cmp_raw numeric,
  add column if not exists avg_ly_raw numeric,
  add column if not exists avg_12m_raw numeric,
  add column if not exists avg_6m_raw numeric,
  add column if not exists avg_4m_raw numeric;

create table if not exists staging.actual_vmi_district_values (
  reference_source_row_id bigint not null
    references reference_data.source_rows (source_row_id) on delete restrict,
  material_id text not null
    references core.materials (material_id) on delete restrict,
  district_id text not null
    references core.districts (district_id) on delete restrict,
  sap_plant_code text not null,
  source_date date not null,
  derived_stock_qty numeric not null default 0,
  derived_cmp_monthly numeric not null default 0,
  max_target_qty numeric,
  max_fill_qty numeric,
  reference_3m_qty numeric,
  min_fill_qty numeric,
  months_available numeric,
  source_observed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (reference_source_row_id, district_id)
);

create index if not exists actual_vmi_values_lookup_idx
  on staging.actual_vmi_district_values (material_id, district_id);

create table if not exists reference_data.stock_observation_evidence (
  stock_observation_evidence_id bigint generated always as identity primary key,
  stock_snapshot_id uuid not null
    references core.stock_snapshots (snapshot_id) on delete restrict,
  source_artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  source_row_id bigint not null
    references reference_data.source_rows (source_row_id) on delete restrict,
  raw_source_row_id bigint not null
    references raw.source_rows (source_row_id) on delete restrict,
  verification_status text not null default 'source_observed'
    check (verification_status = 'source_observed'),
  aggregation_scope text not null
    check (aggregation_scope in ('warehouse', 'district')),
  observed_quantity numeric not null check (observed_quantity >= 0),
  aggregation_rule text not null,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  change_ticket text not null check (btrim(change_ticket) <> ''),
  verified_by text not null check (btrim(verified_by) <> ''),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (stock_snapshot_id, source_row_id)
);

create index if not exists stock_observation_snapshot_idx
  on reference_data.stock_observation_evidence (stock_snapshot_id);

create table if not exists reference_data.usage_observation_evidence (
  usage_observation_evidence_id bigint generated always as identity primary key,
  usage_rate_id uuid not null
    references core.usage_rates (usage_rate_id) on delete restrict,
  source_artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  source_row_id bigint not null
    references reference_data.source_rows (source_row_id) on delete restrict,
  raw_source_row_id bigint not null
    references raw.source_rows (source_row_id) on delete restrict,
  verification_status text not null default 'source_observed'
    check (verification_status = 'source_observed'),
  normalized_dash_count integer not null default 0
    check (normalized_dash_count >= 0),
  excluded_negative_month_count integer not null default 0
    check (excluded_negative_month_count >= 0),
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  change_ticket text not null check (btrim(change_ticket) <> ''),
  verified_by text not null check (btrim(verified_by) <> ''),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (usage_rate_id, source_row_id)
);

create index if not exists usage_observation_rate_idx
  on reference_data.usage_observation_evidence (usage_rate_id);

create table if not exists ops.actual_workbook_imports (
  actual_workbook_import_id uuid primary key default gen_random_uuid(),
  contract_checksum text not null check (contract_checksum ~ '^[0-9a-f]{64}$'),
  stock_checksum text not null check (stock_checksum ~ '^[0-9a-f]{64}$'),
  usage_checksum text not null check (usage_checksum ~ '^[0-9a-f]{64}$'),
  warehouse_checksum text not null check (warehouse_checksum ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  attested_by text not null check (btrim(attested_by) <> ''),
  attestation_text text not null check (btrim(attestation_text) <> ''),
  change_ticket text not null check (btrim(change_ticket) <> ''),
  source_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_counts) = 'object'),
  observation_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(observation_counts) = 'object'),
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (contract_checksum, stock_checksum, usage_checksum, warehouse_checksum)
);

alter table reference_data.stock_observation_evidence
  add column if not exists actual_workbook_import_id uuid
    references ops.actual_workbook_imports (actual_workbook_import_id)
    on delete restrict;
alter table reference_data.usage_observation_evidence
  add column if not exists actual_workbook_import_id uuid
    references ops.actual_workbook_imports (actual_workbook_import_id)
    on delete restrict;

update reference_data.stock_observation_evidence evidence
set actual_workbook_import_id = (
  select import.actual_workbook_import_id
  from ops.actual_workbook_imports import
  where import.stock_checksum = evidence.source_checksum
  order by import.finished_at desc nulls last, import.started_at desc
  limit 1
)
where evidence.actual_workbook_import_id is null
  and exists (
    select 1
    from ops.actual_workbook_imports import
    where import.stock_checksum = evidence.source_checksum
  );

update reference_data.usage_observation_evidence evidence
set actual_workbook_import_id = (
  select import.actual_workbook_import_id
  from ops.actual_workbook_imports import
  where import.usage_checksum = evidence.source_checksum
  order by import.finished_at desc nulls last, import.started_at desc
  limit 1
)
where evidence.actual_workbook_import_id is null
  and exists (
    select 1
    from ops.actual_workbook_imports import
    where import.usage_checksum = evidence.source_checksum
  );

alter table reference_data.stock_observation_evidence
  alter column actual_workbook_import_id set not null;
alter table reference_data.usage_observation_evidence
  alter column actual_workbook_import_id set not null;

create index if not exists stock_observation_import_idx
  on reference_data.stock_observation_evidence (
    actual_workbook_import_id, stock_snapshot_id
  );
create index if not exists usage_observation_import_idx
  on reference_data.usage_observation_evidence (
    actual_workbook_import_id, usage_rate_id
  );

create table if not exists core.monthly_usage_observations (
  monthly_usage_observation_id bigint generated always as identity primary key,
  actual_workbook_import_id uuid not null
    references ops.actual_workbook_imports (actual_workbook_import_id)
    on delete restrict,
  usage_rate_id uuid not null
    references core.usage_rates (usage_rate_id) on delete restrict,
  source_artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  source_row_id bigint not null
    references reference_data.source_rows (source_row_id) on delete restrict,
  raw_source_row_id bigint not null
    references raw.source_rows (source_row_id) on delete restrict,
  source_batch_id uuid not null
    references raw.import_batches (batch_id) on delete restrict,
  material_id text not null
    references core.materials (material_id) on delete restrict,
  district_id text not null
    references core.districts (district_id) on delete restrict,
  period_start date not null,
  raw_quantity_signed numeric,
  demand_quantity numeric not null check (demand_quantity >= 0),
  source_was_dash boolean not null default false,
  negative_adjustment boolean not null default false,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (actual_workbook_import_id, source_row_id, period_start)
);

create index if not exists monthly_usage_lookup_idx
  on core.monthly_usage_observations (
    material_id, district_id, period_start desc
  );

insert into ops.data_quality_rules (
  rule_code, severity, source_entity, field_name, description, is_active
)
values
  (
    'ACTUAL_STOCK_MATERIAL_PADDED',
    'warning',
    'actual_stock',
    'material_id',
    'Numeric SAP material identifier was padded to 12 digits; the source value remains in Raw.',
    true
  ),
  (
    'ACTUAL_STOCK_STORAGE_MISSING',
    'warning',
    'actual_stock',
    'storage_location_code',
    'Storage location is missing; row is preserved but cannot prove a storage-level relation.',
    true
  ),
  (
    'ACTUAL_STOCK_TRANSFER_EXCLUDED',
    'info',
    'actual_stock',
    'stock_in_transfer_qty',
    'Stock in Transfer is preserved in Raw and excluded from Unrestricted stock.',
    true
  ),
  (
    'ACTUAL_USAGE_UNMAPPED_PLANT',
    'warning',
    'actual_usage',
    'sap_plant_code',
    'SAP Plant is outside the 18-district mapping and is not promoted to district usage.',
    true
  ),
  (
    'ACTUAL_USAGE_DASH_NORMALIZED',
    'info',
    'actual_usage',
    'monthly_history',
    'A dash is normalized to zero while source_was_dash remains in Raw history.',
    true
  ),
  (
    'ACTUAL_USAGE_NEGATIVE_ADJUSTMENT',
    'warning',
    'actual_usage',
    'monthly_history',
    'Signed SAP adjustment is preserved in Raw and excluded from non-negative demand.',
    true
  ),
  (
    'ACTUAL_USAGE_NEGATIVE_CMP',
    'warning',
    'actual_usage',
    'cmp_monthly',
    'Negative CMP is preserved as cmp_monthly_raw and normalized to zero in Core.',
    true
  ),
  (
    'ACTUAL_USAGE_NEGATIVE_SUMMARY',
    'warning',
    'actual_usage',
    'summary_metrics',
    'Signed summary metrics are preserved in Raw fields and normalized to non-negative Core demand.',
    true
  ),
  (
    'ACTUAL_SOURCE_GAP_ASSUMED_ZERO',
    'warning',
    'actual_vmi_grid',
    'source_observation',
    'Derived VMI grid cell has no original Stock/Usage source row and is an assumed zero, not an observation.',
    true
  )
on conflict (rule_code) do update
set severity = excluded.severity,
    source_entity = excluded.source_entity,
    field_name = excluded.field_name,
    description = excluded.description,
    is_active = true,
    updated_at = now();

create or replace function public.m21_rebuild_actual_relations()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reference_data
as $$
declare
  v_edge_count bigint;
  v_linked_rows bigint;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M21 relation rebuild requires service_role';
  end if;

  delete from reference_data.relation_edges
  where relation_type like 'actual_%';

  with master_target as (
    select distinct on (r.material_id)
      r.source_row_id,
      r.material_id
    from reference_data.source_rows r
    join reference_data.source_artifacts a using (artifact_id)
    where a.source_path = 'คลังคลองเตย.xlsx'
      and a.source_sheet = 'MASTER'
      and a.data_class = 'actual'
      and r.material_id is not null
    order by r.material_id, a.updated_at desc, r.source_row_id desc
  )
  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'actual_references_material',
    jsonb_build_object('match_key', source.material_id)
  from reference_data.source_rows source
  join reference_data.source_artifacts source_artifact
    on source_artifact.artifact_id = source.artifact_id
   and source_artifact.data_class = 'actual'
  join master_target target
    on target.material_id = source.material_id
  where source.material_id is not null
    and source.source_row_id <> target.source_row_id
  on conflict do nothing;

  with district_target as (
    select distinct on (r.district_id)
      r.source_row_id,
      r.district_id
    from reference_data.source_rows r
    join reference_data.source_artifacts a using (artifact_id)
    where a.source_path = 'คลังคลองเตย.xlsx'
      and a.source_sheet = 'M_Districts'
      and a.data_class = 'actual'
      and r.district_id is not null
    order by r.district_id, a.updated_at desc, r.source_row_id desc
  ), scalar_source as (
    select r.source_row_id, r.district_id
    from reference_data.source_rows r
    join reference_data.source_artifacts a using (artifact_id)
    where a.data_class = 'actual'
      and r.district_id is not null
  ), array_source as (
    select
      r.source_row_id,
      value ->> 'district_id' as district_id
    from reference_data.source_rows r
    join reference_data.source_artifacts a using (artifact_id)
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(r.payload -> 'district_values') = 'array'
          then r.payload -> 'district_values'
        else '[]'::jsonb
      end
    ) value
    where a.data_class = 'actual'
    union
    select
      r.source_row_id,
      value
    from reference_data.source_rows r
    join reference_data.source_artifacts a using (artifact_id)
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(r.payload -> 'district_ids') = 'array'
          then r.payload -> 'district_ids'
        else '[]'::jsonb
      end
    ) value
    where a.data_class = 'actual'
  ), district_source as (
    select * from scalar_source
    union
    select * from array_source
  )
  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'actual_references_district',
    jsonb_build_object('match_key', source.district_id)
  from district_source source
  join district_target target using (district_id)
  where source.source_row_id <> target.source_row_id
  on conflict do nothing;

  with current_import as (
    select stock_checksum, usage_checksum
    from ops.actual_workbook_imports
    where status in ('running', 'succeeded')
    order by
      (status = 'running') desc,
      finished_at desc nulls last,
      started_at desc,
      actual_workbook_import_id desc
    limit 1
  )
  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    usage_row.source_row_id,
    stock_row.source_row_id,
    'actual_usage_to_stock_observation',
    jsonb_build_object(
      'material_id', usage_row.material_id,
      'district_id', usage_row.district_id
    )
  from reference_data.source_rows usage_row
  join reference_data.source_artifacts usage_artifact
    on usage_artifact.artifact_id = usage_row.artifact_id
   and usage_artifact.source_path = 'อัตราการใช้งาน.xlsx'
   and usage_artifact.source_sheet = 'Check CMP'
  join current_import import
    on import.usage_checksum = usage_artifact.source_checksum
  join reference_data.source_rows stock_row
    on stock_row.material_id = usage_row.material_id
   and stock_row.district_id = usage_row.district_id
  join reference_data.source_artifacts stock_artifact
   on stock_artifact.artifact_id = stock_row.artifact_id
   and stock_artifact.source_path = 'Stock.xlsx'
   and stock_artifact.source_sheet = 'update-stock'
   and stock_artifact.source_checksum = import.stock_checksum
  where usage_row.district_id is not null
  on conflict do nothing;

  select count(*) into v_edge_count
  from reference_data.relation_edges
  where relation_type like 'actual_%';

  select count(distinct source_row_id) into v_linked_rows
  from reference_data.relation_edges
  where relation_type like 'actual_%';

  return jsonb_build_object(
    'actual_relation_edges', v_edge_count,
    'actual_linked_source_rows', v_linked_rows
  );
end;
$$;

create or replace function public.m21_assert_actual_import_environment(
  p_source_package_environment text,
  p_production_use_prohibited boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
declare
  v_environment text;
  v_project_ref text;
  v_allowed boolean;
begin
  select environment_name, project_ref
  into v_environment, v_project_ref
  from ops.environment_registry
  order by updated_at desc
  limit 1;

  if v_environment is null then
    raise exception 'Target environment is not registered';
  end if;

  v_allowed := not (
    v_environment = 'production'
    and coalesce(p_production_use_prohibited, false)
  );

  if not v_allowed then
    raise exception
      'Package environment % prohibits import into Production project %',
      coalesce(nullif(btrim(p_source_package_environment), ''), 'unspecified'),
      v_project_ref;
  end if;

  return jsonb_build_object(
    'environment', v_environment,
    'project_ref', v_project_ref,
    'source_package_environment',
      coalesce(nullif(btrim(p_source_package_environment), ''), 'unspecified'),
    'production_use_prohibited',
      coalesce(p_production_use_prohibited, false),
    'allowed', v_allowed
  );
end;
$$;

create or replace function public.m21_promote_actual_workbooks(
  p_contract_checksum text,
  p_stock_checksum text,
  p_usage_checksum text,
  p_warehouse_checksum text,
  p_attested_by text,
  p_attestation_text text,
  p_change_ticket text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, raw, staging, core, analytics, ops,
  reference_data, extensions
as $$
declare
  v_import_id uuid;
  v_contract_artifact uuid;
  v_stock_artifact uuid;
  v_usage_artifact uuid;
  v_master_artifact uuid;
  v_district_artifact uuid;
  v_vmi_artifact uuid;
  v_contract_batch uuid;
  v_stock_batch uuid;
  v_usage_batch uuid;
  v_master_batch uuid;
  v_district_batch uuid;
  v_vmi_batch uuid;
  v_source_counts jsonb;
  v_observation_counts jsonb;
  v_relation_result jsonb;
  v_data_contract_ready boolean;
  v_readiness_reason text;
  v_package_environment text;
  v_production_use_prohibited boolean;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M21 Actual workbook promotion requires service_role';
  end if;
  if coalesce(p_contract_checksum, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_stock_checksum, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_usage_checksum, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_warehouse_checksum, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'All four source checksums are required';
  end if;
  if btrim(coalesce(p_attested_by, '')) = ''
     or btrim(coalesce(p_attestation_text, '')) = ''
     or btrim(coalesce(p_change_ticket, '')) = '' then
    raise exception 'Attestor, attestation text and change ticket are required';
  end if;

  select artifact_id into v_contract_artifact
  from reference_data.source_artifacts
  where source_path = 'รวมสัญญา.xlsx'
    and source_sheet = 'รวมสัญญา'
    and source_checksum = p_contract_checksum;

  select artifact_id into v_stock_artifact
  from reference_data.source_artifacts
  where source_path = 'Stock.xlsx'
    and source_sheet = 'update-stock'
    and source_checksum = p_stock_checksum;

  select artifact_id into v_usage_artifact
  from reference_data.source_artifacts
  where source_path = 'อัตราการใช้งาน.xlsx'
    and source_sheet = 'Check CMP'
    and source_checksum = p_usage_checksum;

  select
    (array_agg(artifact_id) filter (where source_sheet = 'MASTER'))[1],
    (array_agg(artifact_id) filter (where source_sheet = 'M_Districts'))[1],
    (array_agg(artifact_id) filter (where source_sheet = 'VMI คลองเตย'))[1]
  into v_master_artifact, v_district_artifact, v_vmi_artifact
  from reference_data.source_artifacts
  where source_path = 'คลังคลองเตย.xlsx'
    and source_checksum = p_warehouse_checksum;

  if v_contract_artifact is null
     or v_stock_artifact is null
     or v_usage_artifact is null
     or v_master_artifact is null
     or v_district_artifact is null
     or v_vmi_artifact is null then
    raise exception 'Required source artifact/sheet is missing';
  end if;

  select
    coalesce(
      max(nullif(metadata ->> 'source_package_environment', '')),
      max(nullif(metadata ->> 'environment', '')),
      'unspecified'
    ),
    bool_or(
      lower(coalesce(
        metadata ->> 'source_package_production_use_prohibited',
        metadata ->> 'production_use_prohibited',
        'false'
      )) in ('true', 't', '1', 'yes')
    )
  into v_package_environment, v_production_use_prohibited
  from reference_data.source_artifacts
  where artifact_id in (
    v_contract_artifact,
    v_stock_artifact,
    v_usage_artifact,
    v_master_artifact,
    v_district_artifact,
    v_vmi_artifact
  );

  perform public.m21_assert_actual_import_environment(
    v_package_environment,
    coalesce(v_production_use_prohibited, false)
  );

  if exists (
    select 1
    from reference_data.source_artifacts artifact
    where artifact.artifact_id in (
      v_contract_artifact,
      v_stock_artifact,
      v_usage_artifact,
      v_master_artifact,
      v_district_artifact,
      v_vmi_artifact
    )
      and artifact.expected_rows <> (
        select count(*)
        from reference_data.source_rows source_row
        where source_row.artifact_id = artifact.artifact_id
      )
  ) then
    raise exception 'One or more source artifacts are incomplete';
  end if;

  if (select expected_rows from reference_data.source_artifacts
      where artifact_id = v_district_artifact) <> 18 then
    raise exception 'District mapping must contain exactly 18 rows';
  end if;
  if (select expected_rows from reference_data.source_artifacts
      where artifact_id = v_vmi_artifact) <= 0 then
    raise exception 'VMI material scope is empty';
  end if;

  select
    actual_workbook_import_id,
    source_counts,
    observation_counts
  into v_import_id, v_source_counts, v_observation_counts
  from ops.actual_workbook_imports
  where contract_checksum = p_contract_checksum
    and stock_checksum = p_stock_checksum
    and usage_checksum = p_usage_checksum
    and warehouse_checksum = p_warehouse_checksum
    and status = 'succeeded'
  order by finished_at desc nulls last, started_at desc
  limit 1;

  if v_import_id is not null then
    select data_contract_ready
    into v_data_contract_ready
    from analytics.v_production_readiness;

    return jsonb_build_object(
      'actual_workbook_import_id', v_import_id,
      'status', 'succeeded',
      'already_imported', true,
      'source_counts', coalesce(v_source_counts, '{}'::jsonb),
      'observation_counts', coalesce(v_observation_counts, '{}'::jsonb),
      'data_contract_ready', coalesce(v_data_contract_ready, false),
      'readiness_reason',
        'The identical four-checksum import already succeeded.'
    );
  end if;

  insert into ops.actual_workbook_imports (
    contract_checksum,
    stock_checksum,
    usage_checksum,
    warehouse_checksum,
    status,
    attested_by,
    attestation_text,
    change_ticket
  )
  values (
    p_contract_checksum,
    p_stock_checksum,
    p_usage_checksum,
    p_warehouse_checksum,
    'running',
    left(p_attested_by, 200),
    left(p_attestation_text, 1000),
    left(p_change_ticket, 200)
  )
  on conflict (
    contract_checksum, stock_checksum, usage_checksum, warehouse_checksum
  ) do update
  set status = 'running',
      attested_by = excluded.attested_by,
      attestation_text = excluded.attestation_text,
      change_ticket = excluded.change_ticket,
      error_message = null,
      started_at = now(),
      finished_at = null
  returning actual_workbook_import_id into v_import_id;

  begin
  insert into ops.source_attestations (
    source_checksum,
    original_data_class,
    asserted_data_class,
    attestation_text,
    attested_by,
    change_ticket
  )
  select
    checksum,
    'actual',
    'actual',
    left(p_attestation_text, 1000),
    left(p_attested_by, 200),
    left(p_change_ticket, 200)
  from unnest(array[
    p_contract_checksum,
    p_stock_checksum,
    p_usage_checksum,
    p_warehouse_checksum
  ]) checksum
  on conflict (source_checksum, asserted_data_class) do update
  set attestation_text = excluded.attestation_text,
      attested_by = excluded.attested_by,
      change_ticket = excluded.change_ticket,
      attested_at = now();

  insert into raw.import_batches (
    source_system,
    source_file,
    source_sheet,
    source_checksum,
    source_file_size_bytes,
    row_count,
    status,
    imported_at,
    connector_name,
    source_entity,
    started_at,
    finished_at,
    metadata
  )
  select
    'governed_excel',
    artifact.source_path,
    artifact.source_sheet,
    artifact.source_checksum,
    artifact.source_file_size_bytes,
    artifact.expected_rows,
    'succeeded',
    now(),
    'actual-workbook-v1',
    case artifact.source_sheet
      when 'update-stock' then 'actual_stock'
      when 'Check CMP' then 'actual_usage'
      when 'MASTER' then 'actual_material_master'
      when 'M_Districts' then 'actual_districts'
      when 'VMI คลองเตย' then 'materials'
    end,
    now(),
    now(),
    artifact.metadata || jsonb_build_object(
      'actual_workbook_import_id', v_import_id,
      'attested_by', left(p_attested_by, 200),
      'change_ticket', left(p_change_ticket, 200)
    )
  from reference_data.source_artifacts artifact
  where artifact.artifact_id in (
    v_stock_artifact,
    v_usage_artifact,
    v_master_artifact,
    v_district_artifact,
    v_vmi_artifact
  )
  on conflict (source_checksum, source_sheet) do update
  set source_system = excluded.source_system,
      source_file = excluded.source_file,
      source_file_size_bytes = excluded.source_file_size_bytes,
      row_count = excluded.row_count,
      status = 'succeeded',
      imported_at = excluded.imported_at,
      connector_name = excluded.connector_name,
      source_entity = excluded.source_entity,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      error_message = null,
      metadata = raw.import_batches.metadata || excluded.metadata,
      updated_at = now();

  select batch_id into strict v_contract_batch
  from raw.import_batches
  where source_checksum = p_contract_checksum
    and source_sheet = 'รวมสัญญา';
  select batch_id into strict v_stock_batch
  from raw.import_batches
  where source_checksum = p_stock_checksum
    and source_sheet = 'update-stock';
  select batch_id into strict v_usage_batch
  from raw.import_batches
  where source_checksum = p_usage_checksum
    and source_sheet = 'Check CMP';
  select batch_id into strict v_master_batch
  from raw.import_batches
  where source_checksum = p_warehouse_checksum
    and source_sheet = 'MASTER';
  select batch_id into strict v_district_batch
  from raw.import_batches
  where source_checksum = p_warehouse_checksum
    and source_sheet = 'M_Districts';
  select batch_id into strict v_vmi_batch
  from raw.import_batches
  where source_checksum = p_warehouse_checksum
    and source_sheet = 'VMI คลองเตย';

  insert into raw.source_rows (
    batch_id,
    source_entity,
    source_sheet,
    source_row_number,
    row_hash,
    payload
  )
  select
    case artifact.source_sheet
      when 'update-stock' then v_stock_batch
      when 'Check CMP' then v_usage_batch
      when 'MASTER' then v_master_batch
      when 'M_Districts' then v_district_batch
      when 'VMI คลองเตย' then v_vmi_batch
    end,
    case artifact.source_sheet
      when 'update-stock' then 'actual_stock'
      when 'Check CMP' then 'actual_usage'
      when 'MASTER' then 'actual_material_master'
      when 'M_Districts' then 'actual_districts'
      when 'VMI คลองเตย' then 'materials'
    end,
    artifact.source_sheet,
    reference_row.source_row_number,
    reference_row.row_hash,
    reference_row.payload
  from reference_data.source_rows reference_row
  join reference_data.source_artifacts artifact using (artifact_id)
  where reference_row.artifact_id in (
    v_stock_artifact,
    v_usage_artifact,
    v_master_artifact,
    v_district_artifact,
    v_vmi_artifact
  )
  on conflict (batch_id, source_entity, source_row_number) do update
  set row_hash = excluded.row_hash,
      payload = excluded.payload,
      ingested_at = now();

  delete from staging.actual_stock_rows where batch_id = v_stock_batch;
  insert into staging.actual_stock_rows (
    source_row_id,
    reference_source_row_id,
    batch_id,
    source_row_number,
    sap_plant_code,
    storage_location_code,
    material_id,
    source_material_code,
    material_name,
    base_unit,
    unrestricted_qty,
    unrestricted_value,
    stock_in_transfer_qty,
    district_id,
    warehouse_id,
    snapshot_at,
    validation_status,
    validation_messages
  )
  select
    raw_row.source_row_id,
    reference_row.source_row_id,
    v_stock_batch,
    reference_row.source_row_number,
    reference_row.payload ->> 'sap_plant_code',
    nullif(reference_row.payload ->> 'storage_location_code', ''),
    reference_row.material_id,
    reference_row.payload ->> 'source_material_code',
    nullif(reference_row.payload ->> 'material_name', ''),
    nullif(reference_row.payload ->> 'base_unit', ''),
    (reference_row.payload ->> 'unrestricted_qty')::numeric,
    nullif(reference_row.payload ->> 'unrestricted_value', '')::numeric,
    coalesce(
      nullif(reference_row.payload ->> 'stock_in_transfer_qty', '')::numeric,
      0
    ),
    reference_row.district_id,
    reference_row.warehouse_id,
    (reference_row.payload ->> 'snapshot_at')::timestamptz,
    case
      when reference_row.material_id !~ '^[0-9]{12}$' then 'rejected'
      when reference_row.payload ->> 'storage_location_code' is null
        then 'warning'
      else 'valid'
    end,
    jsonb_strip_nulls(jsonb_build_array(
      case when reference_row.material_id !~ '^[0-9]{12}$'
        then jsonb_build_object(
          'rule_code', 'MATERIAL_ID_FORMAT',
          'message', 'Material ID is not a 12-digit SAP code.'
        ) end,
      case when reference_row.payload ->> 'storage_location_code' is null
        then jsonb_build_object(
          'rule_code', 'ACTUAL_STOCK_STORAGE_MISSING',
          'message', 'Storage location is missing.'
        ) end
    ))
  from reference_data.source_rows reference_row
  join raw.source_rows raw_row
    on raw_row.batch_id = v_stock_batch
   and raw_row.source_entity = 'actual_stock'
   and raw_row.source_row_number = reference_row.source_row_number
  where reference_row.artifact_id = v_stock_artifact;

  delete from staging.actual_usage_rows where batch_id = v_usage_batch;
  insert into staging.actual_usage_rows (
    source_row_id,
    reference_source_row_id,
    batch_id,
    source_row_number,
    material_id,
    sap_plant_code,
    district_id,
    as_of_date,
    cmp_monthly_raw,
    cmp_monthly,
    calculated_cmp_raw,
    avg_ly_raw,
    avg_12m_raw,
    avg_6m_raw,
    avg_4m_raw,
    avg_ly,
    avg_12m,
    avg_6m,
    avg_4m,
    monthly_history,
    dash_cell_count,
    negative_month_count,
    validation_status,
    validation_messages
  )
  select
    raw_row.source_row_id,
    reference_row.source_row_id,
    v_usage_batch,
    reference_row.source_row_number,
    reference_row.material_id,
    reference_row.payload ->> 'sap_plant_code',
    reference_row.district_id,
    (reference_row.payload ->> 'as_of_date')::date,
    (reference_row.payload ->> 'cmp_monthly_raw')::numeric,
    greatest((reference_row.payload ->> 'cmp_monthly')::numeric, 0),
    nullif(reference_row.payload ->> 'calculated_cmp_raw', '')::numeric,
    coalesce(
      nullif(reference_row.payload ->> 'avg_ly_raw', '')::numeric,
      nullif(reference_row.payload ->> 'avg_ly', '')::numeric
    ),
    coalesce(
      nullif(reference_row.payload ->> 'avg_12m_raw', '')::numeric,
      nullif(reference_row.payload ->> 'avg_12m', '')::numeric
    ),
    coalesce(
      nullif(reference_row.payload ->> 'avg_6m_raw', '')::numeric,
      nullif(reference_row.payload ->> 'avg_6m', '')::numeric
    ),
    coalesce(
      nullif(reference_row.payload ->> 'avg_4m_raw', '')::numeric,
      nullif(reference_row.payload ->> 'avg_4m', '')::numeric
    ),
    greatest(
      coalesce(
        nullif(reference_row.payload ->> 'avg_ly', '')::numeric,
        nullif(reference_row.payload ->> 'avg_ly_raw', '')::numeric
      ),
      0
    ),
    greatest(
      coalesce(
        nullif(reference_row.payload ->> 'avg_12m', '')::numeric,
        nullif(reference_row.payload ->> 'avg_12m_raw', '')::numeric
      ),
      0
    ),
    greatest(
      coalesce(
        nullif(reference_row.payload ->> 'avg_6m', '')::numeric,
        nullif(reference_row.payload ->> 'avg_6m_raw', '')::numeric
      ),
      0
    ),
    greatest(
      coalesce(
        nullif(reference_row.payload ->> 'avg_4m', '')::numeric,
        nullif(reference_row.payload ->> 'avg_4m_raw', '')::numeric
      ),
      0
    ),
    reference_row.payload -> 'history',
    (
      select count(*)::integer
      from jsonb_array_elements(reference_row.payload -> 'history') month_row
      where coalesce((month_row ->> 'source_was_dash')::boolean, false)
    ),
    (
      select count(*)::integer
      from jsonb_array_elements(reference_row.payload -> 'history') month_row
      where coalesce((month_row ->> 'negative_adjustment')::boolean, false)
    ),
    case
      when reference_row.material_id !~ '^[0-9]{12}$' then 'rejected'
      when reference_row.district_id is null
        or (reference_row.payload ->> 'cmp_monthly_raw')::numeric < 0
        or coalesce(
          nullif(reference_row.payload ->> 'avg_ly_raw', '')::numeric,
          0
        ) < 0
        or coalesce(
          nullif(reference_row.payload ->> 'avg_12m_raw', '')::numeric,
          0
        ) < 0
        or coalesce(
          nullif(reference_row.payload ->> 'avg_6m_raw', '')::numeric,
          0
        ) < 0
        or coalesce(
          nullif(reference_row.payload ->> 'avg_4m_raw', '')::numeric,
          0
        ) < 0
        or exists (
          select 1
          from jsonb_array_elements(reference_row.payload -> 'history') month_row
          where coalesce((month_row ->> 'negative_adjustment')::boolean, false)
        )
        then 'warning'
      else 'valid'
    end,
    '[]'::jsonb
  from reference_data.source_rows reference_row
  join raw.source_rows raw_row
    on raw_row.batch_id = v_usage_batch
   and raw_row.source_entity = 'actual_usage'
   and raw_row.source_row_number = reference_row.source_row_number
  where reference_row.artifact_id = v_usage_artifact;

  insert into core.materials (
    material_id,
    sap_material_id,
    material_name,
    category,
    unit,
    is_vmi,
    master_source,
    data_quality_status,
    source_batch_id
  )
  select distinct on (reference_row.material_id)
    reference_row.material_id,
    case when reference_row.material_id ~ '^[0-9]{12}$'
      then reference_row.material_id end,
    nullif(reference_row.payload ->> 'Material_Name', ''),
    nullif(reference_row.payload ->> 'Category', ''),
    nullif(reference_row.payload ->> 'Unit', ''),
    false,
    'material_master',
    case when reference_row.material_id ~ '^[0-9]{12}$'
      then 'valid' else 'warning' end,
    v_master_batch
  from reference_data.source_rows reference_row
  where reference_row.artifact_id = v_master_artifact
    and reference_row.material_id is not null
  order by reference_row.material_id, reference_row.source_row_number
  on conflict (material_id) do update
  set sap_material_id = coalesce(
        core.materials.sap_material_id,
        excluded.sap_material_id
      ),
      material_name = coalesce(
        excluded.material_name,
        core.materials.material_name
      ),
      category = coalesce(excluded.category, core.materials.category),
      unit = coalesce(excluded.unit, core.materials.unit),
      data_quality_status = case
        when core.materials.data_quality_status = 'valid' then 'valid'
        else excluded.data_quality_status
      end,
      updated_at = now();

  insert into core.materials (
    material_id,
    sap_material_id,
    material_name,
    unit,
    is_vmi,
    master_source,
    data_quality_status,
    source_batch_id
  )
  select distinct on (stock.material_id)
    stock.material_id,
    case when stock.material_id ~ '^[0-9]{12}$' then stock.material_id end,
    stock.material_name,
    stock.base_unit,
    false,
    'material_master',
    case when stock.material_id ~ '^[0-9]{12}$'
      then 'valid' else 'warning' end,
    v_stock_batch
  from staging.actual_stock_rows stock
  where stock.validation_status <> 'rejected'
  order by stock.material_id, stock.source_row_number
  on conflict (material_id) do update
  set material_name = coalesce(
        core.materials.material_name,
        excluded.material_name
      ),
      unit = coalesce(core.materials.unit, excluded.unit),
      updated_at = now();

  update core.materials
  set is_vmi = false,
      updated_at = now()
  where is_vmi;

  perform staging.refresh_contracts(v_contract_batch);
  perform staging.refresh_materials(v_vmi_batch);
  perform core.refresh_contract_foundation(v_contract_batch, v_vmi_batch);

  delete from staging.actual_vmi_district_values
  where reference_source_row_id in (
    select source_row_id
    from reference_data.source_rows
    where artifact_id = v_vmi_artifact
  );

  insert into staging.actual_vmi_district_values (
    reference_source_row_id,
    material_id,
    district_id,
    sap_plant_code,
    source_date,
    derived_stock_qty,
    derived_cmp_monthly,
    max_target_qty,
    max_fill_qty,
    reference_3m_qty,
    min_fill_qty,
    months_available,
    source_observed
  )
  select
    reference_row.source_row_id,
    reference_row.material_id,
    district_value ->> 'district_id',
    district_value ->> 'sap_plant_code',
    (reference_row.payload ->> 'source_date')::timestamptz::date,
    coalesce(nullif(district_value ->> 'stock_qty', '')::numeric, 0),
    coalesce(nullif(district_value ->> 'cmp_monthly', '')::numeric, 0),
    nullif(district_value ->> 'max_target_qty', '')::numeric,
    nullif(district_value ->> 'max_fill_qty', '')::numeric,
    nullif(district_value ->> 'reference_3m_qty', '')::numeric,
    nullif(district_value ->> 'min_fill_qty', '')::numeric,
    nullif(district_value ->> 'months_available', '')::numeric,
    false
  from reference_data.source_rows reference_row
  cross join lateral jsonb_array_elements(
    reference_row.payload -> 'district_values'
  ) district_value
  where reference_row.artifact_id = v_vmi_artifact;

  with observed as (
    select
      stock.material_id,
      case
        when stock.district_id is not null
          then 'DIST-' || stock.district_id
        else stock.warehouse_id
      end as location_id,
      sum(stock.unrestricted_qty) as quantity_on_hand,
      max(stock.snapshot_at) as snapshot_at
    from staging.actual_stock_rows stock
    where stock.batch_id = v_stock_batch
      and stock.validation_status <> 'rejected'
      and (
        stock.district_id is not null
        or stock.warehouse_id = 'WH-KT'
      )
    group by
      stock.material_id,
      case
        when stock.district_id is not null
          then 'DIST-' || stock.district_id
        else stock.warehouse_id
      end
  )
  insert into core.stock_snapshots (
    material_id,
    location_id,
    quantity_on_hand,
    snapshot_at,
    source_batch_id,
    data_class,
    source_quality
  )
  select
    observed.material_id,
    observed.location_id,
    observed.quantity_on_hand,
    observed.snapshot_at,
    v_stock_batch,
    'actual',
    'source_observed'
  from observed
  on conflict (material_id, location_id, snapshot_at) do update
  set quantity_on_hand = excluded.quantity_on_hand,
      source_batch_id = excluded.source_batch_id,
      data_class = 'actual',
      source_quality = 'source_observed';

  with stock_date as (
    select max(snapshot_at) as snapshot_at
    from staging.actual_stock_rows
    where batch_id = v_stock_batch
  ), expected as (
    select
      material.material_id,
      location.location_id,
      stock_date.snapshot_at
    from core.materials material
    cross join core.locations location
    cross join stock_date
    where material.is_vmi
      and location.is_active
      and (
        location.location_type = 'DISTRICT'
        or location.location_id = 'WH-KT'
      )
  )
  insert into core.stock_snapshots (
    material_id,
    location_id,
    quantity_on_hand,
    snapshot_at,
    source_batch_id,
    data_class,
    source_quality
  )
  select
    expected.material_id,
    expected.location_id,
    0,
    expected.snapshot_at,
    v_stock_batch,
    'actual',
    'source_missing_assumed_zero'
  from expected
  where not exists (
    select 1
    from staging.actual_stock_rows observed
    where observed.batch_id = v_stock_batch
      and observed.validation_status <> 'rejected'
      and observed.material_id = expected.material_id
      and case
        when observed.district_id is not null
          then 'DIST-' || observed.district_id
        else observed.warehouse_id
      end = expected.location_id
  )
  on conflict (material_id, location_id, snapshot_at) do update
  set quantity_on_hand = 0,
      source_batch_id = excluded.source_batch_id,
      data_class = 'actual',
      source_quality = 'source_missing_assumed_zero';

  insert into reference_data.stock_observation_evidence (
    actual_workbook_import_id,
    stock_snapshot_id,
    source_artifact_id,
    source_row_id,
    raw_source_row_id,
    aggregation_scope,
    observed_quantity,
    aggregation_rule,
    source_checksum,
    change_ticket,
    verified_by
  )
  select
    v_import_id,
    snapshot.snapshot_id,
    v_stock_artifact,
    stock.reference_source_row_id,
    stock.source_row_id,
    case when stock.district_id is not null then 'district' else 'warehouse' end,
    stock.unrestricted_qty,
    case
      when stock.district_id is not null
        then 'SUM Unrestricted across all Storage Locations in SAP Plant'
      else 'Unrestricted at Plant 2401 / Storage Location 0001'
    end,
    p_stock_checksum,
    left(p_change_ticket, 200),
    left(p_attested_by, 200)
  from staging.actual_stock_rows stock
  join core.stock_snapshots snapshot
    on snapshot.material_id = stock.material_id
   and snapshot.location_id = case
     when stock.district_id is not null then 'DIST-' || stock.district_id
     else stock.warehouse_id
   end
   and snapshot.snapshot_at = stock.snapshot_at
   and snapshot.source_batch_id = v_stock_batch
   and snapshot.source_quality = 'source_observed'
  where stock.batch_id = v_stock_batch
    and stock.validation_status <> 'rejected'
    and (
      stock.district_id is not null
      or stock.warehouse_id = 'WH-KT'
    )
  on conflict (stock_snapshot_id, source_row_id) do update
  set actual_workbook_import_id = excluded.actual_workbook_import_id,
      observed_quantity = excluded.observed_quantity,
      aggregation_rule = excluded.aggregation_rule,
      change_ticket = excluded.change_ticket,
      verified_by = excluded.verified_by,
      verified_at = now();

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
  select
    usage.material_id,
    usage.district_id,
    usage.as_of_date,
    usage.cmp_monthly,
    usage.avg_ly,
    usage.avg_12m,
    usage.avg_6m,
    usage.avg_4m,
    v_usage_batch,
    'actual',
    'source_observed'
  from staging.actual_usage_rows usage
  where usage.batch_id = v_usage_batch
    and usage.district_id is not null
    and usage.validation_status <> 'rejected'
  on conflict (material_id, district_id, as_of_date) do update
  set cmp_monthly = excluded.cmp_monthly,
      avg_ly = excluded.avg_ly,
      avg_12m = excluded.avg_12m,
      avg_6m = excluded.avg_6m,
      avg_4m = excluded.avg_4m,
      source_batch_id = excluded.source_batch_id,
      data_class = 'actual',
      source_quality = 'source_observed',
      updated_at = now();

  with usage_date as (
    select max(as_of_date) as as_of_date
    from staging.actual_usage_rows
    where batch_id = v_usage_batch
  ), expected as (
    select
      material.material_id,
      district.district_id,
      usage_date.as_of_date
    from core.materials material
    cross join core.districts district
    cross join usage_date
    where material.is_vmi
      and district.is_active
  )
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
  select
    expected.material_id,
    expected.district_id,
    expected.as_of_date,
    0,
    0,
    0,
    0,
    0,
    v_usage_batch,
    'actual',
    'source_missing_assumed_zero'
  from expected
  where not exists (
    select 1
    from staging.actual_usage_rows observed
    where observed.batch_id = v_usage_batch
      and observed.validation_status <> 'rejected'
      and observed.material_id = expected.material_id
      and observed.district_id = expected.district_id
  )
  on conflict (material_id, district_id, as_of_date) do update
  set cmp_monthly = 0,
      avg_ly = 0,
      avg_12m = 0,
      avg_6m = 0,
      avg_4m = 0,
      source_batch_id = excluded.source_batch_id,
      data_class = 'actual',
      source_quality = 'source_missing_assumed_zero',
      updated_at = now();

  insert into reference_data.usage_observation_evidence (
    actual_workbook_import_id,
    usage_rate_id,
    source_artifact_id,
    source_row_id,
    raw_source_row_id,
    normalized_dash_count,
    excluded_negative_month_count,
    source_checksum,
    change_ticket,
    verified_by
  )
  select
    v_import_id,
    rate.usage_rate_id,
    v_usage_artifact,
    usage.reference_source_row_id,
    usage.source_row_id,
    usage.dash_cell_count,
    usage.negative_month_count,
    p_usage_checksum,
    left(p_change_ticket, 200),
    left(p_attested_by, 200)
  from staging.actual_usage_rows usage
  join core.usage_rates rate
   on rate.material_id = usage.material_id
   and rate.district_id = usage.district_id
   and rate.as_of_date = usage.as_of_date
   and rate.source_batch_id = v_usage_batch
   and rate.source_quality = 'source_observed'
  where usage.batch_id = v_usage_batch
    and usage.district_id is not null
    and usage.validation_status <> 'rejected'
  on conflict (usage_rate_id, source_row_id) do update
  set actual_workbook_import_id = excluded.actual_workbook_import_id,
      normalized_dash_count = excluded.normalized_dash_count,
      excluded_negative_month_count = excluded.excluded_negative_month_count,
      change_ticket = excluded.change_ticket,
      verified_by = excluded.verified_by,
      verified_at = now();

  delete from core.monthly_usage_observations
  where actual_workbook_import_id = v_import_id;

  insert into core.monthly_usage_observations (
    actual_workbook_import_id,
    usage_rate_id,
    source_artifact_id,
    source_row_id,
    raw_source_row_id,
    source_batch_id,
    material_id,
    district_id,
    period_start,
    raw_quantity_signed,
    demand_quantity,
    source_was_dash,
    negative_adjustment,
    source_checksum
  )
  select
    v_import_id,
    rate.usage_rate_id,
    v_usage_artifact,
    usage.reference_source_row_id,
    usage.source_row_id,
    v_usage_batch,
    usage.material_id,
    usage.district_id,
    ((month_row ->> 'period') || '-01')::date,
    case
      when month_row ->> 'raw_value'
        ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
        then (month_row ->> 'raw_value')::numeric
    end,
    greatest(
      coalesce(nullif(month_row ->> 'demand_quantity', '')::numeric, 0),
      0
    ),
    coalesce((month_row ->> 'source_was_dash')::boolean, false),
    coalesce((month_row ->> 'negative_adjustment')::boolean, false),
    p_usage_checksum
  from staging.actual_usage_rows usage
  join core.usage_rates rate
    on rate.material_id = usage.material_id
   and rate.district_id = usage.district_id
   and rate.as_of_date = usage.as_of_date
   and rate.source_batch_id = v_usage_batch
   and rate.source_quality = 'source_observed'
  cross join lateral jsonb_array_elements(usage.monthly_history) month_row
  where usage.batch_id = v_usage_batch
    and usage.district_id is not null
    and usage.validation_status <> 'rejected'
    and month_row ->> 'period' ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  on conflict (actual_workbook_import_id, source_row_id, period_start)
  do update
  set raw_quantity_signed = excluded.raw_quantity_signed,
      demand_quantity = excluded.demand_quantity,
      source_was_dash = excluded.source_was_dash,
      negative_adjustment = excluded.negative_adjustment,
      source_checksum = excluded.source_checksum;

  update staging.actual_vmi_district_values matrix
  set source_observed = exists (
        select 1
        from staging.actual_stock_rows stock
        where stock.batch_id = v_stock_batch
          and stock.material_id = matrix.material_id
          and stock.district_id = matrix.district_id
      )
      and exists (
        select 1
        from staging.actual_usage_rows usage
        where usage.batch_id = v_usage_batch
          and usage.material_id = matrix.material_id
          and usage.district_id = matrix.district_id
      ),
      updated_at = now()
  where matrix.reference_source_row_id in (
    select source_row_id
    from reference_data.source_rows
    where artifact_id = v_vmi_artifact
  );

  delete from ops.data_quality_issues
  where batch_id in (v_stock_batch, v_usage_batch)
    and source_entity in ('actual_stock', 'actual_usage');

  insert into ops.data_quality_issues (
    batch_id,
    source_row_id,
    source_entity,
    source_row_number,
    rule_code,
    field_name,
    raw_value,
    issue_message
  )
  select
    stock.batch_id,
    stock.source_row_id,
    'actual_stock',
    stock.source_row_number,
    issue.rule_code,
    issue.field_name,
    issue.raw_value,
    issue.issue_message
  from staging.actual_stock_rows stock
  cross join lateral (
    values
      (
        'ACTUAL_STOCK_MATERIAL_PADDED',
        'material_id',
        stock.source_material_code,
        'Source material identifier was padded to 12 digits.',
        stock.source_material_code <> stock.material_id
      ),
      (
        'ACTUAL_STOCK_STORAGE_MISSING',
        'storage_location_code',
        stock.storage_location_code,
        'Storage location is missing.',
        stock.storage_location_code is null
      ),
      (
        'ACTUAL_STOCK_TRANSFER_EXCLUDED',
        'stock_in_transfer_qty',
        stock.stock_in_transfer_qty::text,
        'Stock in Transfer was excluded from Core Unrestricted stock.',
        stock.stock_in_transfer_qty <> 0
      )
  ) issue(rule_code, field_name, raw_value, issue_message, failed)
  where issue.failed
  on conflict (batch_id, source_row_id, rule_code, field_name) do update
  set raw_value = excluded.raw_value,
      issue_message = excluded.issue_message;

  insert into ops.data_quality_issues (
    batch_id,
    source_row_id,
    source_entity,
    source_row_number,
    rule_code,
    field_name,
    raw_value,
    issue_message
  )
  select
    usage.batch_id,
    usage.source_row_id,
    'actual_usage',
    usage.source_row_number,
    issue.rule_code,
    issue.field_name,
    issue.raw_value,
    issue.issue_message
  from staging.actual_usage_rows usage
  cross join lateral (
    values
      (
        'ACTUAL_USAGE_UNMAPPED_PLANT',
        'sap_plant_code',
        usage.sap_plant_code,
        'SAP Plant is outside the active district mapping.',
        usage.district_id is null
      ),
      (
        'ACTUAL_USAGE_DASH_NORMALIZED',
        'monthly_history',
        usage.dash_cell_count::text,
        'Dash-valued monthly cells were normalized to zero.',
        usage.dash_cell_count > 0
      ),
      (
        'ACTUAL_USAGE_NEGATIVE_ADJUSTMENT',
        'monthly_history',
        usage.negative_month_count::text,
        'Signed monthly adjustments were preserved in Raw and excluded from demand.',
        usage.negative_month_count > 0
      ),
      (
        'ACTUAL_USAGE_NEGATIVE_CMP',
        'cmp_monthly',
        usage.cmp_monthly_raw::text,
        'Negative CMP was normalized to zero.',
        usage.cmp_monthly_raw < 0
      ),
      (
        'ACTUAL_USAGE_NEGATIVE_SUMMARY',
        'summary_metrics',
        jsonb_build_object(
          'calculated_cmp_raw', usage.calculated_cmp_raw,
          'avg_ly_raw', usage.avg_ly_raw,
          'avg_12m_raw', usage.avg_12m_raw,
          'avg_6m_raw', usage.avg_6m_raw,
          'avg_4m_raw', usage.avg_4m_raw
        )::text,
        'Signed summary metrics were preserved and normalized to non-negative Core values.',
        coalesce(usage.calculated_cmp_raw, 0) < 0
          or coalesce(usage.avg_ly_raw, 0) < 0
          or coalesce(usage.avg_12m_raw, 0) < 0
          or coalesce(usage.avg_6m_raw, 0) < 0
          or coalesce(usage.avg_4m_raw, 0) < 0
      )
  ) issue(rule_code, field_name, raw_value, issue_message, failed)
  where issue.failed
  on conflict (batch_id, source_row_id, rule_code, field_name) do update
  set raw_value = excluded.raw_value,
      issue_message = excluded.issue_message;

  update raw.import_batches
  set status = 'succeeded',
      imported_at = now(),
      finished_at = now(),
      error_message = null,
      updated_at = now()
  where batch_id in (
    v_contract_batch,
    v_stock_batch,
    v_usage_batch,
    v_master_batch,
    v_district_batch,
    v_vmi_batch
  );

  v_relation_result := public.m21_rebuild_actual_relations();

  select jsonb_build_object(
    'contracts',
      (select expected_rows from reference_data.source_artifacts
       where artifact_id = v_contract_artifact),
    'stock_rows',
      (select count(*) from staging.actual_stock_rows
       where batch_id = v_stock_batch),
    'usage_rows',
      (select count(*) from staging.actual_usage_rows
       where batch_id = v_usage_batch),
    'master_rows',
      (select expected_rows from reference_data.source_artifacts
       where artifact_id = v_master_artifact),
    'district_rows',
      (select expected_rows from reference_data.source_artifacts
       where artifact_id = v_district_artifact),
    'vmi_materials',
      (select expected_rows from reference_data.source_artifacts
       where artifact_id = v_vmi_artifact)
  ) into v_source_counts;

  select jsonb_build_object(
    'observed_district_stock_pairs',
      (
        select count(distinct (snapshot.material_id, location.district_id))
        from reference_data.stock_observation_evidence evidence
        join core.stock_snapshots snapshot
          on snapshot.snapshot_id = evidence.stock_snapshot_id
        join core.locations location using (location_id)
        join core.materials material using (material_id)
        where evidence.actual_workbook_import_id = v_import_id
          and evidence.source_artifact_id = v_stock_artifact
          and location.location_type = 'DISTRICT'
          and material.is_vmi
      ),
    'observed_warehouse_stock_materials',
      (
        select count(distinct snapshot.material_id)
        from reference_data.stock_observation_evidence evidence
        join core.stock_snapshots snapshot
          on snapshot.snapshot_id = evidence.stock_snapshot_id
        join core.materials material using (material_id)
        where evidence.actual_workbook_import_id = v_import_id
          and evidence.source_artifact_id = v_stock_artifact
          and snapshot.location_id = 'WH-KT'
          and material.is_vmi
      ),
    'observed_usage_pairs',
      (
        select count(distinct (rate.material_id, rate.district_id))
        from reference_data.usage_observation_evidence evidence
        join core.usage_rates rate using (usage_rate_id)
        join core.materials material using (material_id)
        where evidence.actual_workbook_import_id = v_import_id
          and evidence.source_artifact_id = v_usage_artifact
          and material.is_vmi
      ),
    'expected_district_material_pairs',
      (
        select count(*)::bigint
        from core.materials material
        cross join core.districts district
        where material.is_vmi and district.is_active
      ),
    'monthly_usage_observations',
      (
        select count(*)
        from core.monthly_usage_observations monthly
        where monthly.actual_workbook_import_id = v_import_id
      )
  ) into v_observation_counts;

  update ops.actual_workbook_imports
  set status = 'succeeded',
      source_counts = v_source_counts,
      observation_counts = v_observation_counts,
      finished_at = now()
  where actual_workbook_import_id = v_import_id;

  select data_contract_ready
  into v_data_contract_ready
  from analytics.v_production_readiness;

  v_data_contract_ready := coalesce(v_data_contract_ready, false);
  v_readiness_reason := case
    when v_data_contract_ready
      then 'Latest successful import satisfies the Production data contract.'
    else format(
      'Latest successful import remains fail-closed: district stock %s/%s, warehouse stock %s/%s, usage %s/%s.',
      coalesce(v_observation_counts ->> 'observed_district_stock_pairs', '0'),
      coalesce(v_observation_counts ->> 'expected_district_material_pairs', '0'),
      coalesce(v_observation_counts ->> 'observed_warehouse_stock_materials', '0'),
      (
        select count(*)::text
        from core.materials
        where is_vmi
      ),
      coalesce(v_observation_counts ->> 'observed_usage_pairs', '0'),
      coalesce(v_observation_counts ->> 'expected_district_material_pairs', '0')
    )
  end;

  return jsonb_build_object(
    'actual_workbook_import_id', v_import_id,
    'status', 'succeeded',
    'source_counts', v_source_counts,
    'observation_counts', v_observation_counts,
    'relations', v_relation_result,
    'data_contract_ready', v_data_contract_ready,
    'readiness_reason', v_readiness_reason
  );
exception
  when others then
    update ops.actual_workbook_imports
    set status = 'failed',
        error_message = left(sqlerrm, 1000),
        finished_at = now()
    where actual_workbook_import_id = v_import_id;

    return jsonb_build_object(
      'actual_workbook_import_id', v_import_id,
      'status', 'failed',
      'error_message', left(sqlerrm, 1000),
      'data_contract_ready', false
    );
  end;
end;
$$;

create or replace view analytics.v_source_observation_coverage
with (security_invoker = true)
as
with latest_successful_import as (
  select actual_workbook_import_id
  from ops.actual_workbook_imports
  where status = 'succeeded'
  order by finished_at desc nulls last, started_at desc,
    actual_workbook_import_id desc
  limit 1
), material_scope as (
  select count(*)::bigint as material_count
  from core.materials
  where is_vmi
), district_scope as (
  select count(*)::bigint as district_count
  from core.districts
  where is_active
), expected as (
  select
    material_count,
    district_count,
    material_count * district_count as district_material_pairs
  from material_scope
  cross join district_scope
), observed_district_stock as (
  select count(*)::bigint as row_count
  from (
    select distinct snapshot.material_id, location.district_id
    from reference_data.stock_observation_evidence evidence
    join core.stock_snapshots snapshot
      on snapshot.snapshot_id = evidence.stock_snapshot_id
    join core.locations location using (location_id)
    join core.materials material using (material_id)
    where evidence.verification_status = 'source_observed'
      and evidence.actual_workbook_import_id = (
        select actual_workbook_import_id from latest_successful_import
      )
      and location.location_type = 'DISTRICT'
      and location.is_active
      and material.is_vmi
  ) observed
), observed_warehouse_stock as (
  select count(distinct snapshot.material_id)::bigint as row_count
  from reference_data.stock_observation_evidence evidence
  join core.stock_snapshots snapshot
    on snapshot.snapshot_id = evidence.stock_snapshot_id
  join core.materials material using (material_id)
  where evidence.verification_status = 'source_observed'
    and evidence.actual_workbook_import_id = (
      select actual_workbook_import_id from latest_successful_import
    )
    and snapshot.location_id = 'WH-KT'
    and material.is_vmi
), observed_usage as (
  select count(*)::bigint as row_count
  from (
    select distinct rate.material_id, rate.district_id
    from reference_data.usage_observation_evidence evidence
    join core.usage_rates rate using (usage_rate_id)
    join core.materials material using (material_id)
    join core.districts district using (district_id)
    where evidence.verification_status = 'source_observed'
      and evidence.actual_workbook_import_id = (
        select actual_workbook_import_id from latest_successful_import
      )
      and material.is_vmi
      and district.is_active
  ) observed
)
select
  expected.material_count as active_vmi_material_count,
  expected.district_count as active_district_count,
  expected.district_material_pairs as expected_district_material_pairs,
  observed_district_stock.row_count as observed_district_stock_pairs,
  expected.district_material_pairs
    - observed_district_stock.row_count as missing_district_stock_pairs,
  observed_warehouse_stock.row_count as observed_warehouse_stock_materials,
  expected.material_count
    - observed_warehouse_stock.row_count as missing_warehouse_stock_materials,
  observed_usage.row_count as observed_usage_pairs,
  expected.district_material_pairs
    - observed_usage.row_count as missing_usage_pairs,
  (
    observed_district_stock.row_count = expected.district_material_pairs
    and observed_warehouse_stock.row_count = expected.material_count
    and observed_usage.row_count = expected.district_material_pairs
  ) as source_observation_ready
from expected
cross join observed_district_stock
cross join observed_warehouse_stock
cross join observed_usage;

create or replace view analytics.v_stock_health
with (security_invoker = true)
as
with latest_successful_import as (
  select actual_workbook_import_id
  from ops.actual_workbook_imports
  where status = 'succeeded'
  order by finished_at desc nulls last, started_at desc,
    actual_workbook_import_id desc
  limit 1
), legacy_nonproduction_fallback as (
  select
    not exists (select 1 from latest_successful_import)
    and exists (
      select 1
      from ops.environment_registry
      where environment_name <> 'production'
    ) as allowed
), latest_location_candidate as (
  select distinct on (snapshot.material_id, snapshot.location_id)
    snapshot.snapshot_id,
    snapshot.material_id,
    snapshot.location_id,
    location.district_id,
    snapshot.quantity_on_hand,
    snapshot.snapshot_at,
    snapshot.source_batch_id,
    snapshot.data_class
  from core.stock_snapshots snapshot
  join core.locations location using (location_id)
  where location.location_type = 'DISTRICT'
    and (
      snapshot.data_class = 'test_fixture'
      or exists (select 1 from latest_successful_import)
      or (select allowed from legacy_nonproduction_fallback)
    )
  order by
    snapshot.material_id,
    snapshot.location_id,
    snapshot.snapshot_at desc,
    snapshot.snapshot_id
), latest_location_snapshot as (
  select candidate.*
  from latest_location_candidate candidate
  where candidate.data_class = 'test_fixture'
    or (select allowed from legacy_nonproduction_fallback)
    or exists (
      select 1
      from reference_data.stock_observation_evidence evidence
      where evidence.stock_snapshot_id = candidate.snapshot_id
        and evidence.verification_status = 'source_observed'
        and evidence.actual_workbook_import_id = (
          select actual_workbook_import_id from latest_successful_import
        )
    )
), district_stock as (
  select
    material_id,
    district_id,
    (array_agg(snapshot_id order by snapshot_at desc, snapshot_id))[1]
      as snapshot_id,
    sum(quantity_on_hand) as quantity_on_hand,
    max(snapshot_at) as snapshot_at,
    (
      array_agg(source_batch_id order by snapshot_at desc)
      filter (where source_batch_id is not null)
    )[1] as source_batch_id,
    case
      when count(distinct data_class) > 1 then 'mixed'
      when bool_or(data_class = 'test_fixture') then 'test_fixture'
      else 'actual'
    end as data_class
  from latest_location_snapshot
  group by material_id, district_id
), latest_usage_candidate as (
  select distinct on (usage.material_id, usage.district_id)
    usage.usage_rate_id,
    usage.material_id,
    usage.district_id,
    usage.as_of_date,
    usage.cmp_monthly,
    usage.avg_ly,
    usage.avg_12m,
    usage.avg_6m,
    usage.avg_4m,
    usage.source_batch_id,
    usage.data_class
  from core.usage_rates usage
  where usage.data_class = 'test_fixture'
    or exists (select 1 from latest_successful_import)
    or (select allowed from legacy_nonproduction_fallback)
  order by
    usage.material_id,
    usage.district_id,
    usage.as_of_date desc,
    usage.updated_at desc
), latest_usage as (
  select candidate.*
  from latest_usage_candidate candidate
  where candidate.data_class = 'test_fixture'
    or (select allowed from legacy_nonproduction_fallback)
    or exists (
      select 1
      from reference_data.usage_observation_evidence evidence
      where evidence.usage_rate_id = candidate.usage_rate_id
        and evidence.verification_status = 'source_observed'
        and evidence.actual_workbook_import_id = (
          select actual_workbook_import_id from latest_successful_import
        )
    )
)
select
  stock.snapshot_id,
  usage.usage_rate_id,
  material.material_id,
  material.material_name,
  district.district_id,
  district.district_name_th,
  coalesce(stock.quantity_on_hand, 0) as current_stock_qty,
  stock.snapshot_at,
  usage.as_of_date as usage_as_of_date,
  usage.cmp_monthly,
  usage.avg_4m,
  usage.avg_6m,
  case
    when usage.cmp_monthly > 0
      then round(coalesce(stock.quantity_on_hand, 0) / usage.cmp_monthly, 1)
  end as months_available,
  case
    when usage.cmp_monthly is null or usage.cmp_monthly = 0 then 'unknown'
    when coalesce(stock.quantity_on_hand, 0) / usage.cmp_monthly < 1.5
      then 'critical'
    when coalesce(stock.quantity_on_hand, 0) / usage.cmp_monthly < 3.5
      then 'watch'
    when coalesce(stock.quantity_on_hand, 0) / usage.cmp_monthly > 6
      then 'overstock'
    else 'healthy'
  end as health_band,
  usage.avg_ly,
  usage.avg_12m,
  stock.snapshot_id is null as source_stock_missing,
  case
    when stock.snapshot_id is null then 'Source Missing / Assumed 0'
    when stock.data_class in ('test_fixture', 'mixed')
      then 'TEST FIXTURE — Not Actual SAP Stock'
    else 'Actual Unrestricted Stock — Source Observed'
  end as stock_source_status,
  stock.source_batch_id as stock_source_batch_id,
  usage.source_batch_id as usage_source_batch_id,
  coalesce(stock.data_class, 'source_missing') as stock_data_class,
  coalesce(usage.data_class, 'source_missing') as usage_data_class,
  case
    when stock.data_class = 'test_fixture'
      and usage.data_class = 'test_fixture' then 'test_fixture'
    when stock.data_class = 'test_fixture'
      or usage.data_class = 'test_fixture' then 'mixed'
    else 'actual'
  end as input_data_class,
  coalesce(stock.data_class = 'test_fixture', false)
    or coalesce(usage.data_class = 'test_fixture', false) as fixture_backed
from core.materials material
cross join core.districts district
left join district_stock stock
  on stock.material_id = material.material_id
 and stock.district_id = district.district_id
left join latest_usage usage
  on usage.material_id = material.material_id
 and usage.district_id = district.district_id
where material.is_vmi
  and district.is_active;

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
    (select count(*) from core.stock_snapshots where data_class = 'test_fixture')
    + (select count(*) from core.usage_rates where data_class = 'test_fixture')
    + (select count(*) from core.packaging_profiles where data_class = 'test_fixture')
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
      and quality.weighted_material_count >= scope.material_count
      and quality.verified_packaging_count >= scope.material_count
    ) as data_contract_ready,
    (
      identities.central_role_count = 4
      and identities.district_user_count >= scope.district_count
    ) as identity_ready,
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
  end as readiness_status
from readiness;

alter table staging.actual_stock_rows enable row level security;
alter table staging.actual_usage_rows enable row level security;
alter table staging.actual_vmi_district_values enable row level security;
alter table reference_data.stock_observation_evidence enable row level security;
alter table reference_data.usage_observation_evidence enable row level security;
alter table ops.actual_workbook_imports enable row level security;
alter table core.monthly_usage_observations enable row level security;

revoke all on staging.actual_stock_rows,
  staging.actual_usage_rows,
  staging.actual_vmi_district_values,
  reference_data.stock_observation_evidence,
  reference_data.usage_observation_evidence,
  ops.actual_workbook_imports,
  core.monthly_usage_observations
  from public, anon, authenticated;
grant all on staging.actual_stock_rows,
  staging.actual_usage_rows,
  staging.actual_vmi_district_values,
  reference_data.stock_observation_evidence,
  reference_data.usage_observation_evidence,
  ops.actual_workbook_imports,
  core.monthly_usage_observations
  to service_role;
grant usage, select on all sequences in schema staging, reference_data, ops
  to service_role;
grant usage, select
  on sequence core.monthly_usage_observations_monthly_usage_observation_id_seq
  to service_role;

revoke all on function public.m21_rebuild_actual_relations()
  from public, anon, authenticated;
revoke all on function public.m21_promote_actual_workbooks(
  text, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.m21_assert_actual_import_environment(
  text, boolean
) from public, anon, authenticated;
grant execute on function public.m21_rebuild_actual_relations()
  to service_role;
grant execute on function public.m21_promote_actual_workbooks(
  text, text, text, text, text, text, text
) to service_role;
grant execute on function public.m21_assert_actual_import_environment(
  text, boolean
) to service_role;

revoke all on analytics.v_source_observation_coverage
  from public, anon, authenticated;
grant select on analytics.v_source_observation_coverage to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607240021',
  'M21',
  'Actual workbook import, row-level Stock/Usage observation evidence, relation coverage and fail-closed readiness.',
  'supabase/migrations/202607240021_actual_workbook_observation_lineage.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
