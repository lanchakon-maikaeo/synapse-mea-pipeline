\set ON_ERROR_STOP on

-- M22: goods-first weekly dispatch — demand sizing, plan save / confirm, role scoping.
begin;

create temporary table m22_checks (check_name text primary key, passed boolean not null);
create temporary table m22_state (
  demand jsonb, picker_demand jsonb, district_demand jsonb, draft jsonb, confirmed jsonb, reconfirmed jsonb,
  bad_mode jsonb, district_plans jsonb, planner_plans jsonb, picker_save jsonb, config jsonb, demand_after jsonb
);
insert into m22_state default values;
grant select, insert, update on m22_checks, m22_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('22000000-0000-4000-8000-000000000001', '{"display_name":"M22 Planner"}'),
  ('22000000-0000-4000-8000-000000000002', '{"display_name":"M22 District"}'),
  ('22000000-0000-4000-8000-000000000003', '{"display_name":"M22 Picker"}');
update public.user_profiles set role = 'planner', district_id = null where user_id = '22000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'district', district_id = '5509' where user_id = '22000000-0000-4000-8000-000000000002';
update public.user_profiles set role = 'picker', district_id = null where user_id = '22000000-0000-4000-8000-000000000003';

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum,
  row_count, status, imported_at, metadata)
values ('22000000-0000-4000-8000-000000000010', 'm22-test', 'm22.csv', 'm22', repeat('3', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, category, unit, weight_per_unit_kg,
  lot_size, is_vmi, master_source, data_quality_status, source_batch_id) values
  ('M22-A', 'M22-A', 'M22 packed', 'TEST', 'EA', null, null, true, 'material_master', 'valid', '22000000-0000-4000-8000-000000000010'),
  ('M22-B', 'M22-B', 'M22 lot size only', 'TEST', 'EA', 2, 50, true, 'material_master', 'valid', '22000000-0000-4000-8000-000000000010'),
  ('M22-C', 'M22-C', 'M22 nothing known', 'TEST', 'EA', null, null, true, 'material_master', 'valid', '22000000-0000-4000-8000-000000000010');
-- 100 units per pallet, 10 kg each
insert into core.packaging_master_profiles (material_id, plant, storage_location, package_type, units_per_package,
  units_per_pallet, item_weight_kg, assumption_status, source_reference, verified)
values ('M22-A', 'WH', 'KT', 'BOX', 10, 100, 10, 'VERIFIED', 'm22 test', true);

select (date_trunc('week', current_date)::date + 14) as wk \gset

insert into ops.replenishment_runs (replenishment_run_id, policy_version, snapshot_cutoff_at, status,
  candidate_count, initiated_by, finished_at)
values ('22000000-0000-4000-8000-000000000101', 'v1.0.0', now(), 'succeeded', 3, '22000000-0000-4000-8000-000000000001', now());
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date,
  version_no, origin_location_id, status, response_due_at, created_by)
values ('22000000-0000-4000-8000-000000000201', '22000000-0000-4000-8000-000000000101', 'RP-M22', :'wk'::date,
  1, 'WH-KT', 'pending_planner_approval', now() + interval '1 day', '22000000-0000-4000-8000-000000000001');
insert into core.replenishment_items (replenishment_item_id, replenishment_plan_id, material_id, district_id,
  current_stock_qty, cmp_monthly, months_available, min_fill_qty, max_fill_qty, suggested_qty, requested_qty,
  final_qty, projected_months_after, source_stock_missing, priority_score, priority_band, status) values
  ('22000000-0000-4000-8000-000000000301', '22000000-0000-4000-8000-000000000201', 'M22-A', '5509',
   10, 100, 0.1, 200, 300, 250, 250, 250, 2.6, false, 9, 'critical', 'district_confirmed'),
  ('22000000-0000-4000-8000-000000000302', '22000000-0000-4000-8000-000000000201', 'M22-B', '5506',
   10, 10, 1, 20, 30, 25, 25, 25, 3.5, false, 3, 'normal', 'district_confirmed'),
  ('22000000-0000-4000-8000-000000000303', '22000000-0000-4000-8000-000000000201', 'M22-C', '5501',
   10, 10, 1, 10, 20, 10, 10, 10, 2, false, 3, 'normal', 'district_confirmed'),
  ('22000000-0000-4000-8000-000000000304', '22000000-0000-4000-8000-000000000201', 'M22-A', '5502',
   10, 10, 1, 10, 20, 900, 900, 900, 2, false, 3, 'normal', 'district_rejected');
-- Approved extra request routed into the week for 5506
insert into ops.ad_hoc_issues (ad_hoc_issue_id, issue_number, material_id, district_id, requested_qty, reason,
  requester_name, status, urgency_code, urgency_note, delivery_mode, delivery_date)
