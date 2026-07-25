-- SYNAPSE M13b: link the transport pipeline to real confirmed replenishment demand.
-- Maps transport route-geo nodes to real districts (5501-5518), exposes a
-- dispatch queue from locked replenishment plans, and lets a trip reference the
-- plan it fulfils. Realises the M08 "Input: Confirmed replenishment plans" contract
-- from the improvement plan while staying free / no-self-host.

begin;

-- 1. Map route-geo refs to real districts (only where the district exists so the
--    clean-CI database, which may not seed districts, does not fail the FK).
alter table core.transport_district_geo
  add column if not exists district_id text references core.districts (district_id);

update core.transport_district_geo g
set district_id = m.district_id
from (values
  ('5501', '5501'), ('5601', '5502'), ('5701', '5503'), ('5801', '5504'),
  ('5901', '5505'), ('6001', '5506'), ('6501', '5507'), ('6601', '5508'),
  ('6701', '5509'), ('6801', '5510'), ('6901', '5511'), ('7001', '5512'),
  ('7501', '5513'), ('7601', '5514'), ('7701', '5515'), ('7801', '5516'),
  ('7901', '5517'), ('8001', '5518')
) as m(route_ref, district_id)
where g.district_ref = m.route_ref
  and exists (select 1 from core.districts d where d.district_id = m.district_id);

create index if not exists transport_district_geo_district_idx
  on core.transport_district_geo (district_id);

-- 2. Let a trip reference the plan it fulfils.
alter table ops.transport_trips
  add column if not exists replenishment_plan_id uuid
    references ops.replenishment_plans (replenishment_plan_id) on delete set null;

-- 3. Dispatch queue: locked plan demand per district, joined to route geo and the
--    nearest serving warehouse (minimum route-leg distance).
create or replace view analytics.v_transport_dispatch_queue as
select
  q.district_id,
  q.district_name_th,
  g.district_ref,
  count(*) as line_count,
  sum(coalesce(q.final_qty, q.confirmed_qty, q.suggested_qty, 0)) as total_qty,
  max(q.plan_number) as plan_number,
  (array_agg(q.replenishment_plan_id order by q.locked_at desc nulls last))[1] as replenishment_plan_id,
  max(q.locked_at) as locked_at,
  nearest.warehouse_code as suggested_warehouse,
  nearest.distance_km as suggested_distance_km,
  g.latitude,
  g.longitude,
  g.map_x,
  g.map_y
from analytics.v_replenishment_queue q
join core.transport_district_geo g on g.district_id = q.district_id
left join lateral (
  select r.warehouse_code, r.distance_km
  from core.transport_route_legs r
  where r.district_ref = g.district_ref
  order by r.distance_km asc
  limit 1
) nearest on true
where q.plan_status = 'locked'
group by
  q.district_id, q.district_name_th, g.district_ref,
  nearest.warehouse_code, nearest.distance_km,
  g.latitude, g.longitude, g.map_x, g.map_y;

grant select on analytics.v_transport_dispatch_queue to service_role;

-- 4. Extend the dispatcher: dispatch-queue read + plan link on trip creation.
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
  v_plan_id uuid;
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
      select district_ref, district_id, name_th, latitude, longitude, map_x, map_y, is_warehouse
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

  if v_method = 'GET' and p_path = '/v1/transport/dispatch-queue' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.suggested_distance_km nulls last, q.district_ref), '[]'::jsonb)
    into v_payload
    from (select * from analytics.v_transport_dispatch_queue) q;
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
    select count(*) into v_missing
    from unnest(v_stops) s(district_ref)
    where not exists (
      select 1 from core.transport_route_legs r
      where r.warehouse_code = v_warehouse and r.district_ref = s.district_ref
    );
    if v_missing > 0 then
      return public.m09_error(422, 'validation_error', 'One or more stops have no route from this warehouse', p_request_id);
    end if;
    select sum(r.distance_km), sum(r.toll_thb), sum(r.travel_minutes)
    into v_dist, v_toll, v_mins
    from core.transport_route_legs r
    join unnest(v_stops) s(district_ref) on s.district_ref = r.district_ref
    where r.warehouse_code = v_warehouse;
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
    v_plan_id := nullif(p_body ->> 'replenishment_plan_id', '')::uuid;
    insert into ops.transport_trips (
      trip_code, batch_code, vehicle_id, driver_name, warehouse_code, route_district_refs,
      total_distance_km, total_toll_thb, total_travel_minutes, fuel_cost_estimate_thb,
      trip_date, status, max_weight_kg, notes, replenishment_plan_id, created_by
    ) values (
      'TRP-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
      nullif(p_body ->> 'batch_code', ''),
      v_vehicle.vehicle_id, v_vehicle.driver_name, v_warehouse, v_stops,
      round(v_dist, 1), v_toll, v_mins, v_fuel,
      coalesce(nullif(p_body ->> 'trip_date', '')::date, current_date),
      'planned', v_vehicle.max_weight_kg,
      left(coalesce(p_body ->> 'notes', ''), 1000), v_plan_id, v_user_id
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
  '202607250002', 'M13b',
  'Transport ↔ replenishment link: district mapping, dispatch queue view, plan reference on trips and dispatch-queue endpoint.',
  'supabase/migrations/202607250002_m13b_transport_replenishment_link.sql'
)
on conflict (version) do update
set description = excluded.description, source_file = excluded.source_file;

commit;
