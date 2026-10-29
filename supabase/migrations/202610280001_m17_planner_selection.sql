-- M17: Planner selection -> server plan.
-- The weekly run creates the system proposal (suggested_qty stays immutable as
-- run evidence). Before districts confirm, the planner's own picks replace it:
-- planner_qty becomes the quantity sent to the district, unpicked proposals are
-- cancelled (kept for audit), and extra materials are added with a reason.
-- District responses then compare against planner_qty instead of the system qty.
-- Endpoint: POST /v1/replenishment/plans/{plan_id}/planner-selection

begin;

alter table core.replenishment_items
  add column if not exists planner_qty numeric,
  add column if not exists planner_source text not null default 'system',
  add column if not exists planner_note text,
  add column if not exists planner_selected_at timestamptz,
  add column if not exists planner_selected_by uuid references auth.users (id) on delete set null;

do $$
begin
  alter table core.replenishment_items
    add constraint replenishment_items_planner_source_check
    check (planner_source in ('system', 'added'));
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter table core.replenishment_items
    add constraint replenishment_items_planner_qty_check
    check (planner_qty is null or planner_qty >= 0);
exception
  when duplicate_object then null;
end
$$;

-- Expose the planner columns to the dashboard queue (appended at the end).
create or replace view analytics.v_replenishment_queue
with (security_invoker = true)
as
select
  p.replenishment_plan_id,
  p.replenishment_run_id,
  p.status as plan_status,
  i.replenishment_item_id,
  i.material_id,
  m.material_name,
  i.district_id,
  d.district_name_th,
  i.current_stock_qty,
  i.cmp_monthly,
  i.months_available,
  i.min_fill_qty,
  i.max_fill_qty,
  i.suggested_qty,
  i.confirmed_qty,
  i.priority_score,
  i.priority_band,
  i.status as item_status,
  i.district_note,
  p.created_at,
  p.plan_number,
  p.week_start_date,
  p.version_no,
  p.parent_plan_id,
  p.response_due_at,
  p.planner_approved_at,
  p.academic_approved_at,
  p.locked_at,
  i.requested_qty,
  i.final_qty,
  i.projected_months_after,
  i.exceeds_six_months,
  i.special_approval_required,
  i.abnormal_risk_level,
  i.abnormal_signals,
  i.source_stock_missing,
  i.district_decision,
  i.requester_name,
  i.confirmed_on_behalf,
  coalesce(
    (
      select sum(a.allocated_qty)
      from ops.fifo_allocations a
      where a.replenishment_item_id = i.replenishment_item_id
        and a.status in ('reserved', 'issued')
    ),
    0
  ) as allocated_qty,
  p.updated_at,
  i.planner_qty,
  i.planner_source,
  i.planner_note,
  i.planner_selected_at
from core.replenishment_plans p
join core.replenishment_items i using (replenishment_plan_id)
join core.materials m using (material_id)
join core.districts d using (district_id);

