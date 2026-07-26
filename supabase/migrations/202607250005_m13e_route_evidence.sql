-- SYNAPSE M13e: owner-approved fleet identity and immutable road evidence.
--
-- This migration deliberately does not map any legacy transport vehicle to a
-- canonical core vehicle. Existing rows fail closed as unmapped, with unknown
-- availability and unverified capacity, until an owner supplies attributable
-- evidence in one atomic update.

begin;

-- --------------------------------------------------------------------------
-- Strict GeoJSON validation used by the immutable road-evidence constraint.
-- The accepted representation is the WGS84 two-dimensional subset of RFC 7946.
-- --------------------------------------------------------------------------
create or replace function core.is_valid_wgs84_linestring(
  p_geometry jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  v_position jsonb;
  v_longitude numeric;
  v_latitude numeric;
begin
  if p_geometry is null
     or jsonb_typeof(p_geometry) <> 'object'
     or p_geometry ->> 'type' <> 'LineString' then
    return false;
  end if;

  if coalesce(
       jsonb_typeof(p_geometry -> 'coordinates'),
       'missing'
     ) <> 'array' then
    return false;
  end if;

  if jsonb_array_length(p_geometry -> 'coordinates') < 2 then
    return false;
  end if;

  for v_position in
    select value
    from jsonb_array_elements(p_geometry -> 'coordinates')
  loop
    if jsonb_typeof(v_position) <> 'array' then
      return false;
    end if;

    if jsonb_array_length(v_position) <> 2 then
      return false;
    end if;

    if coalesce(jsonb_typeof(v_position -> 0), 'missing') <> 'number'
       or coalesce(
         jsonb_typeof(v_position -> 1),
         'missing'
       ) <> 'number' then
      return false;
    end if;

    begin
      v_longitude := (v_position ->> 0)::numeric;
      v_latitude := (v_position ->> 1)::numeric;
    exception
      when invalid_text_representation
        or numeric_value_out_of_range then
        return false;
    end;

    if v_longitude not between -180 and 180
       or v_latitude not between -90 and 90 then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

-- --------------------------------------------------------------------------
-- Owner-approved transport-to-canonical vehicle mapping, capacity provenance,
-- and short-lived availability evidence. No seed is promoted by this change.
-- --------------------------------------------------------------------------
alter table core.transport_vehicles
  add column if not exists canonical_vehicle_id text
    references core.vehicles (vehicle_id) on delete restrict,
  add column if not exists vehicle_mapping_status text not null
    default 'unmapped',
  add column if not exists vehicle_mapping_source_reference text,
  add column if not exists vehicle_mapping_source_checksum_sha256 text,
  add column if not exists vehicle_mapping_source_row_number integer,
  add column if not exists vehicle_mapping_verified_at timestamptz,
  add column if not exists vehicle_mapping_verified_by uuid
    references auth.users (id) on delete restrict,
  add column if not exists vehicle_mapping_approval_ticket text,
  add column if not exists max_pallets numeric,
  add column if not exists capacity_evidence_status text not null
    default 'unverified',
  add column if not exists capacity_source_reference text,
  add column if not exists capacity_source_checksum_sha256 text,
  add column if not exists capacity_source_row_number integer,
  add column if not exists capacity_verified_at timestamptz,
  add column if not exists capacity_verified_by uuid
    references auth.users (id) on delete restrict,
  add column if not exists capacity_verification_ticket text,
  add column if not exists availability_evidence_status text not null
    default 'unknown',
  add column if not exists availability_source_reference text,
  add column if not exists availability_source_checksum_sha256 text,
  add column if not exists availability_source_row_number integer,
  add column if not exists availability_checked_at timestamptz,
  add column if not exists availability_expires_at timestamptz,
  add column if not exists availability_verified_by uuid
    references auth.users (id) on delete restrict,
  add column if not exists availability_verification_ticket text,
  add column if not exists updated_at timestamptz not null default now();

alter table core.transport_vehicles
  drop constraint if exists transport_vehicles_mapping_status_check,
  drop constraint if exists transport_vehicles_mapping_governance_check,
  drop constraint if exists transport_vehicles_max_pallets_check,
  drop constraint if exists transport_vehicles_capacity_status_check,
  drop constraint if exists transport_vehicles_capacity_governance_check,
  drop constraint if exists transport_vehicles_availability_status_check,
  drop constraint if exists transport_vehicles_availability_governance_check;

alter table core.transport_vehicles
  add constraint transport_vehicles_mapping_status_check
    check (vehicle_mapping_status in ('unmapped', 'verified')),
  add constraint transport_vehicles_mapping_governance_check
    check (
      (
        vehicle_mapping_status = 'unmapped'
        and canonical_vehicle_id is null
        and vehicle_mapping_source_reference is null
        and vehicle_mapping_source_checksum_sha256 is null
        and vehicle_mapping_source_row_number is null
        and vehicle_mapping_verified_at is null
        and vehicle_mapping_verified_by is null
        and vehicle_mapping_approval_ticket is null
      )
      or
      (
        vehicle_mapping_status = 'verified'
        and canonical_vehicle_id is not null
        and btrim(coalesce(vehicle_mapping_source_reference, '')) <> ''
        and coalesce(vehicle_mapping_source_checksum_sha256, '')
          ~ '^[0-9a-f]{64}$'
        and coalesce(vehicle_mapping_source_row_number, 0) > 0
        and vehicle_mapping_verified_at is not null
        and vehicle_mapping_verified_by is not null
        and btrim(coalesce(vehicle_mapping_approval_ticket, '')) <> ''
      )
    ),
  add constraint transport_vehicles_max_pallets_check
    check (max_pallets is null or max_pallets > 0),
  add constraint transport_vehicles_capacity_status_check
    check (capacity_evidence_status in ('unverified', 'verified')),
  add constraint transport_vehicles_capacity_governance_check
    check (
      (
        capacity_evidence_status = 'unverified'
        and max_pallets is null
        and capacity_source_reference is null
        and capacity_source_checksum_sha256 is null
        and capacity_source_row_number is null
        and capacity_verified_at is null
        and capacity_verified_by is null
        and capacity_verification_ticket is null
      )
      or
      (
        capacity_evidence_status = 'verified'
        and max_weight_kg > 0
        and max_volume_m3 > 0
        and coalesce(max_pallets, 0) > 0
        and btrim(coalesce(capacity_source_reference, '')) <> ''
        and coalesce(capacity_source_checksum_sha256, '')
          ~ '^[0-9a-f]{64}$'
        and coalesce(capacity_source_row_number, 0) > 0
        and capacity_verified_at is not null
        and capacity_verified_by is not null
        and btrim(coalesce(capacity_verification_ticket, '')) <> ''
      )
    ),
  add constraint transport_vehicles_availability_status_check
    check (
      availability_evidence_status in (
        'unknown',
        'available',
        'unavailable'
      )
    ),
  add constraint transport_vehicles_availability_governance_check
    check (
      (
        availability_evidence_status = 'unknown'
        and availability_source_reference is null
        and availability_source_checksum_sha256 is null
        and availability_source_row_number is null
        and availability_checked_at is null
        and availability_expires_at is null
        and availability_verified_by is null
        and availability_verification_ticket is null
      )
      or
      (
        availability_evidence_status in ('available', 'unavailable')
        and btrim(coalesce(availability_source_reference, '')) <> ''
        and coalesce(availability_source_checksum_sha256, '')
          ~ '^[0-9a-f]{64}$'
        and coalesce(availability_source_row_number, 0) > 0
        and availability_checked_at is not null
        and availability_expires_at > availability_checked_at
        and availability_verified_by is not null
        and btrim(coalesce(availability_verification_ticket, '')) <> ''
      )
    );

create unique index if not exists
  transport_vehicles_canonical_vehicle_uidx
  on core.transport_vehicles (canonical_vehicle_id)
  where canonical_vehicle_id is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'core.transport_vehicles'::regclass
      and conname = 'transport_vehicles_mapping_pair_uk'
  ) then
    alter table core.transport_vehicles
      add constraint transport_vehicles_mapping_pair_uk
      unique (vehicle_id, canonical_vehicle_id);
  end if;
