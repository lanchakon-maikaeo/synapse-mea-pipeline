begin;

create table if not exists ops.api_rate_limit_windows (
  user_id uuid not null references auth.users (id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, window_start)
);

alter table ops.api_rate_limit_windows enable row level security;
revoke all on ops.api_rate_limit_windows from public, anon, authenticated;
grant all on ops.api_rate_limit_windows to service_role;

create or replace function public.m09_result(p_status integer, p_body jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_build_object('status', p_status, 'body', coalesce(p_body, 'null'::jsonb))
$$;

create or replace function public.m09_error(
  p_status integer,
  p_code text,
  p_message text,
  p_request_id text,
  p_details jsonb default null
)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select public.m09_result(
    p_status,
    jsonb_build_object(
      'error', jsonb_build_object(
        'code', p_code,
        'message', p_message,
        'request_id', p_request_id,
        'details', p_details
      )
    )
  )
$$;

create or replace function public.m09_health()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'status', 'ok',
    'service', 'synapse-api',
    'version', 'v1',
    'database', 'ready'
  )
$$;

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
set search_path = pg_catalog, public, core, analytics, ops, raw
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_district_id text;
  v_payload jsonb;
  v_path_id uuid;
  v_limit integer;
  v_offset integer;
  v_count integer;
  v_status_filter text;
  v_search text;
  v_method text := upper(coalesce(p_method, ''));
  v_ready boolean;
