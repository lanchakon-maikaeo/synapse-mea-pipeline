-- M29: FIFO from รวมสัญญา + 105, recalculate a plan with the latest stock,
-- Khlong Toei stock beside every plan line.
--
-- 1. FIFO guidance from contract lots. The Khlong Toei stock (latest promoted
--    Stock คลังคลองเตย) is assumed to be the newest 105 receipts (older stock
--    has been issued first); whatever 105 cannot explain is
--    "ยอดยกมา ไม่ทราบสัญญา" and is issued first. Installments released by a
--    planner (passed inspection, no 105 yet) are lots of their own.
--    core.m29_fifo_holds() lists these lots with what is still free.
-- 2. Locking a plan no longer stops when there are no handling units: the
--    remaining quantity is written to ops.m29_fifo_guidance (lot by lot, FIFO),
--    and any quantity above the Khlong Toei stock is recorded as "short".
--    Issuing a locked plan works with guidance rows only.
-- 3. POST /v1/replenishment/plans/{id}/recalculate: lines not yet confirmed
--    by the district are recalculated with the latest stock; confirmed lines
--    and lines the planner added stay as they are.
-- 4. GET /v1/inventory/fifo also lists the contract lots; GET
--    /v1/replenishment/queue adds kt_stock_qty and the guidance quantity.

begin;

create table if not exists ops.m29_fifo_guidance (
  guidance_id uuid primary key default gen_random_uuid(),
  replenishment_item_id uuid not null references core.replenishment_items (replenishment_item_id) on delete restrict,
  replenishment_plan_id uuid not null references core.replenishment_plans (replenishment_plan_id) on delete restrict,
  material_id text not null references core.materials (material_id) on delete restrict,
  sequence_no integer not null check (sequence_no > 0),
  lot_kind text not null check (lot_kind in ('released', 'receipt', 'unknown', 'short')),
  lot_key text not null,
  purchase_order text,
  line_item text,
  contract_number text,
  lot_date date,
  quantity numeric not null check (quantity > 0),
  status text not null default 'reserved' check (status in ('reserved', 'issued', 'released')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  issued_at timestamptz,
  released_at timestamptz
);

create index if not exists m29_fifo_guidance_item_idx on ops.m29_fifo_guidance (replenishment_item_id);
create index if not exists m29_fifo_guidance_material_idx on ops.m29_fifo_guidance (material_id, status);

alter table ops.m29_fifo_guidance enable row level security;
revoke all on ops.m29_fifo_guidance from public, anon, authenticated;

create table if not exists ops.m29_plan_recalculations (
  recalculation_id uuid primary key default gen_random_uuid(),
  replenishment_plan_id uuid not null references core.replenishment_plans (replenishment_plan_id) on delete restrict,
  recalculated_by uuid references auth.users (id) on delete set null,
  recalculated_at timestamptz not null default now(),
  result jsonb not null
);

alter table ops.m29_plan_recalculations enable row level security;

create table if not exists ops.m29_recalculated_inputs (
  recalculated_input_id uuid primary key default gen_random_uuid(),
  replenishment_plan_id uuid not null references core.replenishment_plans (replenishment_plan_id) on delete restrict,
  replenishment_item_id uuid not null references core.replenishment_items (replenishment_item_id) on delete restrict,
  recalculated_at timestamptz not null,
  material_id text not null,
  district_id text not null,
  input_payload jsonb not null,
  input_sha256 text not null
);

alter table ops.m29_recalculated_inputs enable row level security;
revoke all on ops.m29_recalculated_inputs from public, anon, authenticated;
revoke all on ops.m29_plan_recalculations from public, anon, authenticated;

-- Khlong Toei lots and what is still free --------------------------------
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
  )
  select h.material_id, h.lot_key, h.lot_kind, h.purchase_order, h.line_item, h.contract_number,
    h.lot_date, h.hold_qty, coalesce(u.qty, 0),
    greatest(0::numeric, h.hold_qty - coalesce(u.qty, 0)),
    (row_number() over (partition by h.material_id
      order by (h.lot_kind = 'unknown') desc, h.lot_date nulls first, h.purchase_order, h.line_item))::integer,
    k.snapshot_at
  from holds h
  left join used u on u.material_id = h.material_id and u.lot_key = h.lot_key
  left join kt k on k.material_id = h.material_id
  where h.hold_qty > 0;
$$;

revoke all on function core.m29_fifo_holds() from public, anon, authenticated;

