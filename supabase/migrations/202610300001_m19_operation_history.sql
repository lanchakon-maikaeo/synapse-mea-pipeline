-- M19: One operation history for everything that happened in the warehouse flow.
--
-- Combines into one event stream (newest first):
--   * plans: created, planner quantity adjustments, planner / academic approval, lock,
--     cancel, new version
--   * district responses: confirm / reject (incl. legacy "ไม่รับของ")
--   * abnormal change requests: requested / approved / rejected
--   * issues: FIFO issue movements (plan + ad hoc), returns, legacy issued / adjusted
--   * ad hoc requests: requested / approved / rejected
--   * stock movements: receipt, damage, quarantine, adjustment
--   * transport trips
-- plus a weekly summary (planned lines, on-plan / adjusted / refused / pending,
-- issued quantity) and a per-district summary with refusal rate.
--
-- Read only. Route: GET /v1/history (all roles; district users see their district only).

begin;

-- ------------------------------------------------------------------
-- Legacy history: the workbook identifies districts by SAP plant code
-- (สามเสน = 5601) while SYNAPSE uses district_id (สามเสน = 5502).
-- Normalize on write so old and new history land on the same district.
-- row_key is left as computed from the uploaded value, so re-uploading the
-- same file still updates rows instead of duplicating them.
-- ------------------------------------------------------------------
create or replace function ops.legacy_issue_history_district_map()
returns trigger
language plpgsql
set search_path = pg_catalog, core, ops
as $$
declare
  v_mapped text;
begin
  if not exists (select 1 from core.districts d where d.district_id = new.district_id) then
    select d.district_id into v_mapped
    from core.districts d
    where d.sap_plant_code = new.district_id
    limit 1;
    if v_mapped is not null then
      new.district_id := v_mapped;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists legacy_issue_history_district_map on ops.legacy_issue_history;
create trigger legacy_issue_history_district_map
  before insert or update of district_id on ops.legacy_issue_history
  for each row execute function ops.legacy_issue_history_district_map();

update ops.legacy_issue_history l
set district_id = d.district_id, updated_at = now()
from core.districts d
where d.sap_plant_code = l.district_id
  and not exists (select 1 from core.districts x where x.district_id = l.district_id);

-- ------------------------------------------------------------------
-- Event stream
-- ------------------------------------------------------------------
create or replace view ops.v_operation_history as
with item_ctx as (
  select
    i.replenishment_item_id,
    i.replenishment_plan_id,
    i.material_id,
    i.district_id,
    coalesce(i.planner_qty, i.suggested_qty) as planned_qty,
    i.final_qty,
    p.plan_number
  from core.replenishment_items i
  join core.replenishment_plans p on p.replenishment_plan_id = i.replenishment_plan_id
)
-- Plan created
select
  'plan-created:' || p.replenishment_plan_id::text as event_id,
  p.created_at as event_at,
  'plan'::text as category,
  'plan_created'::text as event_type,
  'synapse'::text as source,
  null::text as district_id,
  null::text as material_id,
  null::text as material_name,
  (select count(*) from core.replenishment_items x
   where x.replenishment_plan_id = p.replenishment_plan_id)::numeric as qty,
  null::numeric as ref_qty,
  p.replenishment_plan_id as plan_id,
  p.plan_number,
  'สัปดาห์ ' || coalesce(to_char(p.week_start_date, 'YYYY-MM-DD'), '-') as reference,
  p.status,
  null::text as note,
  p.created_by as actor_id,
  null::text as actor_text
from core.replenishment_plans p

union all
-- Plan locked
select
  'plan-locked:' || p.replenishment_plan_id::text, p.locked_at, 'plan', 'plan_locked', 'synapse',
  null, null, null, null, null, p.replenishment_plan_id, p.plan_number, null, p.status, null,
  p.locked_by, null
from core.replenishment_plans p
where p.locked_at is not null

union all
-- Plan-level approvals (planner, academic, cancel, version)
select
  'approval:' || a.plan_approval_id::text, a.acted_at, 'plan',
  case a.approval_stage
    when 'planner' then 'plan_planner_approved'
    when 'academic' then 'plan_academic_approved'
    when 'cancel' then 'plan_cancelled'
    when 'version' then 'plan_version'
    when 'lock' then 'plan_lock_logged'
    else 'plan_' || a.approval_stage
  end,
  'synapse', a.district_id, null, null, null, null,
  a.replenishment_plan_id, p.plan_number, null, a.decision, a.note, a.actor_id, null