begin
  if v_user_id is null then
    return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
  end if;

  select role::text, district_id
  into v_role, v_district_id
  from public.user_profiles
  where user_id = v_user_id and is_active;

  if v_role is null then
    return public.m09_error(403, 'forbidden', 'No application role is assigned', p_request_id);
  end if;

  insert into ops.api_rate_limit_windows (user_id, window_start, request_count)
  values (v_user_id, date_trunc('minute', clock_timestamp()), 1)
  on conflict (user_id, window_start) do update
  set request_count = ops.api_rate_limit_windows.request_count + 1,
      updated_at = now()
  returning request_count into v_count;

  if v_count > 120 then
    return public.m09_error(429, 'rate_limited', 'Too many requests', p_request_id);
  end if;

  if v_method = 'GET' and p_path = '/v1/me' then
    return public.m09_result(200, jsonb_build_object(
      'user_id', v_user_id,
      'role', v_role,
      'district_id', v_district_id
    ));
  end if;

  if v_method = 'GET' and p_path = '/v1/contracts' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 50);
    v_offset := coalesce(nullif(p_query ->> 'offset', '')::integer, 0);
    if v_limit not between 1 and 200 or v_offset < 0 then
      return public.m09_error(422, 'validation_error', 'Invalid limit or offset', p_request_id);
    end if;
    v_search := nullif(left(p_query ->> 'search', 100), '');
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (
      select * from analytics.v_contract_status
      where v_search is null
         or purchase_order::text ilike '%' || v_search || '%'
         or coalesce(contract_number, '') ilike '%' || v_search || '%'
         or coalesce(vendor_name, '') ilike '%' || v_search || '%'
      order by updated_at desc, purchase_order
      limit v_limit offset v_offset
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/data-quality' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 100);
    if v_limit not between 1 and 500 then
      return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id);
    end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (select * from analytics.v_data_quality_summary order by last_detected_at desc limit v_limit) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/stock-health' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (
      select * from analytics.v_stock_health
      where v_role <> 'district' or district_id = v_district_id
      order by months_available nulls last, district_id, material_id
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/replenishment/queue' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (
      select * from analytics.v_replenishment_queue
      where v_role <> 'district' or district_id = v_district_id
      order by priority_score desc, district_id, material_id
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path = '/v1/replenishment/runs' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_path_id := core.create_replenishment_run(nullif(p_body ->> 'snapshot_cutoff_at', '')::timestamptz);
    return public.m09_result(201, jsonb_build_object('replenishment_run_id', v_path_id));
  end if;

  if v_method = 'POST' and p_path ~ '^/v1/replenishment/items/[0-9a-fA-F-]{36}/confirm$' then
    if v_role not in ('admin', 'planner', 'district') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    if not (p_body ? 'confirmed_qty') or btrim(coalesce(p_body ->> 'reason', '')) = '' then
      return public.m09_error(422, 'validation_error', 'confirmed_qty and reason are required', p_request_id);
    end if;
    v_path_id := substring(p_path from '^/v1/replenishment/items/([0-9a-fA-F-]{36})/confirm$')::uuid;
    select to_jsonb(core.confirm_replenishment_item(
      v_path_id,
      (p_body ->> 'confirmed_qty')::numeric,
      left(p_body ->> 'reason', 1000)
    )) into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path ~ '^/v1/replenishment/plans/[0-9a-fA-F-]{36}/approve$' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_path_id := substring(p_path from '^/v1/replenishment/plans/([0-9a-fA-F-]{36})/approve$')::uuid;
    perform core.approve_replenishment_plan(v_path_id);
    return public.m09_result(200, jsonb_build_object('replenishment_plan_id', v_path_id));
  end if;

  if v_method = 'GET' and p_path = '/v1/forecasts/latest' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (
      select * from analytics.v_latest_forecasts
      where v_role <> 'district' or district_id = v_district_id
      order by forecast_period, district_id, material_id
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/forecasts/monitoring' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (select * from analytics.v_forecast_monitoring order by created_at desc nulls last) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path = '/v1/forecasts/runs' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    if not (p_body ? 'training_end') then
      return public.m09_error(422, 'validation_error', 'training_end is required', p_request_id);
    end if;
    v_limit := coalesce(nullif(p_body ->> 'horizon_months', '')::integer, 3);
    if v_limit not between 1 and 24 then
      return public.m09_error(422, 'validation_error', 'horizon_months must be 1-24', p_request_id);
    end if;
    select forecast_operational_ready into v_ready from analytics.v_wave3_readiness;
    if not coalesce(v_ready, false) then
      return public.m09_error(409, 'conflict', 'Forecast history is not operationally ready', p_request_id);
    end if;
    v_path_id := analytics.queue_forecast_run(
      (p_body ->> 'training_end')::date,
      v_limit,
      nullif(p_body ->> 'training_start', '')::date
    );
    return public.m09_result(202, jsonb_build_object('forecast_run_id', v_path_id));
  end if;

  if v_method = 'GET' and p_path = '/v1/jobs' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 50);
    v_status_filter := nullif(p_query ->> 'status', '');
    if v_limit not between 1 and 200
       or (v_status_filter is not null and v_status_filter not in ('queued', 'running', 'succeeded', 'failed', 'cancelled')) then
      return public.m09_error(422, 'validation_error', 'Invalid limit or status', p_request_id);
    end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (
      select job_id, job_type, status, attempt_count, max_attempts, result,
             error_message, created_at, started_at, finished_at
      from ops.background_jobs
      where v_status_filter is null or status = v_status_filter
      order by created_at desc limit v_limit
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path ~ '^/v1/jobs/[0-9a-fA-F-]{36}$' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_path_id := substring(p_path from '^/v1/jobs/([0-9a-fA-F-]{36})$')::uuid;
    select to_jsonb(q) into v_payload from (
      select job_id, job_type, status, attempt_count, max_attempts, result,
             error_message, created_at, started_at, finished_at
      from ops.background_jobs where job_id = v_path_id
    ) q;
    if v_payload is null then
      return public.m09_error(404, 'not_found', 'Job not found', p_request_id);
    end if;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path = '/v1/routes/jobs' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    if not (p_body ? 'replenishment_plan_id') then
      return public.m09_error(422, 'validation_error', 'replenishment_plan_id is required', p_request_id);
    end if;
    select route_operational_ready into v_ready from analytics.v_wave3_readiness;
    if not coalesce(v_ready, false) then
      return public.m09_error(409, 'conflict', 'Route master data is not operationally ready', p_request_id);
    end if;
    v_path_id := core.queue_route_job(
      (p_body ->> 'replenishment_plan_id')::uuid,
      nullif(p_body ->> 'forecast_run_id', '')::uuid,
      coalesce(nullif(p_body ->> 'matrix_source', ''), 'valhalla')
    );
    return public.m09_result(202, jsonb_build_object('route_job_id', v_path_id));
  end if;

  if v_method = 'GET' and p_path = '/v1/routes/plans' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 50);
    if v_limit not between 1 and 200 then
      return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id);
    end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (select * from analytics.v_route_plan_summary order by created_at desc limit v_limit) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path ~ '^/v1/routes/plans/[0-9a-fA-F-]{36}$' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_path_id := substring(p_path from '^/v1/routes/plans/([0-9a-fA-F-]{36})$')::uuid;
    select to_jsonb(q) into v_payload
    from (select * from analytics.v_route_plan_summary where route_plan_id = v_path_id) q;
    if v_payload is null then
      return public.m09_error(404, 'not_found', 'Route plan not found', p_request_id);
    end if;
    select public.m09_result(200, jsonb_build_object(
      'summary', v_payload,
      'geojson', (select geojson from analytics.v_route_plan_geojson where route_plan_id = v_path_id)
    )) into v_payload;
    return v_payload;
  end if;

  if v_method = 'POST' and p_path ~ '^/v1/routes/plans/[0-9a-fA-F-]{36}/review$' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    if p_body ->> 'decision' not in ('approved', 'rejected') then
      return public.m09_error(422, 'validation_error', 'decision must be approved or rejected', p_request_id);
    end if;
    if p_body ->> 'decision' = 'rejected' and btrim(coalesce(p_body ->> 'reason', '')) = '' then
      return public.m09_error(422, 'validation_error', 'Rejection reason is required', p_request_id);
    end if;
    v_path_id := substring(p_path from '^/v1/routes/plans/([0-9a-fA-F-]{36})/review$')::uuid;
    perform core.review_route_plan(v_path_id, p_body ->> 'decision', left(p_body ->> 'reason', 1000));
    return public.m09_result(200, jsonb_build_object('route_plan_id', v_path_id));
  end if;

  if v_method = 'GET' and p_path = '/v1/wave3/readiness' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    select to_jsonb(q) into v_payload from (select * from analytics.v_wave3_readiness) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/operations/health' then
    if v_role not in ('admin', 'planner', 'viewer') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    select to_jsonb(q) into v_payload from (select * from analytics.v_operations_health) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/operations/alerts' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 50);
    if v_limit not between 1 and 200 then
      return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id);
    end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload
    from (
      select alert_id, alert_type, severity, status, message, details, created_at, acknowledged_at
      from ops.system_alerts order by created_at desc limit v_limit
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  return public.m09_error(404, 'not_found', 'API path not found', p_request_id);
exception
  when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    return public.m09_error(422, 'validation_error', 'Request contains an invalid value', p_request_id);
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function public.m09_result(integer, jsonb) from public, anon, authenticated;
revoke all on function public.m09_error(integer, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.m09_health() from public;
grant execute on function public.m09_health() to anon, authenticated;
revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text) to authenticated;

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607150009',
  'M09',
  'Serverless same-origin M09 dispatch API with Supabase JWT, RBAC and persistent rate limiting.',
  'supabase/migrations/202607150009_m09_serverless_api.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
