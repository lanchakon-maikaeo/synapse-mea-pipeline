-- M22: Goods-first weekly dispatch.
--
-- After the weekly plan is locked, the planner loads the week's demand (locked
-- plan lines + extra requests routed to that week), the browser solver builds
-- truck trips from the real pallet count / weight (8 pallets per 6-wheel truck,
-- back by 15:00), hands single-district near-full loads close to the warehouse
-- to district pick-up only in weeks the two trucks cannot cover, and the plan is
-- saved (draft) or confirmed. Districts see their confirmed delivery or pick-up.
--
--   GET  /v1/dispatch/demand?week=YYYY-MM-DD   admin, planner, picker
--   GET  /v1/dispatch/plans?week=YYYY-MM-DD    all roles (district: own stops only)
--   POST /v1/dispatch/plans                    admin, planner (save draft / confirm)
--   POST /v1/dispatch/config                   admin, planner (settings, vehicles, district profile)

begin;

create table if not exists ops.dispatch_settings (
  singleton boolean primary key default true check (singleton),
  start_time time not null default '09:30',
  return_by time not null default '15:00',
  unload_minutes integer not null default 40 check (unload_minutes between 5 and 180),
  avg_speed_kmh numeric not null default 30 check (avg_speed_kmh between 5 and 90),
  road_factor numeric not null default 1.55 check (road_factor between 1 and 3),
  loose_per_mixed_pallet numeric not null default 30 check (loose_per_mixed_pallet > 0),
  estimate_pallet_per_line numeric not null default 0.25 check (estimate_pallet_per_line > 0),
  default_pallet_kg numeric not null default 1250 check (default_pallet_kg > 0),
  pickup_max_km numeric not null default 17 check (pickup_max_km >= 0),
  pickup_min_pallets numeric not null default 5 check (pickup_min_pallets >= 0),
  pickup_rotation_weeks integer not null default 4 check (pickup_rotation_weeks between 0 and 26),
  max_stops_per_trip integer not null default 4 check (max_stops_per_trip between 1 and 8),
  max_trips_per_truck_day integer not null default 1 check (max_trips_per_truck_day between 1 and 3),
  reload_minutes integer not null default 30 check (reload_minutes between 0 and 120),
  delivery_weekdays smallint[] not null default '{1,2,3,4,5}',
  baht_per_km numeric not null default 9.64,
  toll_per_trip numeric not null default 89,
  warehouse_lat numeric not null default 13.7200,
  warehouse_lon numeric not null default 100.5500,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
insert into ops.dispatch_settings (singleton) values (true) on conflict do nothing;

create table if not exists ops.dispatch_vehicles (
  vehicle_code text primary key check (vehicle_code ~ '^[A-Za-z0-9.-]{1,20}$'),
  label text not null,
  pallet_capacity integer not null default 8 check (pallet_capacity between 1 and 30),
  max_payload_kg numeric check (max_payload_kg is null or max_payload_kg > 0),
  deck_length_m numeric,
  deck_width_m numeric,
  is_active boolean not null default true,
  sort_order smallint not null default 0
);
insert into ops.dispatch_vehicles (vehicle_code, label, pallet_capacity, max_payload_kg, deck_length_m, deck_width_m, sort_order) values
  ('707', 'พด.707 (6 ล้อ)', 8, null, 5.10, 2.40, 1),
  ('708', 'พด.708 (6 ล้อ)', 8, null, 5.20, 2.45, 2)
on conflict (vehicle_code) do nothing;

create table if not exists ops.dispatch_district_profile (
  district_id text primary key references core.districts (district_id),
  depot_km numeric,
  has_vehicle boolean,
  pickup_allowed boolean not null default true,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
-- One-way distance from คลังคลองเตย (workbook sheet "Analysis": expressway, or normal road where no expressway)
insert into ops.dispatch_district_profile (district_id, depot_km)
select v.district_id, v.km
from (values
  ('5501', 26.0), ('5502', 16.8), ('5503', 28.7), ('5504', 16.1), ('5505', 32.0), ('5506', 32.5),
  ('5507', 8.0), ('5508', 7.6), ('5509', 1.0), ('5510', 10.0), ('5511', 13.0), ('5512', 23.0),
  ('5513', 49.0), ('5514', 11.0), ('5515', 23.0), ('5516', 23.5), ('5517', 35.0), ('5518', 27.0)
) as v (district_id, km)
where exists (select 1 from core.districts d where d.district_id = v.district_id)
on conflict (district_id) do nothing;

create table if not exists ops.dispatch_plans (
  dispatch_plan_id uuid primary key default gen_random_uuid(),
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'superseded')),
  settings jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz
);
create unique index if not exists dispatch_plans_confirmed_week_uq
  on ops.dispatch_plans (week_start) where status = 'confirmed';