-- Write FIFO guidance for one plan line ----------------------------------
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

revoke all on function core.m29_guide_item(uuid, text, numeric) from public, anon, authenticated;

-- reserve_fifo: plan lines fall back to guidance instead of stopping -------
do $$
declare
  v_def text := pg_get_functiondef('core.reserve_fifo(text,text,numeric,uuid,uuid)'::regprocedure);
  v_new text;
  v_old_text text := $q$  if v_remaining > 0 then
    raise exception
      'Insufficient traceable FIFO stock for material %: shortage %',$q$;
  v_new_text text := $q$  if v_remaining > 0 and p_replenishment_item_id is not null then
    -- M29: no handling unit left; guide the rest from contract lots
    perform core.m29_guide_item(p_replenishment_item_id, p_material_id, v_remaining);
    v_remaining := 0;
  end if;
  if v_remaining > 0 then
    raise exception
      'Insufficient traceable FIFO stock for material %: shortage %',$q$;
  begin
  if position('M29: no handling unit left' in v_def) = 0 then
    v_new := replace(v_def, v_old_text, v_new_text);
    if length(v_new) - length(v_def) <> length(v_new_text) - length(v_old_text) then
      raise exception 'M29: reserve_fifo did not match the expected text';
    end if;
    execute v_new;
  end if;

  v_def := pg_get_functiondef('core.issue_replenishment_plan(uuid)'::regprocedure);
  v_old_text := $q$  if not found then
    raise exception 'Plan has no reserved FIFO allocations';$q$;
  v_new_text := $q$  if not found and not exists (
    -- M29: FIFO guidance from contract lots counts as the plan's allocation
    select 1 from ops.m29_fifo_guidance g
    where g.replenishment_plan_id = v_plan.replenishment_plan_id and g.status = 'reserved'
  ) then
    raise exception 'Plan has no reserved FIFO allocations';$q$;
  if position('M29: FIFO guidance' in v_def) = 0 then
    v_new := replace(v_def, v_old_text, v_new_text);
    if length(v_new) - length(v_def) <> length(v_new_text) - length(v_old_text) then
      raise exception 'M29: issue_replenishment_plan did not match the expected text';
    end if;
    execute v_new;
  end if;
end
$$;

-- Guidance follows the plan line: issued with it, released when cancelled
create or replace function ops.m29_guidance_follow_item()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
begin
  if new.status = 'issued' then
    update ops.m29_fifo_guidance set status = 'issued', issued_at = now()
    where replenishment_item_id = new.replenishment_item_id and status = 'reserved';
  elsif new.status in ('cancelled', 'district_rejected') then
    update ops.m29_fifo_guidance set status = 'released', released_at = now()
    where replenishment_item_id = new.replenishment_item_id and status = 'reserved';
  end if;
  return null;
end;
$$;

drop trigger if exists m29_guidance_follow_item on core.replenishment_items;
create trigger m29_guidance_follow_item
  after update of status on core.replenishment_items
  for each row
  when (new.status is distinct from old.status and new.status in ('issued', 'cancelled', 'district_rejected'))
  execute function ops.m29_guidance_follow_item();

-- Recalculation may replace the inputs of lines the district has not confirmed
create or replace function core.protect_replenishment_item_input()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if coalesce(current_setting('synapse.m29_recalculate', true), '') = 'on'
     and old.status in ('draft', 'pending', 'cancelled') then
    return new;
  end if;
  if (
    new.material_id,
    new.district_id,
    new.source_stock_snapshot_id,
    new.source_usage_rate_id,
    new.current_stock_qty,
    new.cmp_monthly,
    new.months_available,
    new.min_fill_qty,
    new.max_fill_qty,
    new.suggested_qty,
    new.source_stock_missing,
    new.priority_score,
    new.priority_band,
    new.input_data_class
  ) is distinct from (
    old.material_id,
    old.district_id,
    old.source_stock_snapshot_id,
    old.source_usage_rate_id,
    old.current_stock_qty,
    old.cmp_monthly,
    old.months_available,
    old.min_fill_qty,
    old.max_fill_qty,
    old.suggested_qty,
    old.source_stock_missing,
    old.priority_score,
    old.priority_band,
    old.input_data_class
  ) then
    raise exception
      'Replenishment item source input % is immutable; create a new plan version',
      old.replenishment_item_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Recalculate a plan with the latest stock -------------------------------