end
$$;

create or replace function core.validate_transport_vehicle_evidence()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_canonical core.vehicles%rowtype;
  v_canonical_home_warehouse text;
  v_current_canonical_warehouse text;
begin
  if new.vehicle_mapping_status <> 'verified' then
    if new.capacity_evidence_status = 'verified'
       or new.availability_evidence_status <> 'unknown' then
      raise exception
        'Capacity or availability evidence requires a verified canonical vehicle mapping'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select vehicle.*
  into v_canonical
  from core.vehicles vehicle
  where vehicle.vehicle_id = new.canonical_vehicle_id;

  if not found then
    raise exception 'Mapped canonical vehicle was not found'
      using errcode = '23514';
  end if;

  if new.capacity_evidence_status = 'verified'
     and (
       v_canonical.max_weight_kg is distinct from new.max_weight_kg
       or v_canonical.max_volume_m3 is distinct from new.max_volume_m3
       or v_canonical.max_pallets is distinct from new.max_pallets
     ) then
    raise exception
      'Verified transport capacity must exactly match canonical vehicle capacity'
      using errcode = '23514';
  end if;

  if new.availability_evidence_status <> 'unknown' then
    select location.warehouse_id
    into v_canonical_home_warehouse
    from core.locations location
    where location.location_id = v_canonical.home_location_id
      and location.location_type = 'WAREHOUSE'
      and location.is_active;

    select warehouse.canonical_warehouse_id
    into v_current_canonical_warehouse
    from core.transport_warehouses warehouse
    where warehouse.warehouse_code = new.current_warehouse
      and warehouse.is_active;

    if v_canonical_home_warehouse is null
       or v_current_canonical_warehouse is null
       or v_canonical_home_warehouse
         is distinct from v_current_canonical_warehouse then
      raise exception
        'Vehicle availability warehouse must match the active canonical home warehouse'
        using errcode = '23514';
    end if;
  end if;

  if new.availability_evidence_status = 'available'
     and new.capacity_evidence_status <> 'verified' then
    raise exception
      'Available routing vehicles require verified capacity evidence'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_transport_vehicle_evidence
  on core.transport_vehicles;
create trigger validate_transport_vehicle_evidence
  before insert or update
  on core.transport_vehicles
  for each row
  execute function core.validate_transport_vehicle_evidence();

drop trigger if exists set_transport_vehicles_updated_at
  on core.transport_vehicles;
create trigger set_transport_vehicles_updated_at
  before update
  on core.transport_vehicles
  for each row
  execute function audit.set_updated_at();

create index if not exists transport_vehicles_route_readiness_idx
  on core.transport_vehicles (
    current_warehouse,
    availability_expires_at,
    canonical_vehicle_id
  )
  where is_active
    and vehicle_mapping_status = 'verified'
    and capacity_evidence_status = 'verified'
    and availability_evidence_status = 'available';

-- Keep the service-only vehicle read contract aligned with the evidence
-- columns added above. Expired evidence becomes unknown, never implicitly
-- available or unavailable. The compatibility aliases are intentionally text
-- and nullable because the dashboard treats false as explicitly unavailable.
create or replace view analytics.v_transport_vehicle_status
with (security_invoker = true)
as
select
  vehicle.vehicle_id,
  vehicle.plate,
  vehicle.asset_code,
  vehicle.vehicle_type,
  vehicle.home_warehouse,
  vehicle.current_warehouse,
  vehicle.loan_status,
  vehicle.driver_name,
  vehicle.max_weight_kg,
  vehicle.max_volume_m3,
  vehicle.fuel_rate_km_per_l,
  vehicle.fuel_price_thb_per_l,
  vehicle.color,
  vehicle.color_light,
  vehicle.is_active,
  vehicle.canonical_vehicle_id,
  vehicle.vehicle_mapping_status,
  vehicle.vehicle_mapping_source_reference,
  vehicle.vehicle_mapping_source_checksum_sha256,
  vehicle.vehicle_mapping_source_row_number,
  vehicle.vehicle_mapping_verified_at,
  vehicle.vehicle_mapping_verified_by,
  vehicle.vehicle_mapping_approval_ticket,
  vehicle.max_pallets,
  vehicle.capacity_evidence_status,
  vehicle.capacity_source_reference,
  vehicle.capacity_source_checksum_sha256,
  vehicle.capacity_source_row_number,
  vehicle.capacity_verified_at,
  vehicle.capacity_verified_by,
  vehicle.capacity_verification_ticket,
  vehicle.availability_evidence_status,
  vehicle.availability_source_reference,
  vehicle.availability_source_checksum_sha256,
  vehicle.availability_source_row_number,
  vehicle.availability_checked_at,
  vehicle.availability_expires_at,
  vehicle.availability_verified_by,
  vehicle.availability_verification_ticket,
  vehicle.updated_at,
  case
    when not vehicle.is_active then false
    when vehicle.availability_evidence_status = 'available'
      and vehicle.availability_expires_at > clock_timestamp() then true
    when vehicle.availability_evidence_status = 'unavailable'
      and vehicle.availability_expires_at > clock_timestamp() then false
    else null
  end as is_available,
  case
    when not vehicle.is_active then 'unavailable'
    when vehicle.availability_evidence_status in (
      'available',
      'unavailable'
    ) and vehicle.availability_expires_at > clock_timestamp()
      then vehicle.availability_evidence_status
    else 'unknown'
  end as availability_status,
  vehicle.availability_source_reference as availability_evidence,
  vehicle.availability_evidence_status in ('available', 'unavailable')
    and vehicle.availability_expires_at > clock_timestamp()
    as availability_is_current
from core.transport_vehicles vehicle;

revoke all on analytics.v_transport_vehicle_status
  from public, anon, authenticated;
grant select on analytics.v_transport_vehicle_status to service_role;

-- --------------------------------------------------------------------------
-- Matrix provenance. Existing matrices remain explicitly unverified.
-- --------------------------------------------------------------------------
alter table analytics.route_matrices
  add column if not exists evidence_status text not null
    default 'legacy_unverified',
  add column if not exists engine_name text,
  add column if not exists engine_version text,
  add column if not exists routing_profile text,
  add column if not exists tileset_version text,
  add column if not exists tileset_last_modified_at timestamptz,
  add column if not exists osm_changeset bigint,
  add column if not exists engine_status_response_sha256 text,
  add column if not exists upstream_request_sha256 text,
  add column if not exists upstream_response_sha256 text,
  add column if not exists evidence_captured_at timestamptz;

alter table analytics.route_matrices
  drop constraint if exists route_matrices_evidence_status_check,
  drop constraint if exists route_matrices_evidence_governance_check;

alter table analytics.route_matrices
  add constraint route_matrices_evidence_status_check
    check (evidence_status in ('legacy_unverified', 'verified')),
  add constraint route_matrices_evidence_governance_check
    check (
      evidence_status = 'legacy_unverified'
      or (
        evidence_status = 'verified'
        and matrix_source = 'valhalla'
        and engine_name = 'valhalla'
        and btrim(coalesce(engine_version, '')) <> ''
        and routing_profile = 'truck'
        and coalesce(tileset_version, '') ~
          '^[a-z0-9][a-z0-9._-]{0,127}-sha256-[0-9a-f]{64}$'
        and tileset_last_modified_at is not null
        and coalesce(osm_changeset, -1) >= 0
        and coalesce(engine_status_response_sha256, '')
          ~ '^[0-9a-f]{64}$'
        and coalesce(upstream_request_sha256, '')
          ~ '^[0-9a-f]{64}$'
        and coalesce(upstream_response_sha256, '')
          ~ '^[0-9a-f]{64}$'
        and evidence_captured_at is not null
      )
    );

create index if not exists route_matrices_verified_generated_idx
  on analytics.route_matrices (generated_at desc, route_matrix_id)
  where evidence_status = 'verified' and matrix_source = 'valhalla';

