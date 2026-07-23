\set ON_ERROR_STOP on

begin;

create temporary table functional_test_state (
  payload jsonb not null,
  publish_result jsonb,
  repeat_result jsonb,
  confirm_result jsonb,
  approve_result jsonb,
  forecast_result jsonb,
  route_result jsonb,
  viewer_result jsonb,
  district_result jsonb,
  replenishment_run_id uuid,
  replenishment_plan_id uuid,
  replenishment_item_id uuid,
  confirmed_qty numeric,
  forecast_run_id uuid,
  forecast_job_id uuid,
  route_job_id uuid,
  route_plan_id uuid
);

create temporary table functional_checks (
  check_name text primary key,
  passed boolean not null
);

insert into auth.users (id, raw_user_meta_data)
values
  ('10000000-0000-4000-8000-000000000001', '{"display_name":"Local Admin"}'),
  ('10000000-0000-4000-8000-000000000002', '{"display_name":"Local Viewer"}'),
  ('10000000-0000-4000-8000-000000000003', '{"display_name":"Local District"}');

update public.user_profiles
set role = 'admin', district_id = null
where user_id = '10000000-0000-4000-8000-000000000001';

update public.user_profiles
set role = 'district', district_id = '5502'
where user_id = '10000000-0000-4000-8000-000000000003';

insert into functional_test_state (payload)
select jsonb_build_object(
  'material_id', material.material_id,
  'district_id', '5501',
  'source_note', 'isolated local pipeline contract',
  'snapshot_at', now(),
  'current_stock', 10,
  'run_replenishment', true,
  'history', (
    select jsonb_agg(
      jsonb_build_object(
        'period', to_char(
          date_trunc('month', current_date) - make_interval(months => 13 - month_index),
          'YYYY-MM'
        ),
        'demand_quantity', 100 + month_index,
        'stockout_days', 0,
        'lead_time_days', 7
      )
      order by month_index
    )
    from generate_series(0, 13) month_index
  )
)
from (
  select material_id
  from core.materials
  order by is_vmi desc, material_id
  limit 1
) material;

grant select, update on functional_test_state to authenticated;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update functional_test_state
set publish_result = public.m10_input_dispatch(
      'POST',
      '/v1/data-inputs/vmi',
      '{}'::jsonb,
      payload,
      'local-functional-publish'
    ),
    repeat_result = public.m10_input_dispatch(
      'POST',
      '/v1/data-inputs/vmi',
      '{}'::jsonb,
      payload,
      'local-functional-repeat'
    );

reset role;