create or replace function core.m29_recalculate_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops, analytics
as $$
declare
  v_plan core.replenishment_plans%rowtype;
  v_run ops.replenishment_runs%rowtype;
  v_policy ops.calculation_policies%rowtype;
  v_cutoff_at timestamptz := statement_timestamp();
  v_cutoff_date date := (statement_timestamp() at time zone 'Asia/Bangkok')::date;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_dropped integer := 0;
  v_added integer := 0;
  v_kept integer := 0;
  v_result jsonb;
  v_note constant text := 'คำนวณใหม่ด้วย Stock ล่าสุด: ไม่ต้องเติมแล้ว';
begin
  select * into v_plan from core.replenishment_plans
  where replenishment_plan_id = p_plan_id for update;
  if not found then
    raise exception 'ไม่พบรอบแผนนี้';
  end if;
  if v_plan.status not in ('draft', 'pending_district_confirmation') then
    raise exception 'คำนวณใหม่ได้เฉพาะรอบแผนที่ยังรอเขตยืนยัน (สถานะตอนนี้ %)', v_plan.status;
  end if;
  select * into v_run from ops.replenishment_runs where replenishment_run_id = v_plan.replenishment_run_id;
  select * into v_policy from ops.calculation_policies where policy_version = v_run.policy_version;
  if not found then
    select * into v_policy from ops.calculation_policies where is_active;
  end if;

  drop table if exists pg_temp.m29_fresh;
  create temporary table m29_fresh on commit drop as
  select
    h.material_id, h.district_id, h.snapshot_id, h.usage_rate_id, h.current_stock_qty, h.cmp_monthly,
    h.months_available, h.source_stock_missing,
    core.round_replenishment(h.cmp_monthly * 4 - h.current_stock_qty) as min_fill_qty,
    core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty) as max_fill_qty,
    round((h.current_stock_qty + core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty)) / h.cmp_monthly, 2)
      as projected_months_after,
    round(greatest(1::numeric, least(10::numeric,
      ((1 - least(h.current_stock_qty / nullif(h.cmp_monthly * 6, 0), 1)) * 10) * 0.5
      + greatest(0::numeric, least(10::numeric, (30 - h.months_available * 30) / 3)) * 0.3
      + 5 * 0.2)), 1) as priority_score,
    case when h.months_available < 1.5 then 'critical'
      when h.months_available < 3.5 then 'high' else 'normal' end as priority_band
  from analytics.stock_health_at(v_cutoff_at) h
  where h.cmp_monthly > 0
    and h.usage_as_of_date between v_cutoff_date - 62
      and (date_trunc('month', v_cutoff_date) + interval '1 month - 1 day')::date
    and h.months_available <= (v_policy.parameters ->> 'months_trigger')::numeric
    and core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty) > 0;

  perform set_config('synapse.m29_recalculate', 'on', true);

  select count(*) into v_kept from core.replenishment_items i
  where i.replenishment_plan_id = p_plan_id
    and (i.status not in ('draft', 'pending', 'cancelled') or i.planner_source = 'added');

  -- lines still needed: new numbers (a quantity nobody edited follows the new suggestion)
  with changed as (
    update core.replenishment_items i
    set source_stock_snapshot_id = f.snapshot_id,
        source_usage_rate_id = f.usage_rate_id,
        current_stock_qty = f.current_stock_qty,
        cmp_monthly = f.cmp_monthly,
        months_available = f.months_available,
        min_fill_qty = f.min_fill_qty,
        max_fill_qty = f.max_fill_qty,
        suggested_qty = f.max_fill_qty,
        requested_qty = case when i.requested_qty is null or i.requested_qty = i.suggested_qty then f.max_fill_qty else i.requested_qty end,
        final_qty = case when i.final_qty is null or i.final_qty = i.suggested_qty then f.max_fill_qty else i.final_qty end,
        planner_qty = case when i.planner_qty = i.suggested_qty then f.max_fill_qty else i.planner_qty end,
        projected_months_after = f.projected_months_after,
        source_stock_missing = f.source_stock_missing,
        priority_score = f.priority_score,
        priority_band = f.priority_band,
        updated_at = now()
    from m29_fresh f
    where i.replenishment_plan_id = p_plan_id
      and i.status in ('draft', 'pending')
      and i.planner_source = 'system'
      and f.material_id = i.material_id and f.district_id = i.district_id
      and (i.source_stock_snapshot_id, i.source_usage_rate_id, i.current_stock_qty, i.cmp_monthly, i.suggested_qty)
        is distinct from (f.snapshot_id, f.usage_rate_id, f.current_stock_qty, f.cmp_monthly, f.max_fill_qty)
    returning i.*
  ), logged as (
    insert into ops.quantity_recommendations (replenishment_item_id, recommendation_version, method, recommended_qty, evidence, source_freshness_status)
    select c.replenishment_item_id,
      coalesce((select max(q.recommendation_version) from ops.quantity_recommendations q
        where q.replenishment_item_id = c.replenishment_item_id), 0) + 1,
      'BUSINESS_RULE_V1', c.suggested_qty,
      jsonb_build_object('recalculated_at', v_cutoff_at, 'policy_version', v_policy.policy_version,
        'current_stock_qty', c.current_stock_qty, 'cmp_monthly', c.cmp_monthly,
        'months_available', c.months_available, 'min_fill_qty', c.min_fill_qty, 'max_fill_qty', c.max_fill_qty,
        'source_stock_missing', c.source_stock_missing),
      case when c.source_stock_missing then 'source_missing_assumed_zero' else 'fresh' end
    from changed c
    returning 1
  )
  select count(*) into v_updated from logged;

  -- ops.replenishment_run_inputs keeps the first inputs of each line; later ones go here
  insert into ops.m29_recalculated_inputs (replenishment_plan_id, replenishment_item_id, recalculated_at,
    material_id, district_id, input_payload, input_sha256)
  select p_plan_id, i.replenishment_item_id, v_cutoff_at, i.material_id, i.district_id, p.payload,
    encode(extensions.digest(convert_to(p.payload::text, 'UTF8'), 'sha256'), 'hex')
  from core.replenishment_items i
  cross join lateral (select jsonb_build_object('material_id', i.material_id, 'district_id', i.district_id,
    'source_stock_snapshot_id', i.source_stock_snapshot_id, 'source_usage_rate_id', i.source_usage_rate_id,
    'current_stock_qty', i.current_stock_qty, 'cmp_monthly', i.cmp_monthly, 'months_available', i.months_available,
    'min_fill_qty', i.min_fill_qty, 'max_fill_qty', i.max_fill_qty, 'suggested_qty', i.suggested_qty,
    'source_stock_missing', i.source_stock_missing, 'priority_score', i.priority_score,
    'priority_band', i.priority_band, 'input_data_class', i.input_data_class,
    'snapshot_cutoff_at', v_cutoff_at, 'recalculated', true) as payload) p
  where i.replenishment_plan_id = p_plan_id and i.status in ('draft', 'pending') and i.updated_at = now()
    and i.planner_source = 'system';

  select count(*) into v_unchanged
  from core.replenishment_items i join m29_fresh f using (material_id, district_id)
  where i.replenishment_plan_id = p_plan_id and i.status in ('draft', 'pending')
    and i.planner_source = 'system' and i.updated_at <> now();

  -- lines no longer needed
  update core.replenishment_items i
  set status = 'cancelled', district_note = v_note, updated_at = now()
  where i.replenishment_plan_id = p_plan_id
    and i.status in ('draft', 'pending')
    and i.planner_source = 'system'
    and not exists (select 1 from m29_fresh f where f.material_id = i.material_id and f.district_id = i.district_id);
  get diagnostics v_dropped = row_count;

  -- lines a previous recalculation dropped come back
  update core.replenishment_items i
  set status = 'pending', district_note = null,
      source_stock_snapshot_id = f.snapshot_id, source_usage_rate_id = f.usage_rate_id,
      current_stock_qty = f.current_stock_qty, cmp_monthly = f.cmp_monthly, months_available = f.months_available,
      min_fill_qty = f.min_fill_qty, max_fill_qty = f.max_fill_qty, suggested_qty = f.max_fill_qty,
      requested_qty = f.max_fill_qty, final_qty = f.max_fill_qty, planner_qty = null,
      projected_months_after = f.projected_months_after, source_stock_missing = f.source_stock_missing,
      priority_score = f.priority_score, priority_band = f.priority_band, updated_at = now()
  from m29_fresh f
  where i.replenishment_plan_id = p_plan_id and i.status = 'cancelled' and i.district_note = v_note
    and f.material_id = i.material_id and f.district_id = i.district_id;
  get diagnostics v_added = row_count;

  -- new lines (the capture trigger records their inputs)
  with inserted as (
    insert into core.replenishment_items (replenishment_plan_id, material_id, district_id, source_stock_snapshot_id,
      source_usage_rate_id, current_stock_qty, cmp_monthly, months_available, min_fill_qty, max_fill_qty,
      suggested_qty, requested_qty, final_qty, projected_months_after, source_stock_missing, priority_score,
      priority_band, status)
    select p_plan_id, f.material_id, f.district_id, f.snapshot_id, f.usage_rate_id, f.current_stock_qty, f.cmp_monthly,
      f.months_available, f.min_fill_qty, f.max_fill_qty, f.max_fill_qty, f.max_fill_qty, f.max_fill_qty,
      f.projected_months_after, f.source_stock_missing, f.priority_score, f.priority_band, 'pending'
    from m29_fresh f
    where not exists (select 1 from core.replenishment_items i
      where i.replenishment_plan_id = p_plan_id and i.material_id = f.material_id and i.district_id = f.district_id)
    returning *
  ), logged as (
    insert into ops.quantity_recommendations (replenishment_item_id, method, recommended_qty, evidence, source_freshness_status)
    select n.replenishment_item_id, 'BUSINESS_RULE_V1', n.suggested_qty,
      jsonb_build_object('recalculated_at', v_cutoff_at, 'policy_version', v_policy.policy_version,
        'current_stock_qty', n.current_stock_qty, 'cmp_monthly', n.cmp_monthly,
        'months_available', n.months_available, 'min_fill_qty', n.min_fill_qty, 'max_fill_qty', n.max_fill_qty,
        'source_stock_missing', n.source_stock_missing),
      case when n.source_stock_missing then 'source_missing_assumed_zero' else 'fresh' end
    from inserted n
    returning 1
  )
  select v_added + count(*) into v_added from logged;

  perform set_config('synapse.m29_recalculate', '', true);

  update core.replenishment_plans
  set status = case when exists (select 1 from core.replenishment_items
        where replenishment_plan_id = p_plan_id and status not in ('cancelled'))
        then 'pending_district_confirmation' else status end,
      updated_at = now()
  where replenishment_plan_id = p_plan_id;

  v_result := jsonb_build_object(
    'replenishment_plan_id', p_plan_id,
    'recalculated_at', v_cutoff_at,
    'updated', v_updated, 'unchanged', v_unchanged, 'dropped', v_dropped,
    'added', v_added, 'kept_confirmed', v_kept);
  insert into ops.m29_plan_recalculations (replenishment_plan_id, recalculated_by, result)
  values (p_plan_id, auth.uid(), v_result);
  return v_result;
