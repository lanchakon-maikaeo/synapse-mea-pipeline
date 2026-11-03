-- M26: ของเข้าคลังตามสัญญา — match รวมสัญญา with 105 and Stock, and let the
-- planner release lots that passed inspection but have no 105 in SAP yet.
--
-- รวมสัญญา holds every contract of the authority, most of them not ours.
-- A contract line (PO + material + งวด) is ours when its material is in the
-- Khlong Toei stock or its PO + material was ever received with 105.
--
-- Per installment:
--   ready            105 posted (with or without วันผ่านตรวจรับ)  → จ่ายได้
--   awaiting_105     วันผ่านตรวจรับ set, no 105 yet               → planner may release
--   confirmed        awaiting_105 + planner release              → counted as stock
--   accepted_before  accepted before the 105 history starts (old, not actionable)
--   overdue / pending  not yet accepted
--
-- 105 is a history: a newer 105 export covers only a date range, so every
-- 105 row ever imported is used (missing_since_run_id is ignored), de-duplicated
-- by material document + item.
--
-- A release adds its quantity to the Khlong Toei stock returned by
-- /v1/warehouse-stock until a 105 for that installment is posted on or before
-- the stock snapshot date — then SAP stock already contains it.
--
--   GET  /v1/contract-lots[?scope=all]   worklist (all signed-in roles except district)
--   POST /v1/contract-lots/confirm       {purchase_order, material_id, line_item, quantity, note}
--   POST /v1/contract-lots/cancel        {release_id, reason}
--   GET  /v1/warehouse-stock             M11 result + released quantity (proxy routes it here)

begin;

create table if not exists ops.passed_test_releases (
  release_id uuid primary key default gen_random_uuid(),
  material_id text not null,
  purchase_order text not null,
  line_item text not null,
  contract_number text,
  quantity numeric not null check (quantity > 0),
  acceptance_date date,
  note text,
  confirmed_by uuid not null,
  confirmed_by_name text,
  confirmed_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancelled_by_name text,
  cancel_reason text
);

create unique index if not exists passed_test_releases_active_uq
  on ops.passed_test_releases (material_id, purchase_order, line_item)
  where cancelled_at is null;

alter table ops.passed_test_releases enable row level security;
revoke all on ops.passed_test_releases from public, anon, authenticated;

