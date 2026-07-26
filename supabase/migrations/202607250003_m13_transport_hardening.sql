-- SYNAPSE M13c: transport governance and transactional hardening.
--
-- This is an additive correction to M13/M13b. It promotes checksum-traced
-- authoritative district/depot coordinates, quarantines unsupported legacy
-- depots, makes dispatch demand plan-specific, serializes vehicle/status
-- mutations, and aligns transport with shared API/write readiness controls.

begin;

-- ============================================================
-- Canonical warehouse and governed geocode provenance
-- ============================================================
alter table core.transport_warehouses
  add column if not exists canonical_warehouse_id text
    references core.warehouses (warehouse_id) on delete restrict;

update core.transport_warehouses
set canonical_warehouse_id = 'WH-KT'
where warehouse_code = 'คลองเตย'
  and canonical_warehouse_id is null
  and exists (
    select 1
    from core.warehouses
    where warehouse_id = 'WH-KT'
  );

create unique index if not exists transport_warehouses_canonical_uidx
  on core.transport_warehouses (canonical_warehouse_id)
  where canonical_warehouse_id is not null;

alter table core.transport_district_geo
  add column if not exists warehouse_code text
    references core.transport_warehouses (warehouse_code) on delete restrict,
  add column if not exists name_en text,
  add column if not exists geocode_status text not null default 'unverified',
  add column if not exists coordinate_source text,
  add column if not exists source_reference text,
  add column if not exists source_checksum_sha256 text,
  add column if not exists source_row_number integer,
  add column if not exists accuracy_meters numeric,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid
    references auth.users (id) on delete set null,
  add column if not exists quarantined_at timestamptz,
  add column if not exists quarantined_by uuid
    references auth.users (id) on delete set null,
  add column if not exists quarantine_reason text,
  add column if not exists updated_at timestamptz not null default now();

-- The authoritative depot has more precision than the six-decimal illustrative
-- seed. Pseudo-map coordinates are not source data and may be null.
drop view if exists analytics.v_transport_dispatch_queue;
drop view if exists analytics.v_transport_route_matrix;

alter table core.transport_district_geo
  alter column latitude type numeric(11, 8)
    using latitude::numeric(11, 8),
  alter column longitude type numeric(11, 8)
    using longitude::numeric(11, 8),
  alter column latitude drop not null,
  alter column longitude drop not null,
  alter column map_x drop not null,
  alter column map_y drop not null;

update core.transport_district_geo
set warehouse_code = 'คลองเตย'
where district_ref = 'WH'
  and is_warehouse
  and warehouse_code is null;

-- The M13 seed explicitly described itself as a deterministic illustrative
-- model. It has no authoritative geocoding evidence, so it must not silently
-- become production routing input.
update core.transport_district_geo
set geocode_status = 'quarantined',
    coordinate_source = coalesce(coordinate_source, 'legacy_m13_seed'),
    source_reference = coalesce(
      source_reference,
      'supabase/migrations/202607250001_m13_transport_pipeline.sql'
    ),
    verified_at = null,
    verified_by = null,
    quarantined_at = coalesce(quarantined_at, now()),
    quarantine_reason = coalesce(
      nullif(btrim(quarantine_reason), ''),
      'Legacy illustrative coordinate requires authoritative verification'
    ),
    updated_at = now()
where geocode_status = 'unverified'
   or source_reference is null;

-- User-authoritative source, verified 2026-07-25:
-- data/MEA_Synapse_Supabase_Production_20260724/data/districts.csv
-- SHA-256 fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a
--
-- district_ref remains the stable source plant/district code. district_id is
-- the existing canonical internal district mapping established in M13b. The
-- source's final blank-code record is assigned the stable internal depot key
-- WH-MMBP and linked to the existing transport warehouse code เมืองใหม่.
insert into core.transport_district_geo (
  district_ref,
  district_id,
  warehouse_code,
  name_en,
  name_th,
  latitude,
  longitude,
  map_x,
  map_y,
  is_warehouse,
  geocode_status,
  coordinate_source,
  source_reference,
  source_checksum_sha256,
  source_row_number,
  accuracy_meters,
  verified_at,
  verified_by,
  quarantined_at,
  quarantined_by,
  quarantine_reason,
  updated_at
)
select
  source.district_ref,
  source.district_id,
  source.warehouse_code,
  source.name_en,
  source.name_th,
  source.latitude,
  source.longitude,
  null,
  null,
  source.is_warehouse,
  'verified',
  'user_authoritative_csv',
  'data/MEA_Synapse_Supabase_Production_20260724/data/districts.csv#row='
    || source.source_row_number::text,
  'fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a',
  source.source_row_number,
  null,
  statement_timestamp(),
  null,
  null,
  null,
  null,
  now()
from (values
  ('5501', '5501', null::text, 'Nawamin District',
    'การไฟฟ้านครหลวง เขตนวลจันทร์', 13.81895000, 100.64410000, false, 2),
  ('5601', '5502', null::text, 'Samsen District',
    'การไฟฟ้านครหลวง เขตสามเสน', 13.78054000, 100.51764000, false, 3),
  ('5701', '5503', null::text, 'Nonthaburi District',
    'การไฟฟ้านครหลวง เขตนนทบุรี', 13.87001000, 100.51778000, false, 4),
  ('5801', '5504', null::text, 'Thonburi District',
    'การไฟฟ้านครหลวง เขตธนบุรี', 13.74671400, 100.47022800, false, 5),
  ('5901', '5505', null::text, 'Bang Yai District',
    'การไฟฟ้านครหลวง เขตบางใหญ่', 13.84836400, 100.43609400, false, 6),
  ('6001', '5506', null::text, 'Lat Krabang District',
    'การไฟฟ้านครหลวง เขตลาดกระบัง', 13.81564100, 100.74612300, false, 7),
  ('6501', '5507', null::text, 'Bang Na District',
    'การไฟฟ้านครหลวง เขตบางนา', 13.67613000, 100.59186000, false, 8),
  ('6601', '5508', null::text, 'Wat Liap District',
    'การไฟฟ้านครหลวง เขตวัดเลียบ', 13.74194400, 100.50000000, false, 9),
  ('6701', '5509', null::text, 'Khlong Toei District',
    'การไฟฟ้านครหลวง เขตคลองเตย', 13.72156000, 100.55539000, false, 10),
  ('6801', '5510', null::text, 'Rat Burana District',
    'การไฟฟ้านครหลวง เขตราษฎร์บูรณะ', 13.67907500, 100.51305100, false, 11),
  ('6901', '5511', null::text, 'Yannawa District',
    'การไฟฟ้านครหลวง เขตยานนาวา', 13.69305600, 100.49333300, false, 12),
  ('7001', '5512', null::text, 'Bang Khun Thian District',
    'การไฟฟ้านครหลวง เขตบางขุนเทียน', 13.65557000, 100.42435000, false, 13),
  ('7501', '5513', null::text, 'Bang Bua Thong District',
    'การไฟฟ้านครหลวง เขตบางบัวทอง', 13.94567700, 100.37977000, false, 14),
  ('7601', '5514', null::text, 'Bang Kapi District',
    'การไฟฟ้านครหลวง เขตบางกะปิ', 13.74407000, 100.60137000, false, 15),
  ('7701', '5515', null::text, 'Samut Prakan District',
    'การไฟฟ้านครหลวง เขตสมุทรปราการ', 13.59431700, 100.60681700, false, 16),
  ('7801', '5516', null::text, 'Bang Phli District',
    'การไฟฟ้านครหลวง เขตบางพลี', 13.64160000, 100.71325000, false, 17),
  ('7901', '5517', null::text, 'Min Buri District',
    'การไฟฟ้านครหลวง เขตมีนบุรี', 13.81160700, 100.70849700, false, 18),
  ('8001', '5518', null::text, 'Bang Khen District',
    'การไฟฟ้านครหลวง เขตบางเขน', 13.87107000, 100.59534000, false, 19),
  ('WH-MMBP', null::text, 'เมืองใหม่',
    'MEA Procurement Department, Mueang Mai Bang Phli',
    'การไฟฟ้านครหลวง ฝ่ายพัสดุ เมืองใหม่บางพลี',
    13.55760333, 100.77072260, true, 20)
) as source(
  district_ref,
  district_id,
  warehouse_code,
  name_en,
  name_th,
  latitude,
  longitude,
  is_warehouse,
  source_row_number
)
on conflict (district_ref) do update
set district_id = excluded.district_id,
    warehouse_code = excluded.warehouse_code,
    name_en = excluded.name_en,
    name_th = excluded.name_th,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    map_x = excluded.map_x,
    map_y = excluded.map_y,
    is_warehouse = excluded.is_warehouse,
    geocode_status = excluded.geocode_status,
    coordinate_source = excluded.coordinate_source,
    source_reference = excluded.source_reference,
    source_checksum_sha256 = excluded.source_checksum_sha256,
    source_row_number = excluded.source_row_number,
    accuracy_meters = excluded.accuracy_meters,
    verified_at = excluded.verified_at,
    verified_by = excluded.verified_by,
    quarantined_at = excluded.quarantined_at,
    quarantined_by = excluded.quarantined_by,
    quarantine_reason = excluded.quarantine_reason,
    updated_at = excluded.updated_at;