-- A worker is route-compatible only when its recent healthy heartbeat was
-- emitted after validating the controlled Valhalla origin and /status
-- identity. Service version or a generic healthy flag alone is insufficient.
create or replace function ops.has_recent_compatible_route_worker()
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, ops
as $$
  select exists (
    select 1
    from ops.service_heartbeats heartbeat
    where heartbeat.service_name like 'synapse-worker:%'
      and heartbeat.service_version =
        '1.2.0-m13e-route-evidence-attested'
      and heartbeat.status = 'healthy'
      and heartbeat.last_seen_at >
        clock_timestamp() - interval '10 minutes'
      and heartbeat.details ->> 'routing_attestation_version' =
        'valhalla-status-v1'
      and heartbeat.details ->> 'routing_ready' = 'true'
      and heartbeat.details ->> 'routing_engine' = 'valhalla'
      and heartbeat.details ->> 'routing_profile' = 'truck'
      and heartbeat.details ->> 'routing_url_policy' =
        'controlled_non_community_origin'
      and (
        heartbeat.details ->> 'valhalla_url'
          ~ '^https://[^[:space:]@?#]+$'
        or heartbeat.details ->> 'valhalla_url'
          ~ '^http://(localhost|127[.]0[.]0[.]1|valhalla)(:[0-9]+)?(/[^[:space:]?#]*)?$'
      )
      and lower(heartbeat.details ->> 'valhalla_url') !~
        '^https://valhalla[0-9]*[.]openstreetmap[.]de([/:]|$)'
      and heartbeat.details ->> 'tileset_version' ~
        '^[a-z0-9][a-z0-9._-]{0,127}-sha256-[0-9a-f]{64}$'
      and btrim(coalesce(
        heartbeat.details ->> 'engine_version',
        ''
      )) <> ''
      and heartbeat.details ->> 'tileset_last_modified' ~ '^[0-9]+$'
      and heartbeat.details ->> 'osm_changeset' ~ '^[0-9]+$'
      and heartbeat.details ->> 'engine_status_response_sha256'
        ~ '^[0-9a-f]{64}$'
      and btrim(coalesce(
        heartbeat.details ->> 'status_validated_at',
        ''
      )) <> ''
      and case
        when heartbeat.details ->> 'status_validated_epoch'
          ~ '^[0-9]{1,10}$' then
          (heartbeat.details ->> 'status_validated_epoch')::bigint >=
            extract(
              epoch from clock_timestamp() - interval '10 minutes'
            )::bigint
          and (heartbeat.details ->> 'status_validated_epoch')::bigint <=
            extract(epoch from heartbeat.last_seen_at)::bigint
        else false
      end
  )
$$;

revoke all on function ops.has_recent_compatible_route_worker()
  from public, anon, authenticated;
grant execute on function ops.has_recent_compatible_route_worker()
  to service_role;

-- --------------------------------------------------------------------------
-- Governed route-job queue. Legacy route jobs remain readable, but every new
-- job is attributable to one authenticated caller and one request id. A
-- request id can be replayed only by the same caller for the exact same plan.
-- --------------------------------------------------------------------------
alter table ops.route_jobs
  add column if not exists requested_by uuid
    references auth.users (id) on delete restrict,
  add column if not exists request_id text;

alter table ops.route_jobs
  drop constraint if exists route_jobs_request_id_check;

alter table ops.route_jobs
  add constraint route_jobs_request_id_check
    check (
      request_id is null
      or (
        length(request_id) between 1 and 64
        and request_id ~ '^[A-Za-z0-9_-]+$'
      )
    );

update ops.route_jobs route_job
set requested_by = background.initiated_by
from ops.background_jobs background
where background.job_id = route_job.job_id
  and route_job.requested_by is null
  and background.initiated_by is not null;

create unique index if not exists route_jobs_actor_request_uidx
  on ops.route_jobs (requested_by, request_id)
  where requested_by is not null and request_id is not null;

create index if not exists route_jobs_plan_created_idx
  on ops.route_jobs (replenishment_plan_id, created_at desc);

create or replace function core.route_plan_has_complete_routing_inputs(
  p_replenishment_plan_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select
    exists (
      select 1
      from core.replenishment_items item
      where item.replenishment_plan_id = p_replenishment_plan_id
        and item.status = 'locked'
        and item.final_qty > 0
    )
    and not exists (
      select 1
      from core.replenishment_items item
      join core.materials material
        on material.material_id = item.material_id
      left join core.transport_district_geo transport_geo
        on transport_geo.district_id = item.district_id
       and not transport_geo.is_warehouse
      left join core.location_geocodes location_geo
        on location_geo.location_id = 'DIST-' || item.district_id
      left join core.material_packaging physical_packaging
        on physical_packaging.material_id = item.material_id
      left join core.packaging_profiles canonical_packaging
        on canonical_packaging.material_id = item.material_id
      where item.replenishment_plan_id = p_replenishment_plan_id
        and item.final_qty > 0
        and (
          item.status <> 'locked'
          or transport_geo.district_ref is null
          or transport_geo.geocode_status <> 'verified'
          or transport_geo.latitude is null
          or transport_geo.longitude is null
          or btrim(coalesce(transport_geo.source_reference, '')) = ''
          or coalesce(transport_geo.source_checksum_sha256, '')
            !~ '^[0-9a-f]{64}$'
          or coalesce(transport_geo.source_row_number, 0) <= 0
          or transport_geo.verified_at is null
          or location_geo.location_id is null
          or location_geo.verified_at is null
          or btrim(coalesce(location_geo.source_reference, '')) = ''
          or coalesce(location_geo.source_checksum_sha256, '')
            !~ '^[0-9a-f]{64}$'
          or coalesce(location_geo.source_row_number, 0) <= 0
          or location_geo.latitude is distinct from
            transport_geo.latitude
          or location_geo.longitude is distinct from
            transport_geo.longitude
          or location_geo.source_checksum_sha256 is distinct from
            transport_geo.source_checksum_sha256
          or location_geo.source_row_number is distinct from
            transport_geo.source_row_number
          or material.unit is null
          or btrim(material.unit) = ''
          or material.weight_per_unit_kg is null
          or material.weight_per_unit_kg <= 0
          or material.weight_per_unit_kg::text in (
            'Infinity', '-Infinity', 'NaN'
          )
          or physical_packaging.material_id is null
          or physical_packaging.quantity_uom is distinct from
            material.unit
          or physical_packaging.quantity_per_box is null
          or physical_packaging.quantity_per_box <= 0
          or physical_packaging.quantity_per_box::text in (
            'Infinity', '-Infinity', 'NaN'
          )
          or physical_packaging.box_volume_m3 is null
          or physical_packaging.box_volume_m3 <= 0
          or physical_packaging.box_volume_m3::text in (
            'Infinity', '-Infinity', 'NaN'
          )
          or physical_packaging.weight_per_box_kg is null
          or physical_packaging.weight_per_box_kg <= 0
          or physical_packaging.weight_per_box_kg::text in (
            'Infinity', '-Infinity', 'NaN'
          )
          or physical_packaging.boxes_per_pallet is null
          or physical_packaging.boxes_per_pallet <= 0
          or physical_packaging.boxes_per_pallet::text in (
            'Infinity', '-Infinity', 'NaN'
          )
          or physical_packaging.verified_at is null
          or btrim(coalesce(
            physical_packaging.source_reference,
            ''
          )) = ''
          or canonical_packaging.material_id is null
          or canonical_packaging.base_uom is distinct from material.unit
          or canonical_packaging.data_class <> 'actual'
          or canonical_packaging.source_quality <> 'verified'
          or canonical_packaging.verified_at is null
          or btrim(coalesce(
            canonical_packaging.source_reference,
            ''
          )) = ''
          or canonical_packaging.inner_pack_qty is null
          or canonical_packaging.inner_pack_qty <= 0
          or canonical_packaging.inner_pack_qty::text in (
            'Infinity', '-Infinity', 'NaN'
          )
          or canonical_packaging.full_pallet_qty is null
          or canonical_packaging.full_pallet_qty <= 0
          or canonical_packaging.full_pallet_qty::text in (
            'Infinity', '-Infinity', 'NaN'
          )
          or abs(
            physical_packaging.quantity_per_box
            - canonical_packaging.inner_pack_qty
          ) > 0.000000001
          or abs(
            physical_packaging.quantity_per_box
              * physical_packaging.boxes_per_pallet
            - canonical_packaging.full_pallet_qty
          ) > 0.000000001
          or abs(
            physical_packaging.weight_per_box_kg
              / physical_packaging.quantity_per_box
            - material.weight_per_unit_kg
          ) > greatest(
            0.000000001,
            0.000001 * abs(material.weight_per_unit_kg)
          )
          or location_geo.service_minutes < 0
          or (
            location_geo.time_window_start is not null
            and location_geo.time_window_end is not null
            and location_geo.time_window_end <=
              location_geo.time_window_start
          )
        )
    )
$$;

revoke all on function core.route_plan_has_complete_routing_inputs(uuid)
  from public, anon, authenticated;
grant execute on function core.route_plan_has_complete_routing_inputs(uuid)
  to service_role;

create or replace function core.route_plan_is_optimization_eligible(
  p_replenishment_plan_id uuid
)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, core
as $$
  select exists (
    select 1
    from core.replenishment_plans plan
    join core.locations origin
      on origin.location_id = plan.origin_location_id
     and origin.location_type = 'WAREHOUSE'
     and origin.is_active
    join core.warehouses canonical
      on canonical.warehouse_id = origin.warehouse_id
     and canonical.is_active
    join core.transport_warehouses transport_warehouse
      on transport_warehouse.canonical_warehouse_id =
        canonical.warehouse_id
     and transport_warehouse.is_active
    join core.transport_district_geo depot_geo
      on depot_geo.is_warehouse
     and depot_geo.warehouse_code = transport_warehouse.warehouse_code
     and depot_geo.geocode_status = 'verified'
    where plan.replenishment_plan_id = p_replenishment_plan_id
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
      )
      and core.route_plan_has_complete_routing_inputs(
        plan.replenishment_plan_id
      )
      and exists (
        select 1
        from core.transport_vehicles transport_vehicle
        join core.vehicles canonical_vehicle
          on canonical_vehicle.vehicle_id =
            transport_vehicle.canonical_vehicle_id
         and canonical_vehicle.is_active
        join core.locations canonical_home
          on canonical_home.location_id =
            canonical_vehicle.home_location_id
         and canonical_home.location_type = 'WAREHOUSE'
         and canonical_home.is_active
        where transport_vehicle.is_active
          and transport_vehicle.current_warehouse =
            transport_warehouse.warehouse_code
          and transport_vehicle.vehicle_mapping_status = 'verified'
          and transport_vehicle.capacity_evidence_status = 'verified'
          and transport_vehicle.availability_evidence_status = 'available'
          and transport_vehicle.availability_expires_at > clock_timestamp()
          and canonical_home.warehouse_id = canonical.warehouse_id
      )
  )