-- One row per contract installment (and per 105 lot without a contract line)
create or replace function core.m26_lot_rows()
returns table (
  material_id text,
  material_name text,
  unit text,
  purchase_order text,
  order_kind text,
  contract_number text,
  line_item text,
  installment_count integer,
  vendor text,
  quantity numeric,
  delivery_date date,
  acceptance_date date,
  received_qty numeric,
  receipt_count integer,
  first_receipt date,
  last_receipt date,
  in_stock boolean,
  kt_stock_qty numeric,
  kt_stock_date date,
  relevant boolean,
  status text,
  release_id uuid,
  release_qty numeric,
  release_counting boolean,
  released_by text,
  released_at timestamptz,
  release_note text
)
language sql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
  with params as (
    select (now() at time zone 'Asia/Bangkok')::date as today
  ), contracts as (
    select
      right(regexp_replace(c.payload ->> 'material_code', '\D', '', 'g'), 12) as material_id,
      regexp_replace(coalesce(c.payload ->> 'purchase_order', ''), '\D', '', 'g') as purchase_order,
      regexp_replace(btrim(coalesce(c.payload ->> 'line_item', '')), '^0+(?=\d)', '') as line_item,
      nullif(btrim(c.payload ->> 'contract_number'), '') as contract_number,
      nullif(btrim(c.payload ->> 'vendor'), '') as vendor,
      nullif(btrim(c.payload ->> 'item_description'), '') as description,
      nullif(btrim(c.payload ->> 'unit'), '') as unit,
      coalesce(nullif(regexp_replace(c.payload ->> 'quantity', '[^0-9.\-]', '', 'g'), '')::numeric, 0) as quantity,
      case when c.payload ->> 'delivery_date' ~ '^\d{4}-\d{2}-\d{2}'
        then left(c.payload ->> 'delivery_date', 10)::date end as delivery_date,
      case when c.payload ->> 'acceptance_date' ~ '^\d{4}-\d{2}-\d{2}'
        then left(c.payload ->> 'acceptance_date', 10)::date end as acceptance_date
    from ops.source_current_rows c
    where c.source_kind = 'contracts'
      and c.missing_since_run_id is null
      and regexp_replace(coalesce(c.payload ->> 'material_code', ''), '\D', '', 'g') <> ''
  ), receipts_raw as (
    select distinct on (
      r.payload ->> 'material_document',
      coalesce(nullif(r.payload ->> 'material_document_item', ''), r.payload ->> 'item', ''),
      right(regexp_replace(r.payload ->> 'material_code', '\D', '', 'g'), 12))
      right(regexp_replace(r.payload ->> 'material_code', '\D', '', 'g'), 12) as material_id,
      regexp_replace(coalesce(r.payload ->> 'purchase_order', ''), '\D', '', 'g') as purchase_order,
      nullif(regexp_replace(btrim(coalesce(
        nullif(r.payload ->> 'po_item', ''),
        case when coalesce(r.payload ->> 'source_layout', '') = '' then r.payload ->> 'item' end,
        '')), '^0+(?=\d)', ''), '') as line_item,
      coalesce(nullif(regexp_replace(r.payload ->> 'quantity', '[^0-9.\-]', '', 'g'), '')::numeric, 0) as quantity,
      case when r.payload ->> 'posting_date' ~ '^\d{4}-\d{2}-\d{2}'
        then left(r.payload ->> 'posting_date', 10)::date end as posting_date,
      nullif(btrim(r.payload ->> 'item_description'), '') as description,
      nullif(btrim(r.payload ->> 'unit'), '') as unit
    from ops.source_current_rows r
    where r.source_kind = 'receipts_105'
    order by
      r.payload ->> 'material_document',
      coalesce(nullif(r.payload ->> 'material_document_item', ''), r.payload ->> 'item', ''),
      right(regexp_replace(r.payload ->> 'material_code', '\D', '', 'g'), 12),
      r.last_changed_run_id
  ), receipts as (
    -- 105 layouts without the PO line: the installment accepted on the posting
    -- date, else the first installment of that PO + material
    select r.material_id, r.purchase_order, r.quantity, r.posting_date, r.description, r.unit,
      coalesce(r.line_item, (
        select c.line_item from contracts c
        where c.material_id = r.material_id and c.purchase_order = r.purchase_order
        order by (c.acceptance_date = r.posting_date) desc nulls last,
          nullif(regexp_replace(c.line_item, '\D', '', 'g'), '')::numeric nulls last
        limit 1), '') as line_item
    from receipts_raw r
  ), receipt_totals as (
    select material_id, purchase_order, line_item,
      sum(quantity) as received_qty, count(*)::integer as receipt_count,
      min(posting_date) as first_receipt, max(posting_date) as last_receipt,
      max(description) as description, max(unit) as unit
    from receipts
    group by 1, 2, 3
  ), coverage as (
    select min(posting_date) as start_date from receipts
  ), kt_import as (
    select right(regexp_replace(s.payload ->> 'material_id', '\D', '', 'g'), 12) as material_id,
      sum(coalesce(nullif(regexp_replace(s.payload ->> 'unrestricted_qty', '[^0-9.\-]', '', 'g'), '')::numeric, 0)) as qty,
      max(s.payload ->> 'material_name') as material_name
    from ops.source_current_rows s
    where s.source_kind = 'stock' and s.missing_since_run_id is null
      and s.payload ->> 'warehouse_id' = 'WH-KT'
    group by 1
  ), kt_core as (
    select distinct on (s.material_id) s.material_id, s.quantity_on_hand,
      (s.snapshot_at at time zone 'Asia/Bangkok')::date as snapshot_date
    from core.stock_snapshots s
    where s.location_id = 'WH-KT'
    order by s.material_id, s.snapshot_at desc
  ), lines as (
    select c.material_id, c.purchase_order, c.line_item, c.contract_number, c.vendor,
      c.description, c.unit, c.quantity, c.delivery_date, c.acceptance_date
    from contracts c
    union all
    -- 105 lots with no contract line at all
    select t.material_id, t.purchase_order, t.line_item, null, null,
      t.description, t.unit, null, null, null
    from receipt_totals t
    where not exists (select 1 from contracts c
      where c.material_id = t.material_id and c.purchase_order = t.purchase_order
        and c.line_item = t.line_item)
  ), counted as (
    select l.*,
      count(*) over (partition by l.material_id, l.purchase_order) as installment_count,
      bool_or(t.receipt_count is not null) over (partition by l.material_id, l.purchase_order) as po_received
    from lines l
    left join receipt_totals t using (material_id, purchase_order, line_item)
  )
  select
    l.material_id,
    coalesce(m.material_name, l.description, ki.material_name) as material_name,
    coalesce(l.unit, m.unit) as unit,
    l.purchase_order,
    case when l.quantity is null then 'no_contract'
      when l.contract_number is not null then 'contract' else 'order' end as order_kind,
    l.contract_number,
    l.line_item,
    l.installment_count::integer,
    l.vendor,
    l.quantity,
    l.delivery_date,
    l.acceptance_date,
    coalesce(t.received_qty, 0),
    coalesce(t.receipt_count, 0),
    t.first_receipt,
    t.last_receipt,
    (ki.material_id is not null or kc.material_id is not null) as in_stock,
    coalesce(ki.qty, kc.quantity_on_hand, 0) as kt_stock_qty,
    kc.snapshot_date,
    (ki.material_id is not null or kc.material_id is not null or l.po_received or rel.release_id is not null) as relevant,
    case
      when t.receipt_count is not null then 'ready'
      when l.acceptance_date is not null and rel.release_id is not null then 'confirmed'
      when l.acceptance_date is not null
        and l.acceptance_date >= coalesce((select start_date from coverage), l.acceptance_date) then 'awaiting_105'
      when l.acceptance_date is not null then 'accepted_before'
      when l.delivery_date is not null and l.delivery_date < (select today from params) then 'overdue'
      else 'pending'
    end as status,
    rel.release_id,
    rel.quantity,
    (rel.release_id is not null and not exists (
      select 1 from receipts r
      where r.material_id = l.material_id and r.purchase_order = l.purchase_order
        and r.line_item = l.line_item
        and r.posting_date <= coalesce(kc.snapshot_date, 'infinity'::date))) as release_counting,
    rel.confirmed_by_name,
    rel.confirmed_at,
    rel.note
  from counted l
  left join receipt_totals t using (material_id, purchase_order, line_item)
  left join core.materials m on m.material_id = l.material_id
  left join kt_import ki on ki.material_id = l.material_id
  left join kt_core kc on kc.material_id = l.material_id
  left join ops.passed_test_releases rel
    on rel.material_id = l.material_id and rel.purchase_order = l.purchase_order
   and rel.line_item = l.line_item and rel.cancelled_at is null;