from ops.plan_approvals a
join core.replenishment_plans p on p.replenishment_plan_id = a.replenishment_plan_id
where a.approval_stage <> 'district_response' and a.approval_stage <> 'lock'

union all
-- District responses (item level)
select
  'approval:' || a.plan_approval_id::text, a.acted_at, 'district',
  case a.decision when 'rejected' then 'district_rejected' else 'district_confirmed' end,
  'synapse', coalesce(a.district_id, c.district_id), c.material_id, null,
  c.final_qty, c.planned_qty,
  a.replenishment_plan_id, c.plan_number, null, a.decision, a.note, a.actor_id, null
from ops.plan_approvals a
join item_ctx c on c.replenishment_item_id = a.replenishment_item_id
where a.approval_stage = 'district_response'

union all
-- Planner quantity adjustments
select
  'adjust:' || r.adjustment_id::text, r.adjusted_at, 'plan', 'qty_adjusted', 'synapse',
  c.district_id, c.material_id, null, r.new_qty, r.previous_qty,
  c.replenishment_plan_id, c.plan_number, null, null, r.adjustment_reason, r.adjusted_by, null
from ops.replenishment_adjustments r
join item_ctx c on c.replenishment_item_id = r.replenishment_item_id

union all
-- Abnormal change request: raised
select
  'change-req:' || d.change_request_id::text, d.requested_at, 'change', 'change_requested', 'synapse',
  c.district_id, c.material_id, null, d.requested_qty, d.baseline_qty,
  c.replenishment_plan_id, c.plan_number,
  case when d.exceeds_six_months then 'เกิน 6 เดือน' end,
  d.risk_level, d.reason, d.requested_by, d.requester_name
from ops.district_change_requests d
join item_ctx c on c.replenishment_item_id = d.replenishment_item_id

union all
-- Abnormal change request: reviewed
select
  'change-review:' || d.change_request_id::text, d.reviewed_at, 'change',
  case d.status when 'approved' then 'change_approved'
    when 'rejected' then 'change_rejected' else 'change_cancelled' end,
  'synapse', c.district_id, c.material_id, null, d.requested_qty, d.baseline_qty,
  c.replenishment_plan_id, c.plan_number, null, d.status, d.review_note, d.reviewed_by, null
from ops.district_change_requests d
join item_ctx c on c.replenishment_item_id = d.replenishment_item_id
where d.reviewed_at is not null

union all
-- Ad hoc request raised
select
  'adhoc-req:' || h.ad_hoc_issue_id::text, h.requested_at, 'adhoc', 'adhoc_requested', 'synapse',
  h.district_id, h.material_id, null, h.requested_qty, null, null, null,
  h.issue_number, h.status, h.reason, h.requested_by, h.requester_name
from ops.ad_hoc_issues h

union all
-- Ad hoc approved / rejected
select
  'adhoc-decision:' || h.ad_hoc_issue_id::text, h.approved_at, 'adhoc',
  case when h.status = 'rejected' then 'adhoc_rejected' else 'adhoc_approved' end,
  'synapse', h.district_id, h.material_id, null, h.requested_qty, null, null, null,
  h.issue_number, h.status, h.approval_note, h.approved_by, null
from ops.ad_hoc_issues h
where h.approved_at is not null

union all
-- Inventory movements (issue, return, receipt, damage, quarantine, adjustment)
select
  'move:' || m.inventory_movement_id::text, m.occurred_at,
  case
    when m.movement_type in ('ISSUE', 'RETURN') then 'issue'
    else 'stock'
  end,
  case
    when m.movement_type = 'ISSUE' and m.ad_hoc_issue_id is not null then 'issue_adhoc'
    when m.movement_type = 'ISSUE' then 'issue'
    else lower(m.movement_type)
  end,
  'synapse',
  coalesce(c.district_id, h.district_id, sc.district_id, sh.district_id),
  m.material_id, null, m.quantity,
  case when m.movement_type = 'ISSUE' then coalesce(c.final_qty, h.requested_qty) end,
  coalesce(c.replenishment_plan_id, sc.replenishment_plan_id),
  coalesce(c.plan_number, sc.plan_number),
  concat_ws(' · ', hu.handling_unit_code, rl.lot_code, h.issue_number),
  m.movement_type, m.reason, m.performed_by, null