-- M08/OR-Tools reads core.location_geocodes rather than the transport-specific
-- geo registry. Synchronize only the 18 canonical districts. The blank-code
-- depot is intentionally not inserted here because no canonical core warehouse
-- location evidence exists yet. Existing delivery windows and service time are
-- preserved on conflict.
alter table core.location_geocodes
  alter column latitude type numeric(11, 8)
    using latitude::numeric(11, 8),
  alter column longitude type numeric(11, 8)
    using longitude::numeric(11, 8);

insert into core.location_geocodes (
  location_id,
  latitude,
  longitude,
  source_reference,
  verified_at
)
select
  'DIST-' || source.district_id,
  source.latitude,
  source.longitude,
  'data/MEA_Synapse_Supabase_Production_20260724/data/districts.csv#row='
    || source.source_row_number::text
    || ';sha256=fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a',
  statement_timestamp()
from (values
  ('5501', 13.81895000, 100.64410000, 2),
  ('5502', 13.78054000, 100.51764000, 3),
  ('5503', 13.87001000, 100.51778000, 4),
  ('5504', 13.74671400, 100.47022800, 5),
  ('5505', 13.84836400, 100.43609400, 6),
  ('5506', 13.81564100, 100.74612300, 7),
  ('5507', 13.67613000, 100.59186000, 8),
  ('5508', 13.74194400, 100.50000000, 9),
  ('5509', 13.72156000, 100.55539000, 10),
  ('5510', 13.67907500, 100.51305100, 11),
  ('5511', 13.69305600, 100.49333300, 12),
  ('5512', 13.65557000, 100.42435000, 13),
  ('5513', 13.94567700, 100.37977000, 14),
  ('5514', 13.74407000, 100.60137000, 15),
  ('5515', 13.59431700, 100.60681700, 16),
  ('5516', 13.64160000, 100.71325000, 17),
  ('5517', 13.81160700, 100.70849700, 18),
  ('5518', 13.87107000, 100.59534000, 19)
) as source(district_id, latitude, longitude, source_row_number)
on conflict (location_id) do update
set latitude = excluded.latitude,
    longitude = excluded.longitude,
    source_reference = excluded.source_reference,
    verified_at = excluded.verified_at;

alter table core.transport_district_geo
  drop constraint if exists transport_district_geo_status_check;
alter table core.transport_district_geo
  add constraint transport_district_geo_status_check
  check (geocode_status in ('unverified', 'verified', 'quarantined'));

alter table core.transport_district_geo
  drop constraint if exists transport_district_geo_accuracy_check;
alter table core.transport_district_geo
  add constraint transport_district_geo_accuracy_check
  check (accuracy_meters is null or accuracy_meters >= 0);

alter table core.transport_district_geo
  drop constraint if exists transport_district_geo_source_checksum_check;
alter table core.transport_district_geo
  add constraint transport_district_geo_source_checksum_check
  check (
    source_checksum_sha256 is null
    or source_checksum_sha256 ~ '^[0-9a-f]{64}$'
  );

alter table core.transport_district_geo
  drop constraint if exists transport_district_geo_governance_check;
alter table core.transport_district_geo
  add constraint transport_district_geo_governance_check
  check (
    (
      geocode_status = 'unverified'
      and verified_at is null
    )
    or (
      geocode_status = 'verified'
      and verified_at is not null
      and latitude is not null
      and longitude is not null
      and btrim(coalesce(coordinate_source, '')) <> ''
      and btrim(coalesce(source_reference, '')) <> ''
      and source_checksum_sha256 ~ '^[0-9a-f]{64}$'
      and source_row_number > 1
      and (
        (
          is_warehouse
          and warehouse_code is not null
          and district_id is null
        )
        or (
          not is_warehouse
          and warehouse_code is null
          and district_id is not null
        )
      )
      and quarantined_at is null
      and quarantine_reason is null
    )
    or (
      geocode_status = 'quarantined'
      and verified_at is null
      and quarantined_at is not null
      and btrim(coalesce(quarantine_reason, '')) <> ''
    )
  );

drop trigger if exists set_transport_district_geo_updated_at
  on core.transport_district_geo;
create trigger set_transport_district_geo_updated_at
  before update on core.transport_district_geo
  for each row execute function audit.set_updated_at();

create index if not exists transport_district_geo_status_idx
  on core.transport_district_geo (geocode_status, is_warehouse, district_ref);

create unique index if not exists transport_district_geo_warehouse_uidx
  on core.transport_district_geo (warehouse_code)
  where is_warehouse and warehouse_code is not null;

create index if not exists transport_route_legs_district_distance_idx
  on core.transport_route_legs (district_ref, distance_km, warehouse_code);

create index if not exists transport_vehicles_home_warehouse_idx
  on core.transport_vehicles (home_warehouse);

create index if not exists transport_vehicles_current_warehouse_idx
  on core.transport_vehicles (current_warehouse);

-- Toll prices must come from an attributable, effective-dated source. The
-- catalog intentionally starts empty: the illustrative M13 route-leg tolls are
-- not promoted to verified tariffs.
create table if not exists core.transport_toll_tariffs (
  toll_tariff_id uuid primary key default gen_random_uuid(),
  operator_name text not null check (btrim(operator_name) <> ''),
  road_name text not null check (btrim(road_name) <> ''),
  toll_plaza_name text,
  entry_plaza_name text,
  exit_plaza_name text,
  vehicle_class text not null check (btrim(vehicle_class) <> ''),
  amount_thb numeric(12, 2) not null check (amount_thb >= 0),
  currency_code text not null default 'THB'
    check (currency_code = 'THB'),
  tariff_version text not null check (btrim(tariff_version) <> ''),
  valid_from date not null,
  valid_to date,
  source_reference text not null check (btrim(source_reference) <> ''),
  verified_at timestamptz not null,
  verified_by uuid not null
    references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transport_toll_tariffs_plaza_shape_check check (
    (
      btrim(coalesce(toll_plaza_name, '')) <> ''
      and entry_plaza_name is null
      and exit_plaza_name is null
    )
    or (
      toll_plaza_name is null
      and btrim(coalesce(entry_plaza_name, '')) <> ''
      and btrim(coalesce(exit_plaza_name, '')) <> ''
    )
  ),
  constraint transport_toll_tariffs_validity_check check (
    valid_to is null or valid_to >= valid_from
  )
);

create unique index if not exists transport_toll_tariffs_version_uidx
  on core.transport_toll_tariffs (
    operator_name,
    road_name,
    coalesce(toll_plaza_name, ''),
    coalesce(entry_plaza_name, ''),
    coalesce(exit_plaza_name, ''),
    vehicle_class,
    valid_from,
    tariff_version
  );

create index if not exists transport_toll_tariffs_current_lookup_idx
  on core.transport_toll_tariffs (
    valid_from,
    valid_to,
    operator_name,
    vehicle_class
  );

drop trigger if exists set_transport_toll_tariffs_updated_at
  on core.transport_toll_tariffs;
create trigger set_transport_toll_tariffs_updated_at
  before update on core.transport_toll_tariffs
  for each row execute function audit.set_updated_at();

alter table core.transport_toll_tariffs enable row level security;
revoke all on core.transport_toll_tariffs from public, anon, authenticated;
grant all on core.transport_toll_tariffs to service_role;

-- ============================================================
-- Idempotent trips and append-only status history
-- ============================================================
alter table ops.transport_trips
  add column if not exists request_id text,
  add column if not exists request_payload_hash text;

alter table ops.transport_trips
  drop constraint if exists transport_trips_request_id_check;
alter table ops.transport_trips
  add constraint transport_trips_request_id_check
  check (
    request_id is null
    or request_id ~ '^[A-Za-z0-9_-]{1,128}$'
  );

alter table ops.transport_trips
  drop constraint if exists transport_trips_request_payload_hash_check;
alter table ops.transport_trips
  add constraint transport_trips_request_payload_hash_check
  check (
    request_payload_hash is null
    or request_payload_hash ~ '^[0-9a-f]{64}$'
  );

create unique index if not exists transport_trips_actor_request_uidx
  on ops.transport_trips (created_by, request_id)
  where request_id is not null;

