-- SYNAPSE Wave 3 / M07: Demand features, versioned forecast runs and background jobs.

begin;

create table if not exists ops.background_jobs (
  job_id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('forecast', 'route')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  initiated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists background_jobs_claim_idx
  on ops.background_jobs (job_type, available_at, created_at)
  where status = 'queued';

create table if not exists analytics.forecast_model_versions (
  model_version text primary key,
  model_name text not null,
  model_family text not null check (model_family in ('baseline', 'statsforecast', 'prophet')),
  parameters jsonb not null default '{}'::jsonb,
  implementation_reference text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into analytics.forecast_model_versions (
  model_version, model_name, model_family, parameters, implementation_reference
)
values
  ('seasonal-naive-v1', 'Seasonal Naive', 'baseline', '{"season_length":12}', 'intelligence/src/synapse_intelligence/forecasting.py'),
  ('moving-average-v1', 'Moving Average', 'baseline', '{"window":3}', 'intelligence/src/synapse_intelligence/forecasting.py')
on conflict (model_version) do update
set model_name = excluded.model_name,
    model_family = excluded.model_family,
    parameters = excluded.parameters,
    implementation_reference = excluded.implementation_reference,
    is_active = true;

create table if not exists analytics.demand_monthly_features (
  demand_feature_id uuid primary key default gen_random_uuid(),
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  period_start date not null check (period_start = date_trunc('month', period_start)::date),
  demand_quantity numeric not null check (demand_quantity >= 0),
  stockout_days integer not null default 0 check (stockout_days between 0 and 31),
  lead_time_days numeric check (lead_time_days is null or lead_time_days >= 0),
  source_batch_id uuid references raw.import_batches (batch_id) on delete restrict,
  feature_version text not null default 'monthly-demand-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (material_id, district_id, period_start, feature_version)
);

create index if not exists demand_monthly_series_idx
  on analytics.demand_monthly_features (material_id, district_id, period_start);

create table if not exists analytics.forecast_runs (
  forecast_run_id uuid primary key default gen_random_uuid(),
  job_id uuid unique references ops.background_jobs (job_id) on delete set null,
  algorithm_version text not null default 'baseline-selector-v1',
  feature_version text not null default 'monthly-demand-v1',
  training_start date,
  training_end date not null,
  horizon_months integer not null default 3 check (horizon_months between 1 and 24),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  series_count integer not null default 0 check (series_count >= 0),
  result_count integer not null default 0 check (result_count >= 0),
  initiated_by uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists analytics.forecast_results (
  forecast_result_id uuid primary key default gen_random_uuid(),
  forecast_run_id uuid not null references analytics.forecast_runs (forecast_run_id) on delete restrict,
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  forecast_period date not null check (forecast_period = date_trunc('month', forecast_period)::date),
  horizon integer not null check (horizon > 0),
  model_version text not null references analytics.forecast_model_versions (model_version),
  predicted_quantity numeric not null check (predicted_quantity >= 0),
  lower_80 numeric not null check (lower_80 >= 0),
  upper_80 numeric not null check (upper_80 >= lower_80),
  created_at timestamptz not null default now(),
  unique (forecast_run_id, material_id, district_id, forecast_period)
);

create index if not exists forecast_results_lookup_idx
  on analytics.forecast_results (material_id, district_id, forecast_period, created_at desc);

create table if not exists analytics.forecast_metrics (
  forecast_metric_id uuid primary key default gen_random_uuid(),
  forecast_run_id uuid not null references analytics.forecast_runs (forecast_run_id) on delete restrict,
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  model_version text not null references analytics.forecast_model_versions (model_version),
  backtest_start date,
  backtest_end date,
  observation_count integer not null check (observation_count > 0),
  wape numeric not null check (wape >= 0),
  mae numeric not null check (mae >= 0),
  bias numeric not null,
  selected boolean not null default false,
  created_at timestamptz not null default now(),
  unique (forecast_run_id, material_id, district_id, model_version)
);

create table if not exists analytics.forecast_drift_events (
  drift_event_id uuid primary key default gen_random_uuid(),
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  detected_at timestamptz not null default now(),
  metric_name text not null check (metric_name in ('wape', 'bias', 'demand_shift', 'data_freshness')),
  observed_value numeric,
  threshold_value numeric,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  details jsonb not null default '{}'::jsonb
);

create or replace function ops.claim_background_job(p_worker_id text, p_job_types text[])
returns ops.background_jobs
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
declare v_job ops.background_jobs%rowtype;
begin
  select * into v_job
  from ops.background_jobs
  where status = 'queued'
    and available_at <= now()
    and job_type = any(p_job_types)
    and attempt_count < max_attempts
  order by available_at, created_at
  for update skip locked
  limit 1;
  if not found then return null; end if;
  update ops.background_jobs
  set status = 'running', attempt_count = attempt_count + 1,
      locked_at = now(), locked_by = p_worker_id,
      started_at = coalesce(started_at, now()), updated_at = now()
  where job_id = v_job.job_id returning * into v_job;
  return v_job;
end;
$$;

create or replace function ops.complete_background_job(p_job_id uuid, p_result jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = pg_catalog, ops
as $$
  update ops.background_jobs
  set status = 'succeeded', result = coalesce(p_result, '{}'::jsonb),
      finished_at = now(), locked_at = null, locked_by = null, updated_at = now()
  where job_id = p_job_id and status = 'running'
$$;

create or replace function ops.fail_background_job(p_job_id uuid, p_error_message text, p_retry_delay_seconds integer default 60)
returns void
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
begin
  update ops.background_jobs
  set status = case when attempt_count < max_attempts then 'queued' else 'failed' end,
      available_at = case when attempt_count < max_attempts then now() + make_interval(secs => greatest(p_retry_delay_seconds, 0)) else available_at end,
      error_message = left(p_error_message, 4000),
      finished_at = case when attempt_count >= max_attempts then now() else null end,
      locked_at = null, locked_by = null, updated_at = now()
  where job_id = p_job_id and status = 'running';
end;
$$;

create or replace function analytics.queue_forecast_run(
  p_training_end date,
  p_horizon_months integer default 3,
  p_training_start date default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, analytics, ops, public
as $$
declare v_role public.app_role; v_job_id uuid; v_run_id uuid;
begin
  select role into v_role from public.user_profiles where user_id = auth.uid() and is_active;
  if v_role is null or v_role not in ('admin', 'planner') then raise exception 'Only planner or admin may queue forecasts'; end if;
  if p_horizon_months not between 1 and 24 then raise exception 'Forecast horizon must be 1-24 months'; end if;
  insert into ops.background_jobs (job_type, payload, initiated_by)
  values ('forecast', '{}'::jsonb, auth.uid()) returning job_id into v_job_id;
  insert into analytics.forecast_runs (job_id, training_start, training_end, horizon_months, initiated_by)
  values (v_job_id, p_training_start, p_training_end, p_horizon_months, auth.uid())
  returning forecast_run_id into v_run_id;
  update ops.background_jobs set payload = jsonb_build_object('forecast_run_id', v_run_id) where job_id = v_job_id;
  return v_run_id;
end;
$$;

create or replace view analytics.v_latest_forecasts
with (security_invoker = true)
as
select distinct on (r.material_id, r.district_id, r.forecast_period)
  r.forecast_result_id, r.forecast_run_id, r.material_id, m.material_name,
  r.district_id, d.district_name_th, r.forecast_period, r.horizon,
  r.model_version, r.predicted_quantity, r.lower_80, r.upper_80, r.created_at
from analytics.forecast_results r
join analytics.forecast_runs f using (forecast_run_id)
join core.materials m using (material_id)
join core.districts d using (district_id)
where f.status = 'succeeded'
order by r.material_id, r.district_id, r.forecast_period, r.created_at desc;

create or replace view analytics.v_forecast_monitoring
with (security_invoker = true)
as
select
  f.forecast_run_id, f.training_end, f.status, f.series_count, f.result_count,
  count(m.forecast_metric_id) as metric_count,
  avg(m.wape) filter (where m.selected) as selected_mean_wape,
  avg(m.mae) filter (where m.selected) as selected_mean_mae,
  avg(m.bias) filter (where m.selected) as selected_mean_bias,
  f.created_at, f.started_at, f.finished_at, f.error_message
from analytics.forecast_runs f
left join analytics.forecast_metrics m using (forecast_run_id)
group by f.forecast_run_id;

do $$
declare table_ref text;
begin
  foreach table_ref in array array['ops.background_jobs', 'analytics.demand_monthly_features'] loop
    execute format('drop trigger if exists set_%s_updated_at on %s', replace(table_ref, '.', '_'), table_ref);
    execute format('create trigger set_%s_updated_at before update on %s for each row execute function audit.set_updated_at()', replace(table_ref, '.', '_'), table_ref);
  end loop;
end;
$$;

alter table ops.background_jobs enable row level security;
alter table analytics.forecast_model_versions enable row level security;
alter table analytics.demand_monthly_features enable row level security;
alter table analytics.forecast_runs enable row level security;
alter table analytics.forecast_results enable row level security;
alter table analytics.forecast_metrics enable row level security;
alter table analytics.forecast_drift_events enable row level security;

revoke all on ops.background_jobs, analytics.forecast_model_versions,
  analytics.demand_monthly_features, analytics.forecast_runs,
  analytics.forecast_results, analytics.forecast_metrics,
  analytics.forecast_drift_events from public, anon, authenticated;
grant all on ops.background_jobs, analytics.forecast_model_versions,
  analytics.demand_monthly_features, analytics.forecast_runs,
  analytics.forecast_results, analytics.forecast_metrics,
  analytics.forecast_drift_events to service_role;
grant select on analytics.v_latest_forecasts, analytics.v_forecast_monitoring to service_role;

revoke all on function ops.claim_background_job(text, text[]), ops.complete_background_job(uuid, jsonb),
  ops.fail_background_job(uuid, text, integer), analytics.queue_forecast_run(date, integer, date)
  from public, anon, authenticated;
grant execute on function ops.claim_background_job(text, text[]), ops.complete_background_job(uuid, jsonb),
  ops.fail_background_job(uuid, text, integer), analytics.queue_forecast_run(date, integer, date) to service_role;

insert into ops.schema_migrations (version, module, description, source_file)
values ('202607150005', 'M07', 'Demand features, baseline forecast runs/results/metrics, drift and retryable background jobs.', 'supabase/migrations/202607150005_m07_forecasting.sql')
on conflict (version) do update set description = excluded.description, source_file = excluded.source_file;

commit;
