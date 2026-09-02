-- M16: governed packaging master details for FIFO setup.

begin;

create table if not exists core.packaging_master_profiles (
  packaging_profile_id uuid primary key default gen_random_uuid(),
  material_id text not null references core.materials (material_id) on delete restrict,
  vendor_alias text not null default 'SUP-UNKNOWN',
  contract_no text not null default '',
  purchase_order text not null default '',
  plant text not null,
  storage_location text not null,
  package_type text not null check (
    package_type in ('FULL_PALLET', 'BOX', 'CRATE', 'BUNDLE', 'LOOSE', 'LONG_MATERIAL')
  ),
  units_per_package numeric not null check (units_per_package > 0),
  item_length_cm numeric check (item_length_cm is null or item_length_cm > 0),
  item_width_cm numeric check (item_width_cm is null or item_width_cm > 0),
  item_height_cm numeric check (item_height_cm is null or item_height_cm > 0),
  item_weight_kg numeric check (item_weight_kg is null or item_weight_kg > 0),
  box_length_cm numeric check (box_length_cm is null or box_length_cm > 0),
  box_width_cm numeric check (box_width_cm is null or box_width_cm > 0),
  box_height_cm numeric check (box_height_cm is null or box_height_cm > 0),
  box_tare_weight_kg numeric check (box_tare_weight_kg is null or box_tare_weight_kg >= 0),
  box_gross_weight_kg numeric check (box_gross_weight_kg is null or box_gross_weight_kg > 0),
  boxes_per_layer integer check (boxes_per_layer is null or boxes_per_layer > 0),
  stack_layers integer check (stack_layers is null or stack_layers > 0),
  boxes_per_pallet integer check (boxes_per_pallet is null or boxes_per_pallet > 0),
  units_per_pallet numeric check (units_per_pallet is null or units_per_pallet > 0),
  pallet_length_m numeric check (pallet_length_m is null or pallet_length_m > 0),
  pallet_width_m numeric check (pallet_width_m is null or pallet_width_m > 0),
  load_height_m numeric check (load_height_m is null or load_height_m > 0),
  pallet_tare_kg numeric check (pallet_tare_kg is null or pallet_tare_kg >= 0),
  max_pallet_gross_kg numeric check (max_pallet_gross_kg is null or max_pallet_gross_kg > 0),
  calculated_pallet_gross_kg numeric check (
    calculated_pallet_gross_kg is null or calculated_pallet_gross_kg > 0
  ),
  assumption_status text not null default 'TEMPORARY_ESTIMATE' check (
    assumption_status in ('TEMPORARY_ESTIMATE', 'VERIFIED')
  ),
  source_reference text not null,
  verified boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packaging_master_profiles_natural_uq unique (
    material_id, vendor_alias, contract_no, purchase_order, plant, storage_location
  )
);

create index if not exists packaging_master_profiles_scope_idx
  on core.packaging_master_profiles (plant, storage_location, material_id);
create index if not exists packaging_master_profiles_created_by_idx
  on core.packaging_master_profiles (created_by);
create index if not exists packaging_master_profiles_updated_by_idx
  on core.packaging_master_profiles (updated_by);

alter table core.packaging_master_profiles enable row level security;
revoke all on core.packaging_master_profiles from public, anon, authenticated;