$$;

-- Quantity released by planners that SAP stock does not contain yet
create or replace function core.m26_passed_test_qty()
returns table (material_id text, passed_test_qty numeric, release_count integer)
language sql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
  select l.material_id, sum(l.release_qty), count(*)::integer
  from core.m26_lot_rows() l
  where l.release_counting
  group by l.material_id;
$$;

create or replace function core.m26_contract_lots(p_scope text default 'relevant')
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
  with rows as (select * from core.m26_lot_rows()),
  shown as (
    select * from rows
    where coalesce(p_scope, 'relevant') = 'all' or relevant
  )
  select jsonb_build_object(
    'scope', case when p_scope = 'all' then 'all' else 'relevant' end,
    'summary', jsonb_build_object(
      'contract_lines', (select count(*) from rows where order_kind <> 'no_contract'),
      'relevant_lines', (select count(*) from rows where relevant and order_kind <> 'no_contract'),
      'ready', (select count(*) from rows where relevant and status = 'ready'),
      'awaiting_105', (select count(*) from rows where relevant and status = 'awaiting_105'),
      'confirmed', (select count(*) from rows where relevant and status = 'confirmed'),
      'overdue', (select count(*) from rows where relevant and status = 'overdue'),
      'pending', (select count(*) from rows where relevant and status = 'pending'),
      'accepted_before', (select count(*) from rows where relevant and status = 'accepted_before'),
      'no_contract', (select count(*) from rows where order_kind = 'no_contract'),
      'receipts_from', (select min(first_receipt) from rows),
      'receipts_to', (select max(last_receipt) from rows),
      'released_counting_qty_materials', (select count(distinct material_id) from rows where release_counting)
    ),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(s) order by
        array_position(array['awaiting_105', 'confirmed', 'ready', 'overdue', 'pending', 'accepted_before'], s.status),
        s.acceptance_date desc nulls last, s.last_receipt desc nulls last,
        s.material_id, s.purchase_order, s.line_item)
      from shown s), '[]'::jsonb)
  );
