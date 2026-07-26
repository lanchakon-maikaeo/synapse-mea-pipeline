-- SYNAPSE M13e emergency rollback.
--
-- Road evidence and owner attestations are retained. The rollback is
-- intentionally non-destructive and disables route approval and new route
-- evidence until a reviewed forward migration is applied.

begin;

-- Fleet evidence is intentionally retained by this non-destructive rollback,
-- so retain the truthful service-only read contract as well.
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

revoke all on function core.review_route_plan(uuid, text, text)
  from public, anon, authenticated, service_role;

revoke insert on core.route_plan_vehicle_road_evidence
  from service_role;

revoke execute on function core.queue_route_job(uuid, uuid, text)
  from service_role;

revoke execute on function core.queue_route_job(uuid, uuid, text, text)
  from service_role;

revoke execute on function core.route_plan_has_complete_routing_inputs(uuid)
  from service_role;

revoke execute on function core.route_plan_is_optimization_eligible(uuid)
  from service_role;

revoke execute on function ops.has_recent_compatible_route_worker()
  from service_role;

-- Restore the M13d dispatcher behavior. Its optimization-job branch is the
-- original fail-closed 410 response, so the security-definer wrapper cannot
-- bypass the queue-function revocation above.
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
  v_result jsonb;
  v_body jsonb;
begin
  v_result := public.m13_transport_dispatch_pre_m13e(
    p_method,
    p_path,
    p_query,
    p_body,
    p_request_id
  );

  if upper(coalesce(p_method, '')) = 'GET'
     and p_path = '/v1/transport/readiness'
     and coalesce((v_result ->> 'status')::integer, 500) = 200 then
    v_body := coalesce(v_result -> 'body', '{}'::jsonb)
      || jsonb_build_object(
        'optimization_worker_ready', false,
        'optimization_worker_status',
          'blocked_m13e_fail_closed_rollback',
        'trip_persistence_ready', false,
        'trip_persistence_status',
          'blocked_route_plan_to_trip_activation_not_configured'
      );
    return jsonb_set(v_result, '{body}', v_body, true);
  end if;

  return v_result;
end;
$$;

revoke all on function public.m13_transport_dispatch(
  text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.m13_transport_dispatch(
  text, text, jsonb, jsonb, text
) to authenticated;

comment on function core.review_route_plan(uuid, text, text) is
  'Disabled by the M13e fail-closed rollback; immutable road and fleet evidence is retained.';

comment on table core.route_plan_vehicle_road_evidence is
  'Retained immutable M13e road evidence; new inserts disabled by the fail-closed rollback.';

commit;
