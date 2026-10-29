-- M18: Packing entry worklist + legacy issue history.
--
-- 1. Packing: a worklist of material + PO lots that have a 105 receipt (or an
--    accepted contract line), with the packing status of each, and a single
--    profile save that warehouse staff (picker) can use as well as admin.
--    Profiles reuse core.packaging_master_profiles (natural key material +
--    vendor + contract + PO + plant + storage location).
-- 2. Legacy issue history: issue / adjusted / refused lines carried over from
--    the old Google Sheet (History sheets + 18 district sheets) so refusal and
--    issue history exist from day one. Re-importing the same lines is
--    idempotent.
-- Endpoints:
--   GET  /v1/packing/worklist
--   POST /v1/packing/profiles
--   GET  /v1/admin/legacy-issue-history
--   POST /v1/admin/legacy-issue-history

begin;

-- ------------------------------------------------------------------
-- Legacy issue history
-- ------------------------------------------------------------------
create table if not exists ops.legacy_issue_history (
  legacy_issue_id uuid primary key default gen_random_uuid(),
  row_key text not null unique,
  district_id text not null,
  district_name text,
  material_id text not null,
  material_name text,
  unit text,
  plan_date date,
  actual_date date,
  planned_qty numeric check (planned_qty is null or planned_qty >= 0),
  issued_qty numeric check (issued_qty is null or issued_qty >= 0),
  outcome text not null check (outcome in ('issued', 'adjusted', 'refused')),
  fill_type text not null default 'unknown'
    check (fill_type in ('vmi', 'passed_test', 'district_request', 'unknown')),
  lot_size_text text,
  note text,
  refused_by text,
  review_flags text[] not null default '{}',
  source_sheet text,
  source_row integer,
  source_file text not null,
  imported_by uuid references auth.users (id) on delete set null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists legacy_issue_history_district_material_idx
  on ops.legacy_issue_history (district_id, material_id, plan_date desc);
create index if not exists legacy_issue_history_outcome_idx
  on ops.legacy_issue_history (outcome, plan_date desc);

alter table ops.legacy_issue_history enable row level security;
revoke all on ops.legacy_issue_history from public, anon, authenticated;

create or replace function core.m18_import_legacy_issue_history(
  p_rows jsonb,
  p_source_file text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_row jsonb;
  v_key text;
  v_existing boolean;
begin
  select role::text into v_role
  from public.user_profiles
  where user_id = v_user_id and is_active;
  if v_user_id is null or coalesce(v_role, '') <> 'admin' then
    raise exception 'Admin role is required to import legacy issue history';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'rows must be a non-empty array';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'At most 5000 rows per request';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if nullif(btrim(v_row ->> 'district_id'), '') is null
       or nullif(btrim(v_row ->> 'material_id'), '') is null
       or coalesce(v_row ->> 'outcome', '') not in ('issued', 'adjusted', 'refused') then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_key := md5(concat_ws('|',
      btrim(v_row ->> 'district_id'),
      btrim(v_row ->> 'material_id'),
      coalesce(v_row ->> 'plan_date', ''),
      coalesce(v_row ->> 'actual_date', ''),
      coalesce(v_row ->> 'planned_qty', ''),
      coalesce(v_row ->> 'issued_qty', ''),
      v_row ->> 'outcome'
    ));
    select true into v_existing from ops.legacy_issue_history where row_key = v_key;
    insert into ops.legacy_issue_history (
      row_key, district_id, district_name, material_id, material_name, unit,
      plan_date, actual_date, planned_qty, issued_qty, outcome, fill_type,
      lot_size_text, note, refused_by, review_flags,
      source_sheet, source_row, source_file, imported_by
    ) values (
      v_key,
      btrim(v_row ->> 'district_id'),
      left(nullif(btrim(v_row ->> 'district_name'), ''), 200),
      btrim(v_row ->> 'material_id'),
      left(nullif(btrim(v_row ->> 'material_name'), ''), 300),
      left(nullif(btrim(v_row ->> 'unit'), ''), 20),
      nullif(v_row ->> 'plan_date', '')::date,
      nullif(v_row ->> 'actual_date', '')::date,
      nullif(v_row ->> 'planned_qty', '')::numeric,
      nullif(v_row ->> 'issued_qty', '')::numeric,
      v_row ->> 'outcome',
      case when v_row ->> 'fill_type' in ('vmi', 'passed_test', 'district_request')
        then v_row ->> 'fill_type' else 'unknown' end,
      left(nullif(btrim(v_row ->> 'lot_size_text'), ''), 200),
      left(nullif(btrim(v_row ->> 'note'), ''), 1000),
      left(nullif(btrim(v_row ->> 'refused_by'), ''), 200),
      coalesce(
        (select array_agg(left(flag, 60)) from jsonb_array_elements_text(
          case when jsonb_typeof(v_row -> 'review_flags') = 'array'
            then v_row -> 'review_flags' else '[]'::jsonb end) flag),
        '{}'
      ),
      left(nullif(btrim(v_row ->> 'source_sheet'), ''), 100),
      nullif(v_row ->> 'source_row', '')::integer,
      left(coalesce(nullif(btrim(p_source_file), ''), 'legacy workbook'), 300),
      v_user_id
    )
    on conflict (row_key) do update
    set district_name = excluded.district_name,
        material_name = excluded.material_name,
        unit = excluded.unit,
        fill_type = excluded.fill_type,
        lot_size_text = excluded.lot_size_text,
        note = excluded.note,
        refused_by = excluded.refused_by,
        review_flags = excluded.review_flags,
        source_sheet = excluded.source_sheet,
        source_row = excluded.source_row,
        source_file = excluded.source_file,
        imported_by = excluded.imported_by,
        updated_at = now();
    if coalesce(v_existing, false) then
      v_updated := v_updated + 1;
    else
      v_inserted := v_inserted + 1;
    end if;
    v_existing := false;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'skipped', v_skipped,
    'total', (select count(*) from ops.legacy_issue_history)
  );
end;
$$;

revoke all on function core.m18_import_legacy_issue_history(jsonb, text)
  from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Packing worklist + single profile save
-- ------------------------------------------------------------------
create or replace function core.m18_packing_worklist()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, core, ops
as $$
  with receipts as (
    select
      right(regexp_replace(payload ->> 'material_code', '\D', '', 'g'), 12) as material_id,
      regexp_replace(coalesce(payload ->> 'purchase_order', ''), '\D', '', 'g') as purchase_order,
      sum(coalesce(nullif(regexp_replace(payload ->> 'quantity', '[^0-9.\-]', '', 'g'), '')::numeric, 0)) as received_qty,
      count(*) as receipt_lines,
      max(payload ->> 'posting_date') as last_receipt,
      min(payload ->> 'posting_date') as first_receipt,
      max(payload ->> 'item_description') as receipt_description,
      max(payload ->> 'unit') as receipt_unit
    from ops.source_current_rows
    where source_kind = 'receipts_105'
      and missing_since_run_id is null
    group by 1, 2
  ), contract_lines as (
    select distinct on (material_id, purchase_order)
      right(regexp_replace(payload ->> 'material_code', '\D', '', 'g'), 12) as material_id,
      regexp_replace(coalesce(payload ->> 'purchase_order', ''), '\D', '', 'g') as purchase_order,
      payload ->> 'contract_number' as contract_no,
      payload ->> 'vendor' as vendor_name,
      payload ->> 'item_description' as description,
      payload ->> 'unit' as unit,
      payload ->> 'acceptance_date' as acceptance_date
    from ops.source_current_rows
    where source_kind = 'contracts'
      and missing_since_run_id is null
      and coalesce(payload ->> 'material_code', '') <> ''
    order by material_id, purchase_order, payload ->> 'acceptance_date' desc nulls last
  ), core_lines as (
    select distinct on (ci.material_id, c.purchase_order::text)
      ci.material_id,
      c.purchase_order::text as purchase_order,
      c.contract_number as contract_no,
      v.vendor_name,
      ci.item_description as description,
      ci.unit,
      ci.acceptance_date::text as acceptance_date
    from core.contract_items ci
    join core.contracts c using (contract_id)
    left join core.vendors v using (vendor_id)
    where ci.is_current and ci.material_id is not null and ci.acceptance_date is not null
    order by ci.material_id, c.purchase_order::text, ci.acceptance_date desc
  ), lots as (
    select
      coalesce(r.material_id, cl.material_id) as material_id,
      coalesce(r.purchase_order, cl.purchase_order) as purchase_order,
      r.received_qty, r.receipt_lines, r.first_receipt, r.last_receipt,
      coalesce(cl.contract_no, '') as contract_no,
      cl.vendor_name,
      coalesce(cl.description, r.receipt_description) as description,
      coalesce(cl.unit, r.receipt_unit) as unit,
      cl.acceptance_date
    from receipts r
    full join contract_lines cl
      on cl.material_id = r.material_id and cl.purchase_order = r.purchase_order
    where r.material_id is not null or cl.acceptance_date is not null
    union all
    select k.material_id, k.purchase_order, null, null, null, null,
      coalesce(k.contract_no, ''), k.vendor_name, k.description, k.unit, k.acceptance_date
    from core_lines k
    where not exists (select 1 from receipts r where r.material_id = k.material_id and r.purchase_order = k.purchase_order)
      and not exists (select 1 from contract_lines cl where cl.material_id = k.material_id and cl.purchase_order = k.purchase_order)
  ), needed as (
    select distinct i.material_id
    from core.replenishment_items i
    join core.replenishment_plans p using (replenishment_plan_id)
    where p.status not in ('cancelled', 'completed')
      and i.status not in ('cancelled', 'district_rejected', 'issued')
  )
  select coalesce(jsonb_agg(to_jsonb(row) order by row.needed_soon desc, row.packing_status, row.last_receipt desc nulls last), '[]'::jsonb)
  from (
    select
      l.material_id,
      coalesce(m.material_name, l.description) as material_name,
      coalesce(m.unit, l.unit) as unit,
      l.purchase_order,
      l.contract_no,
      coalesce(nullif(l.vendor_name, ''), 'SUP-UNKNOWN') as vendor_name,
      l.received_qty,
      l.receipt_lines,
      l.first_receipt,
      l.last_receipt,
      l.acceptance_date,
      (n.material_id is not null) as needed_soon,
      case
        when p.packaging_profile_id is null then 'missing'
        when p.assumption_status = 'VERIFIED' then 'verified'
        else 'estimate'
      end as packing_status,
      to_jsonb(p) - 'created_by' - 'updated_by' as profile
    from lots l
    left join core.materials m on m.material_id = l.material_id
    left join needed n on n.material_id = l.material_id
    left join lateral (
      select pm.*
      from core.packaging_master_profiles pm
      where pm.material_id = l.material_id
        and regexp_replace(pm.purchase_order, '\D', '', 'g') = l.purchase_order
      order by pm.updated_at desc
      limit 1
    ) p on true
    where l.material_id is not null and l.material_id <> ''
  ) row;
$$;

revoke all on function core.m18_packing_worklist() from public, anon, authenticated;

create or replace function core.m18_save_packing_profile(p_profile jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_material text := btrim(coalesce(p_profile ->> 'material_id', ''));
  v_type text := upper(btrim(coalesce(p_profile ->> 'package_type', '')));
  v_units numeric := nullif(p_profile ->> 'units_per_package', '')::numeric;
  v_id uuid;
begin
  select role::text into v_role
  from public.user_profiles
  where user_id = v_user_id and is_active;
  if v_user_id is null or coalesce(v_role, '') not in ('admin', 'picker') then
    raise exception 'Admin or warehouse staff role is required to save packing';
  end if;
  if v_material = '' or not exists (select 1 from core.materials where material_id = v_material) then
    raise exception 'ไม่พบรหัสพัสดุ % ในข้อมูลพัสดุ', v_material;
  end if;
  if v_type not in ('FULL_PALLET', 'BOX', 'CRATE', 'BUNDLE', 'LOOSE', 'LONG_MATERIAL') then
    raise exception 'ประเภทบรรจุภัณฑ์ไม่ถูกต้อง';
  end if;
  if v_units is null or v_units <= 0 then
    raise exception 'จำนวนชิ้นต่อหน่วยบรรจุต้องมากกว่า 0';
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
  ) values (
    v_material,
    coalesce(nullif(btrim(p_profile ->> 'vendor_name'), ''), 'SUP-UNKNOWN'),
    coalesce(btrim(p_profile ->> 'contract_no'), ''),
    coalesce(btrim(p_profile ->> 'purchase_order'), ''),
    '2401',
    '0001',
    v_type,
    v_units,
    nullif(p_profile ->> 'item_length_cm', '')::numeric,
    nullif(p_profile ->> 'item_width_cm', '')::numeric,
    nullif(p_profile ->> 'item_height_cm', '')::numeric,
    nullif(p_profile ->> 'item_weight_kg', '')::numeric,
    nullif(p_profile ->> 'box_length_cm', '')::numeric,
    nullif(p_profile ->> 'box_width_cm', '')::numeric,
    nullif(p_profile ->> 'box_height_cm', '')::numeric,
    nullif(p_profile ->> 'box_tare_weight_kg', '')::numeric,
    nullif(p_profile ->> 'box_gross_weight_kg', '')::numeric,
    nullif(p_profile ->> 'boxes_per_layer', '')::integer,
    nullif(p_profile ->> 'stack_layers', '')::integer,
    nullif(p_profile ->> 'boxes_per_pallet', '')::integer,
    nullif(p_profile ->> 'units_per_pallet', '')::numeric,
    nullif(p_profile ->> 'pallet_length_m', '')::numeric,
    nullif(p_profile ->> 'pallet_width_m', '')::numeric,
    nullif(p_profile ->> 'load_height_m', '')::numeric,
    nullif(p_profile ->> 'pallet_tare_kg', '')::numeric,
    nullif(p_profile ->> 'max_pallet_gross_kg', '')::numeric,
    nullif(p_profile ->> 'calculated_pallet_gross_kg', '')::numeric,
    case when upper(coalesce(p_profile ->> 'assumption_status', '')) = 'VERIFIED'
      then 'VERIFIED' else 'TEMPORARY_ESTIMATE' end,
    left(coalesce(nullif(btrim(p_profile ->> 'source_reference'), ''), 'Packing entry'), 500),
    upper(coalesce(p_profile ->> 'assumption_status', '')) = 'VERIFIED',
    v_user_id,
    v_user_id
  )
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
      updated_at = now()
  returning packaging_profile_id into v_id;

  return jsonb_build_object('packaging_profile_id', v_id, 'saved_at', now());
end;
$$;

revoke all on function core.m18_save_packing_profile(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Dispatcher
-- ------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m18(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl_m18;
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
  v_method text := upper(coalesce(p_method, ''));
  v_payload jsonb;
begin
  if p_path in (
    '/v1/packing/worklist', '/v1/packing/profiles', '/v1/admin/legacy-issue-history'
  ) then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text into v_role
    from public.user_profiles
    where user_id = v_user_id and is_active;

    if v_method = 'GET' and p_path = '/v1/packing/worklist' then
      if coalesce(v_role, '') not in ('admin', 'picker', 'planner') then
        return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
      end if;
      return public.m09_result(200, core.m18_packing_worklist());
    end if;

    if v_method = 'POST' and p_path = '/v1/packing/profiles' then
      if coalesce(v_role, '') not in ('admin', 'picker') then
        return public.m09_error(403, 'forbidden', 'Admin or warehouse staff role is required', p_request_id);
      end if;
      if jsonb_typeof(p_body -> 'profile') is distinct from 'object' then
        return public.m09_error(422, 'validation_error', 'profile must be an object', p_request_id);
      end if;
      return public.m09_result(200, core.m18_save_packing_profile(p_body -> 'profile'));
    end if;

    if v_method = 'GET' and p_path = '/v1/admin/legacy-issue-history' then
      if coalesce(v_role, '') not in ('admin', 'planner') then
        return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
      end if;
      select jsonb_build_object(
        'total', count(*),
        'issued', count(*) filter (where outcome = 'issued'),
        'adjusted', count(*) filter (where outcome = 'adjusted'),
        'refused', count(*) filter (where outcome = 'refused'),
        'first_plan_date', min(plan_date),
        'last_plan_date', max(plan_date),
        'districts', count(distinct district_id),
        'materials', count(distinct material_id),
        'last_imported_at', max(updated_at)
      ) into v_payload
      from ops.legacy_issue_history;
      return public.m09_result(200, v_payload);
    end if;

    if v_method = 'POST' and p_path = '/v1/admin/legacy-issue-history' then
      if coalesce(v_role, '') <> 'admin' then
        return public.m09_error(403, 'forbidden', 'Admin role is required', p_request_id);
      end if;
      if jsonb_typeof(p_body -> 'rows') is distinct from 'array' then
        return public.m09_error(422, 'validation_error', 'rows must be an array', p_request_id);
      end if;
      return public.m09_result(200, core.m18_import_legacy_issue_history(
        p_body -> 'rows', p_body ->> 'source_file'
      ));
    end if;
  end if;

  return public.m09_dispatch_impl_m18(p_method, p_path, p_query, p_body, p_request_id);
exception
  when invalid_text_representation or numeric_value_out_of_range
    or not_null_violation or invalid_datetime_format or datetime_field_overflow then
    return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated;

commit;

-- Post-check (read only)
select
  to_regclass('ops.legacy_issue_history') is not null as legacy_history_ready,
  to_regprocedure('core.m18_packing_worklist()') is not null as packing_worklist_ready,
  jsonb_array_length(core.m18_packing_worklist()) as packing_lots;