values ('22000000-0000-4000-8000-000000000401', 'AH-M22', 'M22-A', '5506', 50, 'สายขาด', 'นาย ค', 'approved',
  'outage', 'พายุ', 'zone_run', :'wk'::date + 1);
-- the M21 trigger routes by today's clock; pin it to the test week
update ops.ad_hoc_issues set delivery_date = :'wk'::date + 1 where ad_hoc_issue_id = '22000000-0000-4000-8000-000000000401';

-- Planner
select set_config('request.jwt.claim.sub', '22000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m22_state set demand = public.m09_dispatch('GET', '/v1/dispatch/demand',
  jsonb_build_object('week', :'wk'), '{}', 'm22-1');
update m22_state set draft = public.m09_dispatch('POST', '/v1/dispatch/plans', '{}',
  jsonb_build_object('week_start', :'wk', 'status', 'draft', 'metrics', '{"trips":1}', 'trips', jsonb_build_array(
    jsonb_build_object('trip_date', :'wk'::date + 1, 'vehicle_code', '708', 'mode', 'delivery', 'pallets', 3,
      'weight_kg', 3000, 'km', 20, 'stops', '[{"district_id":"5509"},{"district_id":"5506"}]'::jsonb))), 'm22-2');
update m22_state set confirmed = public.m09_dispatch('POST', '/v1/dispatch/plans', '{}',
  jsonb_build_object('week_start', :'wk', 'status', 'confirmed', 'trips', jsonb_build_array(
    jsonb_build_object('trip_date', :'wk'::date + 1, 'vehicle_code', '708', 'mode', 'delivery', 'pallets', 3,
      'stops', '[{"district_id":"5506"}]'::jsonb),
    jsonb_build_object('trip_date', :'wk'::date, 'mode', 'pickup', 'pallets', 3,
      'stops', '[{"district_id":"5509"}]'::jsonb),
    jsonb_build_object('trip_date', :'wk'::date + 2, 'vehicle_code', '707', 'mode', 'delivery', 'pallets', 1,
      'stops', '[{"district_id":"5501"}]'::jsonb))), 'm22-3');
update m22_state set bad_mode = public.m09_dispatch('POST', '/v1/dispatch/plans', '{}',
  jsonb_build_object('week_start', :'wk', 'trips', jsonb_build_array(
    jsonb_build_object('mode', 'teleport', 'stops', '[{"district_id":"5509"}]'::jsonb))), 'm22-4');
update m22_state set config = public.m09_dispatch('POST', '/v1/dispatch/config', '{}',
  '{"settings":{"pickup_max_km":12},"vehicles":[{"vehicle_code":"708","max_payload_kg":6500}],"districts":[{"district_id":"5509","has_vehicle":true}]}', 'm22-5');
update m22_state set demand_after = public.m09_dispatch('GET', '/v1/dispatch/demand',
  jsonb_build_object('week', :'wk'), '{}', 'm22-6');
update m22_state set planner_plans = public.m09_dispatch('GET', '/v1/dispatch/plans',
  jsonb_build_object('week', :'wk'), '{}', 'm22-7');
reset role;

select set_config('request.jwt.claim.sub', '22000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m22_state set reconfirmed = public.m09_dispatch('POST', '/v1/dispatch/plans', '{}',
  jsonb_build_object('week_start', :'wk', 'status', 'confirmed', 'trips', jsonb_build_array(
    jsonb_build_object('trip_date', :'wk'::date + 1, 'vehicle_code', '708', 'mode', 'delivery', 'pallets', 4,
      'stops', '[{"district_id":"5506"},{"district_id":"5509"}]'::jsonb))), 'm22-8');
reset role;

-- District and picker
select set_config('request.jwt.claim.sub', '22000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update m22_state set district_demand = public.m09_dispatch('GET', '/v1/dispatch/demand',
  jsonb_build_object('week', :'wk'), '{}', 'm22-9');
update m22_state set district_plans = public.m09_dispatch('GET', '/v1/dispatch/plans',
  jsonb_build_object('week', :'wk'), '{}', 'm22-10');
reset role;
select set_config('request.jwt.claim.sub', '22000000-0000-4000-8000-000000000003', true);
set local role authenticated;
update m22_state set picker_demand = public.m09_dispatch('GET', '/v1/dispatch/demand',
  jsonb_build_object('week', :'wk'), '{}', 'm22-11');
update m22_state set picker_save = public.m09_dispatch('POST', '/v1/dispatch/plans', '{}',
  jsonb_build_object('week_start', :'wk', 'trips', '[]'::jsonb), 'm22-12');
reset role;