create table if not exists ops.dispatch_trips (
  dispatch_trip_id uuid primary key default gen_random_uuid(),
  dispatch_plan_id uuid not null references ops.dispatch_plans (dispatch_plan_id) on delete cascade,
  trip_date date,
  vehicle_code text,
  mode text not null check (mode in ('delivery', 'pickup', 'overflow')),
  seq integer not null default 0,
  stops jsonb not null default '[]'::jsonb,
  pallets numeric not null default 0,
  weight_kg numeric not null default 0,
  km numeric,
  minutes numeric,
  cost_baht numeric,
  layout jsonb
);
create index if not exists dispatch_trips_plan_idx on ops.dispatch_trips (dispatch_plan_id, trip_date, vehicle_code);

alter table ops.dispatch_settings enable row level security;
alter table ops.dispatch_vehicles enable row level security;
alter table ops.dispatch_district_profile enable row level security;
alter table ops.dispatch_plans enable row level security;
alter table ops.dispatch_trips enable row level security;
revoke all on ops.dispatch_settings, ops.dispatch_vehicles, ops.dispatch_district_profile,
  ops.dispatch_plans, ops.dispatch_trips from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Demand for a week
-- ------------------------------------------------------------------
create or replace function core.m22_dispatch_demand(p_week date)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, core, ops, public
as $$
declare
  v_week date := date_trunc('week', p_week)::date;
  v_set ops.dispatch_settings%rowtype;
  v_result jsonb;