create or replace function core.m17_apply_planner_selection(
  p_plan_id uuid,
  p_lines jsonb,
  p_dropped jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_plan core.replenishment_plans%rowtype;
  v_line jsonb;
  v_item core.replenishment_items%rowtype;
  v_found boolean;
  v_item_id uuid;
  v_qty numeric;
  v_reason text;
  v_district text;
  v_material text;
  v_health record;
  v_has_health boolean;
  v_kept integer := 0;
  v_changed integer := 0;
  v_added integer := 0;
  v_dropped integer := 0;
begin
  select role::text into v_role
  from public.user_profiles
  where user_id = v_user_id and is_active;
  if v_user_id is null then
    raise exception 'Missing or invalid bearer token';
  end if;
  if coalesce(v_role, '') not in ('admin', 'planner') then
    raise exception 'Only admin or planner may send a plan to districts';
  end if;
  if not coalesce((
    select controls.operational_writes_enabled
    from ops.environment_controls controls
    where controls.singleton
  ), false) then
    raise exception 'Operational writes are locked until Production cutover gates pass';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines must be a non-empty array';
  end if;
  if jsonb_typeof(coalesce(p_dropped, '[]'::jsonb)) <> 'array' then
    raise exception 'dropped must be an array';
  end if;

  select * into v_plan
  from core.replenishment_plans
  where replenishment_plan_id = p_plan_id
  for update;
  if not found then
    raise exception 'Plan % was not found', p_plan_id;
  end if;
  if v_plan.status not in ('draft', 'pending_district_confirmation') then
    raise exception 'แผนนี้อยู่สถานะ % แล้ว ส่งรายการของผู้วางแผนไม่ได้ ให้ออกเวอร์ชันใหม่แทน', v_plan.status;
  end if;

  -- Lines the planner keeps or adds.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_qty := (v_line ->> 'quantity')::numeric;
    v_district := nullif(btrim(v_line ->> 'district_id'), '');
    v_material := nullif(btrim(v_line ->> 'material_id'), '');
    v_reason := left(nullif(btrim(coalesce(v_line ->> 'reason', '')), ''), 1000);
    v_item_id := nullif(v_line ->> 'replenishment_item_id', '')::uuid;
    if v_qty is null or v_qty <= 0 then
      raise exception 'จำนวนของพัสดุ % เขต % ต้องมากกว่า 0', v_material, v_district;
    end if;

    if v_item_id is null then
      select * into v_item
      from core.replenishment_items
      where replenishment_plan_id = p_plan_id
        and district_id = v_district
        and material_id = v_material
      for update;
      v_found := found;
    else
      select * into v_item
      from core.replenishment_items
      where replenishment_item_id = v_item_id
        and replenishment_plan_id = p_plan_id
      for update;
      v_found := found;
      if not v_found then
        raise exception 'รายการ % ไม่อยู่ในแผนนี้', v_item_id;
      end if;
    end if;

    if v_found then
      if v_item.status not in ('draft', 'pending', 'cancelled') then
        raise exception 'พัสดุ % เขต % เขตตอบแล้ว (%) แก้จากหน้านี้ไม่ได้',
          v_item.material_id, v_item.district_id, v_item.status;
      end if;
      if v_item.status = 'cancelled' and v_reason is null then
        raise exception 'พัสดุ % เขต % ต้องระบุเหตุผลที่เพิ่ม',
          v_item.material_id, v_item.district_id;
      end if;
      if coalesce(v_item.planner_qty, v_item.suggested_qty) is distinct from v_qty then
        insert into ops.replenishment_adjustments (
          replenishment_item_id, previous_qty, new_qty, adjustment_reason, adjusted_by
        ) values (
          v_item.replenishment_item_id,
          coalesce(v_item.planner_qty, v_item.suggested_qty),
          v_qty,
          coalesce(v_reason, 'Planner กำหนดจำนวนก่อนส่งให้เขต'),
          v_user_id
        );
        v_changed := v_changed + 1;
      end if;
      update core.replenishment_items
      set planner_qty = v_qty,
          requested_qty = v_qty,
          final_qty = v_qty,
          projected_months_after = round((current_stock_qty + v_qty) / cmp_monthly, 2),
          exceeds_six_months = (current_stock_qty + v_qty) / cmp_monthly > 6,
          planner_source = case when v_item.status = 'cancelled' then 'added' else planner_source end,
          planner_note = coalesce(v_reason, planner_note),
          planner_selected_at = now(),
          planner_selected_by = v_user_id,
          district_note = case when v_item.status = 'cancelled' then null else district_note end,
          status = 'pending',
          updated_at = now()
      where replenishment_item_id = v_item.replenishment_item_id;
      if v_item.status = 'cancelled' then
        v_added := v_added + 1;
      else
        v_kept := v_kept + 1;
      end if;
    else
      if v_reason is null then
        raise exception 'พัสดุ % เขต % ต้องระบุเหตุผลที่เพิ่ม', v_material, v_district;
      end if;
      select * into v_health
      from analytics.stock_health_at(now()) health
      where health.district_id = v_district
        and health.material_id = v_material
      order by health.snapshot_at desc nulls last
      limit 1;
      v_has_health := found;
      if not v_has_health or coalesce(v_health.cmp_monthly, 0) <= 0 then
        raise exception 'พัสดุ % เขต % ไม่มีข้อมูล Stock/CMP ของเขต (ต้องเป็นพัสดุ VMI ที่มี CMP) จึงเพิ่มเข้าแผนไม่ได้', v_material, v_district;
      end if;
      insert into core.replenishment_items (
        replenishment_plan_id, material_id, district_id,
        source_stock_snapshot_id, source_usage_rate_id,
        current_stock_qty, cmp_monthly, months_available,
        min_fill_qty, max_fill_qty,
        suggested_qty, requested_qty, final_qty,
        projected_months_after, exceeds_six_months, source_stock_missing,
        priority_score, priority_band, status,
        planner_qty, planner_source, planner_note,
        planner_selected_at, planner_selected_by
      ) values (
        p_plan_id, v_material, v_district,
        v_health.snapshot_id, v_health.usage_rate_id,
        greatest(v_health.current_stock_qty, 0), v_health.cmp_monthly,
        greatest(v_health.months_available, 0),
        greatest(core.round_replenishment(v_health.cmp_monthly * 4 - v_health.current_stock_qty), 0),
        greatest(core.round_replenishment(v_health.cmp_monthly * 6 - v_health.current_stock_qty), 0),
        0, v_qty, v_qty,
        round((greatest(v_health.current_stock_qty, 0) + v_qty) / v_health.cmp_monthly, 2),
        (greatest(v_health.current_stock_qty, 0) + v_qty) / v_health.cmp_monthly > 6,
        coalesce(v_health.source_stock_missing, false),
        5,
        case
          when v_health.months_available < 1.5 then 'critical'
          when v_health.months_available < 3.5 then 'high'
          else 'normal'
        end,
        'pending',
        v_qty, 'added', v_reason,
        now(), v_user_id
      );
      v_added := v_added + 1;
    end if;
  end loop;

  -- System proposals the planner did not send.
  for v_line in select value from jsonb_array_elements(coalesce(p_dropped, '[]'::jsonb)) loop
    v_item_id := nullif(v_line ->> 'replenishment_item_id', '')::uuid;
    v_reason := left(coalesce(nullif(btrim(v_line ->> 'reason'), ''), 'ไม่ได้เลือกเข้าแผน'), 900);
    select * into v_item
    from core.replenishment_items
    where replenishment_item_id = v_item_id
      and replenishment_plan_id = p_plan_id
    for update;
    if not found then
      raise exception 'รายการ % ไม่อยู่ในแผนนี้', v_item_id;
    end if;
    if v_item.status not in ('draft', 'pending') then
      continue;
    end if;
    update core.replenishment_items
    set status = 'cancelled',
        district_note = 'Planner ไม่ส่ง: ' || v_reason,
        planner_note = v_reason,
        planner_selected_at = now(),
        planner_selected_by = v_user_id,
        updated_at = now()
    where replenishment_item_id = v_item.replenishment_item_id;
    v_dropped := v_dropped + 1;
  end loop;

  update core.replenishment_plans
  set status = case
        when exists (
          select 1 from core.replenishment_items
          where replenishment_plan_id = p_plan_id
            and status in ('draft', 'pending', 'change_requested')
        ) then 'pending_district_confirmation'
        when exists (
          select 1 from core.replenishment_items
          where replenishment_plan_id = p_plan_id
            and status <> 'cancelled'
        ) then 'pending_planner_approval'
        else 'draft'
      end,
      updated_at = now()
  where replenishment_plan_id = p_plan_id;

  return jsonb_build_object(
    'replenishment_plan_id', p_plan_id,
    'kept', v_kept,
    'quantity_changed', v_changed,
    'added', v_added,
    'dropped', v_dropped,
    'sent_at', now()
  );
end;
$$;

revoke all on function core.m17_apply_planner_selection(uuid, jsonb, jsonb)
  from public, anon, authenticated;

-- District responses compare against what the planner sent, not the raw
-- system proposal. Identical to production_operations_v1 apart from the
-- baseline quantity.
create or replace function core.respond_replenishment_item(
  p_replenishment_item_id uuid,
  p_decision text,
  p_requested_qty numeric,
  p_reason text,
  p_requester_name text
)
returns core.replenishment_items
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_item core.replenishment_items%rowtype;
  v_plan core.replenishment_plans%rowtype;
  v_role public.app_role;
  v_district_id text;
  v_actor_name text;
  v_quantity numeric;
  v_projected numeric;
  v_exceeds_six boolean;
  v_special boolean;
  v_changed boolean;
  v_risk text;
  v_signals jsonb;
begin
  select role, district_id, coalesce(display_name, user_id::text)
  into v_role, v_district_id, v_actor_name
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;

  if v_role not in ('admin', 'planner', 'district') then
    raise exception 'Not authorized to respond to replenishment items';
  end if;
  if p_decision not in ('confirm', 'reject', 'change') then
    raise exception 'Decision must be confirm, reject or change';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Reason is required';
  end if;

  select * into v_item
  from core.replenishment_items
  where replenishment_item_id = p_replenishment_item_id
  for update;
  if not found then
    raise exception 'Replenishment item not found';
  end if;

  select * into v_plan
  from core.replenishment_plans
  where replenishment_plan_id = v_item.replenishment_plan_id
  for update;

  if v_plan.status <> 'pending_district_confirmation'
     or v_item.status not in ('draft', 'pending', 'change_requested') then
    raise exception 'Item is not awaiting district response';
  end if;
  if v_role = 'district' and v_district_id <> v_item.district_id then
    raise exception 'District may only respond to its own items';
  end if;

  v_quantity := case
    when p_decision = 'reject' then 0
    else p_requested_qty
  end;
  if v_quantity is null or v_quantity < 0 then
    raise exception 'Requested quantity must be non-negative';
  end if;
  if btrim(coalesce(p_requester_name, '')) = '' then
    v_actor_name := coalesce(v_actor_name, 'Unknown requester');
  else
    v_actor_name := left(btrim(p_requester_name), 200);
  end if;

  v_projected := round((v_item.current_stock_qty + v_quantity) / v_item.cmp_monthly, 2);
  v_exceeds_six := v_projected > 6;
  v_special := v_projected > 9;
  v_changed := v_quantity <> coalesce(v_item.planner_qty, v_item.suggested_qty);
  v_risk := case
    when v_special then 'high'
    when v_exceeds_six
      or v_quantity > coalesce(v_item.planner_qty, v_item.suggested_qty) * 1.25 then 'medium'
    else 'normal'
  end;
  v_signals := jsonb_build_object(
    'quantity_changed', v_changed,
    'requested_to_suggested_ratio',
      case when coalesce(v_item.planner_qty, v_item.suggested_qty) > 0
        then round(v_quantity / coalesce(v_item.planner_qty, v_item.suggested_qty), 3)
      end,
    'projected_months_after', v_projected,
    'exceeds_six_months', v_exceeds_six,
    'exceeds_nine_months', v_special,
    'source_stock_missing', v_item.source_stock_missing
  );

  update ops.district_change_requests
  set status = 'cancelled',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = 'Superseded by a newer district response',
      updated_at = now()
  where replenishment_item_id = v_item.replenishment_item_id
    and status = 'pending_review';

  if v_changed then
    insert into ops.district_change_requests (
      replenishment_item_id,
      baseline_qty,
      requested_qty,
      projected_months_after,
      exceeds_six_months,
      special_approval_required,
      risk_level,
      abnormal_signals,
      reason,
      requester_name,
      requested_by
    )
    values (
      v_item.replenishment_item_id,
      coalesce(v_item.planner_qty, v_item.suggested_qty),
      v_quantity,
      v_projected,
      v_exceeds_six,
      v_special,
      v_risk,
      v_signals,
      left(p_reason, 1000),
      v_actor_name,
      auth.uid()
    );
  end if;

  insert into ops.replenishment_adjustments (
    replenishment_item_id,
    previous_qty,
    new_qty,
    adjustment_reason,
    adjusted_by
  )
  values (
    v_item.replenishment_item_id,
    v_item.requested_qty,
    v_quantity,
    left(p_reason, 1000),
    auth.uid()
  );

  update core.replenishment_items
  set requested_qty = v_quantity,
      confirmed_qty = case when not v_changed then v_quantity else null end,
      final_qty = case when not v_changed then v_quantity else null end,
      district_decision = case when v_changed then 'change' else p_decision end,
      district_note = left(p_reason, 1000),
      district_confirmed_by = auth.uid(),
      district_confirmed_at = now(),
      requester_name = v_actor_name,
      confirmed_on_behalf = v_role in ('admin', 'planner'),
      projected_months_after = v_projected,
      exceeds_six_months = v_exceeds_six,
      special_approval_required = v_special,
      abnormal_risk_level = v_risk,
      abnormal_signals = v_signals,
      status = case
        when v_changed then 'change_requested'
        when v_quantity = 0 then 'district_rejected'
        else 'district_confirmed'
      end,
      updated_at = now()
  where replenishment_item_id = v_item.replenishment_item_id
  returning * into v_item;

  insert into ops.plan_approvals (
    replenishment_plan_id,
    replenishment_item_id,
    district_id,
    approval_stage,
    decision,
    note,
    actor_id,
    actor_role
  )
  values (
    v_item.replenishment_plan_id,
    v_item.replenishment_item_id,
    v_item.district_id,
    'district_response',
    case when v_quantity = 0 then 'rejected' else 'confirmed' end,
    left(p_reason, 1000),
    auth.uid(),
    v_role::text
  );

  if not exists (
    select 1
    from core.replenishment_items
    where replenishment_plan_id = v_item.replenishment_plan_id
      and status in ('draft', 'pending', 'change_requested')
  ) then
    update core.replenishment_plans
    set status = 'pending_planner_approval',
        district_responses_completed_at = now(),
        updated_at = now()
    where replenishment_plan_id = v_item.replenishment_plan_id;
  end if;

  return v_item;
end;
$$;

do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m17ps(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl_m17ps;
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
  v_plan_id uuid;
  v_payload jsonb;
begin
  if upper(coalesce(p_method, '')) = 'POST'
     and p_path ~ '^/v1/replenishment/plans/[0-9a-fA-F-]{36}/planner-selection$' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text into v_role
    from public.user_profiles
    where user_id = v_user_id and is_active;
    if coalesce(v_role, '') not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Only admin or planner may send a plan to districts', p_request_id);
    end if;
    if not coalesce((
      select controls.operational_writes_enabled
      from ops.environment_controls controls
      where controls.singleton
    ), false) then
      return public.m09_error(423, 'production_not_ready',
        'Operational writes are locked until Production cutover gates pass', p_request_id);
    end if;
    if jsonb_typeof(p_body -> 'lines') is distinct from 'array' then
      return public.m09_error(422, 'validation_error', 'lines must be an array', p_request_id);
    end if;
    v_plan_id := substring(
      p_path from '^/v1/replenishment/plans/([0-9a-fA-F-]{36})/planner-selection$'
    )::uuid;
    select core.m17_apply_planner_selection(
      v_plan_id,
      p_body -> 'lines',
      coalesce(p_body -> 'dropped', '[]'::jsonb)
    ) into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  return public.m09_dispatch_impl_m17ps(p_method, p_path, p_query, p_body, p_request_id);
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

comment on function core.m17_apply_planner_selection(uuid, jsonb, jsonb) is
  'Applies the planner''s selection to an open weekly plan before districts confirm: adjusts quantities, cancels unpicked proposals and adds extra materials with a reason.';

commit;

-- Post-check (read only): the planner endpoint is live, and whether
-- operational writes are open (the send button needs this to be true).
select
  to_regprocedure('core.m17_apply_planner_selection(uuid,jsonb,jsonb)') is not null
    as planner_selection_ready,
  (select operational_writes_enabled from ops.environment_controls where singleton)
    as operational_writes_enabled;
