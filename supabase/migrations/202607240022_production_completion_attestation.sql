-- SYNAPSE M22: Production owner-attested completion for exhaustive sources.
--
-- A missing row in the declared active VMI x district/warehouse scope is zero
-- only after an owner attests that the checksummed sources are exhaustive.
-- These rows remain distinguishable from directly observed SAP rows.

begin;

alter table core.stock_snapshots
  drop constraint if exists stock_snapshots_source_quality_check;
alter table core.stock_snapshots
  add constraint stock_snapshots_source_quality_check
  check (source_quality in (
    'source_observed',
    'source_missing_assumed_zero',
    'owner_attested_zero',
    'source_derived',
    'test_fixture'
  ));

alter table core.usage_rates
  drop constraint if exists usage_rates_source_quality_check;
alter table core.usage_rates
  add constraint usage_rates_source_quality_check
  check (source_quality in (
    'source_observed',
    'source_missing_assumed_zero',
    'owner_attested_zero',
    'source_derived',
    'test_fixture'
  ));

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
       'source_missing_assumed_zero',
       'owner_attested_zero'
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
      and period_start >= v_latest_period - interval '11 months';

    new.cmp_monthly := round(
      (
        coalesce(new.avg_ly, 0)
        + coalesce(new.avg_12m, 0)
        + coalesce(new.avg_6m, 0)
        + coalesce(new.avg_4m, 0)
      ) / 4,
      0
    );
  end if;

  return new;
end;
$$;