from core.inventory_movements m
left join item_ctx c on c.replenishment_item_id = m.replenishment_item_id
left join ops.ad_hoc_issues h on h.ad_hoc_issue_id = m.ad_hoc_issue_id
left join core.inventory_movements src on src.inventory_movement_id = m.source_movement_id
left join item_ctx sc on sc.replenishment_item_id = src.replenishment_item_id
left join ops.ad_hoc_issues sh on sh.ad_hoc_issue_id = src.ad_hoc_issue_id
left join core.handling_units hu on hu.handling_unit_id = m.handling_unit_id
left join core.receipt_lots rl on rl.receipt_lot_id = hu.receipt_lot_id
where m.movement_type in ('ISSUE', 'RETURN', 'RECEIPT', 'DAMAGE', 'QUARANTINE', 'ADJUSTMENT')

union all
-- Transport trips
select
  'trip:' || t.trip_id::text,
  coalesce(t.trip_date::timestamp at time zone 'Asia/Bangkok', t.created_at),
  'transport', 'trip', 'synapse', null, null, null,
  t.total_distance_km, null, t.replenishment_plan_id, p.plan_number,
  concat_ws(' · ', t.trip_code, t.vehicle_id, t.driver_name),
  t.status,
  nullif(array_to_string(t.route_district_refs, ', '), ''),
  t.created_by, null
from ops.transport_trips t
left join core.replenishment_plans p on p.replenishment_plan_id = t.replenishment_plan_id

union all
-- Legacy workbook history
select
  'legacy:' || l.row_key,
  coalesce(l.actual_date, l.plan_date, l.imported_at::date)::timestamp at time zone 'Asia/Bangkok',
  case when l.outcome = 'refused' then 'district' else 'issue' end,
  'legacy_' || l.outcome,
  'legacy', l.district_id, l.material_id, nullif(l.material_name, ''),
  case when l.outcome = 'refused' then l.planned_qty else l.issued_qty end,
  l.planned_qty, null, null,
  concat_ws(' · ',
    case l.fill_type when 'vmi' then 'VMI' when 'passed_test' then 'ของผ่านทดสอบ'
      when 'district_request' then 'เขตแจ้งใช้' end,
    'แผน ' || to_char(l.plan_date, 'YYYY-MM-DD')),
  l.outcome, nullif(l.note, ''), null, nullif(l.refused_by, '')
from ops.legacy_issue_history l;

revoke all on ops.v_operation_history from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Plan line outcomes (for "จ่ายได้ตามแผน" by week / district)
-- ------------------------------------------------------------------
create or replace view ops.v_plan_line_outcomes as
with issued as (
  select m.replenishment_item_id,
    sum(m.quantity) as issued_qty,
    max(m.occurred_at) as last_issued_at
  from core.inventory_movements m
  where m.movement_type = 'ISSUE' and m.replenishment_item_id is not null
  group by m.replenishment_item_id
),
returned as (
  select src.replenishment_item_id, sum(r.quantity) as returned_qty
  from core.inventory_movements r
  join core.inventory_movements src on src.inventory_movement_id = r.source_movement_id
  where r.movement_type = 'RETURN' and src.replenishment_item_id is not null
  group by src.replenishment_item_id
),
lines as (
  select
    'synapse'::text as source,
    i.replenishment_item_id::text as line_id,
    coalesce(p.week_start_date, (p.created_at at time zone 'Asia/Bangkok')::date) as plan_date,
    i.district_id,
    i.material_id,
    coalesce(i.planner_qty, i.suggested_qty) as planned_qty,
    coalesce(i.final_qty, i.confirmed_qty, i.requested_qty, i.planner_qty, i.suggested_qty) as final_qty,
    greatest(coalesce(s.issued_qty, 0) - coalesce(r.returned_qty, 0), 0) as issued_qty,
    i.district_decision,
    i.status
  from core.replenishment_items i
  join core.replenishment_plans p on p.replenishment_plan_id = i.replenishment_plan_id
  left join issued s on s.replenishment_item_id = i.replenishment_item_id
  left join returned r on r.replenishment_item_id = i.replenishment_item_id
  where p.status not in ('draft', 'cancelled')
    and i.status not in ('draft', 'cancelled')
)
select
  source, line_id, plan_date, district_id, material_id, planned_qty, final_qty, issued_qty,
  case
    when district_decision = 'reject' or status = 'district_rejected' or final_qty = 0 then 'refused'
    when issued_qty > 0 and issued_qty >= final_qty and final_qty = planned_qty then 'issued'
    when issued_qty > 0 then 'adjusted'
    else 'pending'
  end as outcome