$$;

revoke all on function core.route_plan_is_optimization_eligible(uuid)
  from public, anon, authenticated;
grant execute on function core.route_plan_is_optimization_eligible(uuid)
  to service_role;

create or replace function core.queue_route_job(
  p_replenishment_plan_id uuid,
  p_forecast_run_id uuid,
  p_matrix_source text,
  p_request_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, ops, public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_role public.app_role;
  v_existing ops.route_jobs%rowtype;
  v_active ops.route_jobs%rowtype;
  v_job_id uuid;
  v_route_job_id uuid;
  v_writes_enabled boolean;
begin
  select profile.role
  into v_role
  from public.user_profiles profile
  where profile.user_id = v_actor_id
    and profile.is_active;

  if v_actor_id is null
     or v_role is null
     or v_role not in ('admin', 'planner') then
    raise exception 'Only planner or admin may queue routes'
      using errcode = '42501';
  end if;

  select controls.operational_writes_enabled
  into v_writes_enabled
  from ops.environment_controls controls
  where controls.singleton;

  if not coalesce(v_writes_enabled, false) then
    raise exception
      'Operational writes are locked until Production cutover gates pass'
      using errcode = '55000';
  end if;

  if p_matrix_source is distinct from 'valhalla' then
    raise exception 'Production route jobs require Valhalla truck matrices'
      using errcode = '23514';
  end if;

  if btrim(coalesce(p_request_id, '')) = ''
     or length(p_request_id) > 64
     or p_request_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'A valid request id is required for route-job idempotency'
      using errcode = '23514';
  end if;

  if p_replenishment_plan_id is null then
    raise exception 'A replenishment plan id is required for route jobs'
      using errcode = '23514';
  end if;

  -- Serialize every actor/plan queue attempt. This closes the race between
  -- two distinct request ids without exposing another actor's active job.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'm13e-active-route:' || v_actor_id::text || ':' ||
        p_replenishment_plan_id::text,
      0
    )
  );

  select route_job.*
  into v_existing
  from ops.route_jobs route_job
  where route_job.requested_by = v_actor_id
    and route_job.request_id = p_request_id
  for update;

  if found
     and (
       v_existing.replenishment_plan_id
         is distinct from p_replenishment_plan_id
       or v_existing.forecast_run_id
         is distinct from p_forecast_run_id
       or v_existing.matrix_source is distinct from 'valhalla'
     ) then
    raise exception
      'Request id is already bound to a different route-job request'
      using errcode = '23505';
  end if;

  perform 1
  from core.replenishment_plans plan
  where plan.replenishment_plan_id = p_replenishment_plan_id
  for share;

  if not found
     or not core.route_plan_is_optimization_eligible(
       p_replenishment_plan_id
     ) then
    raise exception
      'Route job requires an eligible exact locked latest plan with verified geocode, packaging and current fleet evidence'
      using errcode = '23514';
  end if;

  if not ops.has_recent_compatible_route_worker() then
    raise exception
      'No recent compatible route worker has validated controlled Valhalla status evidence'
      using errcode = '57P03';
  end if;

  if v_existing.route_job_id is not null then
    return v_existing.route_job_id;
  end if;

  select route_job.*
  into v_active
  from ops.route_jobs route_job
  join ops.background_jobs background
    using (job_id)
  where route_job.requested_by = v_actor_id
    and route_job.replenishment_plan_id = p_replenishment_plan_id
    and background.status in ('queued', 'running')
  order by route_job.created_at, route_job.route_job_id
  for update of route_job
  limit 1;

  if found then
    return v_active.route_job_id;
  end if;

  insert into ops.background_jobs (
    job_type,
    payload,
    initiated_by
  )
  values (
    'route',
    '{}'::jsonb,
    v_actor_id
  )
  returning job_id into v_job_id;

  insert into ops.route_jobs (
    job_id,
    replenishment_plan_id,
    forecast_run_id,
    algorithm_version,
    matrix_source,
    requested_by,
    request_id
  )
  values (
    v_job_id,
    p_replenishment_plan_id,
    p_forecast_run_id,
    'ortools-m13e-road-evidence-v1',
    'valhalla',
    v_actor_id,
    p_request_id
  )
  returning route_job_id into v_route_job_id;

  update ops.background_jobs
  set payload = jsonb_build_object('route_job_id', v_route_job_id),
      updated_at = now()
  where job_id = v_job_id;

  return v_route_job_id;
exception
  when unique_violation then
    select route_job.*
    into v_existing
    from ops.route_jobs route_job
    where route_job.requested_by = v_actor_id
      and route_job.request_id = p_request_id;

    if found
       and v_existing.replenishment_plan_id
         is not distinct from p_replenishment_plan_id
       and v_existing.forecast_run_id
         is not distinct from p_forecast_run_id
       and v_existing.matrix_source = 'valhalla' then
      return v_existing.route_job_id;
    end if;
    raise;