$$;

create or replace function core.m26_confirm_release(p_body jsonb, p_user uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_material text := right(regexp_replace(coalesce(p_body ->> 'material_id', ''), '\D', '', 'g'), 12);
  v_po text := regexp_replace(coalesce(p_body ->> 'purchase_order', ''), '\D', '', 'g');
  v_line text := regexp_replace(btrim(coalesce(p_body ->> 'line_item', '')), '^0+(?=\d)', '');
  v_qty numeric := nullif(regexp_replace(coalesce(p_body ->> 'quantity', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_lot record;
  v_id uuid;
begin
  select * into v_lot from core.m26_lot_rows() l
  where l.material_id = v_material and l.purchase_order = v_po and l.line_item = v_line
    and l.order_kind <> 'no_contract';
  if not found then
    raise exception 'ไม่พบงวด % ของใบสั่งซื้อ % รหัสพัสดุ % ในรวมสัญญา', v_line, v_po, v_material;
  end if;
  if v_lot.status = 'ready' then
    raise exception 'งวดนี้มี 105 แล้ว จ่ายได้ตาม Stock SAP ไม่ต้องยืนยัน';
  end if;
  if v_lot.status = 'confirmed' then
    raise exception 'งวดนี้ยืนยันจ่ายได้ไว้แล้ว';
  end if;
  if v_lot.acceptance_date is null then
    raise exception 'งวดนี้ยังไม่มีวันผ่านตรวจรับในรวมสัญญา';
  end if;
  if v_qty is null or v_qty <= 0 then
    raise exception 'จำนวนต้องมากกว่า 0';
  end if;
  if v_qty > v_lot.quantity then
    raise exception 'จำนวน % มากกว่าจำนวนของงวด (%)', v_qty, v_lot.quantity;
  end if;

  insert into ops.passed_test_releases (material_id, purchase_order, line_item, contract_number,
    quantity, acceptance_date, note, confirmed_by, confirmed_by_name)
  values (v_material, v_po, v_line, v_lot.contract_number, v_qty, v_lot.acceptance_date,
    nullif(btrim(p_body ->> 'note'), ''), p_user, p_name)
  returning release_id into v_id;

  return jsonb_build_object('release_id', v_id, 'material_id', v_material,
    'purchase_order', v_po, 'line_item', v_line, 'quantity', v_qty);
end;
$$;

create or replace function core.m26_cancel_release(p_body jsonb, p_user uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_id uuid;
begin
  update ops.passed_test_releases
  set cancelled_at = now(), cancelled_by = p_user, cancelled_by_name = p_name,
      cancel_reason = nullif(btrim(p_body ->> 'reason'), '')
  where release_id = nullif(p_body ->> 'release_id', '')::uuid
    and cancelled_at is null
  returning release_id into v_id;
  if v_id is null then
    raise exception 'ไม่พบรายการยืนยันที่ยังใช้งานอยู่';
  end if;
  return jsonb_build_object('release_id', v_id, 'cancelled', true);
end;
$$;

revoke all on function core.m26_lot_rows() from public, anon, authenticated;
revoke all on function core.m26_passed_test_qty() from public, anon, authenticated;
revoke all on function core.m26_contract_lots(text) from public, anon, authenticated;
revoke all on function core.m26_confirm_release(jsonb, uuid, text) from public, anon, authenticated;
revoke all on function core.m26_cancel_release(jsonb, uuid, text) from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m26(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text) rename to m09_dispatch_impl_m26;
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
  v_name text;
  v_result jsonb;
  v_rows jsonb;
begin
  if p_path in ('/v1/contract-lots', '/v1/contract-lots/confirm', '/v1/contract-lots/cancel') then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text, display_name into v_role, v_name
    from public.user_profiles where user_id = v_user_id and is_active;
    if p_path = '/v1/contract-lots' then
      if upper(p_method) <> 'GET' then
        return public.m09_error(405, 'method_not_allowed', 'Method not allowed', p_request_id);
      end if;
      if coalesce(v_role, '') not in ('admin', 'planner', 'picker', 'academic', 'viewer') then
        return public.m09_error(403, 'forbidden', 'Role not allowed', p_request_id);
      end if;
      return public.m09_result(200, core.m26_contract_lots(p_query ->> 'scope'));
    end if;
    if upper(p_method) <> 'POST' then
      return public.m09_error(405, 'method_not_allowed', 'Method not allowed', p_request_id);
    end if;
    if coalesce(v_role, '') not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Admin or planner role is required', p_request_id);
    end if;
    if p_path = '/v1/contract-lots/confirm' then
      return public.m09_result(200, core.m26_confirm_release(p_body, v_user_id, coalesce(v_name, v_user_id::text)));
    end if;
    return public.m09_result(200, core.m26_cancel_release(p_body, v_user_id, coalesce(v_name, v_user_id::text)));
  end if;

  -- /v1/warehouse-stock lives in the M11 legacy dispatcher; the proxy now sends it here
  if p_path = '/v1/warehouse-stock' then
    v_result := public.m11_legacy_dispatch(p_method, p_path, p_query, p_body, p_request_id);
  else
    return public.m09_dispatch_impl_m26(p_method, p_path, p_query, p_body, p_request_id);
  end if;

  -- Khlong Toei stock + quantity released by planners (passed inspection, no 105 yet)
  if p_path = '/v1/warehouse-stock' and upper(p_method) = 'GET'
     and (v_result ->> 'status')::integer = 200
     and jsonb_typeof(v_result -> 'body') = 'array'
     and exists (select 1 from core.m26_passed_test_qty()) then
    select coalesce(jsonb_agg(
      case when r ->> 'location_id' = 'WH-KT' and p.material_id is not null then
        r || jsonb_build_object(
          'sap_quantity', r -> 'quantity_on_hand',
          'passed_test_qty', p.passed_test_qty,
          'quantity_on_hand', coalesce((r ->> 'quantity_on_hand')::numeric, 0) + p.passed_test_qty)
      else r end), '[]'::jsonb)
    into v_rows
    from jsonb_array_elements(v_result -> 'body') r
    left join core.m26_passed_test_qty() p on p.material_id = r ->> 'material_id';

    select v_rows || coalesce(jsonb_agg(jsonb_build_object(
      'material_id', p.material_id, 'material_name', m.material_name, 'unit', m.unit,
      'location_id', 'WH-KT', 'location_name_th', l.location_name_th,
      'quantity_on_hand', p.passed_test_qty, 'sap_quantity', 0,
      'passed_test_qty', p.passed_test_qty, 'snapshot_at', null)), '[]'::jsonb)
    into v_rows
    from core.m26_passed_test_qty() p
    left join core.materials m on m.material_id = p.material_id
    left join core.locations l on l.location_id = 'WH-KT'
    where not exists (select 1 from jsonb_array_elements(v_rows) r
      where r ->> 'location_id' = 'WH-KT' and r ->> 'material_id' = p.material_id);

    v_result := jsonb_set(v_result, '{body}', v_rows);
  end if;
  return v_result;
exception
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text) to authenticated;

commit;

select core.m26_contract_lots() -> 'summary' as summary;