create table if not exists ops.production_completion_attestations (
  production_completion_attestation_id uuid primary key
    default gen_random_uuid(),
  actual_workbook_import_id uuid not null unique
    references ops.actual_workbook_imports (actual_workbook_import_id)
    on delete restrict,
  environment_name text not null check (environment_name = 'production'),
  project_ref text not null check (btrim(project_ref) <> ''),
  zero_completion_policy text not null
    check (
      zero_completion_policy = 'exhaustive_source_omission_means_zero'
    ),
  attested_by text not null check (btrim(attested_by) <> ''),
  attestation_text text not null check (btrim(attestation_text) <> ''),
  change_ticket text not null check (btrim(change_ticket) <> ''),
  owner_attested_stock_zero_count bigint not null default 0
    check (owner_attested_stock_zero_count >= 0),
  owner_attested_usage_zero_count bigint not null default 0
    check (owner_attested_usage_zero_count >= 0),
  attested_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table reference_data.stock_observation_evidence
  alter column source_row_id drop not null,
  alter column raw_source_row_id drop not null,
  add column if not exists evidence_basis text not null
    default 'source_row_observed';
alter table reference_data.stock_observation_evidence
  drop constraint if exists stock_observation_evidence_verification_status_check;
alter table reference_data.stock_observation_evidence
  add constraint stock_observation_evidence_verification_status_check
  check (verification_status in ('source_observed', 'owner_attested_zero'));
alter table reference_data.stock_observation_evidence
  drop constraint if exists stock_observation_evidence_evidence_basis_check;
alter table reference_data.stock_observation_evidence
  add constraint stock_observation_evidence_evidence_basis_check
  check (evidence_basis in ('source_row_observed', 'owner_attestation'));

alter table reference_data.usage_observation_evidence
  alter column source_row_id drop not null,
  alter column raw_source_row_id drop not null,
  add column if not exists evidence_basis text not null
    default 'source_row_observed';
alter table reference_data.usage_observation_evidence
  drop constraint if exists usage_observation_evidence_verification_status_check;
alter table reference_data.usage_observation_evidence
  add constraint usage_observation_evidence_verification_status_check
  check (verification_status in ('source_observed', 'owner_attested_zero'));
alter table reference_data.usage_observation_evidence
  drop constraint if exists usage_observation_evidence_evidence_basis_check;
alter table reference_data.usage_observation_evidence
  add constraint usage_observation_evidence_evidence_basis_check
  check (evidence_basis in ('source_row_observed', 'owner_attestation'));

create unique index if not exists stock_owner_attested_zero_unique
  on reference_data.stock_observation_evidence (
    actual_workbook_import_id, stock_snapshot_id
  )
  where verification_status = 'owner_attested_zero';

create unique index if not exists usage_owner_attested_zero_unique
  on reference_data.usage_observation_evidence (
    actual_workbook_import_id, usage_rate_id
  )
  where verification_status = 'owner_attested_zero';

create or replace function public.m22_attest_production_completion(
  p_actual_workbook_import_id uuid,
  p_attested_by text,
  p_attestation_text text,
  p_change_ticket text,
  p_zero_completion_policy text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, raw, core, analytics, ops,
  reference_data
as $$
declare
  v_environment text;
  v_project_ref text;
  v_stock_checksum text;
  v_usage_checksum text;
  v_stock_artifact uuid;
  v_usage_artifact uuid;
  v_stock_batch uuid;
  v_usage_batch uuid;
  v_attestation_id uuid;
  v_stock_zero_count bigint;
  v_usage_zero_count bigint;
  v_data_contract_ready boolean;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M22 Production completion requires service_role';
  end if;
  if p_zero_completion_policy <>
      'exhaustive_source_omission_means_zero' then
    raise exception 'Unsupported zero completion policy';
  end if;
  if btrim(coalesce(p_attested_by, '')) = ''
     or btrim(coalesce(p_attestation_text, '')) = ''
     or btrim(coalesce(p_change_ticket, '')) = '' then
    raise exception 'Attestor, attestation text and change ticket are required';
  end if;

  select environment_name, project_ref
  into v_environment, v_project_ref
  from ops.environment_registry
  order by updated_at desc
  limit 1;

  if v_environment <> 'production' then
    raise exception 'M22 can only run in the registered Production project';
  end if;

  select stock_checksum, usage_checksum
  into v_stock_checksum, v_usage_checksum
  from ops.actual_workbook_imports
  where actual_workbook_import_id = p_actual_workbook_import_id
    and status = 'succeeded';

  if v_stock_checksum is null or v_usage_checksum is null then
    raise exception 'A successful Actual workbook import is required';
  end if;

  select artifact_id into strict v_stock_artifact
  from reference_data.source_artifacts
  where source_path = 'Stock.xlsx'
    and source_sheet = 'update-stock'
    and source_checksum = v_stock_checksum;

  select artifact_id into strict v_usage_artifact
  from reference_data.source_artifacts
  where source_path = 'อัตราการใช้งาน.xlsx'
    and source_sheet = 'Check CMP'
    and source_checksum = v_usage_checksum;

  select batch_id into strict v_stock_batch
  from raw.import_batches
  where source_checksum = v_stock_checksum
    and source_sheet = 'update-stock';

  select batch_id into strict v_usage_batch
  from raw.import_batches
  where source_checksum = v_usage_checksum
    and source_sheet = 'Check CMP';

  insert into ops.production_completion_attestations (
    actual_workbook_import_id,
    environment_name,
    project_ref,
    zero_completion_policy,
    attested_by,
    attestation_text,
    change_ticket
  )
  values (
    p_actual_workbook_import_id,
    v_environment,
    v_project_ref,
    p_zero_completion_policy,
    left(p_attested_by, 200),
    left(p_attestation_text, 1000),
    left(p_change_ticket, 200)
  )
  on conflict (actual_workbook_import_id) do update
  set zero_completion_policy = excluded.zero_completion_policy,
      attested_by = excluded.attested_by,
      attestation_text = excluded.attestation_text,
      change_ticket = excluded.change_ticket,
      attested_at = now()
  returning production_completion_attestation_id into v_attestation_id;

  update core.stock_snapshots
  set source_quality = 'owner_attested_zero'
  where source_batch_id = v_stock_batch
    and data_class = 'actual'
    and source_quality = 'source_missing_assumed_zero'
    and quantity_on_hand = 0;

  update core.usage_rates
  set source_quality = 'owner_attested_zero',
      updated_at = now()
  where source_batch_id = v_usage_batch
    and data_class = 'actual'
    and source_quality = 'source_missing_assumed_zero'
    and cmp_monthly = 0
    and avg_ly = 0
    and avg_12m = 0
    and avg_6m = 0
    and avg_4m = 0;

  insert into reference_data.stock_observation_evidence (
    actual_workbook_import_id,
    stock_snapshot_id,
    source_artifact_id,
    source_row_id,
    raw_source_row_id,
    verification_status,
    evidence_basis,
    aggregation_scope,
    observed_quantity,
    aggregation_rule,
    source_checksum,
    change_ticket,
    verified_by
  )
  select
    p_actual_workbook_import_id,
    snapshot.snapshot_id,
    v_stock_artifact,
    null,
    null,
    'owner_attested_zero',
    'owner_attestation',
    case
      when location.location_type = 'DISTRICT' then 'district'
      else 'warehouse'
    end,
    0,
    'Exhaustive source omission means zero; no direct SAP row exists.',
    v_stock_checksum,
    left(p_change_ticket, 200),
    left(p_attested_by, 200)
  from core.stock_snapshots snapshot
  join core.locations location using (location_id)
  join core.materials material using (material_id)
  where snapshot.source_batch_id = v_stock_batch
    and snapshot.source_quality = 'owner_attested_zero'
    and material.is_vmi
    and (
      location.location_type = 'DISTRICT'
      or snapshot.location_id = 'WH-KT'
    )
  on conflict (
    actual_workbook_import_id, stock_snapshot_id
  ) where verification_status = 'owner_attested_zero'
  do update
  set change_ticket = excluded.change_ticket,
      verified_by = excluded.verified_by,
      verified_at = now(),
      aggregation_rule = excluded.aggregation_rule,
      evidence_basis = excluded.evidence_basis;

  insert into reference_data.usage_observation_evidence (
    actual_workbook_import_id,
    usage_rate_id,
    source_artifact_id,
    source_row_id,
    raw_source_row_id,
    verification_status,
    evidence_basis,
    normalized_dash_count,
    excluded_negative_month_count,
    source_checksum,
    change_ticket,
    verified_by
  )
  select
    p_actual_workbook_import_id,
    rate.usage_rate_id,
    v_usage_artifact,
    null,
    null,
    'owner_attested_zero',
    'owner_attestation',
    0,
    0,
    v_usage_checksum,
    left(p_change_ticket, 200),
    left(p_attested_by, 200)
  from core.usage_rates rate
  join core.materials material using (material_id)
  join core.districts district using (district_id)
  where rate.source_batch_id = v_usage_batch
    and rate.source_quality = 'owner_attested_zero'
    and material.is_vmi
    and district.is_active
  on conflict (
    actual_workbook_import_id, usage_rate_id
  ) where verification_status = 'owner_attested_zero'
  do update
  set change_ticket = excluded.change_ticket,
      verified_by = excluded.verified_by,
      verified_at = now(),
      evidence_basis = excluded.evidence_basis;

  select count(*) into v_stock_zero_count
  from reference_data.stock_observation_evidence
  where actual_workbook_import_id = p_actual_workbook_import_id
    and verification_status = 'owner_attested_zero';

  select count(*) into v_usage_zero_count
  from reference_data.usage_observation_evidence
  where actual_workbook_import_id = p_actual_workbook_import_id
    and verification_status = 'owner_attested_zero';

  update ops.production_completion_attestations
  set owner_attested_stock_zero_count = v_stock_zero_count,
      owner_attested_usage_zero_count = v_usage_zero_count,
      attested_at = now()
  where production_completion_attestation_id = v_attestation_id;

  select data_contract_ready
  into v_data_contract_ready
  from analytics.v_production_readiness;

  return jsonb_build_object(
    'status', 'succeeded',
    'production_completion_attestation_id', v_attestation_id,
    'actual_workbook_import_id', p_actual_workbook_import_id,
    'project_ref', v_project_ref,
    'owner_attested_stock_zero_count', v_stock_zero_count,
    'owner_attested_usage_zero_count', v_usage_zero_count,
    'data_contract_ready', coalesce(v_data_contract_ready, false)
  );
exception
  when others then
    return jsonb_build_object(
      'status', 'failed',
      'actual_workbook_import_id', p_actual_workbook_import_id,
      'error_message', left(sqlerrm, 1000),
      'data_contract_ready', false
    );
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
), expected as (
  select
    (select count(*)::bigint from core.materials where is_vmi)
      as material_count,
    (select count(*)::bigint from core.districts where is_active)
      as district_count
), district_stock as (
  select
    count(*)::bigint as effective_count,
    count(*) filter (where verification_status = 'source_observed')::bigint
      as observed_count,
    count(*) filter (
      where verification_status = 'owner_attested_zero'
    )::bigint as owner_attested_zero_count
  from (
    select distinct on (snapshot.material_id, location.district_id)
      snapshot.material_id,
      location.district_id,
      evidence.verification_status
    from reference_data.stock_observation_evidence evidence
    join core.stock_snapshots snapshot
      on snapshot.snapshot_id = evidence.stock_snapshot_id
    join core.locations location using (location_id)
    join core.materials material using (material_id)
    where evidence.actual_workbook_import_id = (
        select actual_workbook_import_id from latest_successful_import
      )
      and evidence.verification_status in (
        'source_observed', 'owner_attested_zero'
      )
      and location.location_type = 'DISTRICT'
      and location.is_active
      and material.is_vmi
    order by snapshot.material_id, location.district_id,
      (evidence.verification_status = 'source_observed') desc
  ) covered
), warehouse_stock as (
  select
    count(*)::bigint as effective_count,
    count(*) filter (where verification_status = 'source_observed')::bigint
      as observed_count,
    count(*) filter (
      where verification_status = 'owner_attested_zero'
    )::bigint as owner_attested_zero_count
  from (
    select distinct on (snapshot.material_id)
      snapshot.material_id,
      evidence.verification_status
    from reference_data.stock_observation_evidence evidence
    join core.stock_snapshots snapshot
      on snapshot.snapshot_id = evidence.stock_snapshot_id
    join core.materials material using (material_id)
    where evidence.actual_workbook_import_id = (
        select actual_workbook_import_id from latest_successful_import
      )
      and evidence.verification_status in (
        'source_observed', 'owner_attested_zero'
      )
      and snapshot.location_id = 'WH-KT'
      and material.is_vmi
    order by snapshot.material_id,
      (evidence.verification_status = 'source_observed') desc
  ) covered
), usage as (
  select
    count(*)::bigint as effective_count,
    count(*) filter (where verification_status = 'source_observed')::bigint
      as observed_count,
    count(*) filter (
      where verification_status = 'owner_attested_zero'
    )::bigint as owner_attested_zero_count
  from (
    select distinct on (rate.material_id, rate.district_id)
      rate.material_id,
      rate.district_id,
      evidence.verification_status
    from reference_data.usage_observation_evidence evidence
    join core.usage_rates rate using (usage_rate_id)
    join core.materials material using (material_id)
    join core.districts district using (district_id)
    where evidence.actual_workbook_import_id = (
        select actual_workbook_import_id from latest_successful_import
      )
      and evidence.verification_status in (
        'source_observed', 'owner_attested_zero'
      )
      and material.is_vmi
      and district.is_active
    order by rate.material_id, rate.district_id,
      (evidence.verification_status = 'source_observed') desc
  ) covered
)
select
  expected.material_count as active_vmi_material_count,
  expected.district_count as active_district_count,
  expected.material_count * expected.district_count
    as expected_district_material_pairs,
  district_stock.effective_count as observed_district_stock_pairs,
  expected.material_count * expected.district_count
    - district_stock.effective_count as missing_district_stock_pairs,
  warehouse_stock.effective_count as observed_warehouse_stock_materials,
  expected.material_count - warehouse_stock.effective_count
    as missing_warehouse_stock_materials,
  usage.effective_count as observed_usage_pairs,
  expected.material_count * expected.district_count
    - usage.effective_count as missing_usage_pairs,
  (
    district_stock.effective_count
      = expected.material_count * expected.district_count
    and warehouse_stock.effective_count = expected.material_count
    and usage.effective_count
      = expected.material_count * expected.district_count
  ) as source_observation_ready,
  district_stock.observed_count as direct_district_stock_pairs,
  district_stock.owner_attested_zero_count
    as owner_attested_zero_district_stock_pairs,
  warehouse_stock.observed_count as direct_warehouse_stock_materials,
  warehouse_stock.owner_attested_zero_count
    as owner_attested_zero_warehouse_stock_materials,
  usage.observed_count as direct_usage_pairs,
  usage.owner_attested_zero_count as owner_attested_zero_usage_pairs
from expected
cross join district_stock
cross join warehouse_stock
cross join usage;

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
    snapshot.data_class,
    snapshot.source_quality
  from core.stock_snapshots snapshot
  join core.locations location using (location_id)
  where location.location_type = 'DISTRICT'
    and (
      snapshot.data_class = 'test_fixture'
      or exists (select 1 from latest_successful_import)
      or (select allowed from legacy_nonproduction_fallback)
    )
  order by snapshot.material_id, snapshot.location_id,
    snapshot.snapshot_at desc, snapshot.snapshot_id
), latest_location_snapshot as (
  select candidate.*
  from latest_location_candidate candidate
  where candidate.data_class = 'test_fixture'
    or (select allowed from legacy_nonproduction_fallback)
    or exists (
    select 1
    from reference_data.stock_observation_evidence evidence
    where evidence.stock_snapshot_id = candidate.snapshot_id
      and evidence.verification_status in (
        'source_observed', 'owner_attested_zero'
      )
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
    (array_agg(source_batch_id order by snapshot_at desc))[1]
      as source_batch_id,
    (array_agg(source_quality order by snapshot_at desc))[1]
      as source_quality,
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
    usage.data_class,
    usage.source_quality
  from core.usage_rates usage
  where usage.data_class = 'test_fixture'
    or exists (select 1 from latest_successful_import)
    or (select allowed from legacy_nonproduction_fallback)
  order by usage.material_id, usage.district_id,
    usage.as_of_date desc, usage.updated_at desc
), latest_usage as (
  select candidate.*
  from latest_usage_candidate candidate
  where candidate.data_class = 'test_fixture'
    or (select allowed from legacy_nonproduction_fallback)
    or exists (
    select 1
    from reference_data.usage_observation_evidence evidence
    where evidence.usage_rate_id = candidate.usage_rate_id
      and evidence.verification_status in (
        'source_observed', 'owner_attested_zero'
      )
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
    when usage.cmp_monthly is null then 'unknown'
    when usage.cmp_monthly = 0
      and usage.source_quality = 'owner_attested_zero' then 'no_usage'
    when usage.cmp_monthly = 0 then 'unknown'
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
    when stock.snapshot_id is null then 'Source Missing'
    when stock.data_class in ('test_fixture', 'mixed')
      then 'TEST FIXTURE — Not Actual SAP Stock'
    when stock.source_quality = 'owner_attested_zero'
      then 'Owner-attested zero from exhaustive source omission'
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

alter table ops.production_completion_attestations enable row level security;
revoke all on ops.production_completion_attestations
  from public, anon, authenticated;
grant all on ops.production_completion_attestations to service_role;

revoke all on function public.m22_attest_production_completion(
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.m22_attest_production_completion(
  uuid, text, text, text, text
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
  '202607240022',
  'M22',
  'Production owner-attested zero completion with distinct evidence lineage.',
  'supabase/migrations/202607240022_production_completion_attestation.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