begin
  select * into v_set from ops.dispatch_settings where singleton;

  with plan_lines as (
    select 'plan'::text as source, i.replenishment_item_id::text as line_id, p.plan_number as reference,
      p.status as plan_status, i.district_id, i.material_id,
      coalesce(i.final_qty, i.requested_qty, i.planner_qty, i.suggested_qty) as qty,
      (i.months_available < 0.5) as urgent
    from core.replenishment_items i
    join core.replenishment_plans p on p.replenishment_plan_id = i.replenishment_plan_id
    where p.week_start_date = v_week
      and p.status not in ('draft', 'cancelled')
      and i.status not in ('draft', 'cancelled', 'district_rejected')
  ),
  extra_lines as (
    select 'extra'::text, h.ad_hoc_issue_id::text, h.issue_number, h.status, h.district_id, h.material_id,
      h.requested_qty, coalesce(h.urgency_code, 'normal') <> 'normal'
    from ops.ad_hoc_issues h
    where h.status in ('pending_approval', 'approved')
      and h.delivery_date between v_week and v_week + 6
  ),
  lines as (
    select * from plan_lines where qty > 0
    union all
    select * from extra_lines
  ),
  joined as (
    select l.*, m.material_name, m.unit,
      pr.packaging_profile_id, pr.units_per_package, pr.boxes_per_pallet, pr.calculated_pallet_gross_kg,
      coalesce(nullif(pr.item_weight_kg, 0), nullif(m.weight_per_unit_kg, 0)) as item_weight_kg,
      coalesce(nullif(pr.units_per_pallet, 0),
        case when coalesce(pr.units_per_package, 0) = 0 then nullif(m.lot_size, 0) end) as upp,
      coalesce(pr.units_per_pallet, 0) = 0 and coalesce(pr.units_per_package, 0) = 0
        and coalesce(m.lot_size, 0) > 0 as lot_size_estimate,
      coalesce(pr.units_per_pallet, 0) = 0 and coalesce(pr.units_per_package, 0) = 0 as packing_missing
    from lines l
    left join core.materials m on m.material_id = l.material_id
    left join lateral (
      select * from core.packaging_master_profiles x
      where x.material_id = l.material_id
      order by x.verified desc, (x.assumption_status = 'VERIFIED') desc, x.updated_at desc
      limit 1
    ) pr on true
  ),
  sized as (
    select j.*,
      case
        when j.upp > 0 then floor(j.qty / j.upp)
        when coalesce(j.units_per_package, 0) > 0 and coalesce(j.boxes_per_pallet, 0) > 0
          then floor(ceil(j.qty / j.units_per_package) / j.boxes_per_pallet)
        else 0
      end as full_pallets,
      case
        when j.upp > 0 then (j.qty - floor(j.qty / j.upp) * j.upp) / j.upp
        when coalesce(j.units_per_package, 0) > 0 and coalesce(j.boxes_per_pallet, 0) > 0
          then (ceil(j.qty / j.units_per_package)
                - floor(ceil(j.qty / j.units_per_package) / j.boxes_per_pallet) * j.boxes_per_pallet) / j.boxes_per_pallet
        when coalesce(j.units_per_package, 0) > 0
          then ceil(j.qty / j.units_per_package) / v_set.loose_per_mixed_pallet
        else v_set.estimate_pallet_per_line
      end as mixed_fraction
    from joined j
  ),
  weighed as (
    select s.*,
      case
        when coalesce(s.item_weight_kg, 0) > 0 then s.qty * s.item_weight_kg
        when coalesce(s.calculated_pallet_gross_kg, 0) > 0 then (s.full_pallets + s.mixed_fraction) * s.calculated_pallet_gross_kg
        else (s.full_pallets + s.mixed_fraction) * v_set.default_pallet_kg
      end as weight_kg,
      not (coalesce(s.item_weight_kg, 0) > 0 or coalesce(s.calculated_pallet_gross_kg, 0) > 0) as weight_estimated
    from sized s
  ),
  per_district as (
    select w.district_id,
      sum(w.full_pallets) as full_pallets,
      sum(w.mixed_fraction) as mixed_fraction,
      sum(w.full_pallets) + ceil(sum(w.mixed_fraction) - 0.000001) as pallets,
      round(sum(w.weight_kg)) as weight_kg,
      count(*) as lines,
      count(*) filter (where w.packing_missing) as packing_missing_lines,
      count(*) filter (where w.weight_estimated) as weight_estimated_lines,
      bool_or(w.urgent) as urgent,
      count(*) filter (where w.source = 'extra') as extra_lines,
      jsonb_agg(jsonb_build_object(
        'source', w.source, 'line_id', w.line_id, 'reference', w.reference, 'status', w.plan_status,
        'material_id', w.material_id, 'material_name', w.material_name, 'unit', w.unit, 'qty', w.qty,
        'full_pallets', w.full_pallets, 'mixed_fraction', round(w.mixed_fraction, 3),
        'weight_kg', round(w.weight_kg), 'packing_missing', w.packing_missing, 'lot_size_estimate', w.lot_size_estimate, 'urgent', w.urgent
      ) order by w.full_pallets desc, w.mixed_fraction desc) as line_items
    from weighed w
    group by w.district_id
  ),
  last_pickup as (
    select s ->> 'district_id' as district_id, max(t.trip_date) as last_pickup_date
    from ops.dispatch_trips t
    join ops.dispatch_plans dp on dp.dispatch_plan_id = t.dispatch_plan_id and dp.status = 'confirmed'
    cross join lateral jsonb_array_elements(t.stops) s
    where t.mode = 'pickup'
    group by 1
  )
  select jsonb_build_object(
    'week_start', v_week,
    'settings', to_jsonb(v_set) - 'singleton' - 'updated_by',
    'vehicles', coalesce((select jsonb_agg(to_jsonb(v) order by v.sort_order) from ops.dispatch_vehicles v where v.is_active), '[]'::jsonb),
    'plan_statuses', coalesce((select jsonb_agg(distinct p.status) from core.replenishment_plans p
      where p.week_start_date = v_week and p.status not in ('draft', 'cancelled')), '[]'::jsonb),
    'districts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'district_id', d.district_id,
        'district_name', d.district_name_th,
        'zone', zd.zone_code,
        'zone_weekday', z.weekday,
        'promise_date', case when z.weekday is not null then v_week + z.weekday - 1 end,
        'latitude', g.latitude,
        'longitude', g.longitude,
        'depot_km', pf.depot_km,
        'has_vehicle', pf.has_vehicle,
        'pickup_allowed', coalesce(pf.pickup_allowed, true),
        'last_pickup_date', lp.last_pickup_date,
        'pallets', coalesce(pd.pallets, 0),
        'full_pallets', coalesce(pd.full_pallets, 0),
        'mixed_fraction', round(coalesce(pd.mixed_fraction, 0), 3),
        'weight_kg', coalesce(pd.weight_kg, 0),
        'lines', coalesce(pd.lines, 0),
        'extra_lines', coalesce(pd.extra_lines, 0),
        'packing_missing_lines', coalesce(pd.packing_missing_lines, 0),
        'weight_estimated_lines', coalesce(pd.weight_estimated_lines, 0),
        'urgent', coalesce(pd.urgent, false),
        'items', coalesce(pd.line_items, '[]'::jsonb)
      ) order by d.district_id)
      from core.districts d
      left join per_district pd on pd.district_id = d.district_id
      left join ops.delivery_zone_districts zd on zd.district_id = d.district_id
      left join ops.delivery_zones z on z.zone_code = zd.zone_code
      left join ops.dispatch_district_profile pf on pf.district_id = d.district_id
      left join lateral (
        select x.latitude, x.longitude from core.transport_district_geo x
        where x.district_id = d.district_id and x.geocode_status = 'verified'
        order by x.verified_at desc nulls last limit 1
      ) g on true
      left join last_pickup lp on lp.district_id = d.district_id
      where d.is_active
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- ------------------------------------------------------------------
-- Plans
-- ------------------------------------------------------------------
create or replace function core.m22_dispatch_plans(p_week date, p_scope_district text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, core, ops, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'dispatch_plan_id', dp.dispatch_plan_id, 'week_start', dp.week_start, 'status', dp.status,
    'metrics', case when p_scope_district is null then dp.metrics else '{}'::jsonb end,
    'warnings', case when p_scope_district is null then dp.warnings else '[]'::jsonb end,
    'settings', case when p_scope_district is null then dp.settings else '{}'::jsonb end,
    'note', dp.note, 'created_at', dp.created_at, 'created_by_name', cu.display_name,
    'confirmed_at', dp.confirmed_at, 'confirmed_by_name', fu.display_name,
    'trips', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dispatch_trip_id', t.dispatch_trip_id, 'trip_date', t.trip_date, 'vehicle_code', t.vehicle_code,
        'mode', t.mode, 'seq', t.seq, 'stops', t.stops, 'pallets', t.pallets, 'weight_kg', t.weight_kg,
        'km', t.km, 'minutes', t.minutes, 'cost_baht', t.cost_baht, 'layout', t.layout
      ) order by t.trip_date nulls last, t.vehicle_code, t.seq)
      from ops.dispatch_trips t
      where t.dispatch_plan_id = dp.dispatch_plan_id
        and (p_scope_district is null or exists (
          select 1 from jsonb_array_elements(t.stops) s where s ->> 'district_id' = p_scope_district))
    ), '[]'::jsonb)
  ) order by (dp.status = 'confirmed') desc, dp.created_at desc), '[]'::jsonb)
  from ops.dispatch_plans dp
  left join public.user_profiles cu on cu.user_id = dp.created_by
  left join public.user_profiles fu on fu.user_id = dp.confirmed_by
  where dp.week_start = date_trunc('week', p_week)::date
    and dp.status <> 'superseded'
    and (p_scope_district is null or dp.status = 'confirmed');
