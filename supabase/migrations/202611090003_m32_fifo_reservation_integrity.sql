-- M32: a FIFO reservation can no longer promise the same Khlong Toei stock twice.
--
-- Since M29, locking a plan reserves handling units (HUs) first and guides the
-- rest from contract lots (core.m29_fifo_holds). The lots started from the
-- full Khlong Toei stock and ignored what HUs had already promised: with stock
-- 100 and HU 60 reserved for plan A, plan B could still be guided 100.
-- Two plans locked at the same moment also read the same free quantity.
--
-- 1. m29_fifo_holds: HU quantity still reserved, or issued after the latest
--    Stock คลังคลองเตย file, is taken from the front of the FIFO order
--    (it shows as used). Released lots (no 105 yet) are not Khlong Toei stock
--    and are not touched.
-- 2. reserve_fifo and m29_guide_item take one transaction lock, so FIFO
--    reservations run one at a time. Issue and cancel do not take it.
-- 3. Inside one plan lock the lot snapshot is taken once (M29); HU quantity
--    reserved after that snapshot is now taken from it as well.
--
-- reserve_fifo was patched by text in M29; it is written out in full here and
-- this file is now its definition.

begin;

create or replace function core.m29_fifo_holds()
returns table (
  material_id text,
  lot_key text,
  lot_kind text,
  purchase_order text,
  line_item text,
  contract_number text,
  lot_date date,
  hold_qty numeric,
  used_qty numeric,
  free_qty numeric,
  fifo_sequence integer,
  kt_snapshot_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
  with lots as (
    select * from core.m26_lot_rows()
  ), kt as (
    -- only the latest Stock คลังคลองเตย file: a code missing from it has no stock
    select s.material_id, sum(s.quantity_on_hand) as qty, max(s.snapshot_at) as snapshot_at
    from core.stock_snapshots s
    where s.location_id = 'WH-KT'
      and s.snapshot_at = (select max(x.snapshot_at) from core.stock_snapshots x where x.location_id = 'WH-KT')
    group by s.material_id
  ), hu as (
    -- M32: Khlong Toei stock already promised through handling units
    select k.material_id,
      coalesce((select sum(u.reserved_qty) from core.handling_units u
        where u.material_id = k.material_id and u.location_id = 'WH-KT'), 0)
      + coalesce((select sum(m.quantity) from core.inventory_movements m
        where m.material_id = k.material_id
          and m.movement_type = 'ISSUE'
          and m.handling_unit_id is not null
          and m.from_location_id = 'WH-KT'
          and m.occurred_at > k.snapshot_at), 0) as qty
    from kt k
  ), receipts as (
    select l.material_id, l.purchase_order, l.line_item, l.contract_number,
      coalesce(l.first_receipt, l.acceptance_date) as lot_date,
      coalesce(l.last_receipt, l.first_receipt, l.acceptance_date) as fill_date,
      l.received_qty as cap
    from lots l
    where l.status = 'ready' and l.received_qty > 0
  ), receipt_fill as (
    -- the newest receipts are still in the warehouse
    select r.*, k.qty as kt_qty,
      sum(r.cap) over (partition by r.material_id
        order by r.fill_date desc nulls last, r.purchase_order desc, r.line_item desc
        rows between unbounded preceding and current row) as cum_qty
    from receipts r
    join kt k on k.material_id = r.material_id
  ), holds as (
    select f.material_id, f.purchase_order || ':' || f.line_item as lot_key, 'receipt'::text as lot_kind,
      f.purchase_order, f.line_item, f.contract_number, f.lot_date,
      greatest(0::numeric, least(f.cap, f.kt_qty - (f.cum_qty - f.cap))) as hold_qty
    from receipt_fill f
    union all
    select k.material_id, 'unknown', 'unknown', null, null, null, null,
      greatest(0::numeric, k.qty - coalesce((select sum(r.cap) from receipts r where r.material_id = k.material_id), 0))
    from kt k
    union all
    select l.material_id, l.purchase_order || ':' || l.line_item, 'released',
      l.purchase_order, l.line_item, l.contract_number, l.acceptance_date, l.release_qty
    from lots l
    where l.release_counting and coalesce(l.release_qty, 0) > 0
  ), used as (
    select g.material_id, g.lot_key, sum(g.quantity) as qty
    from ops.m29_fifo_guidance g
    left join kt k on k.material_id = g.material_id
    where g.lot_kind <> 'short'
      and (g.status = 'reserved'
        or (g.status = 'issued' and g.issued_at > coalesce(k.snapshot_at, '-infinity'::timestamptz)))
    group by 1, 2
  ), base as (
    select h.*, coalesce(u.qty, 0) as guided_qty,
      greatest(0::numeric, h.hold_qty - coalesce(u.qty, 0)) as guide_free_qty,
      (row_number() over (partition by h.material_id
        order by (h.lot_kind = 'unknown') desc, h.lot_date nulls first, h.purchase_order, h.line_item))::integer as seq
    from holds h
    left join used u on u.material_id = h.material_id and u.lot_key = h.lot_key
    where h.hold_qty > 0
  ), with_hu as (
    -- HU quantity comes off the front of the FIFO order, Khlong Toei lots only
    select b.*,
      case when b.lot_kind = 'released' then 0::numeric
      else greatest(0::numeric, least(b.guide_free_qty,
        coalesce(hu.qty, 0)
        - (sum(b.guide_free_qty) filter (where b.lot_kind <> 'released')
             over (partition by b.material_id order by b.seq rows between unbounded preceding and current row)
           - b.guide_free_qty)))
      end as hu_qty
    from base b
    left join hu on hu.material_id = b.material_id
  )
  select w.material_id, w.lot_key, w.lot_kind, w.purchase_order, w.line_item, w.contract_number,
    w.lot_date, w.hold_qty, w.guided_qty + w.hu_qty, w.guide_free_qty - w.hu_qty, w.seq, k.snapshot_at
  from with_hu w
  left join kt k on k.material_id = w.material_id;
$$;

create or replace function core.m29_guide_item(p_item_id uuid, p_material_id text, p_quantity numeric)
returns numeric
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_plan_id uuid;
  v_left numeric := p_quantity;
  v_take numeric;
  v_seq integer;
  v_hold record;
begin
  if p_quantity is null or p_quantity <= 0 then
    return 0;
  end if;
  -- M32: one FIFO reservation at a time (same lock as reserve_fifo)
  perform pg_advisory_xact_lock(hashtextextended('synapse:fifo-reservation', 0));

  select replenishment_plan_id into v_plan_id
  from core.replenishment_items where replenishment_item_id = p_item_id;

  -- One snapshot of the lots per transaction (a plan lock guides many lines)
  if to_regclass('pg_temp.m29_holds_tx') is null then
    create temporary table m29_holds_tx on commit drop as
    select * from core.m29_fifo_holds();
  end if;

  select coalesce(max(sequence_no), 0) into v_seq
  from ops.m29_fifo_guidance where replenishment_item_id = p_item_id;

  for v_hold in
    select * from pg_temp.m29_holds_tx h
    where h.material_id = p_material_id and h.free_qty > 0
    order by h.fifo_sequence
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_hold.free_qty);
    v_seq := v_seq + 1;
    insert into ops.m29_fifo_guidance (replenishment_item_id, replenishment_plan_id, material_id, sequence_no,
      lot_kind, lot_key, purchase_order, line_item, contract_number, lot_date, quantity, created_by)
    values (p_item_id, v_plan_id, p_material_id, v_seq, v_hold.lot_kind, v_hold.lot_key,
      v_hold.purchase_order, v_hold.line_item, v_hold.contract_number, v_hold.lot_date, v_take, auth.uid());
    update pg_temp.m29_holds_tx h set free_qty = h.free_qty - v_take
    where h.material_id = p_material_id and h.lot_key = v_hold.lot_key;
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    v_seq := v_seq + 1;
    insert into ops.m29_fifo_guidance (replenishment_item_id, replenishment_plan_id, material_id, sequence_no,
      lot_kind, lot_key, quantity, created_by)
    values (p_item_id, v_plan_id, p_material_id, v_seq, 'short', 'short', v_left, auth.uid());
  end if;
  return p_quantity;