end;
$$;

revoke all on function core.m29_recalculate_plan(uuid) from public, anon, authenticated;

-- Dispatcher ---------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m29(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text) rename to m09_dispatch_impl_m29;
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
set statement_timeout = '60s'
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_result jsonb;
  v_plan_id uuid;
  v_writes boolean;
begin
  if upper(coalesce(p_method, '')) = 'POST'
     and p_path ~ '^/v1/replenishment/plans/[0-9a-fA-F-]{36}/recalculate$' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text into v_role from public.user_profiles where user_id = v_user_id and is_active;
    if coalesce(v_role, '') not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Admin or planner role is required', p_request_id);
    end if;
    select operational_writes_enabled into v_writes from ops.environment_controls where singleton;
    if not coalesce(v_writes, false) then
      return public.m09_error(423, 'production_not_ready', 'Operational writes are locked', p_request_id);
    end if;
    v_plan_id := substring(p_path from '^/v1/replenishment/plans/([0-9a-fA-F-]{36})/recalculate$')::uuid;
    begin
      return public.m09_result(200, core.m29_recalculate_plan(v_plan_id));
    exception when others then
      return public.m09_error(409, 'recalculate_failed', left(sqlerrm, 500), p_request_id);
    end;
  end if;

  v_result := public.m09_dispatch_impl_m29(p_method, p_path, p_query, p_body, p_request_id);

  if upper(coalesce(p_method, '')) <> 'GET'
     or coalesce((v_result ->> 'status')::integer, 0) <> 200
     or jsonb_typeof(v_result -> 'body') <> 'array' then
    return v_result;
  end if;

  -- Contract lots in the FIFO list (no handling units needed)
  if p_path = '/v1/inventory/fifo' then
    return jsonb_set(v_result, '{body}', (v_result -> 'body') || coalesce((
      select jsonb_agg(jsonb_build_object(
        'handling_unit_id', null,
        'handling_unit_code', case h.lot_kind
          when 'unknown' then 'ยอดยกมา ไม่ทราบสัญญา'
          when 'released' then 'PO ' || h.purchase_order || ' รายการ ' || h.line_item || ' · ผ่านตรวจรับ (รอ 105)'
          else 'PO ' || h.purchase_order || ' รายการ ' || h.line_item || coalesce(' · 105 ' || to_char(h.lot_date, 'DD/MM/YYYY'), '') end,
        'material_id', h.material_id,
        'material_name', m.material_name,
        'location_id', 'WH-KT',
        'unit_type', 'LOOSE',
        'opening_status', 'OPEN',
        'received_qty', h.hold_qty,
        'available_qty', h.hold_qty,
        'reserved_qty', h.used_qty,
        'allocatable_qty', h.free_qty,
        'receipt_lot_id', null,
        'lot_code', h.lot_key,
        'acceptance_date', h.lot_date,
        'installment_no', h.line_item,
        'traceability_status', case when h.lot_kind = 'unknown' then 'unknown_source' else 'contract_lots' end,
        'purchase_order', h.purchase_order,
        'line_item', h.line_item,
        'contract_number', coalesce(h.contract_number, case when h.lot_kind = 'unknown' then 'ไม่ทราบสัญญา' else 'ใบสั่ง ' || h.purchase_order end),
        'source_reference', 'M29 รวมสัญญา + 105 + Stock คลองเตย',
        'fifo_source', 'contract_lots',
        'fifo_sequence', 100000 + h.fifo_sequence
      ) order by h.material_id, h.fifo_sequence)
      from core.m29_fifo_holds() h
      left join core.materials m on m.material_id = h.material_id
      where nullif(p_query ->> 'material_id', '') is null or h.material_id = p_query ->> 'material_id'
    ), '[]'::jsonb));
  end if;

  -- Plan lines: Khlong Toei stock and FIFO guidance
  if p_path = '/v1/replenishment/queue' then
    return jsonb_set(v_result, '{body}', coalesce((
      with passed as (select * from core.m26_passed_test_qty()),
      kt_latest as (
        select s.material_id, sum(s.quantity_on_hand) as qty, max(s.snapshot_at) as snapshot_at
        from core.stock_snapshots s
        where s.location_id = 'WH-KT'
          and s.snapshot_at = (select max(x.snapshot_at) from core.stock_snapshots x where x.location_id = 'WH-KT')
        group by s.material_id)
      select jsonb_agg(
        r || jsonb_build_object(
          'kt_stock_qty', coalesce(k.qty, 0) + coalesce(pt.passed_test_qty, 0),
          'kt_stock_at', k.snapshot_at,
          'fifo_guidance_qty', coalesce(g.qty, 0),
          'fifo_short_qty', coalesce(g.short_qty, 0),
          'fifo_guidance', g.lots,
          'allocated_qty', coalesce((r ->> 'allocated_qty')::numeric, 0) + coalesce(g.qty, 0))
        order by ord)
      from jsonb_array_elements(v_result -> 'body') with ordinality as e(r, ord)
      left join kt_latest k on k.material_id = r ->> 'material_id'
      left join passed pt on pt.material_id = r ->> 'material_id'
      left join lateral (
        select sum(x.quantity) filter (where x.lot_kind <> 'short') as qty,
          sum(x.quantity) filter (where x.lot_kind = 'short') as short_qty,
          jsonb_agg(jsonb_build_object('sequence', x.sequence_no, 'lot_kind', x.lot_kind,
            'purchase_order', x.purchase_order, 'line_item', x.line_item,
            'contract_number', x.contract_number, 'lot_date', x.lot_date,
            'quantity', x.quantity, 'status', x.status) order by x.sequence_no) as lots
        from ops.m29_fifo_guidance x
        where x.replenishment_item_id::text = r ->> 'replenishment_item_id'
          and x.status in ('reserved', 'issued')) g on true
    ), '[]'::jsonb));
  end if;

  return v_result;
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text) to authenticated;

commit;

notify pgrst, 'reload schema';

select count(*) as contract_lot_holds, count(distinct material_id) as materials,
  sum(hold_qty) filter (where lot_kind = 'unknown') as unknown_qty,
  sum(hold_qty) filter (where lot_kind <> 'unknown') as lot_qty
from core.m29_fifo_holds();
