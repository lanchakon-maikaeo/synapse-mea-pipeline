-- SYNAPSE M14: incremental Production import from the project-shared
-- MEA_VMI_Database_Template Google Sheet.
--
-- The existing four-workbook import remains the authoritative complete
-- Production snapshot. This migration adds a separate, checksum-bound path for
-- newer monthly CMP rows and their matching physical packaging rows. It never
-- deactivates materials, never fills omitted rows with zero, and only exposes
-- rows with immutable source-artifact, source-row and administrator evidence.

begin;

create table if not exists ops.project_sheet_imports (
  project_sheet_import_id uuid primary key default gen_random_uuid(),
  source_path text not null check (btrim(source_path) <> ''),
  source_spreadsheet_id text not null check (btrim(source_spreadsheet_id) <> ''),
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  source_downloaded_at timestamptz not null,
  material_artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  packaging_artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  contract_artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  usage_artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  status text not null check (status in ('running', 'succeeded')),
  verified_by uuid not null references auth.users (id) on delete restrict,
  attestation_text text not null check (btrim(attestation_text) <> ''),
  change_ticket text not null check (btrim(change_ticket) <> ''),
  promoted_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(promoted_counts) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_spreadsheet_id, source_checksum)
);

create index if not exists project_sheet_imports_status_idx
  on ops.project_sheet_imports (status, finished_at desc nulls last);

alter table reference_data.usage_observation_evidence
  add column if not exists project_sheet_import_id uuid
    references ops.project_sheet_imports (project_sheet_import_id)
    on delete restrict;

alter table reference_data.usage_observation_evidence
  alter column actual_workbook_import_id drop not null;

alter table reference_data.usage_observation_evidence
  drop constraint if exists usage_observation_import_exclusive_check;
alter table reference_data.usage_observation_evidence
  add constraint usage_observation_import_exclusive_check
  check (
    num_nonnulls(actual_workbook_import_id, project_sheet_import_id) = 1
  );

alter table reference_data.usage_observation_evidence
  drop constraint if exists usage_observation_evidence_verification_status_check;
alter table reference_data.usage_observation_evidence
  add constraint usage_observation_evidence_verification_status_check
  check (verification_status in (
    'source_observed',
    'owner_attested_zero',
    'project_sheet_reported_cmp'
  ));

alter table reference_data.usage_observation_evidence
  drop constraint if exists usage_observation_evidence_evidence_basis_check;
alter table reference_data.usage_observation_evidence
  add constraint usage_observation_evidence_evidence_basis_check
  check (evidence_basis in (
    'source_row_observed',
    'owner_attestation',
    'project_shared_sheet'
  ));

create index if not exists usage_observation_project_sheet_idx
  on reference_data.usage_observation_evidence (
    project_sheet_import_id, usage_rate_id
  )
  where project_sheet_import_id is not null;

alter table core.material_packaging
  add column if not exists source_checksum_sha256 text,
  add column if not exists source_row_number integer,
  add column if not exists verified_by uuid
    references auth.users (id) on delete restrict,
  add column if not exists verification_ticket text;

alter table core.material_packaging
  drop constraint if exists material_packaging_source_checksum_check;
alter table core.material_packaging
  add constraint material_packaging_source_checksum_check
  check (
    source_checksum_sha256 is null
    or source_checksum_sha256 ~ '^[0-9a-f]{64}$'
  );
alter table core.material_packaging
  drop constraint if exists material_packaging_source_row_check;
alter table core.material_packaging
  add constraint material_packaging_source_row_check
  check (source_row_number is null or source_row_number > 0);

alter table core.packaging_profiles
  add column if not exists source_checksum_sha256 text,
  add column if not exists source_row_number integer,
  add column if not exists verified_by uuid
    references auth.users (id) on delete restrict,
  add column if not exists verification_ticket text;

alter table core.packaging_profiles
  drop constraint if exists packaging_profiles_source_checksum_check;
alter table core.packaging_profiles
  add constraint packaging_profiles_source_checksum_check
  check (
    source_checksum_sha256 is null
    or source_checksum_sha256 ~ '^[0-9a-f]{64}$'
  );
alter table core.packaging_profiles
  drop constraint if exists packaging_profiles_source_row_check;
alter table core.packaging_profiles
  add constraint packaging_profiles_source_row_check
  check (source_row_number is null or source_row_number > 0);

