-- SYNAPSE M13d: immutable planning inputs and governed route evidence.
--
-- This additive migration closes the remaining historical-cutoff, failure
-- audit, legacy-trip, geocode-state, and route-coordinate provenance gaps.

begin;

-- ============================================================
-- Geocode candidate contract
-- ============================================================
alter table core.transport_district_geo
  add column if not exists candidate_provider text,
  add column if not exists candidate_external_id text,
  add column if not exists candidate_confidence numeric,
  add column if not exists candidate_payload jsonb,
  add column if not exists candidate_observed_at timestamptz,
  add column if not exists candidate_submitted_by uuid
    references auth.users (id) on delete set null;

alter table core.transport_district_geo
  drop constraint if exists transport_district_geo_governance_check;
alter table core.transport_district_geo
  drop constraint if exists transport_district_geo_status_check;

alter table core.transport_district_geo
  alter column geocode_status set default 'candidate';

update core.transport_district_geo
set geocode_status = 'candidate',
    updated_at = now()
where geocode_status = 'unverified';

alter table core.transport_district_geo
  add constraint transport_district_geo_status_check
  check (geocode_status in ('candidate', 'verified', 'quarantined')),
  add constraint transport_district_geo_candidate_confidence_check
  check (
    candidate_confidence is null
    or candidate_confidence between 0 and 1
  ),
  add constraint transport_district_geo_candidate_payload_check
  check (
    candidate_payload is null
    or jsonb_typeof(candidate_payload) = 'object'
  ),
  add constraint transport_district_geo_governance_check
  check (
    (
      geocode_status = 'candidate'
      and verified_at is null
      and quarantined_at is null
      and quarantine_reason is null
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

-- The legacy matrix is useful only as a reference catalogue. Endpoint
-- readiness is exposed separately and never makes its radial metrics road
-- evidence.
create or replace view analytics.v_transport_route_matrix
with (security_invoker = true)
as
select
  route.warehouse_code,
  warehouse.canonical_warehouse_id,
  route.district_ref,
  district_geo.name_th as district_name_th,
  district_geo.latitude,
  district_geo.longitude,
  district_geo.map_x,
  district_geo.map_y,
  route.distance_km,
  route.toll_thb,
  route.travel_minutes,
  route.unload_fixed_min,
  route.unload_per_pallet_min,
  district_geo.geocode_status,
  district_geo.coordinate_source,
  district_geo.source_reference as geocode_source_reference,
  district_geo.source_checksum_sha256 as geocode_source_checksum_sha256,
  district_geo.source_row_number as geocode_source_row_number,
  district_geo.accuracy_meters,
  district_geo.verified_at,
  'legacy_illustrative_not_road_evidence'::text as
    matrix_evidence_status,
  false as road_evidence_usable,
  coalesce(warehouse_geo.geocode_status, 'missing') as
    warehouse_geocode_status,
  false as route_eligible,
  coalesce((
    district_geo.geocode_status = 'verified'
    and warehouse.is_active
    and warehouse.canonical_warehouse_id is not null
    and canonical_warehouse.is_active
    and warehouse_geo.geocode_status = 'verified'
    and exists (
      select 1
      from core.locations origin
      where origin.warehouse_id = canonical_warehouse.warehouse_id
        and origin.location_type = 'WAREHOUSE'
        and origin.is_active
    )
  ), false) as endpoint_geocodes_eligible
from core.transport_route_legs route
join core.transport_warehouses warehouse
  on warehouse.warehouse_code = route.warehouse_code
join core.transport_district_geo district_geo
  on district_geo.district_ref = route.district_ref
left join core.warehouses canonical_warehouse
  on canonical_warehouse.warehouse_id =
    warehouse.canonical_warehouse_id
left join core.transport_district_geo warehouse_geo
  on warehouse_geo.is_warehouse
 and warehouse_geo.warehouse_code = route.warehouse_code;

-- ============================================================
-- Legacy-trip evidence quarantine
-- ============================================================
alter table ops.transport_trips
  add column if not exists road_evidence_status text not null
    default 'quarantined_legacy',
  add column if not exists road_evidence_source text,
  add column if not exists road_evidence_checksum_sha256 text,
  add column if not exists road_evidence_change_ticket text,
  add column if not exists road_evidence_verified_at timestamptz,
  add column if not exists road_evidence_verified_by uuid
    references auth.users (id) on delete restrict;

alter table ops.transport_trips
  drop constraint if exists transport_trips_road_evidence_status_check;
alter table ops.transport_trips
  add constraint transport_trips_road_evidence_status_check
  check (road_evidence_status in ('quarantined_legacy', 'verified')),
  add constraint transport_trips_road_evidence_governance_check
  check (
    (
      road_evidence_status = 'quarantined_legacy'
      and road_evidence_verified_at is null
    )
    or (
      road_evidence_status = 'verified'
      and btrim(coalesce(road_evidence_source, '')) <> ''
      and road_evidence_checksum_sha256 ~ '^[0-9a-f]{64}$'
      and btrim(coalesce(road_evidence_change_ticket, '')) <> ''
      and road_evidence_verified_at is not null
      and road_evidence_verified_by is not null
    )
  );

create index if not exists transport_trips_evidence_status_idx
  on ops.transport_trips (road_evidence_status, status, created_at desc);

create or replace function ops.enforce_transport_trip_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if old.road_evidence_status <> 'verified'
     and new.status <> 'cancelled' then
    raise exception
      'Trip % has no verified road evidence and may only be cancelled',
      old.trip_id
      using errcode = '23514';
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

create or replace view analytics.v_transport_trip_summary
with (security_invoker = true)
as
select
  trip.trip_id,
  trip.trip_code,
  trip.batch_code,
  trip.vehicle_id,
  trip.driver_name,
  trip.warehouse_code,
  trip.route_district_refs,
  trip.total_distance_km,
  trip.total_toll_thb,
  trip.total_travel_minutes,
  trip.fuel_cost_estimate_thb,
  trip.fuel_cost_actual_thb,
  trip.trip_date,
  trip.depart_time,
  trip.return_time,
  trip.status,
  trip.notes,
  trip.created_at,
  trip.replenishment_plan_id,
  trip.request_id,
  trip.road_evidence_status,
  trip.road_evidence_source,
  trip.road_evidence_checksum_sha256,
  trip.road_evidence_change_ticket,
  trip.road_evidence_verified_at,
  trip.road_evidence_verified_by
from ops.transport_trips trip;

do $$
begin
  if to_regprocedure(
    'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'
  ) is null then
    alter function public.m13_transport_dispatch(
      text, text, jsonb, jsonb, text
    ) rename to m13_transport_dispatch_pre_m13d;
  end if;
end
$$;

revoke all on function public.m13_transport_dispatch_pre_m13d(
  text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.m13_transport_dispatch_pre_m13d(
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
  v_trip_id uuid;
  v_requested_status text;
  v_evidence_status text;
  v_role text;
begin
  if upper(coalesce(p_method, '')) = 'POST'
     and p_path ~
       '^/v1/transport/trips/[0-9a-fA-F-]{36}/status$' then
    select profile.role::text
    into v_role
    from public.user_profiles profile
    where profile.user_id = auth.uid()
      and profile.is_active;

    v_requested_status := btrim(coalesce(p_body ->> 'status', ''));
    if v_role in ('admin', 'planner')
       and v_requested_status in ('planned', 'dispatched', 'completed') then
      begin
        v_trip_id := substring(
          p_path
          from '^/v1/transport/trips/([0-9a-fA-F-]{36})/status$'
        )::uuid;
      exception
        when invalid_text_representation then
          return public.m13_transport_dispatch_pre_m13d(
            p_method, p_path, p_query, p_body, p_request_id
          );
      end;

      select trip.road_evidence_status
      into v_evidence_status
      from ops.transport_trips trip
      where trip.trip_id = v_trip_id;

      if found and v_evidence_status <> 'verified' then
        return public.m09_error(
          409,
          'road_evidence_not_verified',
          'Legacy trip has no verified road evidence and may only be cancelled',
          p_request_id,
          jsonb_build_object(
            'trip_id', v_trip_id,
            'road_evidence_status', v_evidence_status,
            'allowed_status', 'cancelled'
          )
        );
      end if;
    end if;
  end if;

  return public.m13_transport_dispatch_pre_m13d(
    p_method, p_path, p_query, p_body, p_request_id
  );
end;
$$;

revoke all on function public.m13_transport_dispatch(
  text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.m13_transport_dispatch(
  text, text, jsonb, jsonb, text
) to authenticated;

-- ============================================================
-- Route-stop precision and coordinate provenance
-- ============================================================
alter table core.location_geocodes
  add column if not exists source_checksum_sha256 text,
  add column if not exists source_row_number integer,
  add column if not exists verified_by uuid
    references auth.users (id) on delete set null,
  add column if not exists verification_ticket text;

update core.location_geocodes
set source_checksum_sha256 = substring(
      source_reference
      from 'sha256=([0-9a-f]{64})'
    ),
    source_row_number = substring(
      source_reference
      from '#row=([0-9]+)'
    )::integer
where source_checksum_sha256 is null
  and source_reference ~
    '#row=[0-9]+;sha256=[0-9a-f]{64}$';

alter table core.location_geocodes
  drop constraint if exists location_geocodes_source_checksum_check;
alter table core.location_geocodes
  add constraint location_geocodes_source_checksum_check
  check (
    source_checksum_sha256 is null
    or source_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint location_geocodes_source_row_number_check
  check (source_row_number is null or source_row_number > 0),
  add constraint location_geocodes_verification_ticket_check
  check (
    verification_ticket is null
    or btrim(verification_ticket) <> ''
  );

-- PostgreSQL does not allow a referenced column's type to change while a
-- view depends on it. Recreate the point-feature view after promoting the
-- route-stop coordinate precision, preserving security-invoker semantics.
drop view if exists analytics.v_route_plan_geojson;

alter table core.route_stops
  alter column latitude type numeric(11, 8)
    using latitude::numeric(11, 8),
  alter column longitude type numeric(11, 8)
    using longitude::numeric(11, 8),
  add column if not exists coordinate_evidence_status text not null
    default 'legacy_unverified',
  add column if not exists coordinate_source_reference text,
  add column if not exists coordinate_source_checksum_sha256 text,
  add column if not exists coordinate_source_row_number integer,
  add column if not exists coordinate_verified_at timestamptz,
  add column if not exists coordinate_verified_by uuid
    references auth.users (id) on delete restrict,
  add column if not exists coordinate_verification_ticket text;

update core.route_stops stop
set coordinate_evidence_status = 'verified_source',
    coordinate_source_reference = geocode.source_reference,
    coordinate_source_checksum_sha256 =
      geocode.source_checksum_sha256,
    coordinate_source_row_number = geocode.source_row_number,
    coordinate_verified_at = geocode.verified_at,
    coordinate_verified_by = geocode.verified_by,
    coordinate_verification_ticket = geocode.verification_ticket
from core.location_geocodes geocode
where geocode.location_id = 'DIST-' || stop.district_id
  and geocode.latitude = stop.latitude
  and geocode.longitude = stop.longitude
  and geocode.verified_at is not null
  and geocode.source_checksum_sha256 ~ '^[0-9a-f]{64}$';

alter table core.route_stops
  drop constraint if exists route_stops_latitude_check;
alter table core.route_stops
  drop constraint if exists route_stops_longitude_check;
alter table core.route_stops
  drop constraint if exists route_stops_coordinate_evidence_status_check;
alter table core.route_stops
  drop constraint if exists route_stops_coordinate_evidence_governance_check;
alter table core.route_stops
  add constraint route_stops_latitude_check
    check (latitude between -90 and 90),
  add constraint route_stops_longitude_check
    check (longitude between -180 and 180),
  add constraint route_stops_coordinate_evidence_status_check
    check (
      coordinate_evidence_status in (
        'legacy_unverified',
        'verified_source'
      )
    ),
  add constraint route_stops_coordinate_evidence_governance_check
    check (
      coordinate_evidence_status = 'legacy_unverified'
      or (
        coordinate_evidence_status = 'verified_source'
        and btrim(coalesce(coordinate_source_reference, '')) <> ''
        and coordinate_source_checksum_sha256 ~ '^[0-9a-f]{64}$'
        and coordinate_source_row_number > 0
        and coordinate_verified_at is not null
      )
    );

create or replace function core.attach_route_stop_coordinate_evidence()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_geocode core.location_geocodes%rowtype;
begin
  select geocode.*
  into v_geocode
  from core.location_geocodes geocode
  where geocode.location_id = 'DIST-' || new.district_id
    and geocode.latitude = new.latitude
    and geocode.longitude = new.longitude
    and geocode.verified_at is not null
    and geocode.source_checksum_sha256 ~ '^[0-9a-f]{64}$';

  if found then
    new.coordinate_evidence_status := 'verified_source';
    new.coordinate_source_reference := v_geocode.source_reference;
    new.coordinate_source_checksum_sha256 :=
      v_geocode.source_checksum_sha256;
    new.coordinate_source_row_number := v_geocode.source_row_number;
    new.coordinate_verified_at := v_geocode.verified_at;
    new.coordinate_verified_by := v_geocode.verified_by;
    new.coordinate_verification_ticket :=
      v_geocode.verification_ticket;
  else
    new.coordinate_evidence_status := 'legacy_unverified';
    new.coordinate_source_reference := null;
    new.coordinate_source_checksum_sha256 := null;
    new.coordinate_source_row_number := null;
    new.coordinate_verified_at := null;
    new.coordinate_verified_by := null;
    new.coordinate_verification_ticket := null;
  end if;

  return new;
end;
$$;

drop trigger if exists attach_route_stop_coordinate_evidence
  on core.route_stops;
create trigger attach_route_stop_coordinate_evidence
  before insert or update of district_id, latitude, longitude
  on core.route_stops
  for each row
  execute function core.attach_route_stop_coordinate_evidence();

create or replace view analytics.v_route_plan_geojson
with (security_invoker = true)
as
select
  plan.route_plan_id,
  jsonb_build_object(
    'type', 'FeatureCollection',
    'feature_scope', 'ordered_stops_only',
    'road_geometry_available', false,
    'features',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'geometry',
          jsonb_build_object(
            'type', 'Point',
            'coordinates',
            jsonb_build_array(stop.longitude, stop.latitude)
          ),
          'properties',
          jsonb_build_object(
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
        )
        order by vehicle.route_sequence, stop.stop_sequence
      ) filter (where stop.route_stop_id is not null),
      '[]'::jsonb
    )
  ) as geojson
from core.route_plans plan
left join core.route_plan_vehicles vehicle
  using (route_plan_id)
left join core.route_stops stop
  using (route_plan_vehicle_id)
group by plan.route_plan_id;

grant select on analytics.v_route_plan_geojson to service_role;

-- Packaging quantities need an explicit UOM before a production worker can
-- compare them with replenishment quantities. Existing rows remain unknown.
alter table core.material_packaging
  add column if not exists quantity_uom text;

alter table core.material_packaging
  drop constraint if exists material_packaging_quantity_uom_check;
alter table core.material_packaging
  add constraint material_packaging_quantity_uom_check
  check (quantity_uom is null or btrim(quantity_uom) <> '');

create or replace function core.enforce_material_packaging_uom()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_material_uom text;
begin
  if new.quantity_uom is null then
    return new;
  end if;

  select material.unit
  into v_material_uom
  from core.materials material
  where material.material_id = new.material_id;

  if btrim(new.quantity_uom) <> btrim(coalesce(v_material_uom, '')) then
    raise exception
      'Packaging UOM % does not match material % UOM %',
      new.quantity_uom,
      new.material_id,
      v_material_uom
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_material_packaging_uom
  on core.material_packaging;
create trigger enforce_material_packaging_uom
  before insert or update of material_id, quantity_uom
  on core.material_packaging
  for each row
  execute function core.enforce_material_packaging_uom();

-- ============================================================
-- Immutable completed observations and run-input snapshots
-- ============================================================
create or replace function core.protect_completed_usage_observation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_is_completed boolean;
  v_owner_attestation_exists boolean;
begin
  if old.data_class <> 'actual' or old.source_batch_id is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select exists (
    select 1
    from raw.import_batches batch
    join ops.actual_workbook_imports import
      on import.usage_checksum = batch.source_checksum
     and import.status = 'succeeded'
    where batch.batch_id = old.source_batch_id
  )
  into v_is_completed;

  if not v_is_completed then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'Completed usage observation % is immutable',
      old.usage_rate_id
      using errcode = '23514';
  end if;

  select exists (
    select 1
    from raw.import_batches batch
    join ops.actual_workbook_imports import
      on import.usage_checksum = batch.source_checksum
     and import.status = 'succeeded'
    join ops.production_completion_attestations attestation
      on attestation.actual_workbook_import_id =
        import.actual_workbook_import_id
    where batch.batch_id = old.source_batch_id
  )
  into v_owner_attestation_exists;

  if old.source_quality = 'source_missing_assumed_zero'
     and new.source_quality = 'owner_attested_zero'
     and v_owner_attestation_exists
     and (
       new.material_id,
       new.district_id,
       new.as_of_date,
       new.cmp_monthly,
       new.avg_ly,
       new.avg_12m,
       new.avg_6m,
       new.avg_4m,
       new.source_batch_id,
       new.data_class
     ) is not distinct from (
       old.material_id,
       old.district_id,
       old.as_of_date,
       old.cmp_monthly,
       old.avg_ly,
       old.avg_12m,
       old.avg_6m,
       old.avg_4m,
       old.source_batch_id,
       old.data_class
     ) then
    return new;
  end if;

  raise exception
    'Completed usage observation % is immutable',
    old.usage_rate_id
    using errcode = '23514';
end;
$$;

drop trigger if exists protect_completed_usage_observation
  on core.usage_rates;
create trigger protect_completed_usage_observation
  before update or delete on core.usage_rates
  for each row
  execute function core.protect_completed_usage_observation();

create or replace function core.protect_completed_stock_observation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_is_completed boolean;
  v_owner_attestation_exists boolean;
begin
  if old.data_class <> 'actual' or old.source_batch_id is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select exists (
    select 1
    from raw.import_batches batch
    join ops.actual_workbook_imports import
      on import.stock_checksum = batch.source_checksum
     and import.status = 'succeeded'
    where batch.batch_id = old.source_batch_id
  )
  into v_is_completed;

  if not v_is_completed then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'Completed stock observation % is immutable',
      old.snapshot_id
      using errcode = '23514';
  end if;

  select exists (
    select 1
    from raw.import_batches batch
    join ops.actual_workbook_imports import
      on import.stock_checksum = batch.source_checksum
     and import.status = 'succeeded'
    join ops.production_completion_attestations attestation
      on attestation.actual_workbook_import_id =
        import.actual_workbook_import_id
    where batch.batch_id = old.source_batch_id
  )
  into v_owner_attestation_exists;

  if old.source_quality = 'source_missing_assumed_zero'
     and new.source_quality = 'owner_attested_zero'
     and v_owner_attestation_exists
     and (
       new.material_id,
       new.location_id,
       new.quantity_on_hand,
       new.snapshot_at,
       new.source_batch_id,
       new.data_class
     ) is not distinct from (
       old.material_id,
       old.location_id,
       old.quantity_on_hand,
       old.snapshot_at,
       old.source_batch_id,
       old.data_class
     ) then
    return new;
  end if;

  raise exception
    'Completed stock observation % is immutable',
    old.snapshot_id
    using errcode = '23514';
end;
$$;

drop trigger if exists protect_completed_stock_observation
  on core.stock_snapshots;
create trigger protect_completed_stock_observation
  before update or delete on core.stock_snapshots
  for each row
  execute function core.protect_completed_stock_observation();

create table if not exists ops.replenishment_run_inputs (
  replenishment_run_input_id uuid primary key default gen_random_uuid(),
  replenishment_run_id uuid not null
    references ops.replenishment_runs (replenishment_run_id)
    on delete restrict,
  replenishment_plan_id uuid not null
    references core.replenishment_plans (replenishment_plan_id)
    on delete restrict,
  replenishment_item_id uuid not null unique
    references core.replenishment_items (replenishment_item_id)
    on delete restrict,
  snapshot_cutoff_at timestamptz,
  material_id text not null,
  district_id text not null,
  source_stock_snapshot_id uuid,
  source_usage_rate_id uuid,
  input_payload jsonb not null
    check (jsonb_typeof(input_payload) = 'object'),
  input_sha256 text not null
    check (input_sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null default now()
);

create index if not exists replenishment_run_inputs_run_idx
  on ops.replenishment_run_inputs (
    replenishment_run_id, district_id, material_id
  );

with inputs as (
  select
    plan.replenishment_run_id,
    item.replenishment_plan_id,
    item.replenishment_item_id,
    run.snapshot_cutoff_at,
    item.material_id,
    item.district_id,
    item.source_stock_snapshot_id,
    item.source_usage_rate_id,
    jsonb_build_object(
      'material_id', item.material_id,
      'district_id', item.district_id,
      'source_stock_snapshot_id', item.source_stock_snapshot_id,
      'source_usage_rate_id', item.source_usage_rate_id,
      'current_stock_qty', item.current_stock_qty,
      'cmp_monthly', item.cmp_monthly,
      'months_available', item.months_available,
      'min_fill_qty', item.min_fill_qty,
      'max_fill_qty', item.max_fill_qty,
      'suggested_qty', item.suggested_qty,
      'source_stock_missing', item.source_stock_missing,
      'priority_score', item.priority_score,
      'priority_band', item.priority_band,
      'input_data_class', item.input_data_class,
      'snapshot_cutoff_at', run.snapshot_cutoff_at
    ) as input_payload
  from core.replenishment_items item
  join core.replenishment_plans plan
    on plan.replenishment_plan_id = item.replenishment_plan_id
  join ops.replenishment_runs run
    on run.replenishment_run_id = plan.replenishment_run_id
)
insert into ops.replenishment_run_inputs (
  replenishment_run_id,
  replenishment_plan_id,
  replenishment_item_id,
  snapshot_cutoff_at,
  material_id,
  district_id,
  source_stock_snapshot_id,
  source_usage_rate_id,
  input_payload,
  input_sha256
)
select
  input.replenishment_run_id,
  input.replenishment_plan_id,
  input.replenishment_item_id,
  input.snapshot_cutoff_at,
  input.material_id,
  input.district_id,
  input.source_stock_snapshot_id,
  input.source_usage_rate_id,
  input.input_payload,
  encode(
    extensions.digest(
      convert_to(input.input_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
from inputs input
on conflict (replenishment_item_id) do nothing;

create or replace function ops.capture_replenishment_run_input()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_run_id uuid;
  v_cutoff_at timestamptz;
  v_payload jsonb;
begin
  select
    plan.replenishment_run_id,
    run.snapshot_cutoff_at
  into
    v_run_id,
    v_cutoff_at
  from core.replenishment_plans plan
  join ops.replenishment_runs run
    on run.replenishment_run_id = plan.replenishment_run_id
  where plan.replenishment_plan_id = new.replenishment_plan_id;

  v_payload := jsonb_build_object(
    'material_id', new.material_id,
    'district_id', new.district_id,
    'source_stock_snapshot_id', new.source_stock_snapshot_id,
    'source_usage_rate_id', new.source_usage_rate_id,
    'current_stock_qty', new.current_stock_qty,
    'cmp_monthly', new.cmp_monthly,
    'months_available', new.months_available,
    'min_fill_qty', new.min_fill_qty,
    'max_fill_qty', new.max_fill_qty,
    'suggested_qty', new.suggested_qty,
    'source_stock_missing', new.source_stock_missing,
    'priority_score', new.priority_score,
    'priority_band', new.priority_band,
    'input_data_class', new.input_data_class,
    'snapshot_cutoff_at', v_cutoff_at
  );

  insert into ops.replenishment_run_inputs (
    replenishment_run_id,
    replenishment_plan_id,
    replenishment_item_id,
    snapshot_cutoff_at,
    material_id,
    district_id,
    source_stock_snapshot_id,
    source_usage_rate_id,
    input_payload,
    input_sha256
  )
  values (
    v_run_id,
    new.replenishment_plan_id,
    new.replenishment_item_id,
    v_cutoff_at,
    new.material_id,
    new.district_id,
    new.source_stock_snapshot_id,
    new.source_usage_rate_id,
    v_payload,
    encode(
      extensions.digest(
        convert_to(v_payload::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  );

  return new;
end;
$$;

drop trigger if exists capture_replenishment_run_input
  on core.replenishment_items;
create trigger capture_replenishment_run_input
  after insert on core.replenishment_items
  for each row
  execute function ops.capture_replenishment_run_input();

create or replace function core.protect_replenishment_item_input()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
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

drop trigger if exists protect_replenishment_item_input
  on core.replenishment_items;
create trigger protect_replenishment_item_input
  before update on core.replenishment_items
  for each row
  execute function core.protect_replenishment_item_input();

alter table ops.replenishment_run_inputs enable row level security;
revoke all on ops.replenishment_run_inputs
  from public, anon, authenticated;
grant all on ops.replenishment_run_inputs to service_role;

drop trigger if exists replenishment_run_inputs_append_only
  on ops.replenishment_run_inputs;
create trigger replenishment_run_inputs_append_only
  before update or delete on ops.replenishment_run_inputs
  for each row
  execute function audit.reject_append_only_mutation();

-- ============================================================
-- Durable failure-attempt outbox
-- ============================================================
create table if not exists ops.replenishment_run_attempts (
  replenishment_run_attempt_id uuid primary key default gen_random_uuid(),
  actor_id uuid not null
    references auth.users (id) on delete restrict,
  request_id text not null
    check (request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  request_payload_hash text not null
    check (request_payload_hash ~ '^[0-9a-f]{64}$'),
  requested_cutoff_at timestamptz,
  attempt_status text not null
    check (attempt_status in ('succeeded', 'failed')),
  replenishment_run_id uuid
    references ops.replenishment_runs (replenishment_run_id)
    on delete restrict,
  error_sqlstate text,
  error_message text,
  result_snapshot jsonb not null
    check (jsonb_typeof(result_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  unique (actor_id, request_id),
  check (
    (
      attempt_status = 'succeeded'
      and replenishment_run_id is not null
      and error_sqlstate is null
      and error_message is null
    )
    or (
      attempt_status = 'failed'
      and replenishment_run_id is null
      and btrim(coalesce(error_sqlstate, '')) <> ''
      and btrim(coalesce(error_message, '')) <> ''
    )
  )
);

create index if not exists replenishment_run_attempts_status_idx
  on ops.replenishment_run_attempts (
    attempt_status, created_at desc
  );

alter table ops.replenishment_run_attempts enable row level security;
revoke all on ops.replenishment_run_attempts
  from public, anon, authenticated;
grant all on ops.replenishment_run_attempts to service_role;

drop trigger if exists replenishment_run_attempts_append_only
  on ops.replenishment_run_attempts;
create trigger replenishment_run_attempts_append_only
  before update or delete on ops.replenishment_run_attempts
  for each row
  execute function audit.reject_append_only_mutation();

create or replace function public.m13_create_replenishment_run(
  p_snapshot_cutoff_at timestamptz,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_writes_enabled boolean;
  v_request_payload jsonb;
  v_request_hash text;
  v_attempt_id uuid := gen_random_uuid();
  v_run_id uuid;
  v_result jsonb;
  v_existing ops.replenishment_run_attempts%rowtype;
  v_error_message text;
  v_error_sqlstate text;
  v_count integer;
begin
  if v_user_id is null then
    return public.m09_error(
      401,
      'unauthorized',
      'Missing or invalid bearer token',
      p_request_id
    );
  end if;

  select profile.role::text
  into v_role
  from public.user_profiles profile
  where profile.user_id = v_user_id
    and profile.is_active;

  if v_role not in ('admin', 'planner') then
    return public.m09_error(
      403,
      'forbidden',
      'Only admin or planner may create replenishment runs',
      p_request_id
    );
  end if;

  if p_request_id is null
     or p_request_id = 'unknown'
     or p_request_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    return public.m09_error(
      422,
      'validation_error',
      'A valid request id is required',
      p_request_id
    );
  end if;

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

  v_request_payload := jsonb_build_object(
    'snapshot_cutoff_at', p_snapshot_cutoff_at
  );
  v_request_hash := encode(
    extensions.digest(
      convert_to(v_request_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'replenishment-run-request:'
        || v_user_id::text || ':' || p_request_id,
      0
    )
  );

  select attempt.*
  into v_existing
  from ops.replenishment_run_attempts attempt
  where attempt.actor_id = v_user_id
    and attempt.request_id = p_request_id;

  if found then
    if v_existing.request_payload_hash is distinct from v_request_hash then
      return public.m09_error(
        409,
        'idempotency_conflict',
        'Request id was already used with another cutoff',
        p_request_id
      );
    end if;
    return v_existing.result_snapshot;
  end if;

  begin
    v_run_id := core.create_replenishment_run(
      p_snapshot_cutoff_at
    );
  exception
    when others then
      get stacked diagnostics
        v_error_message = message_text,
        v_error_sqlstate = returned_sqlstate;

      v_result := public.m09_error(
        409,
        'replenishment_run_failed',
        'Replenishment run failed; the durable attempt record contains the diagnostic',
        p_request_id,
        jsonb_build_object(
          'replenishment_run_attempt_id', v_attempt_id,
          'sqlstate', v_error_sqlstate
        )
      );

      insert into ops.replenishment_run_attempts (
        replenishment_run_attempt_id,
        actor_id,
        request_id,
        request_payload_hash,
        requested_cutoff_at,
        attempt_status,
        error_sqlstate,
        error_message,
        result_snapshot
      )
      values (
        v_attempt_id,
        v_user_id,
        p_request_id,
        v_request_hash,
        p_snapshot_cutoff_at,
        'failed',
        v_error_sqlstate,
        left(v_error_message, 2000),
        v_result
      );

      return v_result;
  end;

  v_result := public.m09_result(
    201,
    jsonb_build_object('replenishment_run_id', v_run_id)
  );

  insert into ops.replenishment_run_attempts (
    replenishment_run_attempt_id,
    actor_id,
    request_id,
    request_payload_hash,
    requested_cutoff_at,
    attempt_status,
    replenishment_run_id,
    result_snapshot
  )
  values (
    v_attempt_id,
    v_user_id,
    p_request_id,
    v_request_hash,
    p_snapshot_cutoff_at,
    'succeeded',
    v_run_id,
    v_result
  );

  return v_result;
end;
$$;

revoke all on function public.m13_create_replenishment_run(
  timestamptz, text
) from public, anon, authenticated;
grant execute on function public.m13_create_replenishment_run(
  timestamptz, text
) to service_role;

-- Direct invocation cannot return an error and retain its in-transaction audit.
-- Force external callers through the durable wrapper.
revoke all on function core.create_replenishment_run(timestamptz)
  from public, anon, authenticated, service_role;

do $$
begin
  if to_regprocedure(
    'public.m09_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'
  ) is null then
    alter function public.m09_dispatch(
      text, text, jsonb, jsonb, text
    ) rename to m09_dispatch_pre_m13d;
  end if;
end
$$;

revoke all on function public.m09_dispatch_pre_m13d(
  text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.m09_dispatch_pre_m13d(
  text, text, jsonb, jsonb, text
) to service_role;

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
set search_path = pg_catalog
as $$
begin
  if upper(coalesce(p_method, '')) = 'POST'
     and p_path = '/v1/replenishment/runs' then
    return public.m13_create_replenishment_run(
      nullif(p_body ->> 'snapshot_cutoff_at', '')::timestamptz,
      p_request_id
    );
  end if;

  return public.m09_dispatch_pre_m13d(
    p_method, p_path, p_query, p_body, p_request_id
  );
exception
  when invalid_datetime_format
    or datetime_field_overflow then
    return public.m09_error(
      422,
      'validation_error',
      'snapshot_cutoff_at is invalid',
      p_request_id
    );
end;
$$;

revoke all on function public.m09_dispatch(
  text, text, jsonb, jsonb, text
) from public, anon;
grant execute on function public.m09_dispatch(
  text, text, jsonb, jsonb, text
) to authenticated, service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607250004',
  'M13d',
  'Immutable completed observations and replenishment inputs, durable run-attempt audit, legacy-trip evidence quarantine, candidate geocode state, and route-stop coordinate provenance.',
  'supabase/migrations/202607250004_m13d_operational_integrity.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
