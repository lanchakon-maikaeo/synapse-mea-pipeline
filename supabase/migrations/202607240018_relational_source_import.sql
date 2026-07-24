-- SYNAPSE M18: governed relational import for Actual contracts, the complete
-- Dummy workbook, and the audited Staging design package.
--
-- Actual rows may promote into core. Reference fixtures and design files are
-- lineage/reference evidence only and are never treated as operational SAP data.

begin;

create schema if not exists reference_data;
comment on schema reference_data is
  'Governed source evidence, typed relation keys and cross-source lineage.';

create table if not exists reference_data.source_artifacts (
  artifact_id uuid primary key default gen_random_uuid(),
  source_path text not null check (btrim(source_path) <> ''),
  source_sheet text not null default '',
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  source_file_size_bytes bigint not null check (source_file_size_bytes >= 0),
  data_class text not null
    check (data_class in ('actual', 'reference_fixture', 'design_reference')),
  expected_rows integer not null default 0 check (expected_rows >= 0),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_path, source_sheet, source_checksum)
);

create table if not exists reference_data.source_rows (
  source_row_id bigint generated always as identity primary key,
  artifact_id uuid not null
    references reference_data.source_artifacts (artifact_id) on delete restrict,
  source_row_number integer not null check (source_row_number > 0),
  natural_key text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  row_hash text not null check (row_hash ~ '^[0-9a-f]{64}$'),
  material_id text,
  district_id text,
  warehouse_id text,
  contract_ref text,
  plan_ref text,
  batch_ref text,
  vehicle_ref text,
  route_ref text,
  trip_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (artifact_id, source_row_number)
);

create table if not exists reference_data.relation_edges (
  relation_edge_id bigint generated always as identity primary key,
  source_row_id bigint not null
    references reference_data.source_rows (source_row_id) on delete cascade,
  target_row_id bigint not null
    references reference_data.source_rows (source_row_id) on delete cascade,
  relation_type text not null check (btrim(relation_type) <> ''),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  check (source_row_id <> target_row_id),
  unique (source_row_id, target_row_id, relation_type)
);

create index if not exists reference_source_rows_material_idx
  on reference_data.source_rows (material_id) where material_id is not null;
create index if not exists reference_source_rows_district_idx
  on reference_data.source_rows (district_id) where district_id is not null;
create index if not exists reference_source_rows_warehouse_idx
  on reference_data.source_rows (warehouse_id) where warehouse_id is not null;
create index if not exists reference_source_rows_contract_idx
  on reference_data.source_rows (contract_ref) where contract_ref is not null;
create index if not exists reference_source_rows_plan_idx
  on reference_data.source_rows (plan_ref) where plan_ref is not null;
create index if not exists reference_source_rows_batch_idx
  on reference_data.source_rows (batch_ref) where batch_ref is not null;
create index if not exists reference_source_rows_vehicle_idx
  on reference_data.source_rows (vehicle_ref) where vehicle_ref is not null;
create index if not exists reference_relation_edges_target_idx
  on reference_data.relation_edges (target_row_id, relation_type);

drop trigger if exists set_reference_artifacts_updated_at
  on reference_data.source_artifacts;
create trigger set_reference_artifacts_updated_at
  before update on reference_data.source_artifacts
  for each row execute function audit.set_updated_at();

drop trigger if exists set_reference_rows_updated_at
  on reference_data.source_rows;
create trigger set_reference_rows_updated_at
  before update on reference_data.source_rows
  for each row execute function audit.set_updated_at();