create table if not exists reference_data.material_packaging_evidence (
  material_packaging_evidence_id bigint generated always as identity primary key,
  project_sheet_import_id uuid not null
    references ops.project_sheet_imports (project_sheet_import_id)
    on delete restrict,
  material_id text not null
    references core.materials (material_id) on delete restrict,
  source_artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  source_row_id bigint not null
    references reference_data.source_rows (source_row_id) on delete restrict,
  raw_source_row_id bigint not null
    references raw.source_rows (source_row_id) on delete restrict,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  source_row_number integer not null check (source_row_number > 0),
  quantity_uom text not null check (btrim(quantity_uom) <> ''),
  quantity_per_box numeric not null check (quantity_per_box > 0),
  box_volume_m3 numeric not null check (box_volume_m3 > 0),
  weight_per_box_kg numeric not null check (weight_per_box_kg > 0),
  boxes_per_pallet numeric not null check (boxes_per_pallet > 0),
  pallet_volume_m3 numeric not null check (pallet_volume_m3 > 0),
  pallet_weight_kg numeric not null check (pallet_weight_kg > 0),
  verified_by uuid not null references auth.users (id) on delete restrict,
  change_ticket text not null check (btrim(change_ticket) <> ''),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (project_sheet_import_id, material_id),
  unique (project_sheet_import_id, source_row_id)
);

create index if not exists material_packaging_evidence_material_idx
  on reference_data.material_packaging_evidence (material_id, verified_at desc);

alter table ops.project_sheet_imports enable row level security;
alter table reference_data.material_packaging_evidence enable row level security;

revoke all on ops.project_sheet_imports,
  reference_data.material_packaging_evidence
  from public, anon, authenticated;
grant all on ops.project_sheet_imports,
  reference_data.material_packaging_evidence
  to service_role;

