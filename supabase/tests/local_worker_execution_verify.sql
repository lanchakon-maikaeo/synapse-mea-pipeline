\set ON_ERROR_STOP on

begin;

create temporary table worker_test_state (
  route_plan_id uuid not null,
  review_result jsonb
);

create temporary table worker_checks (
  check_name text primary key,
  passed boolean not null
);

insert into worker_test_state (route_plan_id)
select route_plan_id
from core.route_plans
order by created_at desc
limit 1;

grant select, update on worker_test_state to authenticated;

insert into worker_checks (check_name, passed)
select 'both_background_jobs_succeeded',
       (select count(*) = 2
        from ops.background_jobs
        where initiated_by = '10000000-0000-4000-8000-000000000001'
          and job_type in ('forecast', 'route')
          and status = 'succeeded')
union all
select 'forecast_run_succeeded',
       coalesce(
         (select status = 'succeeded'
                 and series_count = 1
                 and result_count = 3
          from analytics.forecast_runs
          where initiated_by = '10000000-0000-4000-8000-000000000001'
          order by created_at desc
          limit 1),
         false
       )
union all
select 'forecast_results_persisted',
       (select count(*) = 3
        from analytics.forecast_results result
        join analytics.forecast_runs run using (forecast_run_id)
        where run.initiated_by =
              '10000000-0000-4000-8000-000000000001')
union all
select 'forecast_backtest_metrics_persisted',
       (select count(*) >= 2
        from analytics.forecast_metrics metric
        join analytics.forecast_runs run using (forecast_run_id)
        where run.initiated_by =
              '10000000-0000-4000-8000-000000000001'
          and metric.observation_count > 0)
union all
select 'route_plan_generated',
       coalesce(
         (select solver_status in ('succeeded', 'partial')
                 and served_stop_count = 1
          from core.route_plans
          order by created_at desc
          limit 1),
         false
       )
union all
select 'route_matrix_persisted',
       (select count(*) = 1
        from analytics.route_matrices
        where matrix_source = 'haversine-test')
union all
select 'route_vehicle_and_stop_persisted',
       (select count(*) = 1
        from core.route_stops stop
        join core.route_plan_vehicles vehicle using (route_plan_vehicle_id)
        join worker_test_state state using (route_plan_id))
union all
select 'worker_heartbeat_persisted',
       (select count(*) >= 1
        from ops.service_heartbeats
        where service_name like 'synapse-worker:local-contract-worker-%'
          and status = 'healthy');

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update worker_test_state state
set review_result = public.m09_dispatch(
  'POST',
  '/v1/routes/plans/' || state.route_plan_id || '/review',
  '{}'::jsonb,
  '{"decision":"approved"}'::jsonb,
  'local-worker-route-review'
);

reset role;

insert into worker_checks (check_name, passed)
select 'worker_route_review_status',
       coalesce((review_result ->> 'status')::integer = 200, false)
from worker_test_state
union all
select 'worker_route_plan_approved',
       coalesce(
         (select plan.status = 'approved'
                 and plan.approved_by =
                     '10000000-0000-4000-8000-000000000001'::uuid
          from core.route_plans plan
          join worker_test_state state using (route_plan_id)),
         false
       );

table worker_checks;

do $$
begin
  if exists(select 1 from worker_checks where not passed) then
    raise exception 'local worker execution contract failed: %',
      (select string_agg(check_name, ', ' order by check_name)
       from worker_checks
       where not passed);
  end if;
end
$$;

commit;