create or replace function core.m16_upsert_packaging_master_profiles(
  p_profiles jsonb,
  p_source_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_count integer;
begin
  select role::text into v_role
  from public.user_profiles
  where user_id = v_user_id and is_active;

  if v_user_id is null or v_role <> 'admin' then
    raise exception 'Admin role is required to publish packaging profiles';
  end if;
  if jsonb_typeof(p_profiles) <> 'array' or jsonb_array_length(p_profiles) = 0 then
    raise exception 'profiles must be a non-empty JSON array';
  end if;
  if btrim(coalesce(p_source_reference, '')) = '' then
    raise exception 'source_reference is required';
  end if;

  insert into core.packaging_master_profiles (
    material_id, vendor_alias, contract_no, purchase_order, plant, storage_location,
    package_type, units_per_package,
    item_length_cm, item_width_cm, item_height_cm, item_weight_kg,
    box_length_cm, box_width_cm, box_height_cm, box_tare_weight_kg,
    box_gross_weight_kg, boxes_per_layer, stack_layers, boxes_per_pallet,
    units_per_pallet, pallet_length_m, pallet_width_m, load_height_m,
    pallet_tare_kg, max_pallet_gross_kg, calculated_pallet_gross_kg,
    assumption_status, source_reference, verified, created_by, updated_by
  )
  select
    btrim(profile ->> 'MATERIAL'),
    coalesce(nullif(btrim(profile ->> 'VENDOR_ALIAS'), ''), 'SUP-UNKNOWN'),
    coalesce(btrim(profile ->> 'CONTRACT_NO'), ''),
    coalesce(btrim(profile ->> 'PURCHASE_ORDER'), ''),
    coalesce(nullif(btrim(profile ->> 'PLANT'), ''), '2401'),
    coalesce(nullif(btrim(profile ->> 'STORAGE_LOCATION'), ''), '0001'),
    btrim(profile ->> 'PACKAGE_TYPE'),
    nullif(profile ->> 'UNITS_PER_PACKAGE', '')::numeric,
    nullif(profile ->> 'ITEM_LENGTH_CM', '')::numeric,
    nullif(profile ->> 'ITEM_WIDTH_CM', '')::numeric,
    nullif(profile ->> 'ITEM_HEIGHT_CM', '')::numeric,
    nullif(profile ->> 'ITEM_WEIGHT_KG', '')::numeric,
    nullif(profile ->> 'BOX_LENGTH_CM', '')::numeric,
    nullif(profile ->> 'BOX_WIDTH_CM', '')::numeric,
    nullif(profile ->> 'BOX_HEIGHT_CM', '')::numeric,
    nullif(profile ->> 'BOX_TARE_WEIGHT_KG', '')::numeric,
    nullif(profile ->> 'BOX_GROSS_WEIGHT_KG', '')::numeric,
    nullif(profile ->> 'BOXES_PER_LAYER', '')::integer,
    nullif(profile ->> 'LAYERS', '')::integer,
    nullif(profile ->> 'BOXES_PER_PALLET', '')::integer,
    nullif(profile ->> 'UNITS_PER_PALLET', '')::numeric,
    nullif(profile ->> 'PALLET_LENGTH_M', '')::numeric,
    nullif(profile ->> 'PALLET_WIDTH_M', '')::numeric,
    nullif(profile ->> 'LOAD_HEIGHT_M', '')::numeric,
    nullif(profile ->> 'PALLET_TARE_KG', '')::numeric,
    nullif(profile ->> 'MAX_PALLET_GROSS_KG', '')::numeric,
    nullif(profile ->> 'CALC_PALLET_GROSS_KG', '')::numeric,
    case when upper(coalesce(profile ->> 'ASSUMPTION_STATUS', '')) = 'VERIFIED'
      then 'VERIFIED' else 'TEMPORARY_ESTIMATE' end,
    left(p_source_reference, 500),
    lower(coalesce(profile ->> 'VERIFIED', 'no')) in ('yes', 'true', '1'),
    v_user_id,
    v_user_id
  from jsonb_array_elements(p_profiles) profile
  where btrim(coalesce(profile ->> 'MATERIAL', '')) <> ''
    and btrim(coalesce(profile ->> 'PACKAGE_TYPE', '')) <> ''
    and nullif(profile ->> 'UNITS_PER_PACKAGE', '')::numeric > 0
  on conflict on constraint packaging_master_profiles_natural_uq do update
  set package_type = excluded.package_type,
      units_per_package = excluded.units_per_package,
      item_length_cm = excluded.item_length_cm,
      item_width_cm = excluded.item_width_cm,
      item_height_cm = excluded.item_height_cm,
      item_weight_kg = excluded.item_weight_kg,
      box_length_cm = excluded.box_length_cm,
      box_width_cm = excluded.box_width_cm,
      box_height_cm = excluded.box_height_cm,
      box_tare_weight_kg = excluded.box_tare_weight_kg,
      box_gross_weight_kg = excluded.box_gross_weight_kg,
      boxes_per_layer = excluded.boxes_per_layer,
      stack_layers = excluded.stack_layers,
      boxes_per_pallet = excluded.boxes_per_pallet,
      units_per_pallet = excluded.units_per_pallet,
      pallet_length_m = excluded.pallet_length_m,
      pallet_width_m = excluded.pallet_width_m,
      load_height_m = excluded.load_height_m,
      pallet_tare_kg = excluded.pallet_tare_kg,
      max_pallet_gross_kg = excluded.max_pallet_gross_kg,
      calculated_pallet_gross_kg = excluded.calculated_pallet_gross_kg,
      assumption_status = excluded.assumption_status,
      source_reference = excluded.source_reference,
      verified = excluded.verified,
      updated_by = v_user_id,
      updated_at = now();

  get diagnostics v_count = row_count;
  return jsonb_build_object('saved_profiles', v_count, 'source_reference', p_source_reference);
end;
$$;

revoke all on function core.m16_upsert_packaging_master_profiles(jsonb, text)
  from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m16(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl_m16;
  end if;
end
$$;

create or replace function public.m09_dispatch(
  p_method text,
  p_path text,
  p_query jsonb default '{}'::jsonb,
  p_body jsonb default '{}'::jsonb,
  p_request_id text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_payload jsonb;
  v_limit integer;
begin
  select role::text into v_role
  from public.user_profiles
  where user_id = v_user_id and is_active;

  if upper(coalesce(p_method, '')) = 'POST'
     and p_path = '/v1/admin/packaging-profiles' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    if v_role <> 'admin' then
      return public.m09_error(403, 'forbidden', 'Admin role is required', p_request_id);
    end if;
    if jsonb_typeof(p_body -> 'profiles') <> 'array' then
      return public.m09_error(422, 'validation_error', 'profiles must be an array', p_request_id);
    end if;
    select core.m16_upsert_packaging_master_profiles(
      p_body -> 'profiles',
      coalesce(nullif(p_body ->> 'source_reference', ''), 'MEA Synapse FIFO Packaging Setup')
    ) into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if upper(coalesce(p_method, '')) = 'GET'
     and p_path = '/v1/admin/packaging-profiles' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_limit := least(greatest(coalesce(nullif(p_query ->> 'limit', '')::integer, 500), 1), 2000);
    select coalesce(jsonb_agg(to_jsonb(profile)), '[]'::jsonb) into v_payload
    from (
      select * from core.packaging_master_profiles
      order by updated_at desc, material_id
      limit v_limit
    ) profile;
    return public.m09_result(200, v_payload);
  end if;

  return public.m09_dispatch_impl_m16(p_method, p_path, p_query, p_body, p_request_id);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return public.m09_error(422, 'validation_error', 'Packaging profile contains an invalid value', p_request_id);
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated;

comment on table core.packaging_master_profiles is
  'Per material/vendor/contract/warehouse packaging dimensions, pallet capacity, weight and verification state.';

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202609010001',
  'M16-packaging',
  'Governed packaging master details and authenticated FIFO setup dispatch.',
  'supabase/migrations/202609010001_m16_packaging_master_details.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