create or replace function public.m14_promote_project_sheet_incremental(
  p_source_path text,
  p_source_checksum text,
  p_source_spreadsheet_id text,
  p_source_downloaded_at timestamptz,
  p_verified_by uuid,
  p_attestation_text text,
  p_change_ticket text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_import_id uuid;
  v_existing ops.project_sheet_imports%rowtype;
  v_material_artifact uuid;
  v_packaging_artifact uuid;
  v_contract_artifact uuid;
  v_usage_artifact uuid;
  v_material_batch uuid;
  v_packaging_batch uuid;
  v_contract_batch uuid;
  v_usage_batch uuid;
  v_packaging_count integer;
  v_usage_count integer;
  v_usage_material_count integer;
  v_source_url text;
  v_counts jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M14 project-sheet promotion requires service_role';
  end if;
  if btrim(coalesce(p_source_path, '')) = ''
     or btrim(coalesce(p_source_spreadsheet_id, '')) = '' then
    raise exception 'Source path and spreadsheet id are required';
  end if;
  if coalesce(p_source_checksum, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid source checksum';
  end if;
  if p_source_downloaded_at is null
     or p_source_downloaded_at > statement_timestamp() + interval '5 minutes'
     or p_source_downloaded_at < statement_timestamp() - interval '7 days' then
    raise exception 'Source download timestamp must be current';
  end if;
  if p_verified_by is null
     or not exists (
       select 1
       from public.user_profiles profile
       where profile.user_id = p_verified_by
         and profile.is_active
         and profile.role::text = 'admin'
     ) then
    raise exception 'An active Production admin verifier is required';
  end if;
  if btrim(coalesce(p_attestation_text, '')) = ''
     or btrim(coalesce(p_change_ticket, '')) = '' then
    raise exception 'Attestation text and change ticket are required';
  end if;

  select import.*
  into v_existing
  from ops.project_sheet_imports import
  where import.source_spreadsheet_id = p_source_spreadsheet_id
    and import.source_checksum = p_source_checksum
    and import.status = 'succeeded';

  if found then
    return jsonb_build_object(
      'project_sheet_import_id', v_existing.project_sheet_import_id,
      'source_checksum', v_existing.source_checksum,
      'status', v_existing.status,
      'promoted_counts', v_existing.promoted_counts,
      'reused_existing_import', true
    );
  end if;

  select
    (array_agg(artifact_id) filter (
      where source_sheet = 'DB_Material'
    ))[1],
    (array_agg(artifact_id) filter (
      where source_sheet = 'DB_Contract_Static'
    ))[1],
    (array_agg(artifact_id) filter (
      where source_sheet = 'DB_Contract_SAP'
    ))[1],
    (array_agg(artifact_id) filter (
      where source_sheet = 'DB_SAP_Monthly'
    ))[1]
  into
    v_material_artifact,
    v_packaging_artifact,
    v_contract_artifact,
    v_usage_artifact
  from reference_data.source_artifacts
  where source_path = p_source_path
    and source_checksum = p_source_checksum
    and data_class = 'actual'
    and metadata ->> 'source_spreadsheet_id' = p_source_spreadsheet_id;

  if v_material_artifact is null
     or v_packaging_artifact is null
     or v_contract_artifact is null
     or v_usage_artifact is null then
    raise exception 'All four project-sheet artifacts must be loaded first';
  end if;

  if exists (
    select 1
    from reference_data.source_artifacts artifact
    where artifact.artifact_id in (
      v_material_artifact,
      v_packaging_artifact,
      v_contract_artifact,
      v_usage_artifact
    )
      and artifact.expected_rows <> (
        select count(*)
        from reference_data.source_rows source_row
        where source_row.artifact_id = artifact.artifact_id
      )
  ) then
    raise exception 'One or more project-sheet artifacts are incomplete';
  end if;

  if exists (
    select 1
    from reference_data.source_rows source_row
    where source_row.artifact_id in (
      v_material_artifact,
      v_packaging_artifact,
      v_contract_artifact,
      v_usage_artifact
    )
      and source_row.material_id is not null
      and source_row.material_id !~ '^[0-9]{12}$'
  ) then
    raise exception 'Project sheet contains a non-canonical material id';
  end if;

  insert into ops.project_sheet_imports (
    source_path,
    source_spreadsheet_id,
    source_checksum,
    source_downloaded_at,
    material_artifact_id,
    packaging_artifact_id,
    contract_artifact_id,
    usage_artifact_id,
    status,
    verified_by,
    attestation_text,
    change_ticket
  )
  values (
    p_source_path,
    p_source_spreadsheet_id,
    p_source_checksum,
    p_source_downloaded_at,
    v_material_artifact,
    v_packaging_artifact,
    v_contract_artifact,
    v_usage_artifact,
    'running',
    p_verified_by,
    left(p_attestation_text, 2000),
    left(p_change_ticket, 200)
  )
  returning project_sheet_import_id into v_import_id;

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
    'project_shared_google_sheet',
    artifact.source_path,
    artifact.source_sheet,
    artifact.source_checksum,
    artifact.source_file_size_bytes,
    artifact.expected_rows,
    'succeeded',
    now(),
    'governed-project-sheet-incremental',
    case artifact.source_sheet
      when 'DB_Material' then 'materials'
      when 'DB_Contract_Static' then 'packaging'
      when 'DB_Contract_SAP' then 'contracts'
      when 'DB_SAP_Monthly' then 'usage'
    end,
    now(),
    now(),
    jsonb_build_object(
      'data_class', 'actual',
      'project_sheet_incremental', true,
      'project_sheet_import_id', v_import_id,
      'source_spreadsheet_id', p_source_spreadsheet_id,
      'source_downloaded_at', p_source_downloaded_at,
      'verified_by', p_verified_by,
      'change_ticket', left(p_change_ticket, 200)
    )
  from reference_data.source_artifacts artifact
  where artifact.artifact_id in (
    v_material_artifact,
    v_packaging_artifact,
    v_contract_artifact,
    v_usage_artifact
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

  select batch_id into strict v_material_batch
  from raw.import_batches
  where source_checksum = p_source_checksum
    and source_sheet = 'DB_Material';
  select batch_id into strict v_packaging_batch
  from raw.import_batches
  where source_checksum = p_source_checksum
    and source_sheet = 'DB_Contract_Static';
  select batch_id into strict v_contract_batch
  from raw.import_batches
  where source_checksum = p_source_checksum
    and source_sheet = 'DB_Contract_SAP';
  select batch_id into strict v_usage_batch
  from raw.import_batches
  where source_checksum = p_source_checksum
    and source_sheet = 'DB_SAP_Monthly';

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
      when 'DB_Material' then v_material_batch
      when 'DB_Contract_Static' then v_packaging_batch
      when 'DB_Contract_SAP' then v_contract_batch
      when 'DB_SAP_Monthly' then v_usage_batch
    end,
    case artifact.source_sheet
      when 'DB_Material' then 'materials'
      when 'DB_Contract_Static' then 'packaging'
      when 'DB_Contract_SAP' then 'contracts'
      when 'DB_SAP_Monthly' then 'usage'
    end,
    artifact.source_sheet,
    source_row.source_row_number,
    source_row.row_hash,
    source_row.payload
  from reference_data.source_rows source_row
  join reference_data.source_artifacts artifact using (artifact_id)
  where source_row.artifact_id in (
    v_material_artifact,
    v_packaging_artifact,
    v_contract_artifact,
    v_usage_artifact
  )
  on conflict (batch_id, source_entity, source_row_number) do update
  set row_hash = excluded.row_hash,
      payload = excluded.payload,
      ingested_at = now();

  v_source_url := 'https://docs.google.com/spreadsheets/d/'
    || p_source_spreadsheet_id || '/edit';

  drop table if exists pg_temp.m14_packaging_candidates;
  create temporary table m14_packaging_candidates
  on commit drop
  as
  with ranked as (
    select
      packaging.source_row_id,
      raw_row.source_row_id as raw_source_row_id,
      packaging.source_row_number,
      packaging.material_id,
      material.unit as quantity_uom,
      (packaging.payload ->> 'Pkg_Qty_per_Box')::numeric
        as quantity_per_box,
      (packaging.payload ->> 'Pkg_Box_Width_m')::numeric
        * (packaging.payload ->> 'Pkg_Box_Length_m')::numeric
        * (packaging.payload ->> 'Pkg_Box_Height_m')::numeric
        as box_volume_m3,
      (packaging.payload ->> 'Pkg_Weight_per_Box_kg')::numeric
        as weight_per_box_kg,
      (packaging.payload ->> 'Pkg_Boxes_per_Pallet')::numeric
        as boxes_per_pallet,
      (packaging.payload ->> 'Pkg_Pallet_Width_m')::numeric
        * (packaging.payload ->> 'Pkg_Pallet_Length_m')::numeric
        * (packaging.payload ->> 'Pkg_Pallet_Height_m')::numeric
        as pallet_volume_m3,
      (packaging.payload ->> 'Pkg_Pallet_Weight_kg')::numeric
        as pallet_weight_kg,
      row_number() over (
        partition by packaging.material_id
        order by
          coalesce(
            (
              select max(nullif(contract.payload ->> 'SAP_Updated_Date', '')::timestamptz)
              from reference_data.source_rows contract
              where contract.artifact_id = v_contract_artifact
                and contract.material_id = packaging.material_id
                and contract.contract_ref = packaging.contract_ref
            ),
            '-infinity'::timestamptz
          ) desc,
          packaging.source_row_number desc
      ) as preference_rank
    from reference_data.source_rows packaging
    join core.materials material
      on material.material_id = packaging.material_id
     and material.is_vmi
    join reference_data.source_rows material_source
      on material_source.artifact_id = v_material_artifact
     and material_source.material_id = packaging.material_id
    join raw.source_rows raw_row
      on raw_row.batch_id = v_packaging_batch
     and raw_row.source_entity = 'packaging'
     and raw_row.source_row_number = packaging.source_row_number
    where packaging.artifact_id = v_packaging_artifact
      and btrim(coalesce(material.unit, '')) <> ''
      and coalesce(nullif(packaging.payload ->> 'Pkg_Qty_per_Box', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Box_Width_m', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Box_Length_m', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Box_Height_m', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Weight_per_Box_kg', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Boxes_per_Pallet', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Pallet_Width_m', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Pallet_Length_m', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Pallet_Height_m', '')::numeric, 0) > 0
      and coalesce(nullif(packaging.payload ->> 'Pkg_Pallet_Weight_kg', '')::numeric, 0) > 0
      and exists (
        select 1
        from reference_data.source_rows usage
        join core.districts district
          on district.district_id = usage.district_id
         and district.is_active
        where usage.artifact_id = v_usage_artifact
          and usage.material_id = packaging.material_id
      )
  )
  select *
  from ranked
  where preference_rank = 1;

  alter table pg_temp.m14_packaging_candidates
    add primary key (material_id);

  select count(*)::integer into v_packaging_count
  from pg_temp.m14_packaging_candidates;
  if v_packaging_count = 0 then
    raise exception 'No active VMI packaging rows overlap current usage';
  end if;

  if exists (
    select 1
    from core.materials material
    join pg_temp.m14_packaging_candidates packaging using (material_id)
    where material.weight_per_unit_kg is not null
      and material.weight_per_unit_kg > 0
      and abs(
        material.weight_per_unit_kg
        - packaging.weight_per_box_kg / packaging.quantity_per_box
      ) > greatest(
        0.000000001,
        0.000001 * abs(material.weight_per_unit_kg)
      )
  ) then
    raise exception 'Project-sheet packaging conflicts with an existing material weight';
  end if;

  drop table if exists pg_temp.m14_usage_candidates;
  create temporary table m14_usage_candidates
  on commit drop
  as
  select
    usage.source_row_id,
    raw_row.source_row_id as raw_source_row_id,
    usage.source_row_number,
    usage.material_id,
    usage.district_id,
    (usage.payload ->> 'Last_Import_Date')::timestamptz::date as as_of_date,
    greatest(0, (usage.payload ->> 'Avg_Monthly')::numeric) as cmp_monthly,
    greatest(0, coalesce(
      nullif(usage.payload ->> 'Avg_LY', '')::numeric,
      (usage.payload ->> 'Avg_Monthly')::numeric
    )) as avg_ly,
    greatest(0, coalesce(
      nullif(usage.payload ->> 'Avg_12M', '')::numeric,
      (usage.payload ->> 'Avg_Monthly')::numeric
    )) as avg_12m,
    greatest(0, coalesce(
      nullif(usage.payload ->> 'Avg_6M', '')::numeric,
      (usage.payload ->> 'Avg_Monthly')::numeric
    )) as avg_6m,
    greatest(0, coalesce(
      nullif(usage.payload ->> 'Avg_4M', '')::numeric,
      (usage.payload ->> 'Avg_Monthly')::numeric
    )) as avg_4m
  from reference_data.source_rows usage
  join core.materials material
    on material.material_id = usage.material_id
   and material.is_vmi
  join core.districts district
    on district.district_id = usage.district_id
   and district.is_active
  join pg_temp.m14_packaging_candidates packaging
    on packaging.material_id = usage.material_id
  join raw.source_rows raw_row
    on raw_row.batch_id = v_usage_batch
   and raw_row.source_entity = 'usage'
   and raw_row.source_row_number = usage.source_row_number
  where usage.artifact_id = v_usage_artifact
    and coalesce(nullif(usage.payload ->> 'Avg_Monthly', '')::numeric, -1) >= 0
    and (usage.payload ->> 'Last_Import_Date')::timestamptz::date
      between (statement_timestamp() at time zone 'Asia/Bangkok')::date - 62
      and (statement_timestamp() at time zone 'Asia/Bangkok')::date;

  if (
    select count(*)
    from pg_temp.m14_usage_candidates
  ) <> (
    select count(distinct material_id || '|' || district_id || '|' || as_of_date::text)
    from pg_temp.m14_usage_candidates
  ) then
    raise exception 'Project-sheet usage keys must be unique';
  end if;

  alter table pg_temp.m14_usage_candidates
    add primary key (material_id, district_id, as_of_date);

  select count(*)::integer, count(distinct material_id)::integer
  into v_usage_count, v_usage_material_count
  from pg_temp.m14_usage_candidates;
  if v_usage_count = 0 then
    raise exception 'No fresh active VMI usage rows overlap packaging';
  end if;

  update core.materials material
  set weight_per_unit_kg = packaging.weight_per_box_kg
        / packaging.quantity_per_box,
      data_quality_status = case
        when material.data_quality_status = 'invalid' then 'warning'
        else material.data_quality_status
      end,
      updated_at = now()
  from pg_temp.m14_packaging_candidates packaging
  where material.material_id = packaging.material_id
    and (
      material.weight_per_unit_kg is null
      or material.weight_per_unit_kg <= 0
    );

  insert into core.material_packaging (
    material_id,
    quantity_uom,
    quantity_per_box,
    box_volume_m3,
    weight_per_box_kg,
    boxes_per_pallet,
    pallet_volume_m3,
    pallet_weight_kg,
    source_reference,
    verified_at,
    source_checksum_sha256,
    source_row_number,
    verified_by,
    verification_ticket
  )
  select
    packaging.material_id,
    packaging.quantity_uom,
    packaging.quantity_per_box,
    packaging.box_volume_m3,
    packaging.weight_per_box_kg,
    packaging.boxes_per_pallet,
    packaging.pallet_volume_m3,
    packaging.pallet_weight_kg,
    v_source_url || '#gid=403278381&range=A'
      || packaging.source_row_number::text || ':M'
      || packaging.source_row_number::text,
    now(),
    p_source_checksum,
    packaging.source_row_number,
    p_verified_by,
    left(p_change_ticket, 200)
  from pg_temp.m14_packaging_candidates packaging
  on conflict (material_id) do update
  set quantity_uom = excluded.quantity_uom,
      quantity_per_box = excluded.quantity_per_box,
      box_volume_m3 = excluded.box_volume_m3,
      weight_per_box_kg = excluded.weight_per_box_kg,
      boxes_per_pallet = excluded.boxes_per_pallet,
      pallet_volume_m3 = excluded.pallet_volume_m3,
      pallet_weight_kg = excluded.pallet_weight_kg,
      source_reference = excluded.source_reference,
      verified_at = excluded.verified_at,
      source_checksum_sha256 = excluded.source_checksum_sha256,
      source_row_number = excluded.source_row_number,
      verified_by = excluded.verified_by,
      verification_ticket = excluded.verification_ticket,
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
    source_quality,
    source_checksum_sha256,
    source_row_number,
    verified_by,
    verification_ticket
  )
  select
    packaging.material_id,
    packaging.quantity_per_box * packaging.boxes_per_pallet,
    packaging.quantity_per_box,
    packaging.quantity_uom,
    true,
    v_source_url || '#gid=403278381&range=A'
      || packaging.source_row_number::text || ':M'
      || packaging.source_row_number::text,
    now(),
    'actual',
    v_packaging_batch,
    'verified',
    p_source_checksum,
    packaging.source_row_number,
    p_verified_by,
    left(p_change_ticket, 200)
  from pg_temp.m14_packaging_candidates packaging
  on conflict (material_id) do update
  set full_pallet_qty = excluded.full_pallet_qty,
      inner_pack_qty = excluded.inner_pack_qty,
      base_uom = excluded.base_uom,
      allows_partial_issue = excluded.allows_partial_issue,
      source_reference = excluded.source_reference,
      verified_at = excluded.verified_at,
      data_class = excluded.data_class,
      source_batch_id = excluded.source_batch_id,
      source_quality = excluded.source_quality,
      source_checksum_sha256 = excluded.source_checksum_sha256,
      source_row_number = excluded.source_row_number,
      verified_by = excluded.verified_by,
      verification_ticket = excluded.verification_ticket,
      updated_at = now();

  insert into reference_data.material_packaging_evidence (
    project_sheet_import_id,
    material_id,
    source_artifact_id,
    source_row_id,
    raw_source_row_id,
    source_checksum,
    source_row_number,
    quantity_uom,
    quantity_per_box,
    box_volume_m3,
    weight_per_box_kg,
    boxes_per_pallet,
    pallet_volume_m3,
    pallet_weight_kg,
    verified_by,
    change_ticket
  )
  select
    v_import_id,
    packaging.material_id,
    v_packaging_artifact,
    packaging.source_row_id,
    packaging.raw_source_row_id,
    p_source_checksum,
    packaging.source_row_number,
    packaging.quantity_uom,
    packaging.quantity_per_box,
    packaging.box_volume_m3,
    packaging.weight_per_box_kg,
    packaging.boxes_per_pallet,
    packaging.pallet_volume_m3,
    packaging.pallet_weight_kg,
    p_verified_by,
    left(p_change_ticket, 200)
  from pg_temp.m14_packaging_candidates packaging
  on conflict (project_sheet_import_id, material_id) do nothing;

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
    'source_derived'
  from pg_temp.m14_usage_candidates usage
  on conflict (material_id, district_id, as_of_date) do update
  set cmp_monthly = excluded.cmp_monthly,
      avg_ly = excluded.avg_ly,
      avg_12m = excluded.avg_12m,
      avg_6m = excluded.avg_6m,
      avg_4m = excluded.avg_4m,
      source_batch_id = excluded.source_batch_id,
      data_class = excluded.data_class,
      source_quality = excluded.source_quality,
      updated_at = now();

  insert into reference_data.usage_observation_evidence (
    usage_rate_id,
    source_artifact_id,
    source_row_id,
    raw_source_row_id,
    verification_status,
    normalized_dash_count,
    excluded_negative_month_count,
    source_checksum,
    change_ticket,
    verified_by,
    actual_workbook_import_id,
    project_sheet_import_id,
    evidence_basis
  )
  select
    rate.usage_rate_id,
    v_usage_artifact,
    usage.source_row_id,
    usage.raw_source_row_id,
    'project_sheet_reported_cmp',
    0,
    0,
    p_source_checksum,
    left(p_change_ticket, 200),
    p_verified_by::text,
    null,
    v_import_id,
    'project_shared_sheet'
  from pg_temp.m14_usage_candidates usage
  join core.usage_rates rate
    on rate.material_id = usage.material_id
   and rate.district_id = usage.district_id
   and rate.as_of_date = usage.as_of_date
  on conflict (usage_rate_id, source_row_id) do update
  set verification_status = excluded.verification_status,
      source_checksum = excluded.source_checksum,
      change_ticket = excluded.change_ticket,
      verified_by = excluded.verified_by,
      actual_workbook_import_id = null,
      project_sheet_import_id = excluded.project_sheet_import_id,
      evidence_basis = excluded.evidence_basis,
      verified_at = now();

  v_counts := jsonb_build_object(
    'packaging_materials', v_packaging_count,
    'usage_materials', v_usage_material_count,
    'usage_rows', v_usage_count,
    'source_material_rows', (
      select count(*)
      from reference_data.source_rows
      where artifact_id = v_material_artifact
    ),
    'source_packaging_rows', (
      select count(*)
      from reference_data.source_rows
      where artifact_id = v_packaging_artifact
    ),
    'source_contract_rows', (
      select count(*)
      from reference_data.source_rows
      where artifact_id = v_contract_artifact
    ),
    'source_usage_rows', (
      select count(*)
      from reference_data.source_rows
      where artifact_id = v_usage_artifact
    )
  );

  update ops.project_sheet_imports
  set status = 'succeeded',
      promoted_counts = v_counts,
      finished_at = now()
  where project_sheet_import_id = v_import_id;

  return jsonb_build_object(
    'project_sheet_import_id', v_import_id,
    'source_checksum', p_source_checksum,
    'status', 'succeeded',
    'promoted_counts', v_counts,
    'reused_existing_import', false
  );
end;
$$;

revoke all on function public.m14_promote_project_sheet_incremental(
  text, text, text, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.m14_promote_project_sheet_incremental(
  text, text, text, timestamptz, uuid, text, text
) to service_role;

-- Preserve the full M13e eligibility contract and add immutable packaging
-- provenance. The public function name remains stable for queueing and health
-- checks; the renamed implementation contains the pre-M14 validations.
alter function core.route_plan_has_complete_routing_inputs(uuid)
  rename to route_plan_has_complete_routing_inputs_m13e;

create or replace function core.route_plan_has_complete_routing_inputs(
  p_replenishment_plan_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select
    core.route_plan_has_complete_routing_inputs_m13e(
      p_replenishment_plan_id
    )
    and not exists (
      select 1
      from core.replenishment_items item
      left join core.material_packaging physical
        on physical.material_id = item.material_id
      left join core.packaging_profiles canonical
        on canonical.material_id = item.material_id
      where item.replenishment_plan_id = p_replenishment_plan_id
        and item.status = 'locked'
        and item.final_qty > 0
        and (
          coalesce(physical.source_checksum_sha256, '')
            !~ '^[0-9a-f]{64}$'
          or coalesce(physical.source_row_number, 0) <= 0
          or physical.verified_by is null
          or btrim(coalesce(physical.verification_ticket, '')) = ''
          or coalesce(canonical.source_checksum_sha256, '')
            !~ '^[0-9a-f]{64}$'
          or coalesce(canonical.source_row_number, 0) <= 0
          or canonical.verified_by is null
          or btrim(coalesce(canonical.verification_ticket, '')) = ''
          or physical.source_checksum_sha256 is distinct from
            canonical.source_checksum_sha256
          or physical.source_row_number is distinct from
            canonical.source_row_number
          or physical.verified_by is distinct from canonical.verified_by
          or physical.verification_ticket is distinct from
            canonical.verification_ticket
          or not exists (
            select 1
            from reference_data.material_packaging_evidence evidence
            join ops.project_sheet_imports import
              on import.project_sheet_import_id =
                evidence.project_sheet_import_id
             and import.status = 'succeeded'
            where evidence.material_id = item.material_id
              and evidence.source_checksum =
                physical.source_checksum_sha256
              and evidence.source_row_number =
                physical.source_row_number
              and evidence.verified_by = physical.verified_by
              and evidence.change_ticket =
                physical.verification_ticket
          )
        )
    )
$$;

revoke all on function core.route_plan_has_complete_routing_inputs(uuid)
  from public, anon, authenticated;
grant execute on function core.route_plan_has_complete_routing_inputs(uuid)
  to service_role;

-- Evidence-aware stock health accepts the newest successful incremental
-- project-sheet CMP evidence independently of the latest complete stock import.
create or replace function analytics.stock_health_at(
  p_cutoff_at timestamptz
)
returns table (
  snapshot_id uuid,
  usage_rate_id uuid,
  material_id text,
  district_id text,
  current_stock_qty numeric,
  snapshot_at timestamptz,
  usage_as_of_date date,
  cmp_monthly numeric,
  months_available numeric,
  source_stock_missing boolean
)
language sql
stable
set search_path = ''
as $$
  with params as (
    select coalesce(p_cutoff_at, statement_timestamp()) as cutoff_at
  ), latest_successful_import as (
    select import.actual_workbook_import_id
    from ops.actual_workbook_imports import
    cross join params
    where import.status = 'succeeded'
      and coalesce(import.finished_at, import.started_at) <= params.cutoff_at
    order by
      import.finished_at desc nulls last,
      import.started_at desc,
      import.actual_workbook_import_id desc
    limit 1
  ), latest_successful_project_import as (
    select import.project_sheet_import_id
    from ops.project_sheet_imports import
    cross join params
    where import.status = 'succeeded'
      and coalesce(import.finished_at, import.started_at) <= params.cutoff_at
    order by
      import.finished_at desc nulls last,
      import.started_at desc,
      import.project_sheet_import_id desc
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
    select distinct on (stock.material_id, stock.location_id)
      stock.snapshot_id,
      stock.material_id,
      stock.location_id,
      location.district_id,
      stock.quantity_on_hand,
      stock.snapshot_at,
      stock.data_class
    from core.stock_snapshots stock
    join core.locations location using (location_id)
    cross join params
    where location.location_type = 'DISTRICT'
      and stock.snapshot_at <= params.cutoff_at
      and (
        stock.data_class = 'test_fixture'
        or exists (select 1 from latest_successful_import)
        or (select allowed from legacy_nonproduction_fallback)
      )
    order by
      stock.material_id,
      stock.location_id,
      stock.snapshot_at desc,
      stock.snapshot_id
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
            'source_observed',
            'owner_attested_zero'
          )
          and evidence.actual_workbook_import_id = (
            select actual_workbook_import_id
            from latest_successful_import
          )
      )
  ), district_stock as (
    select
      stock.material_id,
      stock.district_id,
      (
        array_agg(
          stock.snapshot_id
          order by stock.snapshot_at desc, stock.snapshot_id
        )
      )[1] as snapshot_id,
      sum(stock.quantity_on_hand) as quantity_on_hand,
      max(stock.snapshot_at) as snapshot_at
    from latest_location_snapshot stock
    group by stock.material_id, stock.district_id
  ), latest_usage_candidate as (
    select distinct on (usage.material_id, usage.district_id)
      usage.usage_rate_id,
      usage.material_id,
      usage.district_id,
      usage.as_of_date,
      usage.cmp_monthly,
      usage.data_class
    from core.usage_rates usage
    cross join params
    where usage.created_at <= params.cutoff_at
      and usage.as_of_date <= (
        date_trunc(
          'month',
          params.cutoff_at at time zone 'Asia/Bangkok'
        ) + interval '1 month - 1 day'
      )::date
      and (
        usage.data_class = 'test_fixture'
        or exists (select 1 from latest_successful_import)
        or exists (select 1 from latest_successful_project_import)
        or (select allowed from legacy_nonproduction_fallback)
      )
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
          and evidence.verification_status in (
            'source_observed',
            'owner_attested_zero'
          )
          and evidence.actual_workbook_import_id = (
            select actual_workbook_import_id
            from latest_successful_import
          )
      )
      or exists (
        select 1
        from reference_data.usage_observation_evidence evidence
        where evidence.usage_rate_id = candidate.usage_rate_id
          and evidence.verification_status = 'project_sheet_reported_cmp'
          and evidence.project_sheet_import_id = (
            select project_sheet_import_id
            from latest_successful_project_import
          )
      )
  )
  select
    stock.snapshot_id,
    usage.usage_rate_id,
    material.material_id,
    district.district_id,
    coalesce(stock.quantity_on_hand, 0),
    stock.snapshot_at,
    usage.as_of_date,
    usage.cmp_monthly,
    case
      when usage.cmp_monthly > 0 then
        round(coalesce(stock.quantity_on_hand, 0) / usage.cmp_monthly, 1)
    end,
    stock.snapshot_id is null
  from core.materials material
  cross join core.districts district
  left join district_stock stock
    on stock.material_id = material.material_id
   and stock.district_id = district.district_id
  left join latest_usage usage
    on usage.material_id = material.material_id
   and usage.district_id = district.district_id
  where material.is_vmi
    and district.is_active
$$;

revoke all on function analytics.stock_health_at(timestamptz)
  from public, anon, authenticated;
grant execute on function analytics.stock_health_at(timestamptz)
  to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607270001',
  'M14',
  'Checksum-bound incremental project-sheet CMP and packaging import with row-level evidence for Production replenishment and OR-Tools.',
  'supabase/migrations/202607270001_m14_project_sheet_incremental.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