do $$
begin
  if exists (
    select 1
    from ops.transport_trips
    where status in ('planned', 'dispatched')
    group by vehicle_id, trip_date
    having count(*) > 1
  ) then
    raise exception
      'M13c cannot enforce vehicle availability: duplicate active vehicle/day assignments exist';
  end if;
end
$$;

create unique index if not exists transport_trips_vehicle_active_day_uidx
  on ops.transport_trips (vehicle_id, trip_date)
  where status in ('planned', 'dispatched');

create index if not exists transport_trips_plan_idx
  on ops.transport_trips (replenishment_plan_id);

create index if not exists transport_trips_vehicle_idx
  on ops.transport_trips (vehicle_id);

create index if not exists transport_trips_created_by_idx
  on ops.transport_trips (created_by);

create index if not exists transport_trips_status_recent_idx
  on ops.transport_trips (status, created_at desc);

create table if not exists ops.transport_trip_events (
  transport_trip_event_id uuid primary key default gen_random_uuid(),
  trip_id uuid not null
    references ops.transport_trips (trip_id) on delete restrict,
  from_status text,
  to_status text not null,
  request_id text not null
    check (request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  request_payload_hash text not null
    check (request_payload_hash ~ '^[0-9a-f]{64}$'),
  result_snapshot jsonb not null
    check (jsonb_typeof(result_snapshot) = 'object'),
  actor_id uuid references auth.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  constraint transport_trip_events_from_status_check check (
    from_status is null
    or from_status in ('planned', 'dispatched', 'completed', 'cancelled')
  ),
  constraint transport_trip_events_to_status_check check (
    to_status in ('planned', 'dispatched', 'completed', 'cancelled')
  ),
  unique (trip_id, request_id)
);

create index if not exists transport_trip_events_timeline_idx
  on ops.transport_trip_events (trip_id, occurred_at, transport_trip_event_id);

alter table ops.transport_trip_events enable row level security;
revoke all on ops.transport_trip_events from public, anon, authenticated;
grant all on ops.transport_trip_events to service_role;

drop trigger if exists transport_trip_events_append_only
  on ops.transport_trip_events;
create trigger transport_trip_events_append_only
  before update or delete on ops.transport_trip_events
  for each row execute function audit.reject_append_only_mutation();

create or replace function ops.enforce_transport_trip_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if not (
    (old.status = 'planned' and new.status in ('dispatched', 'cancelled'))
    or
    (old.status = 'dispatched' and new.status in ('completed', 'cancelled'))
  ) then
    raise exception 'Invalid transport trip transition from % to %',
      old.status,
      new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_transport_trip_transition
  on ops.transport_trips;
create trigger enforce_transport_trip_transition
  before update of status on ops.transport_trips
  for each row execute function ops.enforce_transport_trip_transition();

-- ============================================================
-- Security-invoker analytics contracts
-- ============================================================
create or replace view analytics.v_transport_vehicle_status
with (security_invoker = true)
as
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

create or replace view analytics.v_transport_route_matrix
with (security_invoker = true)
as
select
  r.warehouse_code,
  warehouse.canonical_warehouse_id,
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
  r.unload_per_pallet_min,
  g.geocode_status,
  g.coordinate_source,
  g.source_reference as geocode_source_reference,
  g.source_checksum_sha256 as geocode_source_checksum_sha256,
  g.source_row_number as geocode_source_row_number,
  g.accuracy_meters,
  g.verified_at,
  'legacy_illustrative_not_road_evidence'::text as
    matrix_evidence_status,
  false as road_evidence_usable,
  coalesce(warehouse_geo.geocode_status, 'missing') as
    warehouse_geocode_status,
  coalesce((
    g.geocode_status = 'verified'
    and warehouse.is_active
    and warehouse.canonical_warehouse_id is not null
    and warehouse_geo.geocode_status = 'verified'
  ), false) as route_eligible
from core.transport_route_legs r
join core.transport_warehouses warehouse
  on warehouse.warehouse_code = r.warehouse_code
join core.transport_district_geo g
  on g.district_ref = r.district_ref
left join core.transport_district_geo warehouse_geo
  on warehouse_geo.is_warehouse
 and warehouse_geo.warehouse_code = r.warehouse_code;

create or replace view analytics.v_transport_trip_summary
with (security_invoker = true)
as
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
  t.created_at,
  t.replenishment_plan_id,
  t.request_id
from ops.transport_trips t;

create or replace view analytics.v_transport_dispatch_queue
with (security_invoker = true)
as
select
  q.district_id,
  q.district_name_th,
  g.district_ref,
  count(*) as line_count,
  case
    when count(distinct coalesce(pp.base_uom, m.unit, 'UNKNOWN')) = 1
      then sum(q.final_qty)
    else null
  end as total_qty,
  q.plan_number,
  q.replenishment_plan_id,
  q.locked_at,
  plan.origin_location_id,
  origin_warehouse.warehouse_id as origin_warehouse_id,
  exact_warehouse.warehouse_code as suggested_warehouse,
  null::numeric as suggested_distance_km,
  coalesce(warehouse_geo.geocode_status, 'missing') as
    suggested_warehouse_geocode_status,
  warehouse_geo.quarantine_reason as
    suggested_warehouse_quarantine_reason,
  g.latitude,
  g.longitude,
  g.map_x,
  g.map_y,
  q.version_no,
  q.week_start_date,
  jsonb_agg(
    jsonb_build_object(
      'replenishment_item_id', q.replenishment_item_id,
      'material_id', q.material_id,
      'quantity', q.final_qty,
      'uom', coalesce(pp.base_uom, m.unit, 'UNKNOWN'),
      'weight_per_unit_kg', m.weight_per_unit_kg
    )
    order by q.material_id, q.replenishment_item_id
  ) as demand_lines,
  sum(q.final_qty * m.weight_per_unit_kg) as estimated_weight_kg,
  bool_and(m.weight_per_unit_kg is not null) as weight_complete,
  g.geocode_status,
  g.quarantine_reason,
  (
    g.geocode_status = 'verified'
    and exact_warehouse.canonical_warehouse_id is not null
    and warehouse_geo.geocode_status = 'verified'
  ) as route_eligible
from analytics.v_replenishment_queue q
join core.replenishment_plans plan
  on plan.replenishment_plan_id = q.replenishment_plan_id
join core.transport_district_geo g
  on g.district_id = q.district_id
join core.materials m
  on m.material_id = q.material_id
left join core.packaging_profiles pp
  on pp.material_id = q.material_id
left join core.locations origin
  on origin.location_id = plan.origin_location_id
 and origin.location_type = 'WAREHOUSE'
 and origin.is_active
left join core.warehouses origin_warehouse
  on origin_warehouse.warehouse_id = origin.warehouse_id
 and origin_warehouse.is_active
left join core.transport_warehouses exact_warehouse
  on exact_warehouse.canonical_warehouse_id =
    origin_warehouse.warehouse_id
 and exact_warehouse.is_active
left join core.transport_district_geo warehouse_geo
  on warehouse_geo.is_warehouse
 and warehouse_geo.warehouse_code = exact_warehouse.warehouse_code
where q.plan_status = 'locked'
  and q.item_status = 'locked'
  and q.final_qty > 0
group by
  q.replenishment_plan_id,
  q.plan_number,
  q.version_no,
  q.week_start_date,
  q.locked_at,
  plan.origin_location_id,
  origin_warehouse.warehouse_id,
  q.district_id,
  q.district_name_th,
  g.district_ref,
  exact_warehouse.warehouse_code,
  exact_warehouse.canonical_warehouse_id,
  warehouse_geo.geocode_status,
  warehouse_geo.quarantine_reason,
  g.latitude,
  g.longitude,
  g.map_x,
  g.map_y,
  g.geocode_status,
  g.quarantine_reason;

revoke all on
  analytics.v_transport_vehicle_status,
  analytics.v_transport_route_matrix,
  analytics.v_transport_trip_summary,
  analytics.v_transport_dispatch_queue
from public, anon, authenticated;

grant select on
  analytics.v_transport_vehicle_status,
  analytics.v_transport_route_matrix,
  analytics.v_transport_trip_summary,
  analytics.v_transport_dispatch_queue
to service_role;

-- ============================================================
-- Hardened dispatcher
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
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_district_id text;
  v_method text := upper(coalesce(p_method, ''));
  v_payload jsonb;
  v_limit integer;
  v_count integer;
  v_writes_enabled boolean;
  v_status_filter text;
  v_warehouse text;
  v_stop_count integer;
  v_distinct_stop_count integer;
  v_missing integer;
  v_plan_id uuid;
  v_trip ops.transport_trips%rowtype;
  v_trip_id uuid;
  v_new_status text;
  v_request_hash text;
  v_normalized_request jsonb;
  v_event ops.transport_trip_events%rowtype;
  v_depot_id text;
  v_depot jsonb;
  v_verified_stops jsonb;
  v_verified_ids jsonb;
  v_objective text;
  v_plan_number text;
  v_plan_version integer;
  v_root_plan_id uuid;
  v_origin_location_id text;
  v_origin_warehouse_id text;
begin
  if v_user_id is null then
    return public.m09_error(
      401,
      'unauthorized',
      'Missing or invalid bearer token',
      p_request_id
    );
  end if;

  select role::text, district_id
  into v_role, v_district_id
  from public.user_profiles
  where user_id = v_user_id
    and is_active;

  if v_role is null then
    return public.m09_error(
      403,
      'forbidden',
      'No application role is assigned',
      p_request_id
    );
  end if;

  -- Use the same persistent per-user window as the other API dispatchers.
  insert into ops.api_rate_limit_windows (
    user_id,
    window_start,
    request_count
  )
  values (
    v_user_id,
    date_trunc('minute', clock_timestamp()),
    1
  )
  on conflict (user_id, window_start) do update
  set request_count = ops.api_rate_limit_windows.request_count + 1,
      updated_at = now()
  returning request_count into v_count;

  if v_count > 120 then
    return public.m09_error(
      429,
      'rate_limited',
      'Too many requests',
      p_request_id
    );
  end if;

  -- Transport POSTs can create database or paid/external routing work. Align all
  -- of them with the production operational-write control.
  if v_method = 'POST' then
    select operational_writes_enabled
    into v_writes_enabled
    from ops.environment_controls
    where singleton;

    if not coalesce(v_writes_enabled, false) then
      return public.m09_error(
        423,
        'production_not_ready',
        'Operational writes are locked until Production cutover gates pass',
        p_request_id
      );
    end if;
  end if;

  -- ---- Readiness and governed reads ----
  if v_method = 'GET' and p_path = '/v1/transport/readiness' then
    select jsonb_build_object(
      'operational_writes_enabled',
        coalesce((
          select operational_writes_enabled
          from ops.environment_controls
          where singleton
        ), false),
      'active_warehouses',
        (select count(*) from core.transport_warehouses where is_active),
      'active_vehicles',
        (select count(*) from core.transport_vehicles where is_active),
      'verified_warehouse_geocodes',
        (
          select count(*)
          from core.transport_district_geo
          where is_warehouse
            and geocode_status = 'verified'
            and warehouse_code is not null
        ),
      'verified_district_geocodes',
        (
          select count(*)
          from core.transport_district_geo
          where not is_warehouse
            and geocode_status = 'verified'
            and district_id is not null
        ),
      'quarantined_geocodes',
        (
          select count(*)
          from core.transport_district_geo
          where geocode_status = 'quarantined'
        ),
      'warehouses_missing_geocode',
        (
          select count(*)
          from core.transport_warehouses warehouse
          where warehouse.is_active
            and not exists (
              select 1
              from core.transport_district_geo warehouse_geo
              where warehouse_geo.is_warehouse
                and warehouse_geo.warehouse_code =
                  warehouse.warehouse_code
            )
        ),
      'verified_depots_missing_canonical_origin',
        (
          select count(*)
          from core.transport_district_geo warehouse_geo
          join core.transport_warehouses warehouse
            on warehouse.warehouse_code = warehouse_geo.warehouse_code
          where warehouse_geo.is_warehouse
            and warehouse_geo.geocode_status = 'verified'
            and (
              warehouse.canonical_warehouse_id is null
              or not exists (
                select 1
                from core.locations origin
                join core.warehouses canonical
                  on canonical.warehouse_id = origin.warehouse_id
                where origin.location_type = 'WAREHOUSE'
                  and origin.is_active
                  and canonical.is_active
                  and canonical.warehouse_id =
                    warehouse.canonical_warehouse_id
              )
            )
        ),
      'warehouse_route_readiness',
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'warehouse_code', warehouse.warehouse_code,
                'geocode_status',
                  coalesce(warehouse_geo.geocode_status, 'missing'),
                'canonical_warehouse_id',
                  warehouse.canonical_warehouse_id,
                'canonical_origin_ready',
                  warehouse.canonical_warehouse_id is not null
                  and exists (
                    select 1
                    from core.locations origin
                    join core.warehouses canonical
                      on canonical.warehouse_id = origin.warehouse_id
                    where origin.location_type = 'WAREHOUSE'
                      and origin.is_active
                      and canonical.is_active
                      and canonical.warehouse_id =
                        warehouse.canonical_warehouse_id
                  ),
                'route_eligible', coalesce(
                  warehouse_geo.geocode_status = 'verified'
                  and warehouse.canonical_warehouse_id is not null
                  and exists (
                    select 1
                    from core.locations origin
                    join core.warehouses canonical
                      on canonical.warehouse_id = origin.warehouse_id
                    where origin.location_type = 'WAREHOUSE'
                      and origin.is_active
                      and canonical.is_active
                      and canonical.warehouse_id =
                        warehouse.canonical_warehouse_id
                  ),
                  false
                )
              )
              order by warehouse.warehouse_code
            )
            from core.transport_warehouses warehouse
            left join core.transport_district_geo warehouse_geo
              on warehouse_geo.is_warehouse
             and warehouse_geo.warehouse_code =
               warehouse.warehouse_code
            where warehouse.is_active
          ),
          '[]'::jsonb
        ),
      'verified_current_toll_tariffs',
        (
          select count(*)
          from core.transport_toll_tariffs tariff
          where tariff.valid_from <= current_date
            and (
              tariff.valid_to is null
              or tariff.valid_to >= current_date
            )
        ),
      'monetary_toll_estimate_available', false,
      'monetary_toll_estimate_status',
        'unavailable_route_tariff_mapping_not_configured',
      'route_ready',
        exists (
          select 1
          from core.transport_district_geo warehouse_geo
          join core.transport_warehouses warehouse
            on warehouse.warehouse_code = warehouse_geo.warehouse_code
           and warehouse.is_active
          join core.warehouses canonical
            on canonical.warehouse_id = warehouse.canonical_warehouse_id
           and canonical.is_active
          join core.locations origin
            on origin.warehouse_id = canonical.warehouse_id
           and origin.location_type = 'WAREHOUSE'
           and origin.is_active
          where warehouse_geo.is_warehouse
            and warehouse_geo.geocode_status = 'verified'
            and warehouse_geo.warehouse_code is not null
        )
        and exists (
          select 1
          from core.transport_district_geo district_geo
          where not district_geo.is_warehouse
            and district_geo.geocode_status = 'verified'
            and district_geo.district_id is not null
        ),
      'route_readiness_status',
        case
          when not exists (
            select 1
            from core.transport_district_geo district_geo
            where not district_geo.is_warehouse
              and district_geo.geocode_status = 'verified'
              and district_geo.district_id is not null
          ) then 'blocked_no_verified_district_geocodes'
          when not exists (
            select 1
            from core.transport_district_geo warehouse_geo
            where warehouse_geo.is_warehouse
              and warehouse_geo.geocode_status = 'verified'
              and warehouse_geo.warehouse_code is not null
          ) then 'blocked_no_verified_depot_geocode'
          when not exists (
            select 1
            from core.transport_district_geo warehouse_geo
            join core.transport_warehouses warehouse
              on warehouse.warehouse_code = warehouse_geo.warehouse_code
             and warehouse.is_active
            join core.warehouses canonical
              on canonical.warehouse_id =
                warehouse.canonical_warehouse_id
             and canonical.is_active
            join core.locations origin
              on origin.warehouse_id = canonical.warehouse_id
             and origin.location_type = 'WAREHOUSE'
             and origin.is_active
            where warehouse_geo.is_warehouse
              and warehouse_geo.geocode_status = 'verified'
          ) then 'blocked_verified_depot_missing_canonical_origin'
          else 'ready'
        end,
      'optimization_worker_ready', false,
      'optimization_worker_status',
        'blocked_status_contract_mismatch',
      'trip_persistence_ready', false,
      'trip_persistence_status',
        'blocked_road_route_evidence_contract_missing'
    )
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/warehouses' then
    select coalesce(
      jsonb_agg(to_jsonb(q) order by q.warehouse_code),
      '[]'::jsonb
    )
    into v_payload
    from (
      select
        warehouse.warehouse_code,
        warehouse.name_th,
        warehouse.canonical_warehouse_id,
        warehouse.is_active,
        warehouse_geo.district_ref as geocode_ref,
        coalesce(warehouse_geo.geocode_status, 'missing') as
          geocode_status,
        warehouse_geo.latitude,
        warehouse_geo.longitude,
        coalesce((
          warehouse_geo.geocode_status = 'verified'
          and warehouse.canonical_warehouse_id is not null
          and exists (
            select 1
            from core.locations origin
            join core.warehouses canonical
              on canonical.warehouse_id = origin.warehouse_id
            where origin.location_type = 'WAREHOUSE'
              and origin.is_active
              and canonical.is_active
              and canonical.warehouse_id =
                warehouse.canonical_warehouse_id
          )
        ), false) as route_eligible
      from core.transport_warehouses warehouse
      left join core.transport_district_geo warehouse_geo
        on warehouse_geo.is_warehouse
       and warehouse_geo.warehouse_code = warehouse.warehouse_code
      where warehouse.is_active
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/geo' then
    select coalesce(
      jsonb_agg(to_jsonb(q) order by q.is_warehouse desc, q.district_ref),
      '[]'::jsonb
    )
    into v_payload
    from (
      select
        district_ref,
        district_id,
        warehouse_code,
        name_en,
        name_th,
        latitude,
        longitude,
        map_x,
        map_y,
        is_warehouse,
        geocode_status,
        coordinate_source,
        source_reference,
        source_checksum_sha256,
        source_row_number,
        accuracy_meters,
        verified_at,
        quarantined_at,
        quarantine_reason,
        (
          geocode_status = 'verified'
          and (
            (
              is_warehouse
              and warehouse_code is not null
              and exists (
                select 1
                from core.transport_warehouses warehouse
                join core.warehouses canonical
                  on canonical.warehouse_id =
                    warehouse.canonical_warehouse_id
                 and canonical.is_active
                join core.locations origin
                  on origin.warehouse_id = canonical.warehouse_id
                 and origin.location_type = 'WAREHOUSE'
                 and origin.is_active
                where warehouse.warehouse_code =
                  core.transport_district_geo.warehouse_code
                  and warehouse.is_active
              )
            )
            or (not is_warehouse and district_id is not null)
          )
        ) as route_eligible,
        updated_at
      from core.transport_district_geo
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/vehicles' then
    select coalesce(
      jsonb_agg(to_jsonb(q) order by q.vehicle_id),
      '[]'::jsonb
    )
    into v_payload
    from (
      select *
      from analytics.v_transport_vehicle_status
      where is_active
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/route-matrix' then
    v_warehouse := nullif(p_query ->> 'warehouse', '');
    select coalesce(
      jsonb_agg(to_jsonb(q) order by q.warehouse_code, q.distance_km),
      '[]'::jsonb
    )
    into v_payload
    from (
      select *
      from analytics.v_transport_route_matrix
      where v_warehouse is null
         or warehouse_code = v_warehouse
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET'
     and p_path = '/v1/transport/dispatch-queue' then
    select coalesce(
      jsonb_agg(
        to_jsonb(q)
        order by
          q.plan_number,
          q.suggested_distance_km nulls last,
          q.district_ref
      ),
      '[]'::jsonb
    )
    into v_payload
    from (
      select *
      from analytics.v_transport_dispatch_queue
      where v_role <> 'district'
         or district_id = v_district_id
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/trips' then
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 100);
    if v_limit not between 1 and 500 then
      return public.m09_error(
        422,
        'validation_error',
        'Invalid limit',
        p_request_id
      );
    end if;

    v_status_filter := nullif(p_query ->> 'status', '');
    if v_status_filter is not null
       and v_status_filter not in (
         'planned',
         'dispatched',
         'completed',
         'cancelled'
       ) then
      return public.m09_error(
        422,
        'validation_error',
        'Invalid status',
        p_request_id
      );
    end if;

    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select *
      from analytics.v_transport_trip_summary trip
      where (
          v_status_filter is null
          or trip.status = v_status_filter
        )
        and (
          v_role <> 'district'
          or exists (
            select 1
            from core.transport_district_geo geo
            where geo.district_id = v_district_id
              and geo.district_ref = any(trip.route_district_refs)
          )
        )
      order by trip.created_at desc
      limit v_limit
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  -- ---- DB-only authorization/plan/geocode preflight for the road engine ----
  if v_method = 'POST' and p_path = '/v1/transport/optimize' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(
        403,
        'forbidden',
        'Only admin or planner may optimize transport routes',
        p_request_id
      );
    end if;

    if jsonb_typeof(p_body) <> 'object'
       or jsonb_typeof(p_body -> 'depot') <> 'object'
       or jsonb_typeof(p_body -> 'stops') <> 'array' then
      return public.m09_error(
        422,
        'validation_error',
        'depot object and stops array are required',
        p_request_id
      );
    end if;

    v_depot_id := btrim(coalesce(p_body #>> '{depot,id}', ''));
    v_stop_count := jsonb_array_length(p_body -> 'stops');
    v_objective := coalesce(nullif(p_body ->> 'objective', ''), 'duration');

    if btrim(coalesce(p_body ->> 'replenishment_plan_id', ''))
         !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      return public.m09_error(
        422,
        'validation_error',
        'A valid replenishment_plan_id UUID is required',
        p_request_id
      );
    end if;

    v_plan_id := (p_body ->> 'replenishment_plan_id')::uuid;

    if p_body ? 'avoidTolls'
       and jsonb_typeof(p_body -> 'avoidTolls') <> 'boolean' then
      return public.m09_error(
        422,
        'validation_error',
        'avoidTolls must be a JSON boolean when provided',
        p_request_id
      );
    end if;

    if v_depot_id = ''
       or v_stop_count not between 1 and 18
       or v_objective not in ('duration', 'distance') then
      return public.m09_error(
        422,
        'validation_error',
        'Invalid depot, stop count or objective',
        p_request_id
      );
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_body -> 'stops') stop(value)
      where jsonb_typeof(stop.value) <> 'object'
         or btrim(coalesce(stop.value ->> 'id', '')) = ''
    ) then
      return public.m09_error(
        422,
        'validation_error',
        'Every stop must contain an id',
        p_request_id
      );
    end if;

    select count(distinct btrim(stop.value ->> 'id'))
    into v_distinct_stop_count
    from jsonb_array_elements(p_body -> 'stops') stop(value);

    if v_distinct_stop_count <> v_stop_count
       or exists (
         select 1
         from jsonb_array_elements(p_body -> 'stops') stop(value)
         where btrim(stop.value ->> 'id') = v_depot_id
       ) then
      return public.m09_error(
        422,
        'validation_error',
        'Depot and destination ids must be unique',
        p_request_id
      );
    end if;

    select jsonb_build_object(
      'id', v_depot_id,
      'district_ref', geo.district_ref,
      'warehouse_code', geo.warehouse_code,
      'canonical_warehouse_id', warehouse.canonical_warehouse_id,
      'lat', geo.latitude,
      'lon', geo.longitude,
      'verified_at', geo.verified_at,
      'source_reference', geo.source_reference,
      'source_checksum_sha256', geo.source_checksum_sha256,
      'source_row_number', geo.source_row_number
    )
    into v_depot
    from core.transport_district_geo geo
    join core.transport_warehouses warehouse
      on warehouse.warehouse_code = geo.warehouse_code
     and warehouse.is_active
    where geo.is_warehouse
      and geo.geocode_status = 'verified'
      and (
        geo.district_ref = v_depot_id
        or geo.warehouse_code = v_depot_id
      )
    order by
      case when geo.warehouse_code = v_depot_id then 0 else 1 end,
      geo.district_ref
    limit 1;

    if v_depot is null then
      return public.m09_error(
        422,
        'geocode_not_verified',
        'Depot geocode is missing, unverified or quarantined',
        p_request_id
      );
    end if;

    -- Only the locked, latest active version in a root-plan lineage may be
    -- optimized, and its origin must still be an active canonical warehouse.
    select
      plan.plan_number,
      plan.version_no,
      coalesce(plan.parent_plan_id, plan.replenishment_plan_id),
      plan.origin_location_id,
      origin.warehouse_id
    into
      v_plan_number,
      v_plan_version,
      v_root_plan_id,
      v_origin_location_id,
      v_origin_warehouse_id
    from core.replenishment_plans plan
    join core.locations origin
      on origin.location_id = plan.origin_location_id
     and origin.location_type = 'WAREHOUSE'
     and origin.is_active
    join core.warehouses canonical
      on canonical.warehouse_id = origin.warehouse_id
     and canonical.is_active
    where plan.replenishment_plan_id = v_plan_id
      and plan.status = 'locked'
      and not exists (
        select 1
        from core.replenishment_plans newer
        where coalesce(
            newer.parent_plan_id,
            newer.replenishment_plan_id
          ) = coalesce(
            plan.parent_plan_id,
            plan.replenishment_plan_id
          )
          and newer.version_no > plan.version_no
          and newer.status not in ('cancelled', 'completed')
      );

    if not found then
      return public.m09_error(
        409,
        'plan_not_dispatchable',
        'Replenishment plan must be locked, active and the latest root-lineage version',
        p_request_id
      );
    end if;

    if (v_depot #>> '{canonical_warehouse_id}')
         is distinct from v_origin_warehouse_id then
      return public.m09_error(
        409,
        'depot_plan_mismatch',
        'Verified depot canonical warehouse does not match the replenishment plan origin',
        p_request_id,
        jsonb_build_object(
          'replenishment_plan_id', v_plan_id,
          'origin_location_id', v_origin_location_id,
          'origin_warehouse_id', v_origin_warehouse_id,
          'depot_warehouse_code', v_depot #>> '{warehouse_code}',
          'depot_canonical_warehouse_id',
            v_depot #>> '{canonical_warehouse_id}'
        )
      );
    end if;

    select
      count(*),
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', requested.stop_id,
            'district_ref', geo.district_ref,
            'district_id', geo.district_id,
            'lat', geo.latitude,
            'lon', geo.longitude,
            'verified_at', geo.verified_at,
            'source_reference', geo.source_reference,
            'source_checksum_sha256', geo.source_checksum_sha256,
            'source_row_number', geo.source_row_number
          )
          order by requested.ordinality
        ),
        '[]'::jsonb
      )
    into v_missing, v_verified_stops
    from (
      select
        btrim(stop.value ->> 'id') as stop_id,
        stop.ordinality
      from jsonb_array_elements(p_body -> 'stops')
        with ordinality stop(value, ordinality)
    ) requested
    join lateral (
      select candidate.*
      from core.transport_district_geo candidate
      where not candidate.is_warehouse
        and candidate.geocode_status = 'verified'
        and (
          candidate.district_ref = requested.stop_id
          or candidate.district_id = requested.stop_id
        )
      order by
        case when candidate.district_ref = requested.stop_id then 0 else 1 end,
        candidate.district_ref
      limit 1
    ) geo on true;

    if v_missing <> v_stop_count then
      return public.m09_error(
        422,
        'geocode_not_verified',
        'One or more destination geocodes are missing, unverified or quarantined',
        p_request_id
      );
    end if;

    select count(*)
    into v_missing
    from (
      select btrim(stop.value ->> 'id') as stop_id
      from jsonb_array_elements(p_body -> 'stops') stop(value)
    ) requested
    where not exists (
      select 1
      from core.transport_district_geo geo
      join core.replenishment_items item
        on item.district_id = geo.district_id
       and item.replenishment_plan_id = v_plan_id
       and item.status = 'locked'
       and item.final_qty > 0
      where not geo.is_warehouse
        and geo.geocode_status = 'verified'
        and (
          geo.district_ref = requested.stop_id
          or geo.district_id = requested.stop_id
        )
    );

    if v_missing > 0 then
      return public.m09_error(
        409,
        'plan_demand_mismatch',
        'Every stop must belong to positive locked demand in the exact replenishment plan',
        p_request_id,
        jsonb_build_object(
          'replenishment_plan_id', v_plan_id
        )
      );
    end if;

    select jsonb_build_array(v_depot ->> 'district_ref')
      || coalesce(
        jsonb_agg(
          to_jsonb(stop.value ->> 'district_ref')
          order by stop.ordinality
        ),
        '[]'::jsonb
      )
    into v_verified_ids
    from jsonb_array_elements(v_verified_stops)
      with ordinality stop(value, ordinality);

    return public.m09_result(
      200,
      jsonb_build_object(
        'authorized', true,
        'request_id', p_request_id,
        'replenishment_plan_id', v_plan_id,
        'root_replenishment_plan_id', v_root_plan_id,
        'plan_number', v_plan_number,
        'plan_version', v_plan_version,
        'origin_location_id', v_origin_location_id,
        'depot', v_depot,
        'stops', v_verified_stops,
        'verified_geo_ids', v_verified_ids,
        'objective', v_objective,
        'avoid_tolls', coalesce((p_body ->> 'avoidTolls')::boolean, false),
        'verified_current_toll_tariffs',
          (
            select count(*)
            from core.transport_toll_tariffs tariff
            where tariff.valid_from <= current_date
              and (
                tariff.valid_to is null
                or tariff.valid_to >= current_date
              )
          ),
        'monetary_toll_estimate_available', false,
        'monetary_toll_estimate_status',
          'unavailable_route_tariff_mapping_not_configured'
      )
    );
  end if;

  -- M08 still consumes the retired confirmed/approved status vocabulary while
  -- Production emits district_confirmed/planner_approved/locked. Keep the
  -- worker explicitly unreachable under the transport namespace until that
  -- contract and its route-job idempotency are migrated together.
  if (
    v_method = 'POST'
    and p_path = '/v1/transport/optimization-jobs'
  ) or (
    v_method = 'GET'
    and p_path ~ '^/v1/transport/optimization-jobs/[0-9a-fA-F-]{36}$'
  ) then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(
        403,
        'forbidden',
        'Only admin or planner may access route optimization jobs',
        p_request_id
      );
    end if;

    return public.m09_error(
      410,
      'optimization_worker_not_ready',
      'Optimization jobs remain disabled until M08 is migrated to the locked replenishment status contract',
      p_request_id,
      jsonb_build_object(
        'readiness_path', '/v1/transport/readiness',
        'required_plan_status', 'locked'
      )
    );
  end if;

  -- ---- Trip creation remains fail-closed pending road evidence persistence ----
  if v_method = 'POST' and p_path = '/v1/transport/trips' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(
        403,
        'forbidden',
        'Only admin or planner may plan trips',
        p_request_id
      );
    end if;

    -- The retired implementation derived distance, duration and toll from the
    -- illustrative radial matrix. Persisting those values after a real-road
    -- OSRM preview would create false operational evidence.
    return public.m09_error(
      410,
      'road_route_evidence_not_persistable',
      'Trip creation is disabled until verified real-road route evidence can be persisted',
      p_request_id,
      jsonb_build_object(
        'preflight_path', '/v1/transport/optimize',
        'readiness_path', '/v1/transport/readiness',
        'required_evidence',
          'server_authenticated_road_route_result'
      )
    );
  end if;

  -- ---- Serialized, idempotent status transitions ----
  if v_method = 'POST'
     and p_path ~ '^/v1/transport/trips/[0-9a-fA-F-]{36}/status$' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(
        403,
        'forbidden',
        'Only admin or planner may update trips',
        p_request_id
      );
    end if;

    if p_request_id = 'unknown'
       or p_request_id !~ '^[A-Za-z0-9_-]{1,128}$' then
      return public.m09_error(
        422,
        'validation_error',
        'A valid request id is required for status updates',
        p_request_id
      );
    end if;

    v_trip_id := substring(
      p_path
      from '^/v1/transport/trips/([0-9a-fA-F-]{36})/status$'
    )::uuid;
    v_new_status := btrim(coalesce(p_body ->> 'status', ''));

    if v_new_status not in (
      'planned',
      'dispatched',
      'completed',
      'cancelled'
    ) then
      return public.m09_error(
        422,
        'validation_error',
        'Invalid status',
        p_request_id
      );
    end if;

    v_normalized_request := jsonb_build_object(
      'status', v_new_status,
      'fuel_cost_actual_thb',
        nullif(p_body ->> 'fuel_cost_actual_thb', ''),
      'depart_time', nullif(p_body ->> 'depart_time', ''),
      'return_time', nullif(p_body ->> 'return_time', '')
    );
    v_request_hash := encode(
      extensions.digest(
        convert_to(v_normalized_request::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    );

    select *
    into v_trip
    from ops.transport_trips
    where trip_id = v_trip_id
    for update;

    if not found then
      return public.m09_error(
        404,
        'not_found',
        'Trip not found',
        p_request_id
      );
    end if;

    select *
    into v_event
    from ops.transport_trip_events
    where trip_id = v_trip_id
      and request_id = p_request_id;

    if found then
      if v_event.request_payload_hash is distinct from v_request_hash then
        return public.m09_error(
          409,
          'idempotency_conflict',
          'Request id was already used with another status payload',
          p_request_id
        );
      end if;
      return public.m09_result(200, v_event.result_snapshot);
    end if;

    if v_trip.status = v_new_status then
      return public.m09_result(200, to_jsonb(v_trip));
    end if;

    if not (
      (
        v_trip.status = 'planned'
        and v_new_status in ('dispatched', 'cancelled')
      )
      or (
        v_trip.status = 'dispatched'
        and v_new_status in ('completed', 'cancelled')
      )
    ) then
      return public.m09_error(
        409,
        'invalid_transition',
        format(
          'Trip cannot transition from %s to %s',
          v_trip.status,
          v_new_status
        ),
        p_request_id
      );
    end if;

    v_status_filter := v_trip.status;
    update ops.transport_trips
    set status = v_new_status,
        fuel_cost_actual_thb = coalesce(
          nullif(p_body ->> 'fuel_cost_actual_thb', '')::numeric,
          fuel_cost_actual_thb
        ),
        depart_time = coalesce(
          nullif(p_body ->> 'depart_time', ''),
          depart_time
        ),
        return_time = coalesce(
          nullif(p_body ->> 'return_time', ''),
          return_time
        ),
        updated_at = now()
    where trip_id = v_trip_id
    returning * into v_trip;

    insert into ops.transport_trip_events (
      trip_id,
      from_status,
      to_status,
      request_id,
      request_payload_hash,
      result_snapshot,
      actor_id
    )
    values (
      v_trip.trip_id,
      v_status_filter,
      v_new_status,
      p_request_id,
      v_request_hash,
      to_jsonb(v_trip),
      v_user_id
    );

    return public.m09_result(200, to_jsonb(v_trip));
  end if;

  return public.m09_error(
    404,
    'not_found',
    'Transport API path not found',
    p_request_id
  );
exception
  when invalid_text_representation
    or numeric_value_out_of_range
    or array_subscript_error then
    return public.m09_error(
      422,
      'validation_error',
      'Transport request contains an invalid value',
      p_request_id
    );
  when unique_violation then
    return public.m09_error(
      409,
      'conflict',
      'Transport request conflicts with an existing assignment',
      p_request_id
    );
  when check_violation or foreign_key_violation then
    return public.m09_error(
      422,
      'validation_error',
      'Transport request violates a data constraint',
      p_request_id
    );
end;
$$;

revoke all on function
  public.m13_transport_dispatch(text, text, jsonb, jsonb, text)
from public, anon, authenticated;

grant execute on function
  public.m13_transport_dispatch(text, text, jsonb, jsonb, text)
to authenticated;

-- ============================================================
-- Inventory/replenishment concurrency and cutoff correctness
-- ============================================================
do $$
begin
  if exists (
    select 1
    from core.replenishment_plans
    where parent_plan_id is null
      and status not in ('cancelled', 'completed')
    group by week_start_date
    having count(*) > 1
  ) then
    raise exception
      'M13c cannot enforce one active root plan per week: duplicates exist';
  end if;
end
$$;

create unique index if not exists
  replenishment_plans_one_active_root_week_uidx
on core.replenishment_plans (week_start_date)
where parent_plan_id is null
  and status not in ('cancelled', 'completed');

create or replace function core.serialize_active_root_replenishment_plan()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.parent_plan_id is null
     and new.status not in ('cancelled', 'completed') then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'replenishment-root-week:' || new.week_start_date::text,
        0
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists serialize_active_root_replenishment_plan
  on core.replenishment_plans;
create trigger serialize_active_root_replenishment_plan
  before insert or update of week_start_date, parent_plan_id, status
  on core.replenishment_plans
  for each row
  execute function core.serialize_active_root_replenishment_plan();

-- This trigger is the final invariant. It runs in the same INSERT statement as
-- the RETURN movement, locks the original ISSUE, and rechecks committed returns.
-- If it rejects, the calling function's earlier handling-unit updates roll back.
create or replace function core.enforce_inventory_return_balance()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_issued_qty numeric;
  v_returned_qty numeric;
begin
  if new.movement_type <> 'RETURN' then
    return new;
  end if;

  if new.source_movement_id is null then
    raise exception 'RETURN requires source ISSUE movement'
      using errcode = '23514';
  end if;

  select source.quantity
  into v_issued_qty
  from core.inventory_movements source
  where source.inventory_movement_id = new.source_movement_id
    and source.movement_type = 'ISSUE'
  for update;

  if not found then
    raise exception 'RETURN source ISSUE movement not found'
      using errcode = '23503';
  end if;

  select coalesce(sum(existing.quantity), 0)
  into v_returned_qty
  from core.inventory_movements existing
  where existing.source_movement_id = new.source_movement_id
    and existing.movement_type = 'RETURN';

  if v_returned_qty + new.quantity > v_issued_qty then
    raise exception
      'Cumulative return quantity % exceeds original ISSUE quantity %',
      v_returned_qty + new.quantity,
      v_issued_qty
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_inventory_return_balance
  on core.inventory_movements;
create trigger enforce_inventory_return_balance
  before insert on core.inventory_movements
  for each row
  when (new.movement_type = 'RETURN')
  execute function core.enforce_inventory_return_balance();

-- Parameterized, evidence-aware stock health used only by replenishment runs.
-- The public dashboard view remains an intentionally current-state view.
create or replace function analytics.stock_health_at(
  p_cutoff_at timestamptz
)
returns table (
  snapshot_id uuid,
  usage_rate_id uuid,
  material_id text,
  district_id text,
  current_stock_qty numeric,
  snapshot_at timestamptz,
  usage_as_of_date date,
  cmp_monthly numeric,
  months_available numeric,
  source_stock_missing boolean
)
language sql
stable
set search_path = ''
as $$
  with params as (
    select coalesce(p_cutoff_at, statement_timestamp()) as cutoff_at
  ), latest_successful_import as (
    select import.actual_workbook_import_id
    from ops.actual_workbook_imports import
    cross join params
    where import.status = 'succeeded'
      and coalesce(import.finished_at, import.started_at) <= params.cutoff_at
    order by
      import.finished_at desc nulls last,
      import.started_at desc,
      import.actual_workbook_import_id desc
    limit 1
  ), legacy_nonproduction_fallback as (
    select
      not exists (select 1 from latest_successful_import)
      and exists (
        select 1
        from ops.environment_registry
        where environment_name <> 'production'
      ) as allowed
  ), latest_location_candidate as (
    select distinct on (stock.material_id, stock.location_id)
      stock.snapshot_id,
      stock.material_id,
      stock.location_id,
      location.district_id,
      stock.quantity_on_hand,
      stock.snapshot_at,
      stock.data_class
    from core.stock_snapshots stock
    join core.locations location using (location_id)
    cross join params
    where location.location_type = 'DISTRICT'
      and stock.snapshot_at <= params.cutoff_at
      and (
        stock.data_class = 'test_fixture'
        or exists (select 1 from latest_successful_import)
        or (select allowed from legacy_nonproduction_fallback)
      )
    order by
      stock.material_id,
      stock.location_id,
      stock.snapshot_at desc,
      stock.snapshot_id
  ), latest_location_snapshot as (
    select candidate.*
    from latest_location_candidate candidate
    where candidate.data_class = 'test_fixture'
      or (select allowed from legacy_nonproduction_fallback)
      or exists (
        select 1
        from reference_data.stock_observation_evidence evidence
        where evidence.stock_snapshot_id = candidate.snapshot_id
          and evidence.verification_status in (
            'source_observed',
            'owner_attested_zero'
          )
          and evidence.actual_workbook_import_id = (
            select actual_workbook_import_id
            from latest_successful_import
          )
      )
  ), district_stock as (
    select
      stock.material_id,
      stock.district_id,
      (
        array_agg(
          stock.snapshot_id
          order by stock.snapshot_at desc, stock.snapshot_id
        )
      )[1] as snapshot_id,
      sum(stock.quantity_on_hand) as quantity_on_hand,
      max(stock.snapshot_at) as snapshot_at
    from latest_location_snapshot stock
    group by stock.material_id, stock.district_id
  ), latest_usage_candidate as (
    select distinct on (usage.material_id, usage.district_id)
      usage.usage_rate_id,
      usage.material_id,
      usage.district_id,
      usage.as_of_date,
      usage.cmp_monthly,
      usage.data_class
    from core.usage_rates usage
    cross join params
    where usage.created_at <= params.cutoff_at
      and usage.as_of_date <= (
        date_trunc(
          'month',
          params.cutoff_at at time zone 'Asia/Bangkok'
        ) + interval '1 month - 1 day'
      )::date
      and (
        usage.data_class = 'test_fixture'
        or exists (select 1 from latest_successful_import)
        or (select allowed from legacy_nonproduction_fallback)
      )
    order by
      usage.material_id,
      usage.district_id,
      usage.as_of_date desc,
      usage.updated_at desc
  ), latest_usage as (
    select candidate.*
    from latest_usage_candidate candidate
    where candidate.data_class = 'test_fixture'
      or (select allowed from legacy_nonproduction_fallback)
      or exists (
        select 1
        from reference_data.usage_observation_evidence evidence
        where evidence.usage_rate_id = candidate.usage_rate_id
          and evidence.verification_status in (
            'source_observed',
            'owner_attested_zero'
          )
          and evidence.actual_workbook_import_id = (
            select actual_workbook_import_id
            from latest_successful_import
          )
      )
  )
  select
    stock.snapshot_id,
    usage.usage_rate_id,
    material.material_id,
    district.district_id,
    coalesce(stock.quantity_on_hand, 0),
    stock.snapshot_at,
    usage.as_of_date,
    usage.cmp_monthly,
    case
      when usage.cmp_monthly > 0 then
        round(coalesce(stock.quantity_on_hand, 0) / usage.cmp_monthly, 1)
    end,
    stock.snapshot_id is null
  from core.materials material
  cross join core.districts district
  left join district_stock stock
    on stock.material_id = material.material_id
   and stock.district_id = district.district_id
  left join latest_usage usage
    on usage.material_id = material.material_id
   and usage.district_id = district.district_id
  where material.is_vmi
    and district.is_active
$$;

revoke all on function analytics.stock_health_at(timestamptz)
  from public, anon, authenticated;
grant execute on function analytics.stock_health_at(timestamptz)
  to service_role;

create or replace function core.create_replenishment_run(
  p_snapshot_cutoff_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_policy ops.calculation_policies%rowtype;
  v_run_id uuid := gen_random_uuid();
  v_plan_id uuid := gen_random_uuid();
  v_origin_location_id text;
  v_week_start date :=
    date_trunc('week', now() at time zone 'Asia/Bangkok')::date;
  v_plan_number text;
  v_cutoff_at timestamptz :=
    coalesce(p_snapshot_cutoff_at, statement_timestamp());
  v_cutoff_date date;
begin
  if v_cutoff_at > statement_timestamp() then
    raise exception 'snapshot_cutoff_at cannot be in the future';
  end if;
  v_cutoff_date := (v_cutoff_at at time zone 'Asia/Bangkok')::date;

  select *
  into v_policy
  from ops.calculation_policies
  where is_active;

  if not found then
    raise exception 'No active replenishment calculation policy';
  end if;

  select location.location_id
  into v_origin_location_id
  from core.locations location
  join core.warehouses warehouse using (warehouse_id)
  where location.location_type = 'WAREHOUSE'
    and location.is_active
    and warehouse.sap_plant_code = '2401'
    and warehouse.storage_location = '0001'
  order by location.location_id
  limit 1;

  if v_origin_location_id is null then
    raise exception
      'Khlong Toei warehouse Plant 2401 / Storage Location 0001 is not configured';
  end if;

  -- Serialize before the user-friendly check; the partial unique index remains
  -- authoritative for every other write path.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'replenishment-root-week:' || v_week_start::text,
      0
    )
  );

  if exists (
    select 1
    from core.replenishment_plans
    where week_start_date = v_week_start
      and parent_plan_id is null
      and status not in ('cancelled', 'completed')
  ) then
    raise exception
      'An active weekly plan already exists for %; version or cancel it instead',
      v_week_start;
  end if;

  if not exists (
    select 1
    from core.usage_rates
    where created_at <= v_cutoff_at
      and as_of_date between
        v_cutoff_date - 62
        and (
          date_trunc('month', v_cutoff_date)
          + interval '1 month - 1 day'
        )::date
  ) then
    raise exception 'No current monthly usage/CMP source is available at cutoff %',
      v_cutoff_at;
  end if;

  v_plan_number := 'RP-' || to_char(v_week_start, 'IYYY-IW')
    || '-' || upper(left(replace(v_plan_id::text, '-', ''), 8));

  insert into ops.replenishment_runs (
    replenishment_run_id,
    policy_version,
    snapshot_cutoff_at,
    initiated_by
  )
  values (
    v_run_id,
    v_policy.policy_version,
    v_cutoff_at,
    auth.uid()
  );

  insert into core.replenishment_plans (
    replenishment_plan_id,
    replenishment_run_id,
    plan_number,
    week_start_date,
    version_no,
    origin_location_id,
    status,
    response_due_at,
    created_by
  )
  values (
    v_plan_id,
    v_run_id,
    v_plan_number,
    v_week_start,
    1,
    v_origin_location_id,
    'draft',
    (
      date_trunc('day', now() at time zone 'Asia/Bangkok')
      + interval '1 day 17 hours'
    ) at time zone 'Asia/Bangkok',
    auth.uid()
  );

  insert into core.replenishment_items (
    replenishment_plan_id,
    material_id,
    district_id,
    source_stock_snapshot_id,
    source_usage_rate_id,
    current_stock_qty,
    cmp_monthly,
    months_available,
    min_fill_qty,
    max_fill_qty,
    suggested_qty,
    requested_qty,
    final_qty,
    projected_months_after,
    source_stock_missing,
    priority_score,
    priority_band,
    status
  )
  select
    v_plan_id,
    health.material_id,
    health.district_id,
    health.snapshot_id,
    health.usage_rate_id,
    health.current_stock_qty,
    health.cmp_monthly,
    health.months_available,
    core.round_replenishment(
      health.cmp_monthly * 4 - health.current_stock_qty
    ),
    core.round_replenishment(
      health.cmp_monthly * 6 - health.current_stock_qty
    ),
    core.round_replenishment(
      health.cmp_monthly * 6 - health.current_stock_qty
    ),
    core.round_replenishment(
      health.cmp_monthly * 6 - health.current_stock_qty
    ),
    core.round_replenishment(
      health.cmp_monthly * 6 - health.current_stock_qty
    ),
    round(
      (
        health.current_stock_qty
        + core.round_replenishment(
          health.cmp_monthly * 6 - health.current_stock_qty
        )
      ) / health.cmp_monthly,
      2
    ),
    health.source_stock_missing,
    round(
      greatest(
        1::numeric,
        least(
          10::numeric,
          (
            (
              1 - least(
                health.current_stock_qty
                  / nullif(health.cmp_monthly * 6, 0),
                1
              )
            ) * 10
          ) * 0.5
          + greatest(
              0::numeric,
              least(
                10::numeric,
                (30 - health.months_available * 30) / 3
              )
            ) * 0.3
          + 5 * 0.2
        )
      ),
      1
    ),
    case
      when health.months_available < 1.5 then 'critical'
      when health.months_available < 3.5 then 'high'
      else 'normal'
    end,
    'pending'
  from analytics.stock_health_at(v_cutoff_at) health
  where health.cmp_monthly > 0
    and health.usage_as_of_date between
      v_cutoff_date - 62
      and (
        date_trunc('month', v_cutoff_date)
        + interval '1 month - 1 day'
      )::date
    and health.months_available
      <= (v_policy.parameters ->> 'months_trigger')::numeric
    and core.round_replenishment(
      health.cmp_monthly * 6 - health.current_stock_qty
    ) > 0;

  insert into ops.quantity_recommendations (
    replenishment_item_id,
    method,
    recommended_qty,
    evidence,
    source_freshness_status
  )
  select
    item.replenishment_item_id,
    'BUSINESS_RULE_V1',
    item.suggested_qty,
    jsonb_build_object(
      'policy_version', v_policy.policy_version,
      'cmp_formula', 'ROUND(AVERAGE(LY,12M,6M,4M),0)',
      'trigger_months', 3.5,
      'min_months', 4,
      'max_months', 6,
      'snapshot_cutoff_at', v_cutoff_at,
      'current_stock_qty', item.current_stock_qty,
      'cmp_monthly', item.cmp_monthly,
      'months_available', item.months_available,
      'min_fill_qty', item.min_fill_qty,
      'max_fill_qty', item.max_fill_qty,
      'source_stock_missing', item.source_stock_missing
    ),
    case
      when item.source_stock_missing then 'source_missing_assumed_zero'
      else 'fresh'
    end
  from core.replenishment_items item
  where item.replenishment_plan_id = v_plan_id;

  update core.replenishment_plans
  set status = case
        when exists (
          select 1
          from core.replenishment_items
          where replenishment_plan_id = v_plan_id
        ) then 'pending_district_confirmation'
        else 'draft'
      end,
      updated_at = now()
  where replenishment_plan_id = v_plan_id;

  update ops.replenishment_runs
  set status = 'succeeded',
      candidate_count = (
        select count(*)
        from core.replenishment_items
        where replenishment_plan_id = v_plan_id
      ),
      usage_cutoff_date = (
        select max(usage.as_of_date)
        from core.replenishment_items item
        join core.usage_rates usage
          on usage.usage_rate_id = item.source_usage_rate_id
        where item.replenishment_plan_id = v_plan_id
      ),
      finished_at = now()
  where replenishment_run_id = v_run_id;

  return v_run_id;
exception
  when others then
    update ops.replenishment_runs
    set status = 'failed',
        error_message = left(sqlerrm, 2000),
        finished_at = now()
    where replenishment_run_id = v_run_id;
    raise;
end;
$$;

revoke all on function core.create_replenishment_run(timestamptz)
  from public, anon, authenticated;
grant execute on function core.create_replenishment_run(timestamptz)
  to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607250003',
  'M13c',
  'Authoritative transport/M08 geocodes, exact-plan route preflight, fail-closed road-evidence persistence, serialized trip history, and inventory concurrency/cutoff hardening.',
  'supabase/migrations/202607250003_m13_transport_hardening.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
