-- M16b: publish governed FIFO opening handling units and warehouse stock.

begin;

alter table core.handling_units
  add column if not exists physical_location text;

create table if not exists ops.fifo_opening_publications (
  publication_id uuid primary key default gen_random_uuid(),
  source_reference text not null unique,
  plant text not null default '2401',
  storage_location text not null default '0001',
  packaging_profile_count integer not null check (packaging_profile_count >= 0),
  handling_unit_count integer not null check (handling_unit_count >= 0),
  opening_quantity numeric not null check (opening_quantity >= 0),
  published_by uuid references auth.users (id) on delete set null,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on ops.fifo_opening_publications from public, anon, authenticated;

create or replace function core.m16b_publish_fifo_opening(
  p_profiles jsonb,
  p_handling_units jsonb,
  p_source_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_row jsonb;
  v_profile_result jsonb;
  v_source text := left(coalesce(nullif(btrim(p_source_reference), ''), 'MEA Synapse FIFO Opening Setup'), 1000);
  v_warehouse_id text;
  v_contract_item_id bigint;
  v_contract_material text;
  v_material_id text;
  v_hu_code text;
  v_lot_code text;
  v_lot_id uuid;
  v_hu_id uuid;
  v_unit_type text;
  v_opening_status text;
  v_physical_location text;
  v_acceptance_date date;
  v_installment text;
  v_initial numeric;
  v_remain numeric;
  v_hu_count integer := 0;
  v_total numeric := 0;
  v_snapshot_at timestamptz := clock_timestamp();
  v_snapshot_count integer := 0;
begin
  select role::text into v_role
  from public.user_profiles
  where user_id = v_user_id and is_active;

  if v_user_id is null then
    raise exception 'Missing or invalid bearer token';
  end if;
  if v_role <> 'admin' then
    raise exception 'Admin role is required';
  end if;
  if jsonb_typeof(p_profiles) <> 'array'
     or jsonb_typeof(p_handling_units) <> 'array'
     or jsonb_array_length(p_handling_units) = 0 then
    raise exception 'profiles and non-empty handling_units arrays are required';
  end if;

  select warehouse_id into v_warehouse_id
  from core.locations
  where location_id = 'WH-KT' and location_type = 'WAREHOUSE';
  if v_warehouse_id is null then
    raise exception 'Khlong Toei warehouse location WH-KT is not configured';
  end if;

  select core.m16_upsert_packaging_master_profiles(p_profiles, v_source)
  into v_profile_result;

  for v_row in select value from jsonb_array_elements(p_handling_units)
  loop
    v_hu_code := left(btrim(coalesce(v_row ->> 'HU_ID', '')), 200);
    v_material_id := btrim(coalesce(v_row ->> 'MATERIAL', ''));
    v_physical_location := left(btrim(coalesce(v_row ->> 'PHYSICAL_LOCATION', '')), 200);
    v_unit_type := upper(btrim(coalesce(v_row ->> 'PACKAGE_TYPE', 'LOOSE')));
    v_initial := nullif(v_row ->> 'INITIAL_QTY', '')::numeric;
    v_remain := nullif(v_row ->> 'CURRENT_REMAIN', '')::numeric;
    v_contract_item_id := nullif(v_row ->> 'CONTRACT_ITEM_ID', '')::bigint;
    v_acceptance_date := least(
      coalesce(nullif(v_row ->> 'ACCEPTED_DATE', '')::date, current_date),
      current_date
    );
    v_installment := left(coalesce(
      nullif(v_row ->> 'DELIVERY_INSTALLMENT', ''),
      nullif(v_row ->> 'RECEIPT_LOT', ''),
      'OPENING'
    ), 100);

    if v_hu_code = '' or v_material_id = '' or v_physical_location = '' then
      raise exception 'HU_ID, MATERIAL and PHYSICAL_LOCATION are required';
    end if;
    if v_unit_type not in ('FULL_PALLET', 'BOX', 'CRATE', 'BUNDLE', 'LOOSE', 'LONG_MATERIAL') then
      raise exception 'Unsupported package type % for %', v_unit_type, v_hu_code;
    end if;
    if v_initial is null or v_initial <= 0
       or v_remain is null or v_remain < 0 or v_remain > v_initial then
      raise exception 'Invalid opening quantity for %', v_hu_code;
    end if;

    select material_id into v_contract_material
    from core.contract_items
    where contract_item_id = v_contract_item_id;
    if v_contract_material is null or v_contract_material <> v_material_id then
      raise exception 'Contract item % does not match material %', v_contract_item_id, v_material_id;
    end if;

    if exists (
      select 1
      from core.handling_units hu
      where hu.handling_unit_code = v_hu_code
        and (
          hu.reserved_qty > 0
          or exists (
            select 1 from core.inventory_movements movement
            where movement.handling_unit_id = hu.handling_unit_id
              and movement.movement_type in ('ISSUE', 'RETURN', 'DAMAGE', 'QUARANTINE')
          )
        )
    ) then
      raise exception 'Handling unit % already has stock activity and cannot be republished', v_hu_code;
    end if;

    v_opening_status := case
      when v_remain = 0 then 'DEPLETED'
      when v_remain < v_initial then 'OPEN'
      else 'SEALED'
    end;
    v_lot_code := 'OPENING-' || left(
      upper(regexp_replace(v_hu_code, '[^A-Za-z0-9-]+', '-', 'g')),
      160
    );

    insert into core.receipt_lots (
      lot_code, contract_item_id, warehouse_id, acceptance_date,
      installment_no, received_qty, remaining_qty, traceability_status,
      source_reference, created_by
    ) values (
      v_lot_code, v_contract_item_id, v_warehouse_id, v_acceptance_date,
      v_installment, v_initial, v_remain, 'complete', v_source, v_user_id
    )
    on conflict (lot_code) do update set
      contract_item_id = excluded.contract_item_id,
      warehouse_id = excluded.warehouse_id,
      acceptance_date = excluded.acceptance_date,
      installment_no = excluded.installment_no,
      received_qty = excluded.received_qty,
      remaining_qty = excluded.remaining_qty,
      traceability_status = excluded.traceability_status,
      source_reference = excluded.source_reference,
      updated_at = now()
    returning receipt_lot_id into v_lot_id;

    insert into core.handling_units (
      handling_unit_code, receipt_lot_id, material_id, location_id,
      unit_type, opening_status, received_qty, available_qty, reserved_qty,
      opened_at, physical_location, source_reference
    ) values (
      v_hu_code, v_lot_id, v_material_id, 'WH-KT',
      v_unit_type, v_opening_status, v_initial, v_remain, 0,
      case when v_opening_status = 'OPEN' then now() else null end,
      v_physical_location, v_source
    )
    on conflict (handling_unit_code) do update set
      receipt_lot_id = excluded.receipt_lot_id,
      material_id = excluded.material_id,
      location_id = excluded.location_id,
      unit_type = excluded.unit_type,
      opening_status = excluded.opening_status,
      received_qty = excluded.received_qty,
      available_qty = excluded.available_qty,
      reserved_qty = 0,
      opened_at = excluded.opened_at,
      physical_location = excluded.physical_location,
      source_reference = excluded.source_reference,
      updated_at = now()
    returning handling_unit_id into v_hu_id;

    insert into core.inventory_movements (
      movement_type, material_id, handling_unit_id, to_location_id,
      quantity, idempotency_key, reason, performed_by, metadata
    ) values (
      'RECEIPT', v_material_id, v_hu_id, 'WH-KT',
      v_initial, 'fifo-opening:' || v_hu_code, v_source, v_user_id,
      jsonb_build_object(
        'opening_publish', true,
        'physical_location', v_physical_location,
        'current_remain', v_remain,
        'contract_item_id', v_contract_item_id
      )
    )
    on conflict (idempotency_key) do update set
      quantity = excluded.quantity,
      reason = excluded.reason,
      metadata = excluded.metadata;

    v_hu_count := v_hu_count + 1;
    v_total := v_total + v_remain;
  end loop;

  insert into core.stock_snapshots (
    material_id, location_id, quantity_on_hand, snapshot_at
  )
  select
    hu.material_id,
    'WH-KT',
    sum(hu.available_qty),
    v_snapshot_at
  from core.handling_units hu
  where hu.location_id = 'WH-KT'
    and hu.opening_status in ('OPEN', 'SEALED', 'OPENING_UNKNOWN')
  group by hu.material_id;
  get diagnostics v_snapshot_count = row_count;

  insert into ops.fifo_opening_publications (
    source_reference, packaging_profile_count, handling_unit_count,
    opening_quantity, published_by, published_at, updated_at
  ) values (
    v_source, jsonb_array_length(p_profiles), v_hu_count,
    v_total, v_user_id, now(), now()
  )
  on conflict (source_reference) do update set
    packaging_profile_count = excluded.packaging_profile_count,
    handling_unit_count = excluded.handling_unit_count,
    opening_quantity = excluded.opening_quantity,
    published_by = excluded.published_by,
    published_at = excluded.published_at,
    updated_at = now();

  return jsonb_build_object(
    'saved_profiles', coalesce((v_profile_result ->> 'saved_profiles')::integer, 0),
    'saved_handling_units', v_hu_count,
    'opening_quantity', v_total,
    'stock_snapshot_materials', v_snapshot_count,
    'warehouse_location', 'WH-KT',
    'published_at', now()
  );
end;
$$;

revoke all on function core.m16b_publish_fifo_opening(jsonb, jsonb, text)
  from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m16b(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl_m16b;
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
set search_path = pg_catalog, public, core
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_payload jsonb;
begin
  select role::text into v_role
  from public.user_profiles
  where user_id = v_user_id and is_active;

  if upper(coalesce(p_method, '')) = 'POST'
     and p_path = '/v1/admin/fifo-opening' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    if v_role <> 'admin' then
      return public.m09_error(403, 'forbidden', 'Admin role is required', p_request_id);
    end if;
    if jsonb_typeof(p_body -> 'profiles') <> 'array'
       or jsonb_typeof(p_body -> 'handling_units') <> 'array' then
      return public.m09_error(422, 'validation_error', 'profiles and handling_units must be arrays', p_request_id);
    end if;
    select core.m16b_publish_fifo_opening(
      p_body -> 'profiles',
      p_body -> 'handling_units',
      coalesce(nullif(p_body ->> 'source_reference', ''), 'MEA Synapse FIFO Opening Setup')
    ) into v_payload;
    return public.m09_result(201, v_payload);
  end if;

  return public.m09_dispatch_impl_m16b(p_method, p_path, p_query, p_body, p_request_id);
exception
  when invalid_text_representation or numeric_value_out_of_range or not_null_violation then
    return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated;

comment on function core.m16b_publish_fifo_opening(jsonb, jsonb, text) is
  'Publishes packaging master, opening handling units, inventory receipt evidence and a Khlong Toei warehouse stock snapshot in one transaction.';

commit;