create or replace function public.m18_import_source_rows(
  p_source_path text,
  p_source_sheet text,
  p_source_checksum text,
  p_source_file_size_bytes bigint,
  p_data_class text,
  p_rows jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, reference_data, extensions
as $$
declare
  v_artifact_id uuid;
  v_row jsonb;
  v_expected_rows integer;
  v_loaded_rows integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M18 source import requires service_role';
  end if;
  if coalesce(p_source_path, '') = '' then
    raise exception 'source_path is required';
  end if;
  if coalesce(p_source_checksum, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid source checksum';
  end if;
  if p_source_file_size_bytes is null or p_source_file_size_bytes < 0 then
    raise exception 'invalid source file size';
  end if;
  if coalesce(p_data_class, '') not in (
    'actual', 'reference_fixture', 'design_reference'
  ) then
    raise exception 'invalid data_class';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 500 then
    raise exception 'rows must be a JSON array containing at most 500 records';
  end if;
  if jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be an object';
  end if;

  v_expected_rows := coalesce(
    nullif(p_metadata ->> 'total_rows', '')::integer,
    jsonb_array_length(p_rows)
  );

  insert into reference_data.source_artifacts (
    source_path,
    source_sheet,
    source_checksum,
    source_file_size_bytes,
    data_class,
    expected_rows,
    metadata
  )
  values (
    p_source_path,
    coalesce(p_source_sheet, ''),
    p_source_checksum,
    p_source_file_size_bytes,
    p_data_class,
    v_expected_rows,
    p_metadata
  )
  on conflict (source_path, source_sheet, source_checksum) do update
  set source_file_size_bytes = excluded.source_file_size_bytes,
      data_class = excluded.data_class,
      expected_rows = excluded.expected_rows,
      metadata = reference_data.source_artifacts.metadata || excluded.metadata,
      updated_at = now()
  returning artifact_id into v_artifact_id;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if coalesce(v_row ->> 'row_number', '') !~ '^[1-9][0-9]*$' then
      raise exception 'each source row requires a positive row_number';
    end if;
    if jsonb_typeof(v_row -> 'payload') <> 'object' then
      raise exception 'each source row requires an object payload';
    end if;

    insert into reference_data.source_rows (
      artifact_id,
      source_row_number,
      natural_key,
      payload,
      row_hash,
      material_id,
      district_id,
      warehouse_id,
      contract_ref,
      plan_ref,
      batch_ref,
      vehicle_ref,
      route_ref,
      trip_ref
    )
    values (
      v_artifact_id,
      (v_row ->> 'row_number')::integer,
      nullif(v_row ->> 'natural_key', ''),
      v_row -> 'payload',
      encode(extensions.digest((v_row -> 'payload')::text, 'sha256'), 'hex'),
      nullif(v_row ->> 'material_id', ''),
      nullif(v_row ->> 'district_id', ''),
      nullif(v_row ->> 'warehouse_id', ''),
      nullif(v_row ->> 'contract_ref', ''),
      nullif(v_row ->> 'plan_ref', ''),
      nullif(v_row ->> 'batch_ref', ''),
      nullif(v_row ->> 'vehicle_ref', ''),
      nullif(v_row ->> 'route_ref', ''),
      nullif(v_row ->> 'trip_ref', '')
    )
    on conflict (artifact_id, source_row_number) do update
    set natural_key = excluded.natural_key,
        payload = excluded.payload,
        row_hash = excluded.row_hash,
        material_id = excluded.material_id,
        district_id = excluded.district_id,
        warehouse_id = excluded.warehouse_id,
        contract_ref = excluded.contract_ref,
        plan_ref = excluded.plan_ref,
        batch_ref = excluded.batch_ref,
        vehicle_ref = excluded.vehicle_ref,
        route_ref = excluded.route_ref,
        trip_ref = excluded.trip_ref,
        updated_at = now();
  end loop;

  select count(*)::integer into v_loaded_rows
  from reference_data.source_rows
  where artifact_id = v_artifact_id;

  return jsonb_build_object(
    'artifact_id', v_artifact_id,
    'source_path', p_source_path,
    'source_sheet', coalesce(p_source_sheet, ''),
    'data_class', p_data_class,
    'expected_rows', v_expected_rows,
    'loaded_rows', v_loaded_rows,
    'complete', v_loaded_rows = v_expected_rows
  );
end;
$$;

create or replace function public.m18_import_contract_chunk(
  p_source_checksum text,
  p_source_file_size_bytes bigint,
  p_rows jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, raw, reference_data, extensions
as $$
declare
  v_batch_id uuid;
  v_row jsonb;
  v_payload jsonb;
  v_row_number integer;
  v_expected_rows integer;
  v_loaded_rows integer;
  v_reference_result jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M18 contract import requires service_role';
  end if;
  if coalesce(p_source_checksum, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid source checksum';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'rows must contain 1-500 records';
  end if;
  if jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be an object';
  end if;

  v_expected_rows := coalesce(
    nullif(p_metadata ->> 'total_rows', '')::integer,
    jsonb_array_length(p_rows)
  );

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
    metadata
  )
  values (
    'excel',
    'รวมสัญญา.xlsx',
    'รวมสัญญา',
    p_source_checksum,
    p_source_file_size_bytes,
    v_expected_rows,
    'running',
    now(),
    'governed-xlsx',
    'contracts',
    now(),
    p_metadata || jsonb_build_object(
      'data_class', 'actual',
      'imported_by', current_user
    )
  )
  on conflict (source_checksum, source_sheet) do update
  set source_file_size_bytes = excluded.source_file_size_bytes,
      row_count = excluded.row_count,
      status = 'running',
      connector_name = excluded.connector_name,
      source_entity = excluded.source_entity,
      error_message = null,
      metadata = raw.import_batches.metadata || excluded.metadata,
      updated_at = now()
  returning batch_id into v_batch_id;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := (v_row ->> 'row_number')::integer;
    v_payload := v_row -> 'payload';
    if v_row_number < 1 or jsonb_typeof(v_payload) <> 'object' then
      raise exception 'invalid contract source row';
    end if;

    insert into public.contracts (
      source_row_number,
      material_code,
      item_description,
      unit,
      procurement_code,
      purchase_order,
      contract_number,
      line_item,
      vendor,
      start_date,
      quantity,
      record_date,
      bid_open_date,
      delivery_date,
      acceptance_date,
      document_date,
      end_date,
      source_batch_id,
      source_file,
      source_sheet,
      source_checksum,
      metadata
    )
    values (
      v_row_number,
      nullif(v_payload ->> 'material_code', ''),
      nullif(v_payload ->> 'item_description', ''),
      nullif(v_payload ->> 'unit', ''),
      nullif(v_payload ->> 'procurement_code', ''),
      nullif(v_payload ->> 'purchase_order', '')::numeric::bigint,
      nullif(v_payload ->> 'contract_number', ''),
      nullif(v_payload ->> 'line_item', '')::numeric::integer,
      nullif(v_payload ->> 'vendor', ''),
      nullif(v_payload ->> 'start_date', '')::date,
      nullif(v_payload ->> 'quantity', '')::numeric,
      nullif(v_payload ->> 'record_date', '')::date,
      nullif(v_payload ->> 'bid_open_date', '')::date,
      nullif(v_payload ->> 'delivery_date', '')::date,
      nullif(v_payload ->> 'acceptance_date', '')::date,
      nullif(v_payload ->> 'document_date', '')::date,
      nullif(v_payload ->> 'end_date', '')::date,
      v_batch_id,
      'รวมสัญญา.xlsx',
      'รวมสัญญา',
      p_source_checksum,
      jsonb_build_object(
        'data_class', 'actual',
        'source_row_number', v_row_number
      )
    )
    on conflict (source_row_number) do update
    set material_code = excluded.material_code,
        item_description = excluded.item_description,
        unit = excluded.unit,
        procurement_code = excluded.procurement_code,
        purchase_order = excluded.purchase_order,
        contract_number = excluded.contract_number,
        line_item = excluded.line_item,
        vendor = excluded.vendor,
        start_date = excluded.start_date,
        quantity = excluded.quantity,
        record_date = excluded.record_date,
        bid_open_date = excluded.bid_open_date,
        delivery_date = excluded.delivery_date,
        acceptance_date = excluded.acceptance_date,
        document_date = excluded.document_date,
        end_date = excluded.end_date,
        source_batch_id = excluded.source_batch_id,
        source_file = excluded.source_file,
        source_sheet = excluded.source_sheet,
        source_checksum = excluded.source_checksum,
        metadata = public.contracts.metadata || excluded.metadata,
        updated_at = now();

    insert into raw.source_rows (
      batch_id,
      source_entity,
      source_sheet,
      source_row_number,
      row_hash,
      payload
    )
    values (
      v_batch_id,
      'contracts',
      'รวมสัญญา',
      v_row_number,
      encode(extensions.digest(v_payload::text, 'sha256'), 'hex'),
      v_payload
    )
    on conflict (batch_id, source_entity, source_row_number) do update
    set row_hash = excluded.row_hash,
        payload = excluded.payload,
        ingested_at = now();
  end loop;

  v_reference_result := public.m18_import_source_rows(
    'รวมสัญญา.xlsx',
    'รวมสัญญา',
    p_source_checksum,
    p_source_file_size_bytes,
    'actual',
    p_rows,
    p_metadata || jsonb_build_object(
      'data_class', 'actual',
      'operational_promotion', true
    )
  );

  select count(*)::integer into v_loaded_rows
  from raw.source_rows
  where batch_id = v_batch_id
    and source_entity = 'contracts';

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'expected_rows', v_expected_rows,
    'loaded_rows', v_loaded_rows,
    'complete', v_loaded_rows = v_expected_rows,
    'reference_artifact', v_reference_result
  );
end;
$$;

create or replace function public.m18_finalize_contract_import(
  p_source_checksum text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, raw, staging, core, reference_data
as $$
declare
  v_contract_batch_id uuid;
  v_material_batch_id uuid;
  v_expected_rows integer;
  v_loaded_rows integer;
  v_staging_result jsonb;
  v_material_result jsonb;
  v_core_result jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M18 contract finalization requires service_role';
  end if;

  select batch_id, row_count
  into v_contract_batch_id, v_expected_rows
  from raw.import_batches
  where source_checksum = p_source_checksum
    and source_sheet = 'รวมสัญญา';

  if v_contract_batch_id is null then
    raise exception 'contract import batch not found';
  end if;

  select count(*)::integer into v_loaded_rows
  from raw.source_rows
  where batch_id = v_contract_batch_id
    and source_entity = 'contracts';

  if v_loaded_rows <> v_expected_rows then
    raise exception 'contract import incomplete: expected %, loaded %',
      v_expected_rows, v_loaded_rows;
  end if;

  select batch_id into v_material_batch_id
  from raw.import_batches
  where source_checksum =
      '39c0735fea5e32c4c9056fdd75830f1e47bde43a71a51a67ca4e86e5bc557126'
    and source_sheet = 'DB_Material';

  if v_material_batch_id is null then
    raise exception 'canonical Actual material batch not found';
  end if;

  v_staging_result := staging.refresh_contracts(v_contract_batch_id);
  v_material_result := staging.refresh_materials(v_material_batch_id);
  v_core_result := core.refresh_contract_foundation(
    v_contract_batch_id,
    v_material_batch_id
  );

  update raw.import_batches
  set status = 'succeeded',
      row_count = v_loaded_rows,
      imported_at = now(),
      finished_at = now(),
      error_message = null,
      updated_at = now()
  where batch_id = v_contract_batch_id;

  return jsonb_build_object(
    'batch_id', v_contract_batch_id,
    'loaded_rows', v_loaded_rows,
    'staging', v_staging_result,
    'materials', v_material_result,
    'core', v_core_result
  );
end;
$$;

create or replace function public.m18_rebuild_reference_relations()
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
    raise exception 'M18 relation rebuild requires service_role';
  end if;

  truncate table reference_data.relation_edges restart identity;

  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'references_material',
    jsonb_build_object('match_key', source.material_id)
  from reference_data.source_rows source
  join reference_data.source_artifacts source_artifact
    on source_artifact.artifact_id = source.artifact_id
  join reference_data.source_rows target
    on target.material_id = source.material_id
  join reference_data.source_artifacts target_artifact
    on target_artifact.artifact_id = target.artifact_id
   and target_artifact.source_sheet = 'DB_Material'
  where source.material_id is not null
    and source.source_row_id <> target.source_row_id
  on conflict do nothing;

  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'contract_static_to_sap',
    jsonb_build_object('match_key', source.contract_ref)
  from reference_data.source_rows source
  join reference_data.source_artifacts source_artifact
    on source_artifact.artifact_id = source.artifact_id
   and source_artifact.source_sheet = 'DB_Contract_SAP'
  join reference_data.source_rows target
    on target.contract_ref = source.contract_ref
  join reference_data.source_artifacts target_artifact
    on target_artifact.artifact_id = target.artifact_id
   and target_artifact.source_sheet = 'DB_Contract_Static'
  where source.contract_ref is not null
  on conflict do nothing;

  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'plan_to_contract',
    jsonb_build_object('match_key', source.contract_ref)
  from reference_data.source_rows source
  join reference_data.source_artifacts source_artifact
    on source_artifact.artifact_id = source.artifact_id
   and source_artifact.source_sheet = 'Trans_Replenishment_Plan'
  join reference_data.source_rows target
    on target.contract_ref = source.contract_ref
  join reference_data.source_artifacts target_artifact
    on target_artifact.artifact_id = target.artifact_id
   and target_artifact.source_sheet in ('DB_Contract_Static', 'DB_Contract_SAP')
  where source.contract_ref is not null
  on conflict do nothing;

  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'dispatch_to_plan',
    jsonb_build_object('match_key', source.plan_ref)
  from reference_data.source_rows source
  join reference_data.source_artifacts source_artifact
    on source_artifact.artifact_id = source.artifact_id
   and source_artifact.source_sheet = 'DB_PernalUse'
  join reference_data.source_rows target
    on target.plan_ref = source.plan_ref
  join reference_data.source_artifacts target_artifact
    on target_artifact.artifact_id = target.artifact_id
   and target_artifact.source_sheet = 'Trans_Replenishment_Plan'
  where source.plan_ref is not null
  on conflict do nothing;

  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'trip_to_vehicle',
    jsonb_build_object('match_key', source.vehicle_ref)
  from reference_data.source_rows source
  join reference_data.source_artifacts source_artifact
    on source_artifact.artifact_id = source.artifact_id
   and source_artifact.source_sheet = 'Trans_Transport_Logs'
  join reference_data.source_rows target
    on target.vehicle_ref = source.vehicle_ref
  join reference_data.source_artifacts target_artifact
    on target_artifact.artifact_id = target.artifact_id
   and target_artifact.source_sheet = 'Master_Vehicle'
  where source.vehicle_ref is not null
  on conflict do nothing;

  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'references_warehouse',
    jsonb_build_object('match_key', source.warehouse_id)
  from reference_data.source_rows source
  join reference_data.source_rows target
    on target.warehouse_id = source.warehouse_id
  join reference_data.source_artifacts target_artifact
    on target_artifact.artifact_id = target.artifact_id
   and target_artifact.source_sheet = 'DB_Warehouse'
  where source.warehouse_id is not null
    and source.source_row_id <> target.source_row_id
  on conflict do nothing;

  insert into reference_data.relation_edges (
    source_row_id, target_row_id, relation_type, evidence
  )
  select
    source.source_row_id,
    target.source_row_id,
    'references_district_route',
    jsonb_build_object('match_key', source.district_id)
  from reference_data.source_rows source
  join reference_data.source_rows target
    on target.district_id = source.district_id
  join reference_data.source_artifacts target_artifact
    on target_artifact.artifact_id = target.artifact_id
   and target_artifact.source_sheet = 'DB_Route'
  where source.district_id is not null
    and source.source_row_id <> target.source_row_id
  on conflict do nothing;

  select count(*) into v_edge_count
  from reference_data.relation_edges;

  select count(distinct source_row_id) into v_linked_rows
  from reference_data.relation_edges;

  return jsonb_build_object(
    'relation_edges', v_edge_count,
    'linked_source_rows', v_linked_rows
  );
end;
$$;

create or replace view analytics.v_source_artifact_inventory
with (security_invoker = true)
as
select
  artifact.artifact_id,
  artifact.source_path,
  nullif(artifact.source_sheet, '') as source_sheet,
  artifact.source_checksum,
  artifact.data_class,
  artifact.expected_rows,
  count(source_row.source_row_id)::bigint as loaded_rows,
  count(source_row.source_row_id) = artifact.expected_rows as complete,
  artifact.metadata,
  artifact.updated_at
from reference_data.source_artifacts artifact
left join reference_data.source_rows source_row
  on source_row.artifact_id = artifact.artifact_id
group by artifact.artifact_id;

create or replace view analytics.v_reference_relation_coverage
with (security_invoker = true)
as
select
  artifact.source_path,
  nullif(artifact.source_sheet, '') as source_sheet,
  artifact.data_class,
  count(source_row.source_row_id)::bigint as source_rows,
  count(distinct edge.source_row_id)::bigint as linked_rows,
  count(edge.relation_edge_id)::bigint as relation_edges,
  count(source_row.source_row_id)
    - count(distinct edge.source_row_id) as unlinked_rows
from reference_data.source_artifacts artifact
left join reference_data.source_rows source_row
  on source_row.artifact_id = artifact.artifact_id
left join reference_data.relation_edges edge
  on edge.source_row_id = source_row.source_row_id
group by
  artifact.source_path,
  artifact.source_sheet,
  artifact.data_class;

alter table reference_data.source_artifacts enable row level security;
alter table reference_data.source_rows enable row level security;
alter table reference_data.relation_edges enable row level security;

revoke all on schema reference_data from public, anon, authenticated;
grant usage on schema reference_data to service_role;
revoke all on all tables in schema reference_data
  from public, anon, authenticated;
grant all on all tables in schema reference_data to service_role;
grant usage, select on all sequences in schema reference_data to service_role;

revoke all on function public.m18_import_source_rows(
  text, text, text, bigint, text, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.m18_import_contract_chunk(
  text, bigint, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.m18_finalize_contract_import(text)
  from public, anon, authenticated;
revoke all on function public.m18_rebuild_reference_relations()
  from public, anon, authenticated;
grant execute on function public.m18_import_source_rows(
  text, text, text, bigint, text, jsonb, jsonb
) to service_role;
grant execute on function public.m18_import_contract_chunk(
  text, bigint, jsonb, jsonb
) to service_role;
grant execute on function public.m18_finalize_contract_import(text)
  to service_role;
grant execute on function public.m18_rebuild_reference_relations()
  to service_role;

revoke all on analytics.v_source_artifact_inventory,
  analytics.v_reference_relation_coverage
  from public, anon, authenticated;
grant select on analytics.v_source_artifact_inventory,
  analytics.v_reference_relation_coverage
  to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607240018',
  'M18',
  'Governed Actual contract import plus complete fixture/design lineage and relational evidence.',
  'supabase/migrations/202607240018_relational_source_import.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
