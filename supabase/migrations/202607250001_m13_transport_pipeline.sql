-- SYNAPSE M13: Governed transport / route-dispatch pipeline.
-- Adds transport masters (warehouses, district geo, vehicles, warehouse->district
-- route legs) and a transactional trips table, all served through a dedicated
-- security-definer dispatcher (public.m13_transport_dispatch) exposed at
-- /v1/transport/*. This connects the Transport module to Supabase as a first-class,
-- governed pipeline following the same conventions as m09/m10/m11. The prior
-- forecasting/OR-Tools /v1/routes* scope remains excluded; this is a separate,
-- deterministic route-leg model with no worker dependency.

begin;

-- ============================================================
-- Masters (reference data)
-- ============================================================
create table if not exists core.transport_warehouses (
  warehouse_code text primary key,
  name_th text not null check (btrim(name_th) <> ''),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists core.transport_district_geo (
  district_ref text primary key,
  name_th text not null check (btrim(name_th) <> ''),
  latitude numeric(9, 6) not null check (latitude between -90 and 90),
  longitude numeric(9, 6) not null check (longitude between -180 and 180),
  map_x integer not null,
  map_y integer not null,
  is_warehouse boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists core.transport_vehicles (
  vehicle_id text primary key,
  plate text not null,
  vehicle_type text not null,
  asset_code text not null,
  storage_location text not null,
  home_warehouse text not null references core.transport_warehouses (warehouse_code) on delete restrict,
  current_warehouse text not null references core.transport_warehouses (warehouse_code) on delete restrict,
  loan_status text not null default 'HOME' check (loan_status in ('HOME', 'LOANED_OUT', 'LOANED_IN')),
  max_weight_kg numeric not null check (max_weight_kg > 0),
  max_volume_m3 numeric not null check (max_volume_m3 > 0),
  fuel_rate_km_per_l numeric not null check (fuel_rate_km_per_l > 0),
  fuel_price_thb_per_l numeric not null check (fuel_price_thb_per_l > 0),
  driver_name text not null,
  color text not null default '#1A56DB',
  color_light text not null default '#DBEAFE',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists core.transport_route_legs (
  warehouse_code text not null references core.transport_warehouses (warehouse_code) on delete cascade,
  district_ref text not null references core.transport_district_geo (district_ref) on delete cascade,
  distance_km numeric not null check (distance_km >= 0),
  toll_thb numeric not null check (toll_thb >= 0),
  travel_minutes integer not null check (travel_minutes >= 0),
  unload_fixed_min integer not null default 0 check (unload_fixed_min >= 0),
  unload_per_pallet_min integer not null default 0 check (unload_per_pallet_min >= 0),
  primary key (warehouse_code, district_ref)
);

-- ============================================================
-- Transactional trips
-- ============================================================
create table if not exists ops.transport_trips (
  trip_id uuid primary key default gen_random_uuid(),
  trip_code text not null unique,
  batch_code text,
  vehicle_id text not null references core.transport_vehicles (vehicle_id) on delete restrict,
  driver_name text not null,
  warehouse_code text not null references core.transport_warehouses (warehouse_code) on delete restrict,
  route_district_refs text[] not null check (array_length(route_district_refs, 1) >= 1),
  total_distance_km numeric not null check (total_distance_km >= 0),
  total_toll_thb numeric not null check (total_toll_thb >= 0),
  total_travel_minutes integer not null check (total_travel_minutes >= 0),
  fuel_cost_estimate_thb numeric not null check (fuel_cost_estimate_thb >= 0),
  fuel_cost_actual_thb numeric check (fuel_cost_actual_thb >= 0),
  trip_date date not null default current_date,
  depart_time text,
  return_time text,
  status text not null default 'planned' check (status in ('planned', 'dispatched', 'completed', 'cancelled')),
  max_weight_kg numeric not null default 0 check (max_weight_kg >= 0),
  notes text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists transport_trips_recent_idx
  on ops.transport_trips (created_at desc, warehouse_code, status);

-- ============================================================
-- Row-level security — served only through the security-definer dispatcher.
-- ============================================================
alter table core.transport_warehouses enable row level security;
alter table core.transport_district_geo enable row level security;
alter table core.transport_vehicles enable row level security;
alter table core.transport_route_legs enable row level security;
alter table ops.transport_trips enable row level security;

revoke all on core.transport_warehouses from public, anon, authenticated;
revoke all on core.transport_district_geo from public, anon, authenticated;
revoke all on core.transport_vehicles from public, anon, authenticated;
revoke all on core.transport_route_legs from public, anon, authenticated;
revoke all on ops.transport_trips from public, anon, authenticated;

grant all on core.transport_warehouses to service_role;
grant all on core.transport_district_geo to service_role;
grant all on core.transport_vehicles to service_role;
grant all on core.transport_route_legs to service_role;
grant all on ops.transport_trips to service_role;

-- ============================================================
-- Analytics views
-- ============================================================
create or replace view analytics.v_transport_vehicle_status as
select
  v.vehicle_id,
  v.plate,
  v.asset_code,
  v.vehicle_type,
  v.home_warehouse,
  v.current_warehouse,
  v.loan_status,
  v.driver_name,
  v.max_weight_kg,
  v.max_volume_m3,
  v.fuel_rate_km_per_l,
  v.fuel_price_thb_per_l,
  v.color,
  v.color_light,
  v.is_active
from core.transport_vehicles v;

create or replace view analytics.v_transport_route_matrix as
select
  r.warehouse_code,
  r.district_ref,
  g.name_th as district_name_th,
  g.latitude,
  g.longitude,
  g.map_x,
  g.map_y,
  r.distance_km,
  r.toll_thb,
  r.travel_minutes,
  r.unload_fixed_min,
  r.unload_per_pallet_min
from core.transport_route_legs r
join core.transport_district_geo g on g.district_ref = r.district_ref;

create or replace view analytics.v_transport_trip_summary as
select
  t.trip_id,
  t.trip_code,
  t.batch_code,
  t.vehicle_id,
  t.driver_name,
  t.warehouse_code,
  t.route_district_refs,
  t.total_distance_km,
  t.total_toll_thb,
  t.total_travel_minutes,
  t.fuel_cost_estimate_thb,
  t.fuel_cost_actual_thb,
  t.trip_date,
  t.depart_time,
  t.return_time,
  t.status,
  t.notes,
  t.created_at
from ops.transport_trips t;

grant select on analytics.v_transport_vehicle_status to service_role;
grant select on analytics.v_transport_route_matrix to service_role;
grant select on analytics.v_transport_trip_summary to service_role;

-- ============================================================
-- Seed masters (ported from the prior pipeline DB_Route / vehicle registry)
-- ============================================================
insert into core.transport_warehouses (warehouse_code, name_th) values
  ('คลองเตย', 'คลังกลาง คลองเตย'),
  ('บางพลี', 'คลังบางพลี'),
  ('เมืองใหม่', 'คลังเมืองใหม่')
on conflict (warehouse_code) do nothing;

insert into core.transport_district_geo (district_ref, name_th, latitude, longitude, map_x, map_y, is_warehouse) values
  ('WH', 'คลังกลาง (คลองเตย)', 13.720000, 100.550000, 165, 265, true),
  ('5501', 'การไฟฟ้าเขต นวลจันทร์', 13.750000, 100.520000, 100, 225, false),
  ('5601', 'การไฟฟ้าเขต สามเสน', 13.810000, 100.490000, 55, 155, false),
  ('5701', 'การไฟฟ้าเขต นนทบุรี', 13.720000, 100.580000, 205, 265, false),
  ('5801', 'การไฟฟ้าเขต ธนบุรี', 13.850000, 100.550000, 155, 105, false),
  ('5901', 'การไฟฟ้าเขต บางใหญ่', 13.730000, 100.480000, 42, 248, false),
  ('6001', 'การไฟฟ้าเขต ลาดกระบัง', 13.680000, 100.510000, 80, 310, false),
  ('6501', 'การไฟฟ้าเขต บางนา', 13.590000, 101.010000, 595, 365, false),
  ('6601', 'การไฟฟ้าเขต วัดเลียบ', 13.520000, 101.080000, 678, 430, false),
  ('6701', 'การไฟฟ้าเขต คลองเตย', 13.610000, 100.920000, 510, 340, false),
  ('6801', 'การไฟฟ้าเขต ราชภูมิบุรณะ', 13.650000, 100.980000, 568, 295, false),
  ('6901', 'การไฟฟ้าเขต ยานนาวา', 13.450000, 101.150000, 758, 498, false),
  ('7001', 'การไฟฟ้าเขต บางขุนเทียน', 13.500000, 101.200000, 800, 448, false),
  ('7501', 'การไฟฟ้าเขต บางบัวทอง', 14.000000, 100.800000, 30, 200, false),
  ('7601', 'การไฟฟ้าเขต บางปะกิ', 14.350000, 100.550000, 90, 110, false),
  ('7701', 'การไฟฟ้าเขต สมุทรปราการ', 14.800000, 100.400000, 135, 70, false),
  ('7801', 'การไฟฟ้าเขต บางพลี', 13.900000, 101.500000, 70, 315, false),
  ('7901', 'การไฟฟ้าเขต มีนบุรี', 13.750000, 101.800000, 220, 350, false),
  ('8001', 'การไฟฟ้าเขต บางเขน', 13.500000, 102.100000, 45, 330, false)
on conflict (district_ref) do nothing;

insert into core.transport_vehicles (vehicle_id, plate, vehicle_type, asset_code, storage_location, home_warehouse, current_warehouse, max_weight_kg, max_volume_m3, fuel_rate_km_per_l, fuel_price_thb_per_l, driver_name, color, color_light) values
  ('V707', 'ทะเบียน 707', '6-wheel', 'พด.707', '0001', 'คลองเตย', 'คลองเตย', 5000, 24.2, 12.5, 35.5, 'สมชาย กาญจนา', '#005BAC', '#DBEAFE'),
  ('V708', 'ทะเบียน 708', '6-wheel', 'พด.708', '0001', 'คลองเตย', 'คลองเตย', 5000, 24.2, 12.5, 35.5, 'ณรงค์ ทองดี', '#10B981', '#D1FAE5'),
  ('V701', 'ทะเบียน 701', '6-wheel', 'พด.701', '0002', 'บางพลี', 'บางพลี', 5000, 24.2, 12.5, 35.5, 'วิชัย ประสาน', '#F59E0B', '#FEF3C7'),
  ('V702', 'ทะเบียน 702', '6-wheel', 'พด.702', '0006', 'เมืองใหม่', 'เมืองใหม่', 5000, 24.2, 13.0, 35.5, 'นิรันดร์ สุขใจ', '#EF4444', '#FEE2E2'),
  ('V703', 'ทะเบียน 703', '6-wheel', 'พด.703', '0006', 'เมืองใหม่', 'เมืองใหม่', 5000, 24.2, 13.0, 35.5, 'ประสงค์ ดีงาม', '#8B5CF6', '#EDE9FE'),
  ('V706', 'ทะเบียน 706', '6-wheel', 'พด.706', '0006', 'เมืองใหม่', 'เมืองใหม่', 5000, 24.2, 13.0, 35.5, 'มานะ ขยัน', '#EC4899', '#FCE7F3')
on conflict (vehicle_id) do nothing;

insert into core.transport_route_legs (warehouse_code, district_ref, distance_km, toll_thb, travel_minutes, unload_fixed_min, unload_per_pallet_min) values
  ('คลองเตย','5501',15.2,60,35,20,8),('คลองเตย','5601',22.8,80,50,20,8),('คลองเตย','5701',18.5,60,40,20,8),
  ('คลองเตย','5801',31.0,100,65,20,8),('คลองเตย','5901',12.3,40,28,20,8),('คลองเตย','6001',28.7,80,60,20,8),
  ('คลองเตย','6501',48.5,140,90,25,10),('คลองเตย','6601',58.0,160,110,25,10),('คลองเตย','6701',41.5,120,80,25,10),
  ('คลองเตย','6801',35.0,100,70,25,10),('คลองเตย','6901',72.5,200,130,25,10),('คลองเตย','7001',65.0,180,120,25,10),
  ('คลองเตย','7501',88.0,220,145,30,12),('คลองเตย','7601',112.0,260,175,30,12),('คลองเตย','7701',138.0,300,210,30,12),
  ('คลองเตย','7801',98.0,240,155,30,12),('คลองเตย','7901',122.0,280,185,30,12),('คลองเตย','8001',155.0,320,225,30,12),
  ('บางพลี','5501',42.0,120,80,20,8),('บางพลี','5601',50.0,140,95,20,8),('บางพลี','5701',45.0,120,85,20,8),
  ('บางพลี','5801',55.0,160,100,20,8),('บางพลี','5901',38.0,100,72,20,8),('บางพลี','6001',52.0,140,95,20,8),
  ('บางพลี','6501',35.0,120,70,25,10),('บางพลี','6601',42.5,120,85,25,10),('บางพลี','6701',28.0,80,55,25,10),
  ('บางพลี','6801',19.5,60,45,25,10),('บางพลี','6901',55.0,160,100,25,10),('บางพลี','7001',48.5,140,90,25,10),
  ('บางพลี','7501',115.0,280,175,30,12),('บางพลี','7601',140.0,320,210,30,12),('บางพลี','7701',168.0,360,245,30,12),
  ('บางพลี','7801',75.5,200,125,30,12),('บางพลี','7901',95.0,220,150,30,12),('บางพลี','8001',125.0,260,190,30,12),
  ('เมืองใหม่','5501',95.0,240,150,20,8),('เมืองใหม่','5601',102.0,260,160,20,8),('เมืองใหม่','5701',98.0,240,155,20,8),
  ('เมืองใหม่','5801',108.0,260,165,20,8),('เมืองใหม่','5901',90.0,220,142,20,8),('เมืองใหม่','6001',105.0,260,162,20,8),
  ('เมืองใหม่','6501',88.0,220,140,25,10),('เมืองใหม่','6601',95.0,240,152,25,10),('เมืองใหม่','6701',80.0,200,130,25,10),
  ('เมืองใหม่','6801',72.0,180,118,25,10),('เมืองใหม่','6901',108.0,260,168,25,10),('เมืองใหม่','7001',100.0,240,158,25,10),
  ('เมืองใหม่','7501',65.0,180,110,30,12),('เมืองใหม่','7601',88.5,200,140,30,12),('เมืองใหม่','7701',112.0,240,175,30,12),
  ('เมืองใหม่','7801',75.5,200,125,30,12),('เมืองใหม่','7901',95.0,220,150,30,12),('เมืองใหม่','8001',125.0,260,190,30,12)
on conflict (warehouse_code, district_ref) do nothing;

-- ============================================================
-- Dispatcher — /v1/transport/*
-- ============================================================
create or replace function public.m13_transport_dispatch(
  p_method text,
  p_path text,
  p_query jsonb default '{}'::jsonb,
  p_body jsonb default '{}'::jsonb,
  p_request_id text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core, analytics, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_district_id text;
  v_method text := upper(coalesce(p_method, ''));
  v_payload jsonb;
  v_limit integer;
  v_status_filter text;
  v_warehouse text;
  v_stops text[];
  v_vehicle core.transport_vehicles%rowtype;
  v_dist numeric;
  v_toll numeric;
  v_mins integer;
  v_missing integer;
  v_fuel numeric;
  v_trip ops.transport_trips%rowtype;
  v_trip_id uuid;
  v_new_status text;
begin
  if v_user_id is null then
    return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
  end if;

  select role::text, district_id into v_role, v_district_id
  from public.user_profiles
  where user_id = v_user_id and is_active;

  if v_role is null then
    return public.m09_error(403, 'forbidden', 'No application role is assigned', p_request_id);
  end if;

  -- ---- Reads (any authenticated role) ----
  if v_method = 'GET' and p_path = '/v1/transport/warehouses' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.warehouse_code), '[]'::jsonb) into v_payload
    from (select warehouse_code, name_th, is_active from core.transport_warehouses where is_active) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/geo' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (
      select district_ref, name_th, latitude, longitude, map_x, map_y, is_warehouse
      from core.transport_district_geo order by is_warehouse desc, district_ref
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/vehicles' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.vehicle_id), '[]'::jsonb) into v_payload
    from (select * from analytics.v_transport_vehicle_status where is_active) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/route-matrix' then
    v_warehouse := nullif(p_query ->> 'warehouse', '');
    select coalesce(jsonb_agg(to_jsonb(q) order by q.warehouse_code, q.distance_km), '[]'::jsonb) into v_payload
    from (
      select * from analytics.v_transport_route_matrix
      where v_warehouse is null or warehouse_code = v_warehouse
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/trips' then
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 100);
    if v_limit not between 1 and 500 then
      return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id);
    end if;
    v_status_filter := nullif(p_query ->> 'status', '');
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (
      select * from analytics.v_transport_trip_summary
      where v_status_filter is null or status = v_status_filter
      order by created_at desc
      limit v_limit
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  -- ---- Writes (admin / planner) ----
  if v_method = 'POST' and p_path = '/v1/transport/trips' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Only admin or planner may plan trips', p_request_id);
    end if;
    v_warehouse := btrim(coalesce(p_body ->> 'warehouse_code', ''));
    if not exists (select 1 from core.transport_warehouses where warehouse_code = v_warehouse and is_active) then
      return public.m09_error(422, 'validation_error', 'Unknown or inactive warehouse', p_request_id);
    end if;
    select array_agg(value::text) into v_stops
    from jsonb_array_elements_text(coalesce(p_body -> 'stops', '[]'::jsonb)) as value;
    if v_stops is null or array_length(v_stops, 1) is null then
      return public.m09_error(422, 'validation_error', 'At least one destination stop is required', p_request_id);
    end if;
    -- All stops must have a route leg from this warehouse.
    select count(*) into v_missing
    from unnest(v_stops) s(district_ref)
    where not exists (
      select 1 from core.transport_route_legs r
      where r.warehouse_code = v_warehouse and r.district_ref = s.district_ref
    );
    if v_missing > 0 then
      return public.m09_error(422, 'validation_error', 'One or more stops have no route from this warehouse', p_request_id);
    end if;
    -- Authoritative totals from the route matrix.
    select sum(r.distance_km), sum(r.toll_thb), sum(r.travel_minutes)
    into v_dist, v_toll, v_mins
    from core.transport_route_legs r
    join unnest(v_stops) s(district_ref) on s.district_ref = r.district_ref
    where r.warehouse_code = v_warehouse;
    -- Vehicle: caller-supplied or first active vehicle stationed at the warehouse.
    if nullif(p_body ->> 'vehicle_id', '') is not null then
      select * into v_vehicle from core.transport_vehicles
      where vehicle_id = p_body ->> 'vehicle_id' and is_active;
      if not found then
        return public.m09_error(422, 'validation_error', 'Unknown or inactive vehicle', p_request_id);
      end if;
    else
      select * into v_vehicle from core.transport_vehicles
      where current_warehouse = v_warehouse and is_active
      order by vehicle_id limit 1;
      if not found then
        return public.m09_error(409, 'conflict', 'No active vehicle stationed at this warehouse', p_request_id);
      end if;
    end if;
    v_fuel := round((v_dist / v_vehicle.fuel_rate_km_per_l) * v_vehicle.fuel_price_thb_per_l, 2);
    insert into ops.transport_trips (
      trip_code, batch_code, vehicle_id, driver_name, warehouse_code, route_district_refs,
      total_distance_km, total_toll_thb, total_travel_minutes, fuel_cost_estimate_thb,
      trip_date, status, max_weight_kg, notes, created_by
    ) values (
      'TRP-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
      nullif(p_body ->> 'batch_code', ''),
      v_vehicle.vehicle_id, v_vehicle.driver_name, v_warehouse, v_stops,
      round(v_dist, 1), v_toll, v_mins, v_fuel,
      coalesce(nullif(p_body ->> 'trip_date', '')::date, current_date),
      'planned', v_vehicle.max_weight_kg,
      left(coalesce(p_body ->> 'notes', ''), 1000), v_user_id
    ) returning * into v_trip;
    return public.m09_result(201, to_jsonb(v_trip));
  end if;

  if v_method = 'POST' and p_path ~ '^/v1/transport/trips/[0-9a-fA-F-]{36}/status$' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Only admin or planner may update trips', p_request_id);
    end if;
    v_trip_id := substring(p_path from '^/v1/transport/trips/([0-9a-fA-F-]{36})/status$')::uuid;
    v_new_status := btrim(coalesce(p_body ->> 'status', ''));
    if v_new_status not in ('planned', 'dispatched', 'completed', 'cancelled') then
      return public.m09_error(422, 'validation_error', 'Invalid status', p_request_id);
    end if;
    update ops.transport_trips
    set status = v_new_status,
        fuel_cost_actual_thb = coalesce(nullif(p_body ->> 'fuel_cost_actual_thb', '')::numeric, fuel_cost_actual_thb),
        depart_time = coalesce(nullif(p_body ->> 'depart_time', ''), depart_time),
        return_time = coalesce(nullif(p_body ->> 'return_time', ''), return_time),
        updated_at = now()
    where trip_id = v_trip_id
    returning * into v_trip;
    if not found then
      return public.m09_error(404, 'not_found', 'Trip not found', p_request_id);
    end if;
    return public.m09_result(200, to_jsonb(v_trip));
  end if;

  return public.m09_error(404, 'not_found', 'Transport API path not found', p_request_id);
end;
$$;

revoke all on function public.m13_transport_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.m13_transport_dispatch(text, text, jsonb, jsonb, text) to authenticated;

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607250001', 'M13',
  'Governed transport pipeline: warehouse/geo/vehicle/route-leg masters, transport_trips, analytics views and /v1/transport dispatcher.',
  'supabase/migrations/202607250001_m13_transport_pipeline.sql'
)
on conflict (version) do update
set description = excluded.description, source_file = excluded.source_file;

commit;
