-- SYNAPSE Wave 3 / M08: Cargo masters, background route jobs, plans and GeoJSON.

begin;

create table if not exists core.location_geocodes (
  location_id text primary key references core.locations (location_id) on delete restrict,
  latitude numeric(9,6) not null check (latitude between -90 and 90),
  longitude numeric(9,6) not null check (longitude between -180 and 180),
  time_window_start time,
  time_window_end time,
  service_minutes integer not null default 15 check (service_minutes >= 0),
  source_reference text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint location_geocodes_time_window_check check (
    time_window_start is null or time_window_end is null or time_window_end > time_window_start
  )
);

create table if not exists core.material_packaging (
  material_id text primary key references core.materials (material_id) on delete restrict,
  quantity_per_box numeric check (quantity_per_box is null or quantity_per_box > 0),
  box_volume_m3 numeric check (box_volume_m3 is null or box_volume_m3 > 0),
  weight_per_box_kg numeric check (weight_per_box_kg is null or weight_per_box_kg > 0),
  boxes_per_pallet numeric check (boxes_per_pallet is null or boxes_per_pallet > 0),
  pallet_volume_m3 numeric check (pallet_volume_m3 is null or pallet_volume_m3 > 0),
  pallet_weight_kg numeric check (pallet_weight_kg is null or pallet_weight_kg > 0),
  source_reference text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.vehicles (
  vehicle_id text primary key,
  vehicle_name text not null,
  max_weight_kg numeric not null check (max_weight_kg > 0),
  max_volume_m3 numeric not null check (max_volume_m3 > 0),
  max_pallets numeric check (max_pallets is null or max_pallets > 0),
  home_location_id text not null references core.locations (location_id) on delete restrict,
  is_active boolean not null default true,
  source_reference text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into core.vehicles (
  vehicle_id, vehicle_name, max_weight_kg, max_volume_m3, max_pallets, home_location_id, source_reference
)
values
  ('707', 'รถ VMI 707', 10000, 40, null, 'WH-KT', 'synapse/ALGORITHM.md section 6'),
  ('708', 'รถ VMI 708', 6000, 24, null, 'WH-KT', 'synapse/ALGORITHM.md section 6')
on conflict (vehicle_id) do update
set vehicle_name = excluded.vehicle_name,
    max_weight_kg = excluded.max_weight_kg,
    max_volume_m3 = excluded.max_volume_m3,
    home_location_id = excluded.home_location_id,
    source_reference = excluded.source_reference,
    is_active = true,
    updated_at = now();

create table if not exists core.drivers (
  driver_id uuid primary key default gen_random_uuid(),
  employee_reference text not null unique,
  display_name text not null,
  license_class text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists analytics.route_matrices (
  route_matrix_id uuid primary key default gen_random_uuid(),
  matrix_source text not null check (matrix_source in ('valhalla', 'haversine-test')),
  costing_model text not null default 'truck',
  location_ids text[] not null,
  distances_m jsonb not null,
  durations_s jsonb not null,
  request_hash text not null unique check (request_hash ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists ops.route_jobs (
  route_job_id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references ops.background_jobs (job_id) on delete restrict,
  replenishment_plan_id uuid not null references core.replenishment_plans (replenishment_plan_id) on delete restrict,
  forecast_run_id uuid references analytics.forecast_runs (forecast_run_id) on delete set null,
  algorithm_version text not null default 'ortools-v1',
  matrix_source text not null default 'valhalla' check (matrix_source in ('valhalla', 'haversine-test')),
  timeout_seconds integer not null default 30 check (timeout_seconds between 1 and 300),
  created_at timestamptz not null default now()
);

create table if not exists core.route_plans (
  route_plan_id uuid primary key default gen_random_uuid(),
  route_job_id uuid not null unique references ops.route_jobs (route_job_id) on delete restrict,
  route_matrix_id uuid references analytics.route_matrices (route_matrix_id) on delete restrict,
  algorithm_version text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'in_progress', 'completed', 'cancelled')),
  solver_status text not null check (solver_status in ('succeeded', 'partial', 'infeasible', 'timeout', 'failed')),
  total_distance_m numeric not null default 0 check (total_distance_m >= 0),
  total_duration_s numeric not null default 0 check (total_duration_s >= 0),
  served_stop_count integer not null default 0 check (served_stop_count >= 0),
  unserved_stop_count integer not null default 0 check (unserved_stop_count >= 0),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.route_plan_vehicles (
  route_plan_vehicle_id uuid primary key default gen_random_uuid(),
  route_plan_id uuid not null references core.route_plans (route_plan_id) on delete restrict,
  vehicle_id text not null references core.vehicles (vehicle_id) on delete restrict,
  driver_id uuid references core.drivers (driver_id) on delete restrict,
  route_sequence integer not null check (route_sequence > 0),
  planned_distance_m numeric not null check (planned_distance_m >= 0),
  planned_duration_s numeric not null check (planned_duration_s >= 0),
  weight_kg numeric not null check (weight_kg >= 0),
  volume_m3 numeric not null check (volume_m3 >= 0),
  pallets numeric not null check (pallets >= 0),
  weight_utilization numeric not null check (weight_utilization between 0 and 1),
  volume_utilization numeric not null check (volume_utilization between 0 and 1),
  pallet_utilization numeric check (pallet_utilization is null or pallet_utilization between 0 and 1),
  created_at timestamptz not null default now(),
  unique (route_plan_id, vehicle_id),
  unique (route_plan_id, route_sequence)
);

create table if not exists core.route_stops (
  route_stop_id uuid primary key default gen_random_uuid(),
  route_plan_vehicle_id uuid not null references core.route_plan_vehicles (route_plan_vehicle_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  stop_sequence integer not null check (stop_sequence > 0),
  eta timestamptz,
  service_minutes integer not null check (service_minutes >= 0),
  weight_kg numeric not null check (weight_kg >= 0),
  volume_m3 numeric not null check (volume_m3 >= 0),
  pallets numeric not null check (pallets >= 0),
  replenishment_item_ids uuid[] not null,
  latitude numeric(9,6) not null,
  longitude numeric(9,6) not null,
  created_at timestamptz not null default now(),
  unique (route_plan_vehicle_id, stop_sequence),
  unique (route_plan_vehicle_id, district_id)
);

create table if not exists core.route_unserved_stops (
  route_unserved_stop_id uuid primary key default gen_random_uuid(),
  route_plan_id uuid not null references core.route_plans (route_plan_id) on delete restrict,
  district_id text references core.districts (district_id) on delete restrict,
  reason_code text not null check (reason_code in ('missing_geocode', 'missing_packaging', 'capacity', 'time_window', 'solver_timeout', 'infeasible')),
  reason_detail text not null,
  replenishment_item_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create or replace function core.queue_route_job(
  p_replenishment_plan_id uuid,
  p_forecast_run_id uuid default null,
  p_matrix_source text default 'valhalla'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, ops, public
as $$
declare v_role public.app_role; v_job_id uuid; v_route_job_id uuid; v_plan_status text;
begin
  select role into v_role from public.user_profiles where user_id = auth.uid() and is_active;
  if v_role is null or v_role not in ('admin', 'planner') then raise exception 'Only planner or admin may queue routes'; end if;
  select status into v_plan_status from core.replenishment_plans where replenishment_plan_id = p_replenishment_plan_id;
  if v_plan_status <> 'approved' then raise exception 'Replenishment plan must be approved before routing'; end if;
  if p_matrix_source not in ('valhalla', 'haversine-test') then raise exception 'Unsupported matrix source'; end if;
  insert into ops.background_jobs (job_type, payload, initiated_by)
  values ('route', '{}'::jsonb, auth.uid()) returning job_id into v_job_id;
  insert into ops.route_jobs (job_id, replenishment_plan_id, forecast_run_id, matrix_source)
  values (v_job_id, p_replenishment_plan_id, p_forecast_run_id, p_matrix_source)
  returning route_job_id into v_route_job_id;
  update ops.background_jobs set payload = jsonb_build_object('route_job_id', v_route_job_id) where job_id = v_job_id;
  return v_route_job_id;
end;
$$;

create or replace function core.review_route_plan(p_route_plan_id uuid, p_decision text, p_reason text default null)
returns core.route_plans
language plpgsql
security definer
set search_path = pg_catalog, core, public
as $$
declare v_role public.app_role; v_plan core.route_plans%rowtype;
begin
  select role into v_role from public.user_profiles where user_id = auth.uid() and is_active;
  if v_role is null or v_role not in ('admin', 'planner') then raise exception 'Only planner or admin may review route plans'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Decision must be approved or rejected'; end if;
  if p_decision = 'rejected' and btrim(coalesce(p_reason, '')) = '' then raise exception 'Rejection reason is required'; end if;
  update core.route_plans
  set status = p_decision,
      approved_by = case when p_decision = 'approved' then auth.uid() else null end,
      approved_at = case when p_decision = 'approved' then now() else null end,
      rejection_reason = case when p_decision = 'rejected' then p_reason else null end,
      updated_at = now()
  where route_plan_id = p_route_plan_id and status = 'draft'
  returning * into v_plan;
  if not found then raise exception 'Draft route plan not found'; end if;
  return v_plan;
end;
$$;

create or replace view analytics.v_route_plan_geojson
with (security_invoker = true)
as
select
  p.route_plan_id,
  jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'geometry', jsonb_build_object('type', 'Point', 'coordinates', jsonb_build_array(s.longitude, s.latitude)),
      'properties', jsonb_build_object(
        'district_id', s.district_id,
        'vehicle_id', v.vehicle_id,
        'route_sequence', v.route_sequence,
        'stop_sequence', s.stop_sequence,
        'eta', s.eta
      )
    ) order by v.route_sequence, s.stop_sequence) filter (where s.route_stop_id is not null), '[]'::jsonb)
  ) as geojson
from core.route_plans p
left join core.route_plan_vehicles v using (route_plan_id)
left join core.route_stops s using (route_plan_vehicle_id)
group by p.route_plan_id;

create or replace view analytics.v_route_plan_summary
with (security_invoker = true)
as
select
  p.route_plan_id, p.route_job_id, p.status, p.solver_status,
  p.total_distance_m, p.total_duration_s, p.served_stop_count, p.unserved_stop_count,
  count(distinct v.vehicle_id) as vehicle_count,
  max(v.weight_utilization) as max_weight_utilization,
  max(v.volume_utilization) as max_volume_utilization,
  p.created_at, p.approved_at, p.rejection_reason
from core.route_plans p
left join core.route_plan_vehicles v using (route_plan_id)
group by p.route_plan_id;

do $$
declare table_name text;
begin
  foreach table_name in array array['location_geocodes', 'material_packaging', 'vehicles', 'drivers', 'route_plans'] loop
    execute format('drop trigger if exists set_%I_updated_at on core.%I', table_name, table_name);
    execute format('create trigger set_%I_updated_at before update on core.%I for each row execute function audit.set_updated_at()', table_name, table_name);
  end loop;
end;
$$;

alter table core.location_geocodes enable row level security;
alter table core.material_packaging enable row level security;
alter table core.vehicles enable row level security;
alter table core.drivers enable row level security;
alter table analytics.route_matrices enable row level security;
alter table ops.route_jobs enable row level security;
alter table core.route_plans enable row level security;
alter table core.route_plan_vehicles enable row level security;
alter table core.route_stops enable row level security;
alter table core.route_unserved_stops enable row level security;

revoke all on core.location_geocodes, core.material_packaging, core.vehicles, core.drivers,
  analytics.route_matrices, ops.route_jobs, core.route_plans, core.route_plan_vehicles,
  core.route_stops, core.route_unserved_stops from public, anon, authenticated;
grant all on core.location_geocodes, core.material_packaging, core.vehicles, core.drivers,
  analytics.route_matrices, ops.route_jobs, core.route_plans, core.route_plan_vehicles,
  core.route_stops, core.route_unserved_stops to service_role;
grant select on analytics.v_route_plan_geojson, analytics.v_route_plan_summary to service_role;

revoke all on function core.queue_route_job(uuid, uuid, text), core.review_route_plan(uuid, text, text)
  from public, anon, authenticated;
grant execute on function core.queue_route_job(uuid, uuid, text), core.review_route_plan(uuid, text, text)
  to service_role;

insert into ops.schema_migrations (version, module, description, source_file)
values ('202607150006', 'M08', 'Vehicle/cargo masters, Valhalla matrix cache, OR-Tools route jobs, stops, utilization, unserved reasons and GeoJSON.', 'supabase/migrations/202607150006_m08_routes.sql')
on conflict (version) do update set description = excluded.description, source_file = excluded.source_file;

commit;
