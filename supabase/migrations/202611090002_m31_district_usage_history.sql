-- M31: district dispatch history, recommendation from real usage, district
-- usage dashboard.
--
-- 1. (history comes from ops.legacy_issue_history, imported on the page
--    นำเข้าข้อมูล → ประวัติจากระบบเดิม: History จ่ายได้ตามแผน / History ไม่รับของ
--    and the 18 district sheets of คลังคลองเตย.xlsx)
-- 2. core.m31_dispatch_history(): that history plus plan lines SYNAPSE has
--    issued or the district refused. Older imports keyed districts by SAP
--    plant (5601 = สามเสน); those are mapped to the district (5502).
-- 3. core.m31_suggest(): quantity from the district's monthly usage
--    (12 months), with the reason in Thai:
--      no use in 12 months / used once        -> 0 (district asks when needed)
--      used 2-5 of 12 months                  -> one typical use - district stock
--      used 6+ months                         -> 6 x adjusted CMP - district stock
--         adjusted CMP = (median month + mean of the last 4 months) / 2,
--         months above 3x the median count as 3x the median
--      refused before ("ไม่รับของ")            -> at most 4 x adjusted CMP
--    The plan queue keeps the full quantity and shows what Khlong Toei lacks.
-- 4. GET /v1/district-usage?district_id=5502|all
--    GET /v1/district-usage/history?district_id=&material_id=
--    GET /v1/district-usage/summary
--    GET /v1/replenishment/queue adds ai_qty / ai_reason / ai_rule / ai_kt_short / usage.

begin;

-- Dispatch history -----------------------------------------------------------
create or replace function core.m31_dispatch_history()
returns table (
  source text,
  district_id text,
  district_name text,
  material_id text,
  material_name text,
  plan_date date,
  actual_date date,
  plan_qty numeric,
  actual_qty numeric,
  unit text,
  lot_size text,
  status text,
  fill_type text,
  note text,
  rejected_by text,
  reference text
)
language sql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
  select 'ไฟล์คลังคลองเตย'::text,
    coalesce(dp.district_id, l.district_id), coalesce(d.district_name_th, l.district_name),
    l.material_id, coalesce(m.material_name, l.material_name),
    l.plan_date, l.actual_date, l.planned_qty, l.issued_qty,
    coalesce(nullif(l.unit, ''), m.unit), l.lot_size_text,
    case l.outcome when 'issued' then 'จ่ายได้ตามแผน' when 'adjusted' then 'ปรับจำนวน' else 'ไม่รับของ' end,
    case l.fill_type when 'vmi' then 'จ่ายตาม VMI' when 'passed_test' then 'ของผ่านทดสอบ'
      when 'district_request' then 'เขตแจ้งใช้' else 'ไม่ระบุ' end,
    nullif(l.note, ''), nullif(l.refused_by, ''), l.source_sheet
  from ops.legacy_issue_history l
  left join core.districts dp on dp.sap_plant_code = l.district_id
  left join core.districts d on d.district_id = coalesce(dp.district_id, l.district_id)
  left join core.materials m on m.material_id = l.material_id
  union all
  select 'SYNAPSE', i.district_id, d.district_name_th, i.material_id, m.material_name,
    p.week_start_date,
    case when i.status = 'issued' then (i.updated_at at time zone 'Asia/Bangkok')::date end,
    coalesce(i.planner_qty, i.suggested_qty),
    case when i.status = 'issued' then i.final_qty end,
    m.unit, null,
    case i.status when 'issued' then
        case when i.final_qty is distinct from coalesce(i.planner_qty, i.suggested_qty) then 'ปรับจำนวน' else 'จ่ายได้ตามแผน' end
      else 'ไม่รับของ' end,
    case when i.planner_source = 'added' then 'เขตแจ้งใช้' else 'จ่ายตาม VMI' end,
    i.district_note, i.district_confirmed_by::text, p.plan_number
  from core.replenishment_items i
  join core.replenishment_plans p using (replenishment_plan_id)
  left join core.districts d on d.district_id = i.district_id
  left join core.materials m on m.material_id = i.material_id
  where i.status in ('issued', 'district_rejected');
$$;

revoke all on function core.m31_dispatch_history() from public, anon, authenticated;