from lines
union all
select
  'legacy', l.row_key, coalesce(l.plan_date, l.actual_date), l.district_id, l.material_id,
  l.planned_qty, coalesce(l.issued_qty, l.planned_qty), coalesce(l.issued_qty, 0), l.outcome
from ops.legacy_issue_history l;

revoke all on ops.v_plan_line_outcomes from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Query function
-- ------------------------------------------------------------------
create or replace function core.m19_operation_history(
  p_query jsonb,
  p_scope_district text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, core, ops
as $$
declare
  v_from date := nullif(p_query ->> 'from', '')::date;
  v_to date := nullif(p_query ->> 'to', '')::date;
  v_district text := coalesce(p_scope_district, nullif(btrim(p_query ->> 'district_id'), ''));
  v_material text := nullif(btrim(p_query ->> 'material'), '');
  v_source text := nullif(btrim(p_query ->> 'source'), '');
  v_q text := nullif(btrim(p_query ->> 'q'), '');
  v_categories text[] := case
    when nullif(btrim(p_query ->> 'category'), '') is null then null
    else string_to_array(replace(p_query ->> 'category', ' ', ''), ',')
  end;
  v_limit integer := least(greatest(coalesce(nullif(p_query ->> 'limit', '')::integer, 300), 1), 2000);
  v_offset integer := greatest(coalesce(nullif(p_query ->> 'offset', '')::integer, 0), 0);
  v_result jsonb;
begin
  if v_source is not null and v_source not in ('synapse', 'legacy') then
    raise exception 'source must be synapse or legacy';
  end if;

  with base as (
    select
      e.*,
      (e.event_at at time zone 'Asia/Bangkok')::date as event_date,
      coalesce(e.material_name, mat.material_name) as material_label,
      mat.unit,
      d.district_name_th as district_name,
      coalesce(e.actor_text, up.display_name) as actor
    from ops.v_operation_history e
    left join core.materials mat on mat.material_id = e.material_id
    left join core.districts d on d.district_id = e.district_id
    left join public.user_profiles up on up.user_id = e.actor_id
    where e.event_at is not null
  ),
  scoped as (
    select * from base b
    where (v_from is null or b.event_date >= v_from)
      and (v_to is null or b.event_date <= v_to)
      and (v_district is null or b.district_id = v_district)
      and (v_source is null or b.source = v_source)
      and (v_material is null or b.material_id like v_material || '%'
           or b.material_label ilike '%' || v_material || '%')
      and (v_q is null or concat_ws(' ', b.material_id, b.material_label, b.plan_number,
             b.reference, b.note, b.actor, b.district_name) ilike '%' || v_q || '%')
  ),
  listed as (
    select * from scoped s
    where v_categories is null or s.category = any (v_categories)
  ),
  page as (
    select * from listed
    order by event_at desc, event_id desc
    limit v_limit offset v_offset
  ),
  lines as (
    select o.*, date_trunc('week', o.plan_date)::date as week_start
    from ops.v_plan_line_outcomes o
    left join core.materials mat on mat.material_id = o.material_id
    where o.plan_date is not null
      and (v_from is null or o.plan_date >= v_from)
      and (v_to is null or o.plan_date <= v_to)
      and (v_district is null or o.district_id = v_district)
      and (v_source is null or o.source = v_source)
      and (v_material is null or o.material_id like v_material || '%'
           or mat.material_name ilike '%' || v_material || '%')
  ),
  issue_weeks as (
    select date_trunc('week', event_date)::date as week_start,
      count(*) filter (where event_type in ('issue', 'issue_adhoc', 'legacy_issued', 'legacy_adjusted')) as issue_events,
      coalesce(sum(qty) filter (where event_type in ('issue', 'issue_adhoc', 'legacy_issued', 'legacy_adjusted')), 0)
        - coalesce(sum(qty) filter (where event_type = 'return'), 0) as issued_qty,
      count(distinct material_id) filter (where event_type in ('issue', 'issue_adhoc', 'legacy_issued', 'legacy_adjusted')) as issued_materials
    from scoped
    where category = 'issue'
    group by 1
  ),
  line_weeks as (
    select week_start,
      count(*) as planned_lines,
      count(*) filter (where outcome = 'issued') as on_plan,
      count(*) filter (where outcome = 'adjusted') as adjusted,
      count(*) filter (where outcome = 'refused') as refused,
      count(*) filter (where outcome = 'pending') as pending,
      coalesce(sum(planned_qty), 0) as planned_qty
    from lines
    group by 1
  ),
  weeks as (
    select coalesce(l.week_start, i.week_start) as week_start,
      coalesce(l.planned_lines, 0) as planned_lines,
      coalesce(l.on_plan, 0) as on_plan,
      coalesce(l.adjusted, 0) as adjusted,
      coalesce(l.refused, 0) as refused,
      coalesce(l.pending, 0) as pending,
      coalesce(l.planned_qty, 0) as planned_qty,
      coalesce(i.issue_events, 0) as issue_events,
      coalesce(i.issued_qty, 0) as issued_qty,
      coalesce(i.issued_materials, 0) as issued_materials
    from line_weeks l
    full join issue_weeks i on i.week_start = l.week_start
  ),
  by_district as (
    select o.district_id, d.district_name_th as district_name,
      count(*) as planned_lines,
      count(*) filter (where outcome = 'issued') as on_plan,
      count(*) filter (where outcome = 'adjusted') as adjusted,
      count(*) filter (where outcome = 'refused') as refused,
      count(*) filter (where outcome = 'pending') as pending,
      max(o.plan_date) as last_plan_date
    from lines o
    left join core.districts d on d.district_id = o.district_id
    group by o.district_id, d.district_name_th
  )
  select jsonb_build_object(
    'total', (select count(*) from listed),
    'limit', v_limit,
    'offset', v_offset,
    'scope_district_id', p_scope_district,
    'counts', coalesce((select jsonb_object_agg(category, n) from (
        select category, count(*) as n from scoped group by category) c), '{}'::jsonb),
    'sources', coalesce((select jsonb_object_agg(source, n) from (
        select source, count(*) as n from scoped group by source) c), '{}'::jsonb),
    'first_event_date', (select min(event_date) from scoped),
    'last_event_date', (select max(event_date) from scoped),
    'outcomes', (select jsonb_build_object(
        'planned_lines', count(*),
        'on_plan', count(*) filter (where outcome = 'issued'),
        'adjusted', count(*) filter (where outcome = 'adjusted'),
        'refused', count(*) filter (where outcome = 'refused'),
        'pending', count(*) filter (where outcome = 'pending')) from lines),
    'weekly', coalesce((select jsonb_agg(to_jsonb(w) order by w.week_start desc) from (
        select * from weeks order by week_start desc limit 104) w), '[]'::jsonb),
    'by_district', coalesce((select jsonb_agg(to_jsonb(b) order by b.planned_lines desc, b.district_id)
        from by_district b), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'event_id', p.event_id,
        'event_at', p.event_at,
        'event_date', p.event_date,
        'category', p.category,
        'event_type', p.event_type,
        'source', p.source,
        'district_id', p.district_id,
        'district_name', p.district_name,
        'material_id', p.material_id,
        'material_name', p.material_label,
        'unit', p.unit,
        'qty', p.qty,
        'ref_qty', p.ref_qty,
        'plan_id', p.plan_id,
        'plan_number', p.plan_number,
        'reference', nullif(p.reference, ''),
        'status', p.status,
        'note', p.note,
        'actor', p.actor
      ) order by p.event_at desc, p.event_id desc) from page p), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function core.m19_operation_history(jsonb, text) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Dispatcher
-- ------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m19(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl_m19;
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
  v_district_id text;
begin
  if p_path = '/v1/history' and upper(coalesce(p_method, '')) = 'GET' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text, district_id into v_role, v_district_id
    from public.user_profiles
    where user_id = v_user_id and is_active;
    if v_role is null then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    if v_role = 'district' and v_district_id is null then
      return public.m09_error(403, 'forbidden', 'District user has no district', p_request_id);
    end if;
    return public.m09_result(200, core.m19_operation_history(
      coalesce(p_query, '{}'::jsonb),
      case when v_role = 'district' then v_district_id end
    ));
  end if;

  return public.m09_dispatch_impl_m19(p_method, p_path, p_query, p_body, p_request_id);
exception
  when invalid_text_representation or numeric_value_out_of_range
    or invalid_datetime_format or datetime_field_overflow then
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
  to_regclass('ops.v_operation_history') is not null as history_view_ready,
  to_regprocedure('core.m19_operation_history(jsonb,text)') is not null as history_function_ready,
  (select count(*) from ops.v_operation_history) as history_events;