$$;

create or replace function core.m22_save_dispatch(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_week date := (p_body ->> 'week_start')::date;
  v_status text := coalesce(p_body ->> 'status', 'draft');
  v_id uuid;
  v_trip jsonb;
  v_seq integer := 0;
begin
  if v_week is null or extract(isodow from v_week) <> 1 then
    raise exception 'week_start ต้องเป็นวันจันทร์';
  end if;
  if v_status not in ('draft', 'confirmed') then
    raise exception 'status ต้องเป็น draft หรือ confirmed';
  end if;
  if jsonb_typeof(p_body -> 'trips') is distinct from 'array' then
    raise exception 'trips ต้องเป็น array';
  end if;
  if jsonb_array_length(p_body -> 'trips') > 200 then
    raise exception 'จำนวนเที่ยวเกิน 200';
  end if;

  -- One open draft per week; a confirmation supersedes the previous confirmed plan.
  update ops.dispatch_plans set status = 'superseded'
  where week_start = v_week and (status = 'draft' or (v_status = 'confirmed' and status = 'confirmed'));

  insert into ops.dispatch_plans (week_start, status, settings, metrics, warnings, note, created_by,
    confirmed_by, confirmed_at)
  values (v_week, v_status, coalesce(p_body -> 'settings', '{}'::jsonb), coalesce(p_body -> 'metrics', '{}'::jsonb),
    coalesce(p_body -> 'warnings', '[]'::jsonb), left(nullif(btrim(p_body ->> 'note'), ''), 1000), auth.uid(),
    case when v_status = 'confirmed' then auth.uid() end,
    case when v_status = 'confirmed' then now() end)
  returning dispatch_plan_id into v_id;

  for v_trip in select value from jsonb_array_elements(p_body -> 'trips') loop
    v_seq := v_seq + 1;
    if coalesce(v_trip ->> 'mode', '') not in ('delivery', 'pickup', 'overflow') then
      raise exception 'mode ของเที่ยวไม่ถูกต้อง';
    end if;
    if jsonb_typeof(v_trip -> 'stops') is distinct from 'array' or jsonb_array_length(v_trip -> 'stops') = 0 then
      raise exception 'แต่ละเที่ยวต้องมีจุดส่งอย่างน้อย 1 จุด';
    end if;
    if v_trip ->> 'mode' = 'delivery' and nullif(v_trip ->> 'vehicle_code', '') is not null
       and not exists (select 1 from ops.dispatch_vehicles v where v.vehicle_code = v_trip ->> 'vehicle_code') then
      raise exception 'ไม่พบรถ %', v_trip ->> 'vehicle_code';
    end if;
    insert into ops.dispatch_trips (dispatch_plan_id, trip_date, vehicle_code, mode, seq, stops, pallets,
      weight_kg, km, minutes, cost_baht, layout)
    values (v_id, nullif(v_trip ->> 'trip_date', '')::date, nullif(v_trip ->> 'vehicle_code', ''),
      v_trip ->> 'mode', v_seq, v_trip -> 'stops', coalesce((v_trip ->> 'pallets')::numeric, 0),
      coalesce((v_trip ->> 'weight_kg')::numeric, 0), (v_trip ->> 'km')::numeric, (v_trip ->> 'minutes')::numeric,
      (v_trip ->> 'cost_baht')::numeric, v_trip -> 'layout');
  end loop;

  return jsonb_build_object('dispatch_plan_id', v_id, 'status', v_status, 'trips', v_seq);
end;
$$;

create or replace function core.m22_update_config(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_s jsonb := p_body -> 'settings';
  v_row jsonb;
begin
  if jsonb_typeof(v_s) = 'object' then
    update ops.dispatch_settings set
      unload_minutes = coalesce((v_s ->> 'unload_minutes')::integer, unload_minutes),
      avg_speed_kmh = coalesce((v_s ->> 'avg_speed_kmh')::numeric, avg_speed_kmh),
      loose_per_mixed_pallet = coalesce((v_s ->> 'loose_per_mixed_pallet')::numeric, loose_per_mixed_pallet),
      estimate_pallet_per_line = coalesce((v_s ->> 'estimate_pallet_per_line')::numeric, estimate_pallet_per_line),
      default_pallet_kg = coalesce((v_s ->> 'default_pallet_kg')::numeric, default_pallet_kg),
      pickup_max_km = coalesce((v_s ->> 'pickup_max_km')::numeric, pickup_max_km),
      pickup_min_pallets = coalesce((v_s ->> 'pickup_min_pallets')::numeric, pickup_min_pallets),
      pickup_rotation_weeks = coalesce((v_s ->> 'pickup_rotation_weeks')::integer, pickup_rotation_weeks),
      max_stops_per_trip = coalesce((v_s ->> 'max_stops_per_trip')::integer, max_stops_per_trip),
      max_trips_per_truck_day = coalesce((v_s ->> 'max_trips_per_truck_day')::integer, max_trips_per_truck_day),
      reload_minutes = coalesce((v_s ->> 'reload_minutes')::integer, reload_minutes),
      start_time = coalesce((v_s ->> 'start_time')::time, start_time),
      return_by = coalesce((v_s ->> 'return_by')::time, return_by),
      baht_per_km = coalesce((v_s ->> 'baht_per_km')::numeric, baht_per_km),
      toll_per_trip = coalesce((v_s ->> 'toll_per_trip')::numeric, toll_per_trip),
      updated_at = now(), updated_by = auth.uid()
    where singleton;
  end if;
  if jsonb_typeof(p_body -> 'vehicles') = 'array' then
    for v_row in select value from jsonb_array_elements(p_body -> 'vehicles') loop
      update ops.dispatch_vehicles set
        pallet_capacity = coalesce((v_row ->> 'pallet_capacity')::integer, pallet_capacity),
        max_payload_kg = case when v_row ? 'max_payload_kg' then nullif(v_row ->> 'max_payload_kg', '')::numeric else max_payload_kg end,
        is_active = coalesce((v_row ->> 'is_active')::boolean, is_active)
      where vehicle_code = v_row ->> 'vehicle_code';
    end loop;
  end if;
  if jsonb_typeof(p_body -> 'districts') = 'array' then
    for v_row in select value from jsonb_array_elements(p_body -> 'districts') loop
      insert into ops.dispatch_district_profile (district_id, depot_km, has_vehicle, pickup_allowed, updated_by)
      values (v_row ->> 'district_id', nullif(v_row ->> 'depot_km', '')::numeric,
        nullif(v_row ->> 'has_vehicle', '')::boolean, coalesce((v_row ->> 'pickup_allowed')::boolean, true), auth.uid())
      on conflict (district_id) do update set
        depot_km = coalesce(excluded.depot_km, ops.dispatch_district_profile.depot_km),
        has_vehicle = case when v_row ? 'has_vehicle' then excluded.has_vehicle else ops.dispatch_district_profile.has_vehicle end,
        pickup_allowed = case when v_row ? 'pickup_allowed' then excluded.pickup_allowed else ops.dispatch_district_profile.pickup_allowed end,
        updated_at = now(), updated_by = auth.uid();
    end loop;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function core.m22_dispatch_demand(date) from public, anon, authenticated;
revoke all on function core.m22_dispatch_plans(date, text) from public, anon, authenticated;
revoke all on function core.m22_save_dispatch(jsonb) from public, anon, authenticated;
revoke all on function core.m22_update_config(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Dispatcher
-- ------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m22(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl_m22;
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
  v_method text := upper(coalesce(p_method, ''));
  v_week date;
begin
  if p_path in ('/v1/dispatch/demand', '/v1/dispatch/plans', '/v1/dispatch/config') then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text, district_id into v_role, v_district_id
    from public.user_profiles where user_id = v_user_id and is_active;
    if v_role is null then
      return public.m09_error(403, 'forbidden', 'No application role is assigned', p_request_id);
    end if;
    v_week := coalesce(nullif(p_query ->> 'week', '')::date, (now() at time zone 'Asia/Bangkok')::date);

    if p_path = '/v1/dispatch/demand' and v_method = 'GET' then
      if v_role not in ('admin', 'planner', 'picker') then
        return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
      end if;
      return public.m09_result(200, core.m22_dispatch_demand(v_week));
    end if;
    if p_path = '/v1/dispatch/plans' and v_method = 'GET' then
      return public.m09_result(200, core.m22_dispatch_plans(v_week,
        case when v_role = 'district' then v_district_id end));
    end if;
    if p_path = '/v1/dispatch/plans' and v_method = 'POST' then
      if v_role not in ('admin', 'planner') then
        return public.m09_error(403, 'forbidden', 'Admin or planner role is required', p_request_id);
      end if;
      return public.m09_result(200, core.m22_save_dispatch(coalesce(p_body, '{}'::jsonb)));
    end if;
    if p_path = '/v1/dispatch/config' and v_method = 'POST' then
      if v_role not in ('admin', 'planner') then
        return public.m09_error(403, 'forbidden', 'Admin or planner role is required', p_request_id);
      end if;
      return public.m09_result(200, core.m22_update_config(coalesce(p_body, '{}'::jsonb)));
    end if;
    return public.m09_error(405, 'method_not_allowed', 'Method not allowed', p_request_id);
  end if;

  return public.m09_dispatch_impl_m22(p_method, p_path, p_query, p_body, p_request_id);
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
  (select count(*) from ops.dispatch_vehicles) as vehicles,
  (select count(*) from ops.dispatch_district_profile) as district_profiles,
  (select count(*) from core.transport_district_geo where geocode_status = 'verified' and district_id is not null) as verified_district_coords;