-- Recommendation from the district's real usage -------------------------------
create or replace function core.m31_suggest(
  p_material text,
  p_district text,
  p_stock numeric,
  p_refused text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_plant text;
  v_payload jsonb;
  v_asof date;
  v_month date;
  v_text text;
  v_usage numeric[] := '{}';
  v_labels text[] := '{}';
  v_used integer;
  v_median numeric;
  v_typical numeric;
  v_last4 numeric;
  v_cmp numeric;
  v_spikes integer := 0;
  v_qty numeric;
  v_rule text;
  v_reason text;
  v_stock numeric := greatest(coalesce(p_stock, 0), 0);
begin
  select sap_plant_code into v_plant from core.districts where district_id = p_district;
  select payload into v_payload from ops.source_current_rows
  where source_kind = 'usage' and business_key = p_material || '|' || v_plant and missing_since_run_id is null;
  if v_payload is null then
    return jsonb_build_object('rule', 'no_usage', 'qty', null,
      'reason', 'ไม่มีรหัสนี้ในไฟล์อัตราการใช้ของเขต');
  end if;

  v_asof := coalesce(nullif(v_payload ->> 'as_of_date', '')::date, current_date);
  for i in reverse 11..0 loop
    v_month := (date_trunc('month', v_asof) - make_interval(months => i))::date;
    v_text := v_payload -> 'monthly_usage' ->> to_char(v_month, 'YYYY-MM');
    v_labels := v_labels || to_char(v_month, 'YYYY-MM');
    v_usage := v_usage || greatest(0::numeric,
      coalesce(case when v_text ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then v_text::numeric end, 0));
  end loop;

  select count(*) filter (where x > 0),
    percentile_cont(0.5) within group (order by x),
    (select percentile_cont(0.5) within group (order by y) from unnest(v_usage) y where y > 0)
  into v_used, v_median, v_typical
  from unnest(v_usage) x;

  if v_used = 0 then
    v_rule := 'none';
    v_qty := 0;
    v_reason := 'ไม่มีการเบิกใช้ใน 12 เดือน → ไม่เติม';
  elsif v_used = 1 then
    v_rule := 'once';
    v_qty := 0;
    v_reason := format('เบิกใช้ครั้งเดียวใน 12 เดือน (%s) → ไม่เติม ให้เขตแจ้งใช้เมื่อต้องการ',
      trim(to_char(v_typical, 'FM999,999,990.##')));
  elsif v_used < 6 then
    v_rule := 'occasional';
    v_qty := greatest(0, round(v_typical - v_stock));
    v_reason := format('ใช้เป็นครั้งคราว %s/12 เดือน ครั้งละประมาณ %s → เติมพอใช้ 1 ครั้ง',
      v_used, trim(to_char(v_typical, 'FM999,999,990.##')));
  else
    v_rule := 'regular';
    select count(*) filter (where x > 3 * v_median) into v_spikes from unnest(v_usage) x;
    select avg(least(x, 3 * v_median)) into v_last4
    from unnest(v_usage[9:12]) x;
    v_cmp := round((v_median + v_last4) / 2);
    v_qty := greatest(0, round(v_cmp * 6 - v_stock));
    v_reason := format('ใช้สม่ำเสมอ %s/12 เดือน ค่ากลาง %s · 4 เดือนล่าสุด %s → CMP ปรับ %s × 6 − Stock เขต %s',
      v_used, trim(to_char(v_median, 'FM999,999,990.##')), trim(to_char(v_last4, 'FM999,999,990.##')),
      trim(to_char(v_cmp, 'FM999,999,990')), trim(to_char(v_stock, 'FM999,999,990.##')));
    if v_spikes > 0 then
      v_reason := v_reason || format(' · เดือนที่สูงผิดปกติ %s เดือนนับแค่ 3 เท่าของค่ากลาง', v_spikes);
    end if;
  end if;

  if nullif(btrim(coalesce(p_refused, '')), '') is not null and v_qty > 0 then
    if v_rule = 'regular' then
      v_qty := least(v_qty, greatest(0, round(v_cmp * 4 - v_stock)));
    end if;
    v_reason := v_reason || format(' · เขตเคยไม่รับของรายการนี้ ("%s") → เติมแค่ถึง 4 เดือน', p_refused);
  end if;

  return jsonb_build_object(
    'rule', v_rule,
    'qty', v_qty,
    'reason', v_reason,
    'months_used', v_used,
    'median', v_median,
    'typical', v_typical,
    'last4', v_last4,
    'cmp_adjusted', v_cmp,
    'spikes', v_spikes,
    'usage_12m', to_jsonb(v_usage),
    'usage_labels', to_jsonb(v_labels),
    'usage_as_of', v_asof);
end;
$$;

revoke all on function core.m31_suggest(text, text, numeric, text) from public, anon, authenticated;

-- One row per material for a district (or every district) --------------------
create or replace function core.m31_district_usage(p_district text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, core, ops, analytics
as $$
  with hist as (
    select * from core.m31_dispatch_history()
    where p_district = 'all' or district_id = p_district
  ), hist_agg as (
    select h.district_id, h.material_id,
      count(*) filter (where h.status in ('จ่ายได้ตามแผน', 'ปรับจำนวน')) as issued_lines,
      sum(coalesce(h.actual_qty, h.plan_qty)) filter (where h.status in ('จ่ายได้ตามแผน', 'ปรับจำนวน')) as issued_qty,
      max(coalesce(h.actual_date, h.plan_date)) filter (where h.status in ('จ่ายได้ตามแผน', 'ปรับจำนวน')) as last_issued,
      count(*) filter (where h.status = 'ไม่รับของ') as refused_lines,
      (array_agg(coalesce(nullif(h.note, ''), 'ไม่ระบุเหตุผล') order by h.plan_date desc)
        filter (where h.status = 'ไม่รับของ'))[1] as last_refusal,
      count(*) filter (where h.fill_type = 'เขตแจ้งใช้') as district_requests
    from hist h
    group by 1, 2
  ), kt as (
    select s.material_id, sum(s.quantity_on_hand) as qty
    from core.stock_snapshots s
    where s.location_id = 'WH-KT'
      and s.snapshot_at = (select max(x.snapshot_at) from core.stock_snapshots x where x.location_id = 'WH-KT')
    group by 1
  ), health as (
    select * from analytics.stock_health_at(now())
    where p_district = 'all' or district_id = p_district
  ), keys as (
    select h.district_id, h.material_id from health h
    union
    select a.district_id, a.material_id from hist_agg a where a.district_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'district_id', k.district_id,
      'district_name', d.district_name_th,
      'material_id', k.material_id,
      'material_name', m.material_name,
      'unit', m.unit,
      'is_vmi', coalesce(m.is_vmi, false),
      'district_stock_qty', h.current_stock_qty,
      'cmp_monthly', h.cmp_monthly,
      'months_available', h.months_available,
      'kt_stock_qty', coalesce(kt.qty, 0),
      'issued_lines', coalesce(a.issued_lines, 0),
      'issued_qty', coalesce(a.issued_qty, 0),
      'last_issued', a.last_issued,
      'refused_lines', coalesce(a.refused_lines, 0),
      'last_refusal', a.last_refusal,
      'district_requests', coalesce(a.district_requests, 0),
      'suggestion', core.m31_suggest(k.material_id, k.district_id, h.current_stock_qty, a.last_refusal)
    ) order by k.district_id, k.material_id), '[]'::jsonb)
  from keys k
  left join core.districts d on d.district_id = k.district_id
  left join core.materials m on m.material_id = k.material_id
  left join health h on h.district_id = k.district_id and h.material_id = k.material_id
  left join hist_agg a on a.district_id = k.district_id and a.material_id = k.material_id
  left join kt on kt.material_id = k.material_id
  where coalesce(m.is_vmi, false) or a.material_id is not null;