end;
$$;

create or replace function core.queue_route_job(
  p_replenishment_plan_id uuid,
  p_forecast_run_id uuid default null,
  p_matrix_source text default 'valhalla'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
begin
  return core.queue_route_job(
    p_replenishment_plan_id,
    p_forecast_run_id,
    p_matrix_source,
    'route-api-' || gen_random_uuid()::text
  );
end;
$$;

revoke all on function core.queue_route_job(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function core.queue_route_job(uuid, uuid, text, text)
  to service_role;

revoke all on function core.queue_route_job(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function core.queue_route_job(uuid, uuid, text)
  to service_role;

-- --------------------------------------------------------------------------
-- Immutable road geometry and engine evidence, one record per planned vehicle.
-- --------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'core.route_plan_vehicles'::regclass
      and conname = 'route_plan_vehicles_identity_pair_uk'
  ) then
    alter table core.route_plan_vehicles
      add constraint route_plan_vehicles_identity_pair_uk
      unique (route_plan_vehicle_id, vehicle_id);
  end if;
end
$$;

create table if not exists core.route_plan_vehicle_road_evidence (
  route_plan_vehicle_id uuid primary key,
  route_matrix_id uuid not null
    references analytics.route_matrices (route_matrix_id) on delete restrict,
  transport_vehicle_id text not null,
  canonical_vehicle_id text not null,
  vehicle_mapping_source_checksum_sha256 text not null
    check (
      vehicle_mapping_source_checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
  capacity_source_checksum_sha256 text not null
    check (capacity_source_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  availability_source_checksum_sha256 text not null
    check (availability_source_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  availability_checked_at timestamptz not null,
  availability_expires_at timestamptz not null,
  geometry_geojson jsonb not null
    check (core.is_valid_wgs84_linestring(geometry_geojson)),
  road_distance_m bigint not null check (road_distance_m > 0),
  road_duration_s bigint not null check (road_duration_s > 0),
  has_toll boolean,
  engine_name text not null check (engine_name = 'valhalla'),
  engine_version text not null check (btrim(engine_version) <> ''),
  routing_profile text not null check (routing_profile = 'truck'),
  tileset_version text not null check (
    tileset_version ~
      '^[a-z0-9][a-z0-9._-]{0,127}-sha256-[0-9a-f]{64}$'
  ),
  tileset_last_modified_at timestamptz not null,
  osm_changeset bigint not null check (osm_changeset >= 0),
  engine_status_response_sha256 text not null
    check (engine_status_response_sha256 ~ '^[0-9a-f]{64}$'),
  route_request_sha256 text not null
    check (route_request_sha256 ~ '^[0-9a-f]{64}$'),
  route_response_sha256 text not null
    check (route_response_sha256 ~ '^[0-9a-f]{64}$'),
  ordered_waypoint_ids text[] not null,
  ordered_waypoint_count integer not null
    check (ordered_waypoint_count >= 3),
  evidence_status text not null default 'verified'
    check (evidence_status = 'verified'),
  captured_at timestamptz not null default clock_timestamp(),
  evidence_verified_at timestamptz not null default clock_timestamp(),
  evidence_validator_version text not null
    check (btrim(evidence_validator_version) <> ''),
  created_at timestamptz not null default clock_timestamp(),
  constraint route_plan_vehicle_road_evidence_plan_vehicle_fk
    foreign key (route_plan_vehicle_id, canonical_vehicle_id)
    references core.route_plan_vehicles (
      route_plan_vehicle_id,
      vehicle_id
    )
    on delete restrict,
  constraint route_plan_vehicle_road_evidence_mapping_fk
    foreign key (transport_vehicle_id, canonical_vehicle_id)
    references core.transport_vehicles (
      vehicle_id,
      canonical_vehicle_id
    )
    on delete restrict,
  constraint route_plan_vehicle_road_evidence_time_check
    check (
      availability_checked_at <= captured_at
      and captured_at < availability_expires_at
      and captured_at <= evidence_verified_at
    ),
  constraint route_plan_vehicle_road_evidence_waypoint_check
    check (
      cardinality(ordered_waypoint_ids) = ordered_waypoint_count
      and ordered_waypoint_ids[1] =
        ordered_waypoint_ids[ordered_waypoint_count]
      and array_position(ordered_waypoint_ids, null) is null
    )
);

create index if not exists route_vehicle_road_evidence_engine_idx
  on core.route_plan_vehicle_road_evidence (
    engine_name,
    engine_version,
    tileset_version,
    captured_at desc
  );

create index if not exists route_vehicle_road_evidence_matrix_idx
  on core.route_plan_vehicle_road_evidence (
    route_matrix_id,
    route_plan_vehicle_id
  );

create or replace function core.reject_road_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception
    'Route road evidence is append-only and immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists route_road_evidence_append_only
  on core.route_plan_vehicle_road_evidence;
create trigger route_road_evidence_append_only
  before update or delete
  on core.route_plan_vehicle_road_evidence
  for each row
  execute function core.reject_road_evidence_mutation();

alter table core.route_plan_vehicle_road_evidence
  enable row level security;

revoke all on core.route_plan_vehicle_road_evidence
  from public, anon, authenticated, service_role;
grant select, insert on core.route_plan_vehicle_road_evidence
  to service_role;

-- --------------------------------------------------------------------------
-- Review is fail-closed. Rejection remains available for any draft plan, while
-- approval requires exact positive locked demand, current fleet evidence, a
-- verified Valhalla matrix, and road evidence for every planned vehicle.
-- --------------------------------------------------------------------------
create or replace function core.review_route_plan(
  p_route_plan_id uuid,
  p_decision text,
  p_reason text default null
)
returns core.route_plans
language plpgsql
security definer
set search_path = pg_catalog, core, analytics, ops, public
as $$
declare
  v_role public.app_role;
  v_plan core.route_plans%rowtype;
  v_replenishment_plan_id uuid;
  v_matrix_source text;
  v_matrix_evidence_status text;
  v_matrix_location_ids text[];
  v_matrix_engine_name text;
  v_matrix_engine_version text;
  v_matrix_routing_profile text;
  v_matrix_tileset_version text;
  v_matrix_tileset_last_modified_at timestamptz;
  v_matrix_osm_changeset bigint;
  v_matrix_status_response_sha256 text;
  v_origin_location_id text;
  v_routed_item_count bigint;
  v_distinct_routed_item_count bigint;
  v_vehicle_count bigint;
  v_stop_count bigint;
begin
  select profile.role
  into v_role
  from public.user_profiles profile
  where profile.user_id = auth.uid()
    and profile.is_active;

  if v_role is null or v_role not in ('admin', 'planner') then
    raise exception 'Only planner or admin may review route plans';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;
  if p_decision = 'rejected'
     and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Rejection reason is required';
  end if;

  select plan.*
  into v_plan
  from core.route_plans plan
  where plan.route_plan_id = p_route_plan_id
    and plan.status = 'draft'
  for update;

  if not found then
    raise exception 'Draft route plan not found';
  end if;

  if p_decision = 'rejected' then
    update core.route_plans
    set status = 'rejected',
        approved_by = null,
        approved_at = null,
        rejection_reason = p_reason,
        updated_at = now()
    where route_plan_id = p_route_plan_id
    returning * into v_plan;
    return v_plan;
  end if;

  select
    job.replenishment_plan_id,
    matrix.matrix_source,
    matrix.evidence_status,
    matrix.location_ids,
    matrix.engine_name,
    matrix.engine_version,
    matrix.routing_profile,
    matrix.tileset_version,
    matrix.tileset_last_modified_at,
    matrix.osm_changeset,
    matrix.engine_status_response_sha256
  into
    v_replenishment_plan_id,
    v_matrix_source,
    v_matrix_evidence_status,
    v_matrix_location_ids,
    v_matrix_engine_name,
    v_matrix_engine_version,
    v_matrix_routing_profile,
    v_matrix_tileset_version,
    v_matrix_tileset_last_modified_at,
    v_matrix_osm_changeset,
    v_matrix_status_response_sha256
  from ops.route_jobs job
  join analytics.route_matrices matrix
    on matrix.route_matrix_id = v_plan.route_matrix_id
  where job.route_job_id = v_plan.route_job_id;

  if v_replenishment_plan_id is null
     or v_matrix_source is distinct from 'valhalla'
     or v_matrix_evidence_status is distinct from 'verified' then
    raise exception
      'Route approval requires a verified Valhalla matrix'
      using errcode = '23514';
  end if;

  if v_plan.solver_status <> 'succeeded'
     or v_plan.unserved_stop_count <> 0
     or v_plan.served_stop_count <= 0 then
    raise exception
      'Route approval requires a succeeded solver result with no unserved stops'
      using errcode = '23514';
  end if;

  select plan.origin_location_id
  into v_origin_location_id
  from core.replenishment_plans plan
  join core.locations origin
    on origin.location_id = plan.origin_location_id
   and origin.location_type = 'WAREHOUSE'
   and origin.is_active
  join core.warehouses warehouse
    on warehouse.warehouse_id = origin.warehouse_id
   and warehouse.is_active
  where plan.replenishment_plan_id = v_replenishment_plan_id
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
    raise exception
      'Route approval requires the exact locked latest replenishment plan'
      using errcode = '23514';
  end if;

  if cardinality(v_matrix_location_ids)
       <> v_plan.served_stop_count + 1
     or v_matrix_location_ids[1]
       is distinct from v_origin_location_id
     or (
       select count(distinct location_id)
       from unnest(v_matrix_location_ids) as matrix_location(location_id)
     ) <> cardinality(v_matrix_location_ids)
     or exists (
       select 1
       from core.route_stops stop
       join core.route_plan_vehicles vehicle
         using (route_plan_vehicle_id)
       where vehicle.route_plan_id = p_route_plan_id
         and not (
           ('DIST-' || stop.district_id) =
           any(v_matrix_location_ids)
         )
     ) then
    raise exception
      'Valhalla matrix locations must exactly match the locked plan origin and served stops'
      using errcode = '23514';
  end if;

  select count(*)
  into v_vehicle_count
  from core.route_plan_vehicles vehicle
  where vehicle.route_plan_id = p_route_plan_id;

  select count(*)
  into v_stop_count
  from core.route_stops stop
  join core.route_plan_vehicles vehicle
    using (route_plan_vehicle_id)
  where vehicle.route_plan_id = p_route_plan_id;

  if v_vehicle_count = 0
     or v_stop_count <> v_plan.served_stop_count then
    raise exception
      'Route vehicle and served-stop counts are incomplete'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from core.route_plan_vehicles vehicle
    left join core.route_plan_vehicle_road_evidence evidence
      using (route_plan_vehicle_id)
    left join core.transport_vehicles transport
      on transport.vehicle_id = evidence.transport_vehicle_id
    where vehicle.route_plan_id = p_route_plan_id
      and (
        evidence.route_plan_vehicle_id is null
        or evidence.evidence_status <> 'verified'
        or evidence.route_matrix_id is distinct from v_plan.route_matrix_id
        or evidence.engine_name is distinct from v_matrix_engine_name
        or evidence.engine_version is distinct from v_matrix_engine_version
        or evidence.routing_profile is distinct from v_matrix_routing_profile
        or evidence.tileset_version is distinct from v_matrix_tileset_version
        or evidence.tileset_last_modified_at
          is distinct from v_matrix_tileset_last_modified_at
        or evidence.osm_changeset is distinct from v_matrix_osm_changeset
        or evidence.engine_status_response_sha256
          is distinct from v_matrix_status_response_sha256
        or evidence.canonical_vehicle_id
          is distinct from vehicle.vehicle_id
        or evidence.ordered_waypoint_count <> (
          select count(*) + 2
          from core.route_stops stop
          where stop.route_plan_vehicle_id =
            vehicle.route_plan_vehicle_id
        )
        or evidence.ordered_waypoint_ids is distinct from (
          select
            array[v_origin_location_id]
            || coalesce(
              array_agg(
                'DIST-' || stop.district_id
                order by stop.stop_sequence
              ),
              array[]::text[]
            )
            || array[v_origin_location_id]
          from core.route_stops stop
          where stop.route_plan_vehicle_id =
            vehicle.route_plan_vehicle_id
        )
        or vehicle.planned_distance_m
          is distinct from evidence.road_distance_m::numeric
        or vehicle.planned_duration_s
          is distinct from evidence.road_duration_s::numeric
        or evidence.availability_expires_at <= clock_timestamp()
        or transport.vehicle_mapping_status <> 'verified'
        or transport.capacity_evidence_status <> 'verified'
        or transport.availability_evidence_status <> 'available'
        or transport.canonical_vehicle_id
          is distinct from evidence.canonical_vehicle_id
        or transport.availability_expires_at <= clock_timestamp()
        or transport.vehicle_mapping_source_checksum_sha256
          is distinct from
            evidence.vehicle_mapping_source_checksum_sha256
        or transport.capacity_source_checksum_sha256
          is distinct from evidence.capacity_source_checksum_sha256
        or transport.availability_source_checksum_sha256
          is distinct from evidence.availability_source_checksum_sha256
        or transport.availability_checked_at
          is distinct from evidence.availability_checked_at
        or transport.availability_expires_at
          is distinct from evidence.availability_expires_at
      )
  ) then
    raise exception
      'Every route vehicle requires complete current road/fleet evidence matching its verified route matrix identity'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from core.route_stops stop
    join core.route_plan_vehicles vehicle
      using (route_plan_vehicle_id)
    where vehicle.route_plan_id = p_route_plan_id
      and stop.coordinate_evidence_status <> 'verified_source'
  ) then
    raise exception
      'Every route stop requires verified coordinate provenance'
      using errcode = '23514';
  end if;

  select
    count(*),
    count(distinct routed.replenishment_item_id)
  into
    v_routed_item_count,
    v_distinct_routed_item_count
  from core.route_stops stop
  join core.route_plan_vehicles vehicle
    using (route_plan_vehicle_id)
  cross join lateral unnest(stop.replenishment_item_ids)
    as routed(replenishment_item_id)
  where vehicle.route_plan_id = p_route_plan_id;

  if v_routed_item_count = 0
     or v_routed_item_count <> v_distinct_routed_item_count
     or exists (
       select 1
       from core.route_stops stop
       join core.route_plan_vehicles vehicle
         using (route_plan_vehicle_id)
       cross join lateral unnest(stop.replenishment_item_ids)
         as routed(replenishment_item_id)
       left join core.replenishment_items item
         on item.replenishment_item_id =
           routed.replenishment_item_id
       where vehicle.route_plan_id = p_route_plan_id
         and (
           item.replenishment_item_id is null
           or item.replenishment_plan_id
             is distinct from v_replenishment_plan_id
           or item.status <> 'locked'
           or coalesce(item.final_qty, 0) <= 0
           or item.district_id is distinct from stop.district_id
         )
     )
     or exists (
       select 1
       from core.replenishment_items item
       where item.replenishment_plan_id =
         v_replenishment_plan_id
         and item.status = 'locked'
         and item.final_qty > 0
         and not exists (
           select 1
           from core.route_stops stop
           join core.route_plan_vehicles vehicle
             using (route_plan_vehicle_id)
           cross join lateral unnest(
             stop.replenishment_item_ids
           ) as routed(replenishment_item_id)
           where vehicle.route_plan_id = p_route_plan_id
             and routed.replenishment_item_id =
               item.replenishment_item_id
         )
     ) then
    raise exception
      'Route stops must exactly cover positive locked demand from the route job plan'
      using errcode = '23514';
  end if;

  if v_plan.total_distance_m is distinct from (
       select coalesce(sum(evidence.road_distance_m), 0)::numeric
       from core.route_plan_vehicles vehicle
       join core.route_plan_vehicle_road_evidence evidence
         using (route_plan_vehicle_id)
       where vehicle.route_plan_id = p_route_plan_id
     )
     or v_plan.total_duration_s is distinct from (
       select coalesce(sum(evidence.road_duration_s), 0)::numeric
       from core.route_plan_vehicles vehicle
       join core.route_plan_vehicle_road_evidence evidence
         using (route_plan_vehicle_id)
       where vehicle.route_plan_id = p_route_plan_id
     ) then
    raise exception
      'Route plan totals must equal immutable road evidence'
      using errcode = '23514';
  end if;

  update core.route_plans
  set status = 'approved',
      approved_by = auth.uid(),
      approved_at = now(),
      rejection_reason = null,
      updated_at = now()
  where route_plan_id = p_route_plan_id
    and status = 'draft'
  returning * into v_plan;

  if not found then
    raise exception 'Draft route plan not found';
  end if;
  return v_plan;
end;
$$;

revoke all on function core.review_route_plan(uuid, text, text)
  from public, anon, authenticated;
grant execute on function core.review_route_plan(uuid, text, text)
  to service_role;

-- --------------------------------------------------------------------------
-- Same-origin optimization-job API. The M13d dispatcher is retained as the
-- delegate for every other transport path, including the fail-closed trip
-- creation path. Route-plan-to-trip activation is deliberately not added.
-- --------------------------------------------------------------------------
do $$
begin
  if to_regprocedure(
    'public.m13_transport_dispatch_pre_m13e(text,text,jsonb,jsonb,text)'
  ) is null then
    alter function public.m13_transport_dispatch(
      text, text, jsonb, jsonb, text
    ) rename to m13_transport_dispatch_pre_m13e;
  end if;
end
$$;

revoke all on function public.m13_transport_dispatch_pre_m13e(
  text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.m13_transport_dispatch_pre_m13e(
  text, text, jsonb, jsonb, text
) to service_role;

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
  v_method text := upper(coalesce(p_method, ''));
  v_count integer;
  v_writes_enabled boolean;
  v_route_job_id uuid;
  v_existing_route_job_id uuid;
  v_plan_id uuid;
  v_forecast_run_id uuid;
  v_result jsonb;
  v_body jsonb;
  v_queue_data_ready boolean;
  v_worker_heartbeat_ready boolean;
  v_worker_ready boolean;
  v_worker_status text;
  v_eligible_plan_ids uuid[] := array[]::uuid[];
begin
  if v_user_id is not null then
    select profile.role::text
    into v_role
    from public.user_profiles profile
    where profile.user_id = v_user_id
      and profile.is_active;
  end if;

  if v_method = 'GET' and p_path = '/v1/transport/readiness' then
    v_result := public.m13_transport_dispatch_pre_m13e(
      p_method,
      p_path,
      p_query,
      p_body,
      p_request_id
    );

    if coalesce((v_result ->> 'status')::integer, 500) <> 200 then
      return v_result;
    end if;

    v_body := coalesce(v_result -> 'body', '{}'::jsonb);

    select coalesce(
      array_agg(
        plan.replenishment_plan_id
        order by plan.replenishment_plan_id
      ) filter (
        where core.route_plan_is_optimization_eligible(
          plan.replenishment_plan_id
        )
      ),
      array[]::uuid[]
    )
    into v_eligible_plan_ids
    from core.replenishment_plans plan;

    v_queue_data_ready := cardinality(v_eligible_plan_ids) > 0;
    v_worker_heartbeat_ready :=
      ops.has_recent_compatible_route_worker();

    v_writes_enabled := coalesce(
      (v_body ->> 'operational_writes_enabled')::boolean,
      false
    );
    v_worker_ready :=
      v_writes_enabled
      and coalesce((v_body ->> 'route_ready')::boolean, false)
      and coalesce(v_queue_data_ready, false)
      and coalesce(v_worker_heartbeat_ready, false);

    v_worker_status := case
      when not v_writes_enabled then
        'blocked_operational_writes_locked'
      when not coalesce((v_body ->> 'route_ready')::boolean, false) then
        coalesce(
          v_body ->> 'route_readiness_status',
          'blocked_route_master_data_not_ready'
        )
      when not coalesce(v_queue_data_ready, false) then
        'blocked_no_exact_locked_plan_with_verified_depot_and_fleet'
      when not coalesce(v_worker_heartbeat_ready, false) then
        'blocked_no_recent_optimization_worker_heartbeat'
      else 'ready_valhalla_exact_locked_plan_queue'
    end;

    v_body := v_body
      || jsonb_build_object(
        'optimization_worker_ready', v_worker_ready,
        'optimization_worker_status', v_worker_status,
        'optimization_job_path',
          '/v1/transport/optimization-jobs',
        'optimization_required_plan_status', 'locked',
        'optimization_matrix_source', 'valhalla',
        'trip_persistence_ready', false,
        'trip_persistence_status',
          'blocked_route_plan_to_trip_activation_not_configured'
      );

    if v_role in ('admin', 'planner') then
      v_body := v_body || jsonb_build_object(
        'optimization_eligible_plan_ids',
          case
            when v_worker_ready then to_jsonb(v_eligible_plan_ids)
            else '[]'::jsonb
          end,
        'optimization_plan_eligibility_scope',
          'exact_locked_plan_current_evidence_and_worker'
      );
    end if;

    return jsonb_set(v_result, '{body}', v_body, true);
  end if;

  if not (
    (
      v_method = 'POST'
      and p_path = '/v1/transport/optimization-jobs'
    )
    or (
      v_method = 'GET'
      and p_path ~
        '^/v1/transport/optimization-jobs/[0-9a-fA-F-]{36}$'
    )
  ) then
    return public.m13_transport_dispatch_pre_m13e(
      p_method,
      p_path,
      p_query,
      p_body,
      p_request_id
    );
  end if;

  if v_user_id is null then
    return public.m09_error(
      401,
      'unauthorized',
      'Missing or invalid bearer token',
      p_request_id
    );
  end if;

  if v_role is null or v_role not in ('admin', 'planner') then
    return public.m09_error(
      403,
      'forbidden',
      'Only admin or planner may access route optimization jobs',
      p_request_id
    );
  end if;

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

  if v_method = 'POST' then
    select controls.operational_writes_enabled
    into v_writes_enabled
    from ops.environment_controls controls
    where controls.singleton;

    if not coalesce(v_writes_enabled, false) then
      return public.m09_error(
        423,
        'production_not_ready',
        'Operational writes are locked until Production cutover gates pass',
        p_request_id
      );
    end if;

    if not (p_body ? 'replenishment_plan_id')
       or jsonb_typeof(p_body -> 'replenishment_plan_id') <> 'string' then
      return public.m09_error(
        422,
        'validation_error',
        'replenishment_plan_id is required',
        p_request_id
      );
    end if;

    if p_body ? 'matrix_source'
       and p_body ->> 'matrix_source' <> 'valhalla' then
      return public.m09_error(
        422,
        'validation_error',
        'Production route jobs accept only matrix_source=valhalla',
        p_request_id
      );
    end if;

    begin
      v_plan_id := (p_body ->> 'replenishment_plan_id')::uuid;
      v_forecast_run_id := nullif(
        p_body ->> 'forecast_run_id',
        ''
      )::uuid;
    exception
      when invalid_text_representation then
        return public.m09_error(
          422,
          'validation_error',
          'Route job identifiers must be valid UUIDs',
          p_request_id
        );
    end;

    select route_job.route_job_id
    into v_existing_route_job_id
    from ops.route_jobs route_job
    where route_job.requested_by = v_user_id
      and route_job.request_id = p_request_id;

    begin
      v_route_job_id := core.queue_route_job(
        v_plan_id,
        v_forecast_run_id,
        'valhalla',
        p_request_id
      );
    exception
      when check_violation then
        return public.m09_error(
          409,
          'route_job_not_dispatchable',
          'Route job failed governed locked-plan, geocode or fleet preflight',
          p_request_id
        );
      when unique_violation then
        return public.m09_error(
          409,
          'idempotency_conflict',
          'Request id is already bound to a different route-job request',
          p_request_id
        );
      when object_not_in_prerequisite_state then
        return public.m09_error(
          423,
          'production_not_ready',
          'Operational writes are locked until Production cutover gates pass',
          p_request_id
        );
      when cannot_connect_now then
        return public.m09_error(
          503,
          'optimization_worker_unavailable',
          'No recent compatible worker has validated controlled Valhalla routing evidence',
          p_request_id
        );
    end;

    select jsonb_build_object(
      'route_job_id', route_job.route_job_id,
      'job_id', background.job_id,
      'status', background.status,
      'algorithm_version', route_job.algorithm_version,
      'matrix_source', route_job.matrix_source,
      'replenishment_plan_id', route_job.replenishment_plan_id,
      'idempotent_replay',
        v_existing_route_job_id is not null
        or route_job.request_id is distinct from p_request_id
    )
    into v_body
    from ops.route_jobs route_job
    join ops.background_jobs background
      using (job_id)
    where route_job.route_job_id = v_route_job_id
      and route_job.requested_by = v_user_id;

    return public.m09_result(202, v_body);
  end if;

  v_route_job_id := substring(
    p_path
    from '^/v1/transport/optimization-jobs/([0-9a-fA-F-]{36})$'
  )::uuid;

  select jsonb_build_object(
    'route_job_id', route_job.route_job_id,
    'job_id', background.job_id,
    'replenishment_plan_id', route_job.replenishment_plan_id,
    'forecast_run_id', route_job.forecast_run_id,
    'algorithm_version', route_job.algorithm_version,
    'matrix_source', route_job.matrix_source,
    'status', background.status,
    'attempt_count', background.attempt_count,
    'max_attempts', background.max_attempts,
    'result', background.result,
    'error', case
      when background.status = 'failed' then
        jsonb_build_object(
          'code', 'route_optimization_failed',
          'message',
            'Route optimization failed; inspect audited worker logs',
          'retryable',
            background.attempt_count < background.max_attempts
        )
      else null
    end,
    'route_plan_id', route_plan.route_plan_id,
    'route_plan_status', route_plan.status,
    'created_at', route_job.created_at,
    'started_at', background.started_at,
    'finished_at', background.finished_at
  )
  into v_body
  from ops.route_jobs route_job
  join ops.background_jobs background
    using (job_id)
  left join core.route_plans route_plan
    using (route_job_id)
  where route_job.route_job_id = v_route_job_id
    and (
      route_job.requested_by = v_user_id
      or v_role = 'admin'
    );

  if v_body is null then
    return public.m09_error(
      404,
      'not_found',
      'Route optimization job not found',
      p_request_id
    );
  end if;

  return public.m09_result(200, v_body);
end;
$$;

revoke all on function public.m13_transport_dispatch(
  text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.m13_transport_dispatch(
  text, text, jsonb, jsonb, text
) to authenticated;

-- --------------------------------------------------------------------------
-- Truthful GeoJSON: one real road LineString per evidenced vehicle plus its
-- ordered stop points. No straight-line interpolation is manufactured.
-- --------------------------------------------------------------------------
create or replace view analytics.v_route_plan_geojson
with (security_invoker = true)
as
select
  plan.route_plan_id,
  jsonb_build_object(
    'type', 'FeatureCollection',
    'feature_scope', 'verified_road_lines_and_ordered_stops',
    'road_geometry_available',
      exists (
        select 1
        from core.route_plan_vehicles vehicle
        where vehicle.route_plan_id = plan.route_plan_id
      )
      and not exists (
        select 1
        from core.route_plan_vehicles vehicle
        left join core.route_plan_vehicle_road_evidence evidence
          using (route_plan_vehicle_id)
        where vehicle.route_plan_id = plan.route_plan_id
          and evidence.route_plan_vehicle_id is null
      ),
    'route_plan_status', plan.status,
    'matrix_source', matrix.matrix_source,
    'matrix_evidence_status', matrix.evidence_status,
    'features', coalesce(features.payload, '[]'::jsonb)
  ) as geojson
from core.route_plans plan
left join analytics.route_matrices matrix
  using (route_matrix_id)
left join lateral (
  select jsonb_agg(
    feature_rows.feature
    order by
      feature_rows.route_sequence,
      feature_rows.feature_order,
      feature_rows.stop_sequence
  ) as payload
  from (
    select
      vehicle.route_sequence,
      0 as feature_order,
      0 as stop_sequence,
      jsonb_build_object(
        'type', 'Feature',
        'geometry', evidence.geometry_geojson,
        'properties', jsonb_build_object(
          'feature_kind', 'verified_road_route',
          'transport_vehicle_id',
            evidence.transport_vehicle_id,
          'vehicle_id', evidence.canonical_vehicle_id,
          'route_sequence', vehicle.route_sequence,
          'road_distance_m', evidence.road_distance_m,
          'road_duration_s', evidence.road_duration_s,
          'has_toll', evidence.has_toll,
          'engine_name', evidence.engine_name,
          'engine_version', evidence.engine_version,
          'routing_profile', evidence.routing_profile,
          'tileset_version', evidence.tileset_version,
          'tileset_last_modified_at',
            evidence.tileset_last_modified_at,
          'osm_changeset', evidence.osm_changeset,
          'engine_status_response_sha256',
            evidence.engine_status_response_sha256,
          'route_request_sha256',
            evidence.route_request_sha256,
          'route_response_sha256',
            evidence.route_response_sha256,
          'ordered_waypoint_count',
            evidence.ordered_waypoint_count,
          'ordered_waypoint_ids',
            evidence.ordered_waypoint_ids,
          'evidence_status', evidence.evidence_status,
          'captured_at', evidence.captured_at,
          'evidence_verified_at',
            evidence.evidence_verified_at
        )
      ) as feature
    from core.route_plan_vehicles vehicle
    join core.route_plan_vehicle_road_evidence evidence
      using (route_plan_vehicle_id)
    where vehicle.route_plan_id = plan.route_plan_id

    union all

    select
      vehicle.route_sequence,
      1 as feature_order,
      stop.stop_sequence,
      jsonb_build_object(
        'type', 'Feature',
        'geometry', jsonb_build_object(
          'type', 'Point',
          'coordinates', jsonb_build_array(
            stop.longitude,
            stop.latitude
          )
        ),
        'properties', jsonb_build_object(
          'feature_kind', 'verified_ordered_stop',
          'district_id', stop.district_id,
          'vehicle_id', vehicle.vehicle_id,
          'route_sequence', vehicle.route_sequence,
          'stop_sequence', stop.stop_sequence,
          'eta', stop.eta,
          'coordinate_evidence_status',
            stop.coordinate_evidence_status,
          'coordinate_source_reference',
            stop.coordinate_source_reference,
          'coordinate_source_checksum_sha256',
            stop.coordinate_source_checksum_sha256,
          'coordinate_source_row_number',
            stop.coordinate_source_row_number
        )
      ) as feature
    from core.route_plan_vehicles vehicle
    join core.route_stops stop
      using (route_plan_vehicle_id)
    where vehicle.route_plan_id = plan.route_plan_id
  ) feature_rows
) features on true;

grant select on analytics.v_route_plan_geojson to service_role;

revoke all on function core.is_valid_wgs84_linestring(jsonb)
  from public, anon, authenticated;
grant execute on function core.is_valid_wgs84_linestring(jsonb)
  to service_role;

revoke all on function core.validate_transport_vehicle_evidence()
  from public, anon, authenticated;
revoke all on function core.reject_road_evidence_mutation()
  from public, anon, authenticated;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607250005',
  'M13e',
  'Owner-approved canonical fleet mapping, verified capacity and expiring availability evidence, immutable Valhalla matrix/road evidence, truthful GeoJSON and fail-closed route review.',
  'supabase/migrations/202607250005_m13e_route_evidence.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
