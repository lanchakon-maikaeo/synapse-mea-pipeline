-- SYNAPSE M02-M07/M09/M10: governed Web input pipeline for real VMI observations.
-- Admin/planner input is recorded Raw -> Staging -> Core/Analytics in one transaction.

begin;

create table if not exists staging.vmi_input_rows (
  vmi_input_row_id bigint generated always as identity primary key,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  source_row_id bigint not null unique references raw.source_rows (source_row_id) on delete restrict,
  record_type text not null check (record_type in ('stock', 'demand')),
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  observed_at timestamptz,
  period_start date,
  quantity numeric not null check (quantity >= 0),
  validation_status text not null default 'valid' check (validation_status in ('valid', 'warning', 'rejected')),
  submitted_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint vmi_input_rows_shape check (
    (record_type = 'stock' and observed_at is not null and period_start is null)
    or (record_type = 'demand' and observed_at is null and period_start is not null
        and period_start = date_trunc('month', period_start)::date)
  )
);

create index if not exists vmi_input_rows_batch_idx
  on staging.vmi_input_rows (batch_id, record_type, period_start);

create table if not exists ops.web_input_submissions (
  submission_id uuid primary key default gen_random_uuid(),
  batch_id uuid not null unique references raw.import_batches (batch_id) on delete restrict,
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  source_note text not null check (btrim(source_note) <> ''),
  input_month_count integer not null check (input_month_count between 3 and 36),
  stock_snapshot_id uuid references core.stock_snapshots (snapshot_id) on delete restrict,
  usage_rate_id uuid references core.usage_rates (usage_rate_id) on delete restrict,
  replenishment_run_id uuid references ops.replenishment_runs (replenishment_run_id) on delete set null,
  submitted_by uuid not null references auth.users (id) on delete restrict,
  status text not null default 'published' check (status in ('published', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists web_input_submissions_recent_idx
  on ops.web_input_submissions (created_at desc, district_id, material_id);

create or replace function core.publish_vmi_web_input(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, raw, staging, core, analytics, ops, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_role public.app_role;
  v_profile_district text;
  v_material_id text := btrim(coalesce(p_payload ->> 'material_id', ''));
  v_district_id text := btrim(coalesce(p_payload ->> 'district_id', ''));
  v_source_note text := btrim(coalesce(p_payload ->> 'source_note', ''));
  v_snapshot_at timestamptz;
  v_current_stock numeric;
  v_history jsonb := p_payload -> 'history';
  v_history_count integer;
  v_distinct_periods integer;
  v_checksum text;
  v_batch_id uuid;
  v_source_row_id bigint;
  v_stock_snapshot_id uuid;
  v_usage_rate_id uuid;
  v_replenishment_run_id uuid;
  v_existing ops.web_input_submissions%rowtype;
  v_latest_period date;
  v_values numeric[];
  v_cmp numeric;
  v_avg_4m numeric;
  v_avg_6m numeric;
  v_avg_12m numeric;
  v_row record;
  v_row_number integer := 1;
begin
  if v_user_id is null then raise exception 'Missing authenticated user'; end if;

  select role, district_id into v_role, v_profile_district
  from public.user_profiles where user_id = v_user_id and is_active;
  if v_role not in ('admin', 'planner') then
    raise exception 'Only admin or planner may publish operational input';
  end if;

  if jsonb_typeof(p_payload) <> 'object' then raise exception 'Input must be a JSON object'; end if;
  if v_material_id = '' or not exists (select 1 from core.materials where material_id = v_material_id) then
    raise exception 'Material does not exist in Supabase master data';
  end if;
  if v_district_id = '' or not exists (select 1 from core.districts where district_id = v_district_id and is_active) then
    raise exception 'District does not exist or is inactive';
  end if;
  if length(v_source_note) < 3 or length(v_source_note) > 500 then
    raise exception 'Source note must contain 3-500 characters';
  end if;
  if not (p_payload ? 'snapshot_at') or not (p_payload ? 'current_stock') then
    raise exception 'snapshot_at and current_stock are required';
  end if;
  v_snapshot_at := (p_payload ->> 'snapshot_at')::timestamptz;
  v_current_stock := (p_payload ->> 'current_stock')::numeric;
  if v_current_stock < 0 then raise exception 'Current stock must be non-negative'; end if;
  if v_snapshot_at > now() + interval '5 minutes' then raise exception 'Stock snapshot cannot be in the future'; end if;

  if jsonb_typeof(v_history) <> 'array' then raise exception 'history must be an array'; end if;
  v_history_count := jsonb_array_length(v_history);
  if v_history_count not between 3 and 36 then raise exception 'History must contain 3-36 monthly observations'; end if;
  if exists (
    select 1 from jsonb_array_elements(v_history) h
    where coalesce(h ->> 'period', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
       or not (h ? 'demand_quantity')
       or (h ->> 'demand_quantity')::numeric < 0
  ) then raise exception 'Each history row requires a valid month and non-negative demand'; end if;

  select count(distinct h ->> 'period') into v_distinct_periods
  from jsonb_array_elements(v_history) h;
  if v_distinct_periods <> v_history_count then raise exception 'History contains duplicate months'; end if;
  if exists (
    select 1 from jsonb_array_elements(v_history) h
    where to_date((h ->> 'period') || '-01', 'YYYY-MM-DD') > date_trunc('month', current_date)::date
  ) then raise exception 'Demand history cannot contain a future month'; end if;

  v_checksum := encode(extensions.digest(
    convert_to((p_payload - 'run_replenishment')::text || ':' || v_user_id::text, 'UTF8'),
    'sha256'
  ), 'hex');

  insert into raw.import_batches (
    source_system, source_file, source_sheet, source_checksum, row_count, status,
    imported_at, connector_name, source_entity, started_at, finished_at, metadata
  ) values (
    'web_app', 'web://synapse/vmi-input', 'vmi_input', v_checksum,
    v_history_count + 1, 'succeeded', now(), 'synapse-web', 'vmi_observations', now(), now(),
    jsonb_build_object('submitted_by', v_user_id, 'source_note', v_source_note, 'pipeline_version', 'web-input-v1')
  )
  on conflict (source_checksum, source_sheet) do update
  set updated_at = now()
  returning batch_id into v_batch_id;

  select * into v_existing from ops.web_input_submissions where batch_id = v_batch_id;
  if found then
    if coalesce((p_payload ->> 'run_replenishment')::boolean, false)
       and v_existing.replenishment_run_id is null then
      v_replenishment_run_id := core.create_replenishment_run(v_snapshot_at);
      update ops.web_input_submissions
      set replenishment_run_id = v_replenishment_run_id,
          updated_at = now()
      where submission_id = v_existing.submission_id;
      v_existing.replenishment_run_id := v_replenishment_run_id;
    end if;
    return jsonb_build_object(
      'submission_id', v_existing.submission_id,
      'batch_id', v_existing.batch_id,
      'stock_snapshot_id', v_existing.stock_snapshot_id,
      'usage_rate_id', v_existing.usage_rate_id,
      'replenishment_run_id', v_existing.replenishment_run_id,
      'history_count', v_existing.input_month_count,
      'idempotent', true
    );
  end if;

  insert into raw.source_rows (
    batch_id, source_entity, source_sheet, source_row_number, row_hash, payload
  ) values (
    v_batch_id, 'stock_observation', 'vmi_input', 1,
    encode(extensions.digest(convert_to(jsonb_build_object(
      'material_id', v_material_id, 'district_id', v_district_id,
      'snapshot_at', v_snapshot_at, 'quantity_on_hand', v_current_stock
    )::text, 'UTF8'), 'sha256'), 'hex'),
    jsonb_build_object(
      'material_id', v_material_id, 'district_id', v_district_id,
      'snapshot_at', v_snapshot_at, 'quantity_on_hand', v_current_stock,
      'source_note', v_source_note
    )
  ) returning source_row_id into v_source_row_id;

  insert into staging.vmi_input_rows (
    batch_id, source_row_id, record_type, material_id, district_id,
    observed_at, quantity, validation_status, submitted_by
  ) values (
    v_batch_id, v_source_row_id, 'stock', v_material_id, v_district_id,
    v_snapshot_at, v_current_stock, 'valid', v_user_id
  );

  for v_row in
    select
      to_date((h ->> 'period') || '-01', 'YYYY-MM-DD') as period_start,
      (h ->> 'demand_quantity')::numeric as demand_quantity,
      greatest(0, least(31, coalesce(nullif(h ->> 'stockout_days', '')::integer, 0))) as stockout_days,
      nullif(h ->> 'lead_time_days', '')::numeric as lead_time_days
    from jsonb_array_elements(v_history) h
    order by h ->> 'period'
  loop
    v_row_number := v_row_number + 1;
    insert into raw.source_rows (
      batch_id, source_entity, source_sheet, source_row_number, row_hash, payload
    ) values (
      v_batch_id, 'monthly_demand', 'vmi_input', v_row_number,
      encode(extensions.digest(convert_to(jsonb_build_object(
        'material_id', v_material_id, 'district_id', v_district_id,
        'period_start', v_row.period_start, 'demand_quantity', v_row.demand_quantity,
        'stockout_days', v_row.stockout_days, 'lead_time_days', v_row.lead_time_days
      )::text, 'UTF8'), 'sha256'), 'hex'),
      jsonb_build_object(
        'material_id', v_material_id, 'district_id', v_district_id,
        'period_start', v_row.period_start, 'demand_quantity', v_row.demand_quantity,
        'stockout_days', v_row.stockout_days, 'lead_time_days', v_row.lead_time_days,
        'source_note', v_source_note
      )
    ) returning source_row_id into v_source_row_id;

    insert into staging.vmi_input_rows (
      batch_id, source_row_id, record_type, material_id, district_id,
      period_start, quantity, validation_status, submitted_by
    ) values (
      v_batch_id, v_source_row_id, 'demand', v_material_id, v_district_id,
      v_row.period_start, v_row.demand_quantity, 'valid', v_user_id
    );

    insert into analytics.demand_monthly_features (
      material_id, district_id, period_start, demand_quantity, stockout_days,
      lead_time_days, source_batch_id, feature_version
    ) values (
      v_material_id, v_district_id, v_row.period_start, v_row.demand_quantity,
      v_row.stockout_days, v_row.lead_time_days, v_batch_id, 'monthly-demand-v1'
    )
    on conflict (material_id, district_id, period_start, feature_version) do update
    set demand_quantity = excluded.demand_quantity,
        stockout_days = excluded.stockout_days,
        lead_time_days = excluded.lead_time_days,
        source_batch_id = excluded.source_batch_id,
        updated_at = now();
  end loop;

  insert into core.stock_snapshots (
    material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id
  ) values (
    v_material_id, 'DIST-' || v_district_id, v_current_stock, v_snapshot_at, v_batch_id
  )
  on conflict (material_id, location_id, snapshot_at) do update
  set quantity_on_hand = excluded.quantity_on_hand,
      source_batch_id = excluded.source_batch_id
  returning snapshot_id into v_stock_snapshot_id;

  select array_agg(demand_quantity order by period_start desc), max(period_start)
  into v_values, v_latest_period
  from analytics.demand_monthly_features
  where material_id = v_material_id and district_id = v_district_id
    and feature_version = 'monthly-demand-v1';

  v_cmp := coalesce(v_values[1], 0) * 0.5
         + coalesce(v_values[2], v_values[1], 0) * 0.3
         + coalesce(v_values[3], v_values[2], v_values[1], 0) * 0.2;
  select coalesce(sum(value), 0) into v_avg_4m from unnest(v_values[1:least(4, array_length(v_values, 1))]) value;
  select coalesce(sum(value), 0) into v_avg_6m from unnest(v_values[1:least(6, array_length(v_values, 1))]) value;
  select coalesce(sum(value), 0) into v_avg_12m from unnest(v_values[1:least(12, array_length(v_values, 1))]) value;

  insert into core.usage_rates (
    material_id, district_id, as_of_date, cmp_monthly, avg_12m, avg_6m, avg_4m, source_batch_id
  ) values (
    v_material_id, v_district_id, (v_latest_period + interval '1 month - 1 day')::date,
    v_cmp, v_avg_12m, v_avg_6m, v_avg_4m, v_batch_id
  )
  on conflict (material_id, district_id, as_of_date) do update
  set cmp_monthly = excluded.cmp_monthly,
      avg_12m = excluded.avg_12m,
      avg_6m = excluded.avg_6m,
      avg_4m = excluded.avg_4m,
      source_batch_id = excluded.source_batch_id,
      updated_at = now()
  returning usage_rate_id into v_usage_rate_id;

  if coalesce((p_payload ->> 'run_replenishment')::boolean, false) then
    v_replenishment_run_id := core.create_replenishment_run(v_snapshot_at);
  end if;

  insert into ops.web_input_submissions (
    batch_id, material_id, district_id, source_note, input_month_count,
    stock_snapshot_id, usage_rate_id, replenishment_run_id, submitted_by
  ) values (
    v_batch_id, v_material_id, v_district_id, v_source_note, v_history_count,
    v_stock_snapshot_id, v_usage_rate_id, v_replenishment_run_id, v_user_id
  ) returning submission_id into v_existing.submission_id;

  return jsonb_build_object(
    'submission_id', v_existing.submission_id,
    'batch_id', v_batch_id,
    'stock_snapshot_id', v_stock_snapshot_id,
    'usage_rate_id', v_usage_rate_id,
    'replenishment_run_id', v_replenishment_run_id,
    'history_count', v_history_count,
    'cmp_monthly', v_cmp,
    'forecast_ready', array_length(v_values, 1) >= 14,
    'idempotent', false
  );
end;
$$;

create or replace function public.m10_input_dispatch(
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
  v_limit integer;
  v_count integer;
  v_search text;
  v_method text := upper(coalesce(p_method, ''));
begin
  if v_user_id is null then
    return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
  end if;
  select role::text, district_id into v_role, v_district_id
  from public.user_profiles where user_id = v_user_id and is_active;
  if v_role is null then
    return public.m09_error(403, 'forbidden', 'No application role is assigned', p_request_id);
  end if;

  insert into ops.api_rate_limit_windows (user_id, window_start, request_count)
  values (v_user_id, date_trunc('minute', clock_timestamp()), 1)
  on conflict (user_id, window_start) do update
  set request_count = ops.api_rate_limit_windows.request_count + 1, updated_at = now()
  returning request_count into v_count;
  if v_count > 120 then return public.m09_error(429, 'rate_limited', 'Too many requests', p_request_id); end if;

  if v_method = 'GET' and p_path = '/v1/reference/materials' then
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 1000);
    if v_limit not between 1 and 1000 then return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id); end if;
    v_search := nullif(left(btrim(coalesce(p_query ->> 'search', '')), 100), '');
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload from (
      select material_id, sap_material_id, material_name, category, unit,
             lot_size, moq, data_quality_status
      from core.materials
      where v_search is null or material_id ilike '%' || v_search || '%'
         or coalesce(material_name, '') ilike '%' || v_search || '%'
      order by is_vmi desc, material_id limit v_limit
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/reference/districts' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload from (
      select district_id, sap_plant_code, district_name_th
      from core.districts
      where is_active and (v_role <> 'district' or district_id = v_district_id)
      order by district_id
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/data-inputs/vmi' then
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 50);
    if v_limit not between 1 and 200 then return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id); end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload from (
      select s.submission_id, s.batch_id, s.material_id, m.material_name,
             s.district_id, d.district_name_th, s.source_note, s.input_month_count,
             s.stock_snapshot_id, s.usage_rate_id, s.replenishment_run_id,
             s.submitted_by, s.status, s.created_at
      from ops.web_input_submissions s
      join core.materials m using (material_id)
      join core.districts d using (district_id)
      where v_role <> 'district' or s.district_id = v_district_id
      order by s.created_at desc limit v_limit
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/data-inputs/vmi/context' then
    if btrim(coalesce(p_query ->> 'material_id', '')) = ''
       or btrim(coalesce(p_query ->> 'district_id', '')) = '' then
      return public.m09_error(422, 'validation_error', 'material_id and district_id are required', p_request_id);
    end if;
    if v_role = 'district' and p_query ->> 'district_id' <> v_district_id then
      return public.m09_error(403, 'forbidden', 'District scope does not match the user profile', p_request_id);
    end if;
    select jsonb_build_object(
      'material', (select to_jsonb(m) from (
        select material_id, material_name, unit, lot_size, moq, data_quality_status
        from core.materials where material_id = p_query ->> 'material_id'
      ) m),
      'district', (select to_jsonb(d) from (
        select district_id, sap_plant_code, district_name_th
        from core.districts where district_id = p_query ->> 'district_id' and is_active
      ) d),
      'stock', (select to_jsonb(s) from (
        select ss.quantity_on_hand, ss.snapshot_at, ss.source_batch_id
        from core.stock_snapshots ss
        join core.locations l using (location_id)
        where ss.material_id = p_query ->> 'material_id'
          and l.district_id = p_query ->> 'district_id'
        order by ss.snapshot_at desc limit 1
      ) s),
      'usage_rate', (select to_jsonb(u) from (
        select cmp_monthly, avg_4m, avg_6m, avg_12m, as_of_date, source_batch_id
        from core.usage_rates
        where material_id = p_query ->> 'material_id'
          and district_id = p_query ->> 'district_id'
        order by as_of_date desc limit 1
      ) u),
      'history', coalesce((select jsonb_agg(to_jsonb(h) order by h.period_start) from (
        select period_start, demand_quantity, stockout_days, lead_time_days, source_batch_id
        from analytics.demand_monthly_features
        where material_id = p_query ->> 'material_id'
          and district_id = p_query ->> 'district_id'
          and feature_version = 'monthly-demand-v1'
        order by period_start desc limit 36
      ) h), '[]'::jsonb)
    ) into v_payload;
    if v_payload -> 'material' = 'null'::jsonb or v_payload -> 'district' = 'null'::jsonb then
      return public.m09_error(404, 'not_found', 'Material or district was not found', p_request_id);
    end if;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path = '/v1/data-inputs/vmi' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Only admin or planner may publish operational input', p_request_id);
    end if;
    select core.publish_vmi_web_input(p_body) into v_payload;
    return public.m09_result(201, v_payload);
  end if;

  return public.m09_error(404, 'not_found', 'Input API path not found', p_request_id);
exception
  when raise_exception then
    return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    return public.m09_error(422, 'validation_error', 'Request contains an invalid value', p_request_id);
  when check_violation or foreign_key_violation or unique_violation then
    return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

alter table staging.vmi_input_rows enable row level security;
alter table ops.web_input_submissions enable row level security;
revoke all on staging.vmi_input_rows, ops.web_input_submissions from public, anon, authenticated;
grant all on staging.vmi_input_rows, ops.web_input_submissions to service_role;

revoke all on function core.publish_vmi_web_input(jsonb) from public, anon, authenticated;
revoke all on function public.m10_input_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.m10_input_dispatch(text, text, jsonb, jsonb, text) to authenticated;

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607160010', 'M02-M07-M09-M10',
  'Governed Web input pipeline from Supabase reference masters through Raw, Staging, Stock, usage and demand features.',
  'supabase/migrations/202607160010_m10_web_input_pipeline.sql'
)
on conflict (version) do update
set description = excluded.description, source_file = excluded.source_file;

commit;