$$;

revoke all on function core.m31_district_usage(text) from public, anon, authenticated;

-- Dispatcher -------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m31(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text) rename to m09_dispatch_impl_m31;
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
  v_district text;
  v_result jsonb;
begin
  if upper(coalesce(p_method, '')) = 'GET' and p_path like '/v1/district-usage%' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text, district_id into v_role, v_district
    from public.user_profiles where user_id = v_user_id and is_active;
    if v_role is null then
      return public.m09_error(403, 'forbidden', 'Active profile is required', p_request_id);
    end if;
    -- a district user only sees their own district
    v_district := case when v_role = 'district' then v_district
      else nullif(p_query ->> 'district_id', '') end;

    if p_path = '/v1/district-usage' then
      if v_district is null then
        return public.m09_error(400, 'bad_request', 'district_id is required (or "all")', p_request_id);
      end if;
      return public.m09_result(200, core.m31_district_usage(v_district));
    elsif p_path = '/v1/district-usage/history' then
      return public.m09_result(200, coalesce((
        select jsonb_agg(to_jsonb(h) order by h.plan_date desc nulls last, h.district_id, h.material_id)
        from core.m31_dispatch_history() h
        where (v_district is null or v_district = 'all' or h.district_id = v_district)
          and (nullif(p_query ->> 'material_id', '') is null or h.material_id = p_query ->> 'material_id')
      ), '[]'::jsonb));
    elsif p_path = '/v1/district-usage/summary' then
      return public.m09_result(200, coalesce((
        select jsonb_agg(x order by x ->> 'district_id') from (
          select jsonb_build_object(
            'district_id', d.district_id,
            'district_name', d.district_name_th,
            'issued_lines', count(h.*) filter (where h.status in ('จ่ายได้ตามแผน', 'ปรับจำนวน')),
            'refused_lines', count(h.*) filter (where h.status = 'ไม่รับของ'),
            'district_requests', count(h.*) filter (where h.fill_type = 'เขตแจ้งใช้'),
            'materials', count(distinct h.material_id),
            'first_date', min(h.plan_date),
            'last_date', max(h.plan_date)) as x
          from core.districts d
          left join core.m31_dispatch_history() h on h.district_id = d.district_id
          where v_district is null or v_district = 'all' or d.district_id = v_district
          group by d.district_id, d.district_name_th) s
      ), '[]'::jsonb));
    end if;
    return public.m09_error(404, 'not_found', 'Unknown district-usage route', p_request_id);
  end if;

  v_result := public.m09_dispatch_impl_m31(p_method, p_path, p_query, p_body, p_request_id);

  if upper(coalesce(p_method, '')) = 'GET' and p_path = '/v1/replenishment/queue'
     and coalesce((v_result ->> 'status')::integer, 0) = 200
     and jsonb_typeof(v_result -> 'body') = 'array' then
    return jsonb_set(v_result, '{body}', coalesce((
      with refused as (
        select h.district_id, h.material_id,
          (array_agg(coalesce(nullif(h.note, ''), 'ไม่ระบุเหตุผล') order by h.plan_date desc))[1] as reason
        from core.m31_dispatch_history() h
        where h.status = 'ไม่รับของ'
        group by 1, 2
      )
      select jsonb_agg(r || jsonb_build_object(
          -- what the district really needs; a shortage stays visible
          'ai_qty', (s.v ->> 'qty')::numeric,
          'ai_rule', s.v ->> 'rule',
          'ai_reason', (s.v ->> 'reason') || case
            when (s.v ->> 'qty')::numeric > coalesce((r ->> 'kt_stock_qty')::numeric, (s.v ->> 'qty')::numeric)
            then format(' · Stock คลองเตยมี %s ขาด %s', r ->> 'kt_stock_qty',
              (s.v ->> 'qty')::numeric - (r ->> 'kt_stock_qty')::numeric) else '' end,
          'ai_kt_short', greatest(0::numeric, coalesce((s.v ->> 'qty')::numeric, 0)
            - coalesce((r ->> 'kt_stock_qty')::numeric, coalesce((s.v ->> 'qty')::numeric, 0))),
          'ai_usage', s.v -> 'usage_12m',
          'ai_usage_labels', s.v -> 'usage_labels',
          'ai_typical', s.v -> 'typical',
          'ai_cmp_adjusted', s.v -> 'cmp_adjusted',
          'ai_months_used', s.v -> 'months_used')
        order by ord)
      from jsonb_array_elements(v_result -> 'body') with ordinality as e(r, ord)
      left join refused f on f.district_id = r ->> 'district_id' and f.material_id = r ->> 'material_id'
      cross join lateral (select core.m31_suggest(r ->> 'material_id', r ->> 'district_id',
        (r ->> 'current_stock_qty')::numeric, f.reason) as v) s
    ), '[]'::jsonb));
  end if;

  return v_result;
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text) to authenticated;

commit;

notify pgrst, 'reload schema';
