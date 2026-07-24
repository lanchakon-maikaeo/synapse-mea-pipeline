-- SYNAPSE M20: promote an owner-attested workbook into operational Actual data.
--
-- This migration does not assume that a filename describes the data class.
-- Promotion requires an explicit owner attestation, preserves the original
-- checksum and rows, records lineage, and fails closed on incomplete coverage.

begin;

create table if not exists ops.source_attestations (
  attestation_id uuid primary key default gen_random_uuid(),
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  original_data_class text not null,
  asserted_data_class text not null check (asserted_data_class = 'actual'),
  attestation_text text not null check (btrim(attestation_text) <> ''),
  attested_by text not null check (btrim(attested_by) <> ''),
  change_ticket text not null check (btrim(change_ticket) <> ''),
  attested_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source_checksum, asserted_data_class)
);

create table if not exists ops.source_promotions (
  promotion_id uuid primary key default gen_random_uuid(),
  attestation_id uuid not null
    references ops.source_attestations (attestation_id) on delete restrict,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  materials_promoted integer not null default 0 check (materials_promoted >= 0),
  packaging_promoted integer not null default 0 check (packaging_promoted >= 0),
  stock_promoted integer not null default 0 check (stock_promoted >= 0),
  usage_promoted integer not null default 0 check (usage_promoted >= 0),
  dq_remediations integer not null default 0 check (dq_remediations >= 0),
  validation_details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(validation_details) = 'object'),
  promoted_by text not null default current_user,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function ops.promote_owner_attested_workbook(
  p_source_checksum text,
  p_attested_by text,
  p_attestation_text text,
  p_change_ticket text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, ops, raw, core, reference_data, extensions
as $$
declare
  v_attestation_id uuid;
  v_promotion_id uuid;
  v_material_artifact uuid;
  v_packaging_artifact uuid;
  v_stock_artifact uuid;
  v_usage_artifact uuid;
  v_material_batch uuid;
  v_packaging_batch uuid;
  v_stock_batch uuid;
  v_usage_batch uuid;
  v_material_count integer;
  v_packaging_count integer;
  v_stock_count integer;
  v_usage_count integer;
  v_dq_count integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Actual promotion requires service_role';
  end if;
  if coalesce(p_source_checksum, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid source checksum';
  end if;
  if btrim(coalesce(p_attested_by, '')) = ''
     or btrim(coalesce(p_attestation_text, '')) = ''
     or btrim(coalesce(p_change_ticket, '')) = '' then
    raise exception 'Attestor, attestation text and change ticket are required';
  end if;

  select
    (array_agg(artifact_id) filter (where source_sheet = 'DB_Material'))[1],
    (array_agg(artifact_id) filter (where source_sheet = 'DB_Contract_Static'))[1],
    (array_agg(artifact_id) filter (where source_sheet = 'DB_Stock'))[1],
    (array_agg(artifact_id) filter (where source_sheet = 'DB_SAP_Monthly'))[1]
  into
    v_material_artifact,
    v_packaging_artifact,
    v_stock_artifact,
    v_usage_artifact
  from reference_data.source_artifacts
  where source_checksum = p_source_checksum;

  if v_material_artifact is null
     or v_packaging_artifact is null
     or v_stock_artifact is null
     or v_usage_artifact is null then
    raise exception 'Required workbook sheets are not present in governed source evidence';
  end if;

  if exists (
    select 1
    from reference_data.source_artifacts a
    where a.artifact_id in (
      v_material_artifact,
      v_packaging_artifact,
      v_stock_artifact,
      v_usage_artifact
    )
      and a.expected_rows <> (
        select count(*)
        from reference_data.source_rows r
        where r.artifact_id = a.artifact_id
      )
  ) then
    raise exception 'One or more source sheets are incomplete';
  end if;

  select count(*) into v_material_count
  from reference_data.source_rows
  where artifact_id = v_material_artifact;
  select count(*) into v_packaging_count
  from reference_data.source_rows
  where artifact_id = v_packaging_artifact;
  select count(*) into v_stock_count
  from reference_data.source_rows
  where artifact_id = v_stock_artifact;
  select count(*) into v_usage_count
  from reference_data.source_rows
  where artifact_id = v_usage_artifact;

  if v_material_count <> 225
     or v_packaging_count <> 225
     or v_stock_count <> 4275
     or v_usage_count <> 4050 then
    raise exception
      'Workbook contract mismatch (materials %, packaging %, stock %, usage %)',
      v_material_count, v_packaging_count, v_stock_count, v_usage_count;
  end if;

  if (
    select count(distinct material_id || '|' || district_id)
    from reference_data.source_rows
    where artifact_id = v_usage_artifact
  ) <> 4050 then
    raise exception 'Usage district-material coverage is not unique and complete';
  end if;
  if (
    select count(distinct material_id || '|' || (payload ->> 'Location_ID'))
    from reference_data.source_rows
    where artifact_id = v_stock_artifact
      and payload ->> 'Location_Type' = 'DISTRICT'
  ) <> 4050 then
    raise exception 'Stock district-material coverage is not unique and complete';
  end if;
  if exists (
    select 1
    from reference_data.source_rows
    where artifact_id = v_material_artifact
      and coalesce(nullif(payload ->> 'Weight_per_Unit_kg', '')::numeric, 0) <= 0
  ) then
    raise exception 'Material weight must be positive for every VMI material';
  end if;
  if exists (
    select 1
    from reference_data.source_rows
    where artifact_id = v_packaging_artifact
      and (
        coalesce(nullif(payload ->> 'Pkg_Qty_per_Box', '')::numeric, 0) <= 0
        or coalesce(nullif(payload ->> 'Pkg_Boxes_per_Pallet', '')::numeric, 0) <= 0
      )
  ) then
    raise exception 'Packaging quantities must be positive for every VMI material';
  end if;

  insert into ops.source_attestations (
    source_checksum,
    original_data_class,
    asserted_data_class,
    attestation_text,
    attested_by,
    change_ticket
  )
  values (
    p_source_checksum,
    'reference_fixture',
    'actual',
    left(p_attestation_text, 1000),
    left(p_attested_by, 200),
    left(p_change_ticket, 200)
  )
  on conflict (source_checksum, asserted_data_class) do update
  set attestation_text = excluded.attestation_text,
      attested_by = excluded.attested_by,
      change_ticket = excluded.change_ticket,
      attested_at = now()
  returning attestation_id into v_attestation_id;

  insert into ops.source_promotions (
    attestation_id,
    source_checksum,
    status
  )
  values (v_attestation_id, p_source_checksum, 'running')
  returning promotion_id into v_promotion_id;

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
    'owner_attested_excel',
    a.source_path,
    a.source_sheet,
    a.source_checksum,
    a.source_file_size_bytes,
    a.expected_rows,
    'succeeded',
    now(),
    'governed-reference-promotion',
    case a.source_sheet
      when 'DB_Material' then 'materials'
      when 'DB_Contract_Static' then 'packaging'
      when 'DB_Stock' then 'stock'
      when 'DB_SAP_Monthly' then 'usage'
    end,
    now(),
    now(),
    jsonb_build_object(
      'data_class', 'actual',
      'original_data_class', a.data_class,
      'attestation_id', v_attestation_id,
      'promotion_id', v_promotion_id,
      'change_ticket', left(p_change_ticket, 200)
    )
  from reference_data.source_artifacts a
  where a.artifact_id in (
    v_material_artifact,
    v_packaging_artifact,
    v_stock_artifact,
    v_usage_artifact
  )
  on conflict (source_checksum, source_sheet) do update
  set source_system = excluded.source_system,
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

  select batch_id into strict v_material_batch
  from raw.import_batches
  where source_checksum = p_source_checksum and source_sheet = 'DB_Material';
  select batch_id into strict v_packaging_batch
  from raw.import_batches
  where source_checksum = p_source_checksum and source_sheet = 'DB_Contract_Static';
  select batch_id into strict v_stock_batch
  from raw.import_batches
  where source_checksum = p_source_checksum and source_sheet = 'DB_Stock';
  select batch_id into strict v_usage_batch
  from raw.import_batches
  where source_checksum = p_source_checksum and source_sheet = 'DB_SAP_Monthly';

  insert into raw.source_rows (
    batch_id,
    source_entity,
    source_sheet,
    source_row_number,
    row_hash,
    payload
  )
  select
    case a.source_sheet
      when 'DB_Material' then v_material_batch
      when 'DB_Contract_Static' then v_packaging_batch
      when 'DB_Stock' then v_stock_batch
      when 'DB_SAP_Monthly' then v_usage_batch
    end,
    case a.source_sheet
      when 'DB_Material' then 'materials'
      when 'DB_Contract_Static' then 'packaging'
      when 'DB_Stock' then 'stock'
      when 'DB_SAP_Monthly' then 'usage'
    end,
    a.source_sheet,
    r.source_row_number,
    r.row_hash,
    r.payload
  from reference_data.source_rows r
  join reference_data.source_artifacts a using (artifact_id)
  where r.artifact_id in (
    v_material_artifact,
    v_packaging_artifact,
    v_stock_artifact,
    v_usage_artifact
  )
  on conflict (batch_id, source_entity, source_row_number) do update
  set row_hash = excluded.row_hash,
      payload = excluded.payload,
      ingested_at = now();

  update core.materials m
  set is_vmi = false,
      updated_at = now()
  where m.is_vmi
    and not exists (
      select 1
      from reference_data.source_rows r
      where r.artifact_id = v_material_artifact
        and r.material_id = m.material_id
    );

  insert into core.materials (
    material_id,
    sap_material_id,
    material_name,
    category,
    unit,
    weight_per_unit_kg,
    lot_size,
    moq,
    is_vmi,
    master_source,
    data_quality_status,
    source_batch_id
  )
  select
    r.material_id,
    nullif(r.payload ->> 'SAP_Material_ID', ''),
    nullif(r.payload ->> 'Material_Name', ''),
    nullif(r.payload ->> 'Category', ''),
    nullif(r.payload ->> 'Unit', ''),
    (r.payload ->> 'Weight_per_Unit_kg')::numeric,
    (r.payload ->> 'Lot_Size')::numeric,
    (r.payload ->> 'MOQ')::numeric,
    true,
    'material_master',
    'valid',
    v_material_batch
  from reference_data.source_rows r
  where r.artifact_id = v_material_artifact
  on conflict (material_id) do update
  set sap_material_id = excluded.sap_material_id,
      material_name = excluded.material_name,
      category = excluded.category,
      unit = excluded.unit,
      weight_per_unit_kg = excluded.weight_per_unit_kg,
      lot_size = excluded.lot_size,
      moq = excluded.moq,
      is_vmi = true,
      master_source = 'material_master',
      data_quality_status = 'valid',
      source_batch_id = excluded.source_batch_id,
      updated_at = now();

  insert into core.packaging_profiles (
    material_id,
    full_pallet_qty,
    inner_pack_qty,
    base_uom,
    allows_partial_issue,
    source_reference,
    verified_at,
    data_class,
    source_batch_id,
    source_quality
  )
  select
    p.material_id,
    (p.payload ->> 'Pkg_Qty_per_Box')::numeric
      * (p.payload ->> 'Pkg_Boxes_per_Pallet')::numeric,
    (p.payload ->> 'Pkg_Qty_per_Box')::numeric,
    m.payload ->> 'Unit',
    true,
    'MEA_VMI_Dummy_Klongtoey.xlsx#DB_Contract_Static@'
      || left(p_source_checksum, 12),
    now(),
    'actual',
    v_packaging_batch,
    'verified'
  from reference_data.source_rows p
  join reference_data.source_rows m
    on m.artifact_id = v_material_artifact
   and m.material_id = p.material_id
  where p.artifact_id = v_packaging_artifact
  on conflict (material_id) do update
  set full_pallet_qty = excluded.full_pallet_qty,
      inner_pack_qty = excluded.inner_pack_qty,
      base_uom = excluded.base_uom,
      allows_partial_issue = excluded.allows_partial_issue,
      source_reference = excluded.source_reference,
      verified_at = excluded.verified_at,
      data_class = 'actual',
      source_batch_id = excluded.source_batch_id,
      source_quality = 'verified',
      updated_at = now();

  insert into core.stock_snapshots (
    material_id,
    location_id,
    quantity_on_hand,
    snapshot_at,
    source_batch_id,
    data_class
  )
  select
    r.material_id,
    case r.payload ->> 'Location_Type'
      when 'WAREHOUSE' then 'WH-KT'
      when 'DISTRICT' then 'DIST-' || (r.payload ->> 'Location_ID')
    end,
    greatest(0, (r.payload ->> 'Current_Stock_Qty')::numeric),
    (r.payload ->> 'SAP_Updated_Date')::timestamptz,
    v_stock_batch,
    'actual'
  from reference_data.source_rows r
  where r.artifact_id = v_stock_artifact
  on conflict (material_id, location_id, snapshot_at) do update
  set quantity_on_hand = excluded.quantity_on_hand,
      source_batch_id = excluded.source_batch_id,
      data_class = 'actual';

  insert into ops.data_quality_rules (
    rule_code,
    severity,
    source_entity,
    field_name,
    description,
    is_active
  )
  values (
    'ACTUAL_USAGE_NEGATIVE_NORMALIZED',
    'warning',
    'usage',
    'Avg_Monthly',
    'Negative aggregate usage was normalized to zero because all source monthly values were zero.',
    true
  )
  on conflict (rule_code) do update
  set severity = excluded.severity,
      description = excluded.description,
      is_active = true,
      updated_at = now();

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
    v_usage_batch,
    raw_row.source_row_id,
    'usage',
    ref_row.source_row_number,
    'ACTUAL_USAGE_NEGATIVE_NORMALIZED',
    'Avg_Monthly',
    ref_row.payload ->> 'Avg_Monthly',
    'Normalized to 0; Jan-Dec source values are all 0.'
  from reference_data.source_rows ref_row
  join raw.source_rows raw_row
    on raw_row.batch_id = v_usage_batch
   and raw_row.source_entity = 'usage'
   and raw_row.source_row_number = ref_row.source_row_number
  where ref_row.artifact_id = v_usage_artifact
    and (ref_row.payload ->> 'Avg_Monthly')::numeric < 0
    and not exists (
      select 1
      from jsonb_each_text(ref_row.payload - array[
        'SAP_ID', 'Material_ID', 'District_ID', 'Year',
        'Avg_4M', 'Avg_6M', 'Avg_12M', 'Avg_LY',
        'Avg_Monthly', 'Last_Import_Date'
      ]) month_value
      where coalesce(nullif(month_value.value, '')::numeric, 0) <> 0
    )
  on conflict (batch_id, source_row_id, rule_code, field_name) do update
  set raw_value = excluded.raw_value,
      issue_message = excluded.issue_message;

  get diagnostics v_dq_count = row_count;

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
    data_class
  )
  select
    r.material_id,
    r.district_id,
    (r.payload ->> 'Last_Import_Date')::timestamptz::date,
    greatest(0, (r.payload ->> 'Avg_Monthly')::numeric),
    greatest(0, (r.payload ->> 'Avg_LY')::numeric),
    greatest(0, (r.payload ->> 'Avg_12M')::numeric),
    greatest(0, (r.payload ->> 'Avg_6M')::numeric),
    greatest(0, (r.payload ->> 'Avg_4M')::numeric),
    v_usage_batch,
    'actual'
  from reference_data.source_rows r
  where r.artifact_id = v_usage_artifact
  on conflict (material_id, district_id, as_of_date) do update
  set cmp_monthly = excluded.cmp_monthly,
      avg_ly = excluded.avg_ly,
      avg_12m = excluded.avg_12m,
      avg_6m = excluded.avg_6m,
      avg_4m = excluded.avg_4m,
      source_batch_id = excluded.source_batch_id,
      data_class = 'actual',
      updated_at = now();

  update reference_data.source_artifacts
  set data_class = 'actual',
      metadata = metadata || jsonb_build_object(
        'original_data_class', 'reference_fixture',
        'owner_attested_actual', true,
        'attestation_id', v_attestation_id,
        'promotion_id', v_promotion_id,
        'change_ticket', left(p_change_ticket, 200),
        'attested_at', now()
      ),
      updated_at = now()
  where source_checksum = p_source_checksum;

  update ops.source_promotions
  set status = 'succeeded',
      materials_promoted = v_material_count,
      packaging_promoted = v_packaging_count,
      stock_promoted = v_stock_count,
      usage_promoted = v_usage_count,
      dq_remediations = v_dq_count,
      validation_details = jsonb_build_object(
        'expected_vmi_materials', 225,
        'expected_active_districts', 18,
        'expected_district_material_pairs', 4050,
        'warehouse_stock_rows', 225,
        'district_stock_rows', 4050,
        'usage_rows', 4050,
        'negative_usage_rows_normalized', v_dq_count
      ),
      finished_at = now()
  where promotion_id = v_promotion_id;

  return jsonb_build_object(
    'promotion_id', v_promotion_id,
    'attestation_id', v_attestation_id,
    'source_checksum', p_source_checksum,
    'data_class', 'actual',
    'materials_promoted', v_material_count,
    'packaging_promoted', v_packaging_count,
    'stock_promoted', v_stock_count,
    'usage_promoted', v_usage_count,
    'dq_remediations', v_dq_count,
    'status', 'succeeded'
  );
end;
$$;

alter table ops.source_attestations enable row level security;
alter table ops.source_promotions enable row level security;

revoke all on ops.source_attestations, ops.source_promotions
  from public, anon, authenticated;
grant all on ops.source_attestations, ops.source_promotions to service_role;

revoke all on function ops.promote_owner_attested_workbook(text, text, text, text)
  from public, anon, authenticated;
grant execute on function ops.promote_owner_attested_workbook(text, text, text, text)
  to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607240020',
  'M20',
  'Owner-attested Actual workbook promotion with lineage, validation and DQ remediation.',
  'supabase/migrations/202607240020_owner_attested_actual_promotion.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
