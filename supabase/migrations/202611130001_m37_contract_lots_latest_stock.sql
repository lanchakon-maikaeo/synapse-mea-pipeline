-- M37: ของเข้าคลังตามสัญญา shows Khlong Toei stock from the newest stock file only.
--
-- 1. kt_core took each code's last snapshot ever, so a code missing from the
--    newest file kept an old quantity (734 lots in production showed stale
--    stock, e.g. MP9-8942-MGB showed 100 from 8 Sep). Now only the newest
--    file counts; a code missing from it has 0 and is not marked in stock.
-- 2. A passed-test release keeps counting until a 105 posted BEFORE the stock
--    file date. The file is pulled in the morning, so a 105 keyed the same day
--    is not in it yet (was: on or before).
--
-- Written in full from M33 (no text patch).

begin;

CREATE OR REPLACE FUNCTION core.m26_lot_rows()
 RETURNS TABLE(material_id text, material_name text, unit text, purchase_order text, order_kind text, contract_number text, line_item text, installment_count integer, vendor text, quantity numeric, delivery_date date, acceptance_date date, received_qty numeric, receipt_count integer, first_receipt date, last_receipt date, in_stock boolean, kt_stock_qty numeric, kt_stock_date date, relevant boolean, status text, release_id uuid, release_qty numeric, release_counting boolean, released_by text, released_at timestamp with time zone, release_note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops'
AS $function$
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
    where c.source_kind = 'contracts' -- contracts_cumulative: missing lines keep their last values
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
  ), kt_latest as (
    -- the newest Khlong Toei stock file; a code missing from it has no stock
    select max(s.snapshot_at) as snapshot_at,
      (max(s.snapshot_at) at time zone 'Asia/Bangkok')::date as snapshot_date
    from core.stock_snapshots s
    where s.location_id = 'WH-KT'
  ), kt_core as (
    select s.material_id, sum(s.quantity_on_hand) as quantity_on_hand, max(k.snapshot_date) as snapshot_date
    from core.stock_snapshots s
    join kt_latest k on s.snapshot_at = k.snapshot_at
    where s.location_id = 'WH-KT'
    group by s.material_id
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
    coalesce(kc.snapshot_date, (select snapshot_date from kt_latest)),
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
        -- the stock file is pulled in the morning: a 105 posted on its date is
        -- not in it yet, so the release keeps counting until a newer file
        and r.posting_date < coalesce((select snapshot_date from kt_latest), 'infinity'::date))) as release_counting,
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
$function$;

revoke all on function core.m26_lot_rows() from public, anon, authenticated;

commit;