create temporary table m22_d as
select x ->> 'district_id' as district_id, x as d
from m22_state, jsonb_array_elements(demand #> '{body,districts}') x;

insert into m22_checks select 'demand returns 18 districts with vehicles',
  (demand ->> 'status')::int = 200 and jsonb_array_length(demand #> '{body,districts}') = 18
  and jsonb_array_length(demand #> '{body,vehicles}') = 2
from m22_state;
insert into m22_checks select 'packed item splits into full and mixed pallets',
  (d ->> 'full_pallets')::numeric = 2 and (d ->> 'mixed_fraction')::numeric = 0.5
  and (d ->> 'pallets')::numeric = 3 and (d ->> 'weight_kg')::numeric = 2500
  and (d ->> 'packing_missing_lines')::int = 0 and (d ->> 'urgent')::boolean
from m22_d where district_id = '5509';
insert into m22_checks select 'extra request and lot-size estimate are added to the district',
  (d ->> 'lines')::int = 2 and (d ->> 'extra_lines')::int = 1
  and (d ->> 'pallets')::numeric = 1 and (d ->> 'mixed_fraction')::numeric = 1
  and (d ->> 'weight_kg')::numeric = 550 and (d ->> 'packing_missing_lines')::int = 1
  and d -> 'items' @> '[{"material_id":"M22-B","lot_size_estimate":true}]'
from m22_d where district_id = '5506';
insert into m22_checks select 'unknown item uses per-line estimate and default weight',
  (d ->> 'mixed_fraction')::numeric = 0.25 and (d ->> 'weight_kg')::numeric = 313
  and (d ->> 'weight_estimated_lines')::int = 1
from m22_d where district_id = '5501';
insert into m22_checks select 'rejected lines are excluded',
  (d ->> 'lines')::int = 0 and (d ->> 'pallets')::numeric = 0
from m22_d where district_id = '5502';
insert into m22_checks select 'district carries zone promise date and verified coordinates',
  d ->> 'zone' = 'E' and (d ->> 'promise_date')::date = :'wk'::date + 1
  and (d ->> 'latitude')::numeric between 13.8 and 13.83 and (d ->> 'depot_km')::numeric = 32.5
from m22_d where district_id = '5506';
insert into m22_checks select 'draft saved',
  (draft ->> 'status')::int = 200 and draft #>> '{body,status}' = 'draft' from m22_state;
insert into m22_checks select 'confirm supersedes the draft',
  (confirmed ->> 'status')::int = 200
  and (select status from ops.dispatch_plans where dispatch_plan_id = (draft #>> '{body,dispatch_plan_id}')::uuid) = 'superseded'
from m22_state;
insert into m22_checks select 'invalid mode rejected', (bad_mode ->> 'status')::int = 400 from m22_state;
insert into m22_checks select 'config updates settings, payload and district vehicle',
  (config ->> 'status')::int = 200
  and (demand_after #>> '{body,settings,pickup_max_km}')::numeric = 12
  and demand_after -> 'body' -> 'vehicles' @> '[{"vehicle_code":"708","max_payload_kg":6500}]'
  and exists (select 1 from jsonb_array_elements(demand_after #> '{body,districts}') x
    where x ->> 'district_id' = '5509' and (x ->> 'has_vehicle')::boolean)
from m22_state;
insert into m22_checks select 'pickup in confirmed plan sets last pickup date',
  exists (select 1 from jsonb_array_elements(demand_after #> '{body,districts}') x
    where x ->> 'district_id' = '5509' and (x ->> 'last_pickup_date')::date = :'wk'::date)
from m22_state;
insert into m22_checks select 'reconfirm leaves exactly one confirmed plan',
  (reconfirmed ->> 'status')::int = 200
  and (select count(*) from ops.dispatch_plans where week_start = :'wk'::date and status = 'confirmed') = 1
from m22_state;
insert into m22_checks select 'planner sees metrics and all trips',
  jsonb_array_length(planner_plans -> 'body') = 1
  and jsonb_array_length(planner_plans #> '{body,0,trips}') = 3
from m22_state;
insert into m22_checks select 'district sees only own trips without metrics',
  (district_plans ->> 'status')::int = 200
  and jsonb_array_length(district_plans #> '{body,0,trips}') = 1
  and district_plans #> '{body,0,metrics}' = '{}'::jsonb
from m22_state;
insert into m22_checks select 'district cannot load demand', (district_demand ->> 'status')::int = 403 from m22_state;
insert into m22_checks select 'picker loads demand but cannot save',
  (picker_demand ->> 'status')::int = 200 and (picker_save ->> 'status')::int = 403
from m22_state;

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m22_checks where not passed;
  if v_failed is not null then raise exception 'M22 checks failed: %', v_failed; end if;
  if (select count(*) from m22_checks) <> 16 then raise exception 'M22: expected 16 checks, got %', (select count(*) from m22_checks); end if;
end
$$;

select check_name, passed from m22_checks order by check_name;
rollback;