update functional_test_state state
set replenishment_run_id = (state.publish_result #>> '{body,replenishment_run_id}')::uuid,
    replenishment_plan_id = plan.replenishment_plan_id,
    replenishment_item_id = item.replenishment_item_id,
    confirmed_qty = item.suggested_qty
from core.replenishment_plans plan
join core.replenishment_items item using (replenishment_plan_id)
where plan.replenishment_run_id =
      (state.publish_result #>> '{body,replenishment_run_id}')::uuid;

insert into functional_checks (check_name, passed)
select 'admin_publish_status',
       coalesce((publish_result ->> 'status')::integer = 201, false)
from functional_test_state
union all
select 'repeat_is_idempotent',
       coalesce(
         (repeat_result ->> 'status')::integer = 201
         and (repeat_result #>> '{body,idempotent}')::boolean,
         false
       )
from functional_test_state
union all
select 'single_web_submission',
       (select count(*) = 1
        from ops.web_input_submissions
        where source_note = 'isolated local pipeline contract')
union all
select 'raw_lineage_rows',
       (select count(*) = 15
        from raw.source_rows
        where batch_id = (
          select (publish_result #>> '{body,batch_id}')::uuid
          from functional_test_state
        ))
union all
select 'staging_lineage_rows',
       (select count(*) = 15
        from staging.vmi_input_rows
        where batch_id = (
          select (publish_result #>> '{body,batch_id}')::uuid
          from functional_test_state
        ))
union all
select 'monthly_features_published',
       (select count(*) = 14
        from analytics.demand_monthly_features
        where source_batch_id = (
          select (publish_result #>> '{body,batch_id}')::uuid
          from functional_test_state
        ))
union all
select 'replenishment_candidate_created',
       coalesce(
         (select replenishment_run_id is not null
                 and replenishment_plan_id is not null
                 and replenishment_item_id is not null
          from functional_test_state),
         false
       );

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update functional_test_state state
set confirm_result = public.m09_dispatch(
      'POST',
      '/v1/replenishment/items/' || state.replenishment_item_id || '/confirm',
      '{}'::jsonb,
      jsonb_build_object(
        'confirmed_qty', state.confirmed_qty,
        'reason',
        'local functional confirmation'
      ),
      'local-functional-confirm'
    );

update functional_test_state state
set approve_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/' || state.replenishment_plan_id || '/approve',
  '{}'::jsonb,
  '{}'::jsonb,
  'local-functional-approve'
);

update functional_test_state state
set forecast_result = public.m09_dispatch(
  'POST',
  '/v1/forecasts/runs',
  '{}'::jsonb,
  jsonb_build_object(
    'training_start', date_trunc('month', current_date) - interval '13 months',
    'training_end', current_date,
    'horizon_months', 3
  ),
  'local-functional-forecast'
);

reset role;

update functional_test_state state
set forecast_run_id = (state.forecast_result #>> '{body,forecast_run_id}')::uuid,
    forecast_job_id = run.job_id
from analytics.forecast_runs run
where run.forecast_run_id =
      (state.forecast_result #>> '{body,forecast_run_id}')::uuid;

insert into functional_checks (check_name, passed)
select 'replenishment_confirm_status',
       coalesce((confirm_result ->> 'status')::integer = 200, false)
from functional_test_state
union all
select 'replenishment_approve_status',
       coalesce((approve_result ->> 'status')::integer = 200, false)
from functional_test_state
union all
select 'replenishment_plan_approved',
       coalesce(
         (select plan.status = 'approved'
          from core.replenishment_plans plan
          join functional_test_state state
            on state.replenishment_plan_id = plan.replenishment_plan_id),
         false
       )
union all
select 'forecast_queue_status',
       coalesce((forecast_result ->> 'status')::integer = 202, false)
from functional_test_state
union all
select 'forecast_job_queued',
       coalesce(
         (select job.job_type = 'forecast' and job.status = 'queued'
          from ops.background_jobs job
          join functional_test_state state
            on state.forecast_job_id = job.job_id),
         false
       );

insert into core.location_geocodes (
  location_id,
  latitude,
  longitude,
  time_window_start,
  time_window_end,
  service_minutes,
  source_reference,
  verified_at
)
select
  location_id,
  13.70 + row_number() over (order by location_id) * 0.001,
  100.50 + row_number() over (order by location_id) * 0.001,
  time '08:00',
  time '16:00',
  15,
  'isolated-local-functional-test',
  now()
from core.locations
on conflict (location_id) do update
set verified_at = excluded.verified_at,
    source_reference = excluded.source_reference;

insert into core.material_packaging (
  material_id,
  quantity_per_box,
  box_volume_m3,
  weight_per_box_kg,
  boxes_per_pallet,
  pallet_volume_m3,
  pallet_weight_kg,
  source_reference,
  verified_at
)
select
  payload ->> 'material_id',
  10,
  0.05,
  5,
  20,
  1,
  100,
  'isolated-local-functional-test',
  now()
from functional_test_state
on conflict (material_id) do update
set quantity_per_box = excluded.quantity_per_box,
    box_volume_m3 = excluded.box_volume_m3,
    weight_per_box_kg = excluded.weight_per_box_kg,
    boxes_per_pallet = excluded.boxes_per_pallet,
    pallet_volume_m3 = excluded.pallet_volume_m3,
    pallet_weight_kg = excluded.pallet_weight_kg,
    source_reference = excluded.source_reference,
    verified_at = excluded.verified_at;

update core.vehicles
set max_pallets = 20,
    source_reference = 'isolated-local-functional-test'
where is_active;

insert into core.drivers (
  employee_reference,
  display_name,
  license_class
)
values ('LOCAL-DRIVER', 'Local Driver', 'ท.2');

insert into functional_checks (check_name, passed)
select 'route_readiness_fixture',
       coalesce((select route_operational_ready from analytics.v_wave3_readiness), false);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update functional_test_state state
set route_result = public.m09_dispatch(
  'POST',
  '/v1/routes/jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id', state.replenishment_plan_id,
    'forecast_run_id', state.forecast_run_id,
    'matrix_source', 'valhalla'
  ),
  'local-functional-route'
);

reset role;

update functional_test_state state
set route_job_id = (state.route_result #>> '{body,route_job_id}')::uuid
where state.route_result #>> '{body,route_job_id}' is not null;

insert into functional_checks (check_name, passed)
select 'route_queue_status',
       coalesce((route_result ->> 'status')::integer = 202, false)
from functional_test_state
union all
select 'route_job_uses_valhalla',
       coalesce(
         (select route.matrix_source = 'valhalla'
                 and job.job_type = 'route'
                 and job.status = 'queued'
          from ops.route_jobs route
          join ops.background_jobs job using (job_id)
          join functional_test_state state
            on state.route_job_id = route.route_job_id),
         false
       );

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

update functional_test_state
set viewer_result = public.m10_input_dispatch(
  'POST',
  '/v1/data-inputs/vmi',
  '{}'::jsonb,
  payload,
  'local-functional-viewer-denial'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;

update functional_test_state state
set district_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/items/' || state.replenishment_item_id || '/confirm',
  '{}'::jsonb,
  '{"confirmed_qty":0,"reason":"cross-district denial test"}'::jsonb,
  'local-functional-district-denial'
);

reset role;

insert into functional_checks (check_name, passed)
select 'viewer_publish_forbidden',
       coalesce(
         (viewer_result ->> 'status')::integer = 403
         and viewer_result #>> '{body,error,code}' = 'forbidden',
         false
       )
from functional_test_state
union all
select 'cross_district_confirmation_blocked',
       coalesce(
         (district_result ->> 'status')::integer = 403
         and district_result #>> '{body,error,code}' = 'forbidden',
         false
       )
from functional_test_state;

table functional_checks;

do $$
begin
  if exists(select 1 from functional_checks where not passed) then
    raise exception 'local pipeline workflow contract failed: %',
      (select string_agg(check_name, ', ' order by check_name)
       from functional_checks
       where not passed);
  end if;
end
$$;

-- The public API must queue Valhalla in production. The isolated worker
-- execution that follows explicitly switches only this disposable job to the
-- test adapter so CI does not depend on map tiles or external network access.
update ops.route_jobs route
set matrix_source = 'haversine-test'
from functional_test_state state
where route.route_job_id = state.route_job_id;

commit;