end;
$$;

create or replace function core.reserve_fifo(
  p_material_id text,
  p_location_id text,
  p_quantity numeric,
  p_replenishment_item_id uuid default null,
  p_ad_hoc_issue_id uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_remaining numeric := p_quantity;
  v_take numeric;
  v_sequence integer := 0;
  v_hu record;
  v_hu_taken numeric;
  v_hold record;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Allocation quantity must be positive';
  end if;
  if (p_replenishment_item_id is null) = (p_ad_hoc_issue_id is null) then
    raise exception 'Exactly one allocation source is required';
  end if;
  -- M32: one FIFO reservation at a time, so two plans cannot read the same free stock
  perform pg_advisory_xact_lock(hashtextextended('synapse:fifo-reservation', 0));

  for v_hu in
    select
      hu.handling_unit_id,
      hu.handling_unit_code,
      hu.available_qty - hu.reserved_qty as allocatable_qty
    from core.handling_units hu
    join core.receipt_lots lot using (receipt_lot_id)
    join core.contract_items ci using (contract_item_id)
    join core.contracts c using (contract_id)
    where hu.material_id = p_material_id
      and hu.location_id = p_location_id
      and (
        (
          hu.opening_status in ('OPEN', 'SEALED')
          and lot.traceability_status = 'complete'
        )
        or (
          hu.opening_status = 'OPENING_UNKNOWN'
          and lot.traceability_status = 'reconciled_actual_sources'
          and exists (
            select 1
            from reference_data.opening_balance_handling_unit_evidence evidence
            where evidence.handling_unit_id = hu.handling_unit_id
              and evidence.material_id = hu.material_id
              and btrim(evidence.verification_ticket) <> ''
              and evidence.verified_at is not null
          )
        )
      )
      and hu.available_qty > hu.reserved_qty
    order by
      case hu.opening_status
        when 'OPEN' then 0
        when 'SEALED' then 1
        else 2
      end,
      lot.acceptance_date,
      c.purchase_order,
      ci.line_item,
      ci.source_row_number,
      hu.handling_unit_code
    for update of hu
  loop
    exit when v_remaining <= 0;
    v_sequence := v_sequence + 1;
    v_take := least(v_remaining, v_hu.allocatable_qty);

    insert into ops.fifo_allocations (
      replenishment_item_id,
      ad_hoc_issue_id,
      handling_unit_id,
      allocation_sequence,
      allocated_qty,
      reserved_by
    )
    values (
      p_replenishment_item_id,
      p_ad_hoc_issue_id,
      v_hu.handling_unit_id,
      v_sequence,
      v_take,
      auth.uid()
    );

    update core.handling_units
    set reserved_qty = reserved_qty + v_take,
        updated_at = now()
    where handling_unit_id = v_hu.handling_unit_id;

    insert into core.inventory_movements (
      movement_type,
      material_id,
      handling_unit_id,
      from_location_id,
      quantity,
      replenishment_item_id,
      ad_hoc_issue_id,
      idempotency_key,
      reason,
      performed_by
    )
    values (
      'RESERVE',
      p_material_id,
      v_hu.handling_unit_id,
      p_location_id,
      v_take,
      p_replenishment_item_id,
      p_ad_hoc_issue_id,
      'reserve:' || coalesce(
        p_replenishment_item_id::text,
        p_ad_hoc_issue_id::text
      ) || ':' || v_hu.handling_unit_id::text,
      'FIFO reservation from verified legacy opening-balance reconciliation',
      auth.uid()
    );

    v_remaining := v_remaining - v_take;
  end loop;

  -- M32: the lot snapshot of this transaction was taken before these HUs were
  -- reserved; take the same quantity off the front of its Khlong Toei lots.
  v_hu_taken := p_quantity - v_remaining;
  if v_hu_taken > 0 and p_location_id = 'WH-KT' and to_regclass('pg_temp.m29_holds_tx') is not null then
    for v_hold in
      select h.lot_key, h.free_qty
      from pg_temp.m29_holds_tx h
      where h.material_id = p_material_id and h.lot_kind <> 'released' and h.free_qty > 0
      order by h.fifo_sequence
    loop
      exit when v_hu_taken <= 0;
      v_take := least(v_hu_taken, v_hold.free_qty);
      update pg_temp.m29_holds_tx h
      set free_qty = h.free_qty - v_take, used_qty = h.used_qty + v_take
      where h.material_id = p_material_id and h.lot_key = v_hold.lot_key;
      v_hu_taken := v_hu_taken - v_take;
    end loop;
  end if;

  if v_remaining > 0 and p_replenishment_item_id is not null then
    -- M29: no handling unit left; guide the rest from contract lots
    perform core.m29_guide_item(p_replenishment_item_id, p_material_id, v_remaining);
    v_remaining := 0;
  end if;
  if v_remaining > 0 then
    raise exception
      'Insufficient traceable FIFO stock for material %: shortage %',
      p_material_id,
      v_remaining;
  end if;
  return p_quantity;
end;
$$;

revoke all on function core.m29_fifo_holds() from public, anon, authenticated;
revoke all on function core.m29_guide_item(uuid, text, numeric) from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
