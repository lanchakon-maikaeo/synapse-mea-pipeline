-- SYNAPSE M02/M03/M05/M06/M07/M09/M10: governed import of the real legacy sources
-- documented in synapse/DATABASE.md. Dummy workbooks are intentionally excluded.

begin;

create table if not exists staging.legacy_material_rows (
  source_row_id bigint primary key references raw.source_rows (source_row_id) on delete restrict,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  source_row_number integer not null,
  material_id text not null,
  material_name text,
  unit text,
  validation_status text not null check (validation_status in ('valid', 'warning', 'rejected')),
  loaded_at timestamptz not null default now(),
  unique (batch_id, source_row_number)
);

create table if not exists staging.legacy_stock_rows (
  source_row_id bigint primary key references raw.source_rows (source_row_id) on delete restrict,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  source_row_number integer not null,
  material_id text not null,
  location_id text not null,
  quantity_on_hand numeric not null check (quantity_on_hand >= 0),
  snapshot_at timestamptz not null,
  validation_status text not null check (validation_status in ('valid', 'warning', 'rejected')),
  loaded_at timestamptz not null default now(),
  unique (batch_id, source_row_number)
);

create table if not exists staging.legacy_usage_rows (
  source_row_id bigint primary key references raw.source_rows (source_row_id) on delete restrict,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  source_row_number integer not null,
  material_id text not null,
  sap_plant_code text not null,
  district_id text not null,
  as_of_date date not null,
  cmp_monthly numeric not null check (cmp_monthly >= 0),
  avg_ly numeric check (avg_ly is null or avg_ly >= 0),
  avg_12m numeric check (avg_12m is null or avg_12m >= 0),
  avg_6m numeric check (avg_6m is null or avg_6m >= 0),
  avg_4m numeric check (avg_4m is null or avg_4m >= 0),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  validation_status text not null check (validation_status in ('valid', 'warning', 'rejected')),
  loaded_at timestamptz not null default now(),
  unique (batch_id, source_row_number)
);

create table if not exists ops.legacy_source_imports (
  source_key text primary key check (source_key in ('materials', 'warehouse_stock', 'cmp_usage')),
  batch_id uuid not null unique references raw.import_batches (batch_id) on delete restrict,
  source_url text not null,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  expected_rows integer not null check (expected_rows >= 0),
  loaded_rows integer not null default 0 check (loaded_rows >= 0),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  source_observed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists legacy_usage_series_idx
  on staging.legacy_usage_rows (material_id, district_id, as_of_date desc);

create or replace function public.m11_import_legacy_actual(
  p_source_key text,
  p_source_checksum text,
  p_rows jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, raw, staging, core, analytics, ops, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_batch_id uuid;
  v_run_id uuid;
  v_row jsonb;
  v_payload jsonb;
  v_history_row jsonb;
  v_source_row_id bigint;
  v_row_number integer;
  v_expected_rows integer;
  v_loaded_rows integer;
  v_source_url text;
  v_source_sheet text;
  v_source_entity text;
  v_material_id text;
  v_district_id text;
  v_snapshot_at timestamptz;
  v_as_of_date date;
  v_status text;
begin
  if v_user_id is null then raise exception 'Missing authenticated user'; end if;
  select role::text into v_role from public.user_profiles where user_id = v_user_id and is_active;
  if v_role <> 'admin' then raise exception 'Only admin may import legacy operational sources'; end if;
  if coalesce(p_source_key, '') not in ('materials', 'warehouse_stock', 'cmp_usage') then raise exception 'Unsupported source_key'; end if;
  if coalesce(p_source_checksum, '') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid source checksum'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'rows must contain 1-500 records';
  end if;
  if jsonb_typeof(p_metadata) <> 'object' then raise exception 'metadata must be an object'; end if;

  v_expected_rows := coalesce((p_metadata ->> 'total_rows')::integer, jsonb_array_length(p_rows));
  v_source_url := left(coalesce(nullif(p_metadata ->> 'source_url', ''), 'legacy://synapse/' || p_source_key), 2000);
  v_source_sheet := case p_source_key
    when 'materials' then 'DB_Material'
    when 'warehouse_stock' then 'DB_Stock-WAREHOUSE'
    else 'CMP'
  end;
  v_source_entity := 'legacy_actual_' || p_source_key;

  insert into raw.import_batches (
    source_system, source_file, source_sheet, source_checksum, row_count, status,
    imported_at, connector_name, source_entity, started_at, metadata
  ) values (
    'legacy_google_sheets', v_source_url, v_source_sheet, p_source_checksum,
    v_expected_rows, 'running', now(), 'legacy-http', v_source_entity, now(),
    p_metadata || jsonb_build_object('imported_by', v_user_id, 'dummy_data_excluded', true)
  )
  on conflict (source_checksum, source_sheet) do update
  set row_count = excluded.row_count,
      status = case when raw.import_batches.status = 'succeeded' then 'succeeded' else 'running' end,
      connector_name = excluded.connector_name,
      source_entity = excluded.source_entity,
      metadata = raw.import_batches.metadata || excluded.metadata,
      error_message = null,
      updated_at = now()
  returning batch_id into v_batch_id;

  insert into ops.legacy_source_imports (
    source_key, batch_id, source_url, source_checksum, expected_rows,
    source_observed_at, metadata, status
  ) values (
    p_source_key, v_batch_id, v_source_url, p_source_checksum, v_expected_rows,
    nullif(p_metadata ->> 'source_observed_at', '')::timestamptz,
    p_metadata, 'running'
  )
  on conflict (source_key) do update
  set batch_id = excluded.batch_id,
      source_url = excluded.source_url,
      source_checksum = excluded.source_checksum,
      expected_rows = excluded.expected_rows,
      source_observed_at = excluded.source_observed_at,
      metadata = ops.legacy_source_imports.metadata || excluded.metadata,
      status = 'running',
      finished_at = null,
      updated_at = now();

  select run_id into v_run_id
  from ops.pipeline_runs
  where batch_id = v_batch_id and pipeline_name = 'legacy-actual-' || p_source_key
  order by created_at limit 1;
  if v_run_id is null then
    insert into ops.pipeline_runs (pipeline_name, batch_id, status, started_at)
    values ('legacy-actual-' || p_source_key, v_batch_id, 'running', now())
    returning run_id into v_run_id;
  else
    update ops.pipeline_runs
    set status = 'running', error_message = null, updated_at = now()
    where run_id = v_run_id;
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row) <> 'object' then raise exception 'Each row must be an object'; end if;
    v_row_number := (v_row ->> 'row_number')::integer;
    if v_row_number < 1 or v_row_number > v_expected_rows then raise exception 'row_number is out of range'; end if;
    v_payload := v_row - 'row_number';

    insert into raw.source_rows (
      batch_id, source_entity, source_sheet, source_row_number, row_hash, payload
    ) values (
      v_batch_id, v_source_entity, v_source_sheet, v_row_number,
      encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex'),
      v_payload
    )
    on conflict (batch_id, source_entity, source_row_number) do nothing
    returning source_row_id into v_source_row_id;
    if v_source_row_id is null then
      select source_row_id into v_source_row_id
      from raw.source_rows
      where batch_id = v_batch_id and source_entity = v_source_entity and source_row_number = v_row_number;
    end if;

    v_material_id := btrim(coalesce(v_row ->> 'material_id', ''));
    if v_material_id = '' then raise exception 'material_id is required'; end if;

    if p_source_key = 'materials' then
      insert into staging.legacy_material_rows (
        source_row_id, batch_id, source_row_number, material_id, material_name, unit, validation_status
      ) values (
        v_source_row_id, v_batch_id, v_row_number, v_material_id,
        nullif(btrim(v_row ->> 'material_name'), ''), nullif(btrim(v_row ->> 'unit'), ''),
        case when v_material_id ~ '^[0-9]{12}$' and nullif(btrim(v_row ->> 'material_name'), '') is not null
             then 'valid' else 'warning' end
      )
      on conflict (source_row_id) do update
      set material_name = excluded.material_name,
          unit = excluded.unit,
          validation_status = excluded.validation_status,
          loaded_at = now();

      insert into core.materials (
        material_id, sap_material_id, material_name, unit, lot_size, moq,
        is_vmi, master_source, data_quality_status, source_batch_id
      ) values (
        v_material_id, case when v_material_id ~ '^[0-9]{12}$' then v_material_id end,
        nullif(btrim(v_row ->> 'material_name'), ''), nullif(btrim(v_row ->> 'unit'), ''), 1, 1,
        true, 'material_master',
        case when v_material_id ~ '^[0-9]{12}$' and nullif(btrim(v_row ->> 'material_name'), '') is not null
             then 'valid' else 'warning' end,
        v_batch_id
      )
      on conflict (material_id) do update
      set sap_material_id = coalesce(excluded.sap_material_id, core.materials.sap_material_id),
          material_name = coalesce(excluded.material_name, core.materials.material_name),
          unit = coalesce(excluded.unit, core.materials.unit),
          is_vmi = true,
          master_source = 'material_master',
          data_quality_status = excluded.data_quality_status,
          source_batch_id = excluded.source_batch_id,
          updated_at = now();

    elsif p_source_key = 'warehouse_stock' then
      v_snapshot_at := (v_row ->> 'snapshot_at')::timestamptz;
      if (v_row ->> 'quantity_on_hand')::numeric < 0 then raise exception 'Stock quantity must be non-negative'; end if;

      insert into core.materials (
        material_id, sap_material_id, is_vmi, master_source, data_quality_status, source_batch_id
      ) values (
        v_material_id, case when v_material_id ~ '^[0-9]{12}$' then v_material_id end,
        true, 'material_master', 'warning', v_batch_id
      )
      on conflict (material_id) do update set is_vmi = true, updated_at = now();

      insert into staging.legacy_stock_rows (
        source_row_id, batch_id, source_row_number, material_id, location_id,
        quantity_on_hand, snapshot_at, validation_status
      ) values (
        v_source_row_id, v_batch_id, v_row_number, v_material_id, 'WH-KT',
        (v_row ->> 'quantity_on_hand')::numeric, v_snapshot_at, 'valid'
      )
      on conflict (source_row_id) do update
      set quantity_on_hand = excluded.quantity_on_hand,
          snapshot_at = excluded.snapshot_at,
          loaded_at = now();

      insert into core.stock_snapshots (
        material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id
      ) values (
        v_material_id, 'WH-KT', (v_row ->> 'quantity_on_hand')::numeric, v_snapshot_at, v_batch_id
      )
      on conflict (material_id, location_id, snapshot_at) do update
      set quantity_on_hand = excluded.quantity_on_hand,
          source_batch_id = excluded.source_batch_id;

    else
      v_district_id := btrim(coalesce(v_row ->> 'district_id', ''));
      v_as_of_date := (v_row ->> 'as_of_date')::date;
      if not exists (
        select 1 from core.districts
        where district_id = v_district_id and sap_plant_code = v_row ->> 'sap_plant_code' and is_active
      ) then raise exception 'CMP row has an invalid district mapping'; end if;
      if (v_row ->> 'cmp_monthly')::numeric < 0 then raise exception 'CMP must be non-negative'; end if;

      insert into core.materials (
        material_id, sap_material_id, is_vmi, master_source, data_quality_status, source_batch_id
      ) values (
        v_material_id, case when v_material_id ~ '^[0-9]{12}$' then v_material_id end,
        true, 'material_master', 'warning', v_batch_id
      )
      on conflict (material_id) do update set is_vmi = true, updated_at = now();

      if jsonb_typeof(coalesce(v_row -> 'history', '[]'::jsonb)) <> 'array' then
        raise exception 'history must be an array';
      end if;

      insert into staging.legacy_usage_rows (
        source_row_id, batch_id, source_row_number, material_id, sap_plant_code, district_id,
        as_of_date, cmp_monthly, avg_ly, avg_12m, avg_6m, avg_4m, history, validation_status
      ) values (
        v_source_row_id, v_batch_id, v_row_number, v_material_id, v_row ->> 'sap_plant_code', v_district_id,
        v_as_of_date, (v_row ->> 'cmp_monthly')::numeric,
        nullif(v_row ->> 'avg_ly', '')::numeric, nullif(v_row ->> 'avg_12m', '')::numeric,
        nullif(v_row ->> 'avg_6m', '')::numeric, nullif(v_row ->> 'avg_4m', '')::numeric,
        coalesce(v_row -> 'history', '[]'::jsonb),
        case when jsonb_array_length(coalesce(v_row -> 'history', '[]'::jsonb)) >= 3 then 'valid' else 'warning' end
      )
      on conflict (source_row_id) do update
      set cmp_monthly = excluded.cmp_monthly,
          avg_ly = excluded.avg_ly,
          avg_12m = excluded.avg_12m,
          avg_6m = excluded.avg_6m,
          avg_4m = excluded.avg_4m,
          history = excluded.history,
          validation_status = excluded.validation_status,
          loaded_at = now();

      insert into core.usage_rates (
        material_id, district_id, as_of_date, cmp_monthly,
        avg_ly, avg_12m, avg_6m, avg_4m, source_batch_id
      ) values (
        v_material_id, v_district_id, v_as_of_date, (v_row ->> 'cmp_monthly')::numeric,
        nullif(v_row ->> 'avg_ly', '')::numeric, nullif(v_row ->> 'avg_12m', '')::numeric,
        nullif(v_row ->> 'avg_6m', '')::numeric, nullif(v_row ->> 'avg_4m', '')::numeric,
        v_batch_id
      )
      on conflict (material_id, district_id, as_of_date) do update
      set cmp_monthly = excluded.cmp_monthly,
          avg_ly = excluded.avg_ly,
          avg_12m = excluded.avg_12m,
          avg_6m = excluded.avg_6m,
          avg_4m = excluded.avg_4m,
          source_batch_id = excluded.source_batch_id,
          updated_at = now();

      for v_history_row in select value from jsonb_array_elements(coalesce(v_row -> 'history', '[]'::jsonb))
      loop
        if coalesce(v_history_row ->> 'period', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
           or (v_history_row ->> 'demand_quantity')::numeric < 0 then
          raise exception 'Invalid monthly history row';
        end if;
        insert into analytics.demand_monthly_features (
          material_id, district_id, period_start, demand_quantity,
          stockout_days, source_batch_id, feature_version
        ) values (
          v_material_id, v_district_id,
          to_date((v_history_row ->> 'period') || '-01', 'YYYY-MM-DD'),
          (v_history_row ->> 'demand_quantity')::numeric,
          0, v_batch_id, 'monthly-demand-v1'
        )
        on conflict (material_id, district_id, period_start, feature_version) do update
        set demand_quantity = excluded.demand_quantity,
            source_batch_id = excluded.source_batch_id,
            updated_at = now();
      end loop;
    end if;
  end loop;

  select count(*) into v_loaded_rows
  from raw.source_rows
  where batch_id = v_batch_id and source_entity = v_source_entity;
  v_status := case when v_loaded_rows >= v_expected_rows then 'succeeded' else 'running' end;

  update raw.import_batches
  set row_count = v_expected_rows,
      status = v_status,
      imported_at = case when v_status = 'succeeded' then now() else imported_at end,
      finished_at = case when v_status = 'succeeded' then now() else null end,
      updated_at = now()
  where batch_id = v_batch_id;

  update ops.legacy_source_imports
  set loaded_rows = v_loaded_rows,
      status = v_status,
      finished_at = case when v_status = 'succeeded' then now() else null end,
      updated_at = now()
  where source_key = p_source_key;

  update ops.pipeline_runs
  set status = v_status,
      rows_read = v_loaded_rows,
      rows_written = v_loaded_rows,
      finished_at = case when v_status = 'succeeded' then now() else null end,
      metrics = jsonb_build_object('expected_rows', v_expected_rows, 'source_checksum', p_source_checksum),
      updated_at = now()
  where run_id = v_run_id;

  return jsonb_build_object(
    'source_key', p_source_key,
    'batch_id', v_batch_id,
    'expected_rows', v_expected_rows,
    'loaded_rows', v_loaded_rows,
    'status', v_status
  );
exception when others then
  if v_batch_id is not null then
    update raw.import_batches set status = 'failed', error_message = left(sqlerrm, 1000), finished_at = now(), updated_at = now()
    where batch_id = v_batch_id;
    update ops.legacy_source_imports set status = 'failed', finished_at = now(), updated_at = now()
    where batch_id = v_batch_id;
    update ops.pipeline_runs set status = 'failed', error_message = left(sqlerrm, 1000), finished_at = now(), updated_at = now()
    where run_id = v_run_id;
  end if;
  raise;
end;
$$;

create or replace function public.m11_legacy_dispatch(
  p_method text,
  p_path text,
  p_query jsonb default '{}'::jsonb,
  p_body jsonb default '{}'::jsonb,
  p_request_id text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core, analytics, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_payload jsonb;
  v_limit integer;
  v_search text;
  v_count integer;
  v_method text := upper(coalesce(p_method, ''));
begin
  if v_user_id is null then
    return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
  end if;
  select role::text into v_role from public.user_profiles where user_id = v_user_id and is_active;
  if v_role is null then return public.m09_error(403, 'forbidden', 'No application role is assigned', p_request_id); end if;

  insert into ops.api_rate_limit_windows (user_id, window_start, request_count)
  values (v_user_id, date_trunc('minute', clock_timestamp()), 1)
  on conflict (user_id, window_start) do update
  set request_count = ops.api_rate_limit_windows.request_count + 1, updated_at = now()
  returning request_count into v_count;
  if v_count > 120 then return public.m09_error(429, 'rate_limited', 'Too many requests', p_request_id); end if;

  if v_method = 'GET' and p_path = '/v1/reference/materials' then
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 1200);
    if v_limit not between 1 and 2000 then return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id); end if;
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

  if v_method = 'GET' and p_path = '/v1/warehouse-stock' then
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 500);
    if v_limit not between 1 and 1000 then return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id); end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_payload from (
      select distinct on (s.material_id, s.location_id)
        s.material_id, m.material_name, m.unit, s.location_id, l.location_name_th,
        s.quantity_on_hand, s.snapshot_at, s.source_batch_id
      from core.stock_snapshots s
      join core.locations l using (location_id)
      join core.materials m using (material_id)
      where l.location_type = 'WAREHOUSE'
      order by s.material_id, s.location_id, s.snapshot_at desc
      limit v_limit
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/data-sources/legacy/status' then
    select jsonb_build_object(
      'sources', coalesce((select jsonb_agg(to_jsonb(s) order by source_key) from (
        select source_key, source_url, expected_rows, loaded_rows, status,
               source_observed_at, started_at, finished_at, updated_at
        from ops.legacy_source_imports
      ) s), '[]'::jsonb),
      'totals', jsonb_build_object(
        'materials', (select count(*) from core.materials where is_vmi),
        'warehouse_stock_snapshots', (select count(*) from core.stock_snapshots ss join core.locations l using (location_id) where l.location_type = 'WAREHOUSE'),
        'district_stock_snapshots', (select count(*) from core.stock_snapshots ss join core.locations l using (location_id) where l.location_type = 'DISTRICT'),
        'usage_rates', (select count(*) from core.usage_rates),
        'monthly_demand_rows', (select count(*) from analytics.demand_monthly_features where feature_version = 'monthly-demand-v1'),
        'forecast_ready_series', (select count(*) from (
          select material_id, district_id from analytics.demand_monthly_features
          where feature_version = 'monthly-demand-v1'
          group by material_id, district_id having count(*) >= 14
        ) r)
      ),
      'warnings', case when not exists (
        select 1 from core.stock_snapshots ss join core.locations l using (location_id) where l.location_type = 'DISTRICT'
      ) then jsonb_build_array('District Stock source is not available; Apps Script dist_stock currently returns an error and no value was fabricated.')
      else '[]'::jsonb end
    ) into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path = '/v1/admin/import/legacy' then
    if v_role <> 'admin' then return public.m09_error(403, 'forbidden', 'Only admin may import legacy sources', p_request_id); end if;
    select public.m11_import_legacy_actual(
      p_body ->> 'source_key', p_body ->> 'source_checksum', p_body -> 'rows', coalesce(p_body -> 'metadata', '{}'::jsonb)
    ) into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  return public.m09_error(404, 'not_found', 'Legacy source API path not found', p_request_id);
exception
  when raise_exception then return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    return public.m09_error(422, 'validation_error', 'Request contains an invalid value', p_request_id);
  when others then return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

alter table staging.legacy_material_rows enable row level security;
alter table staging.legacy_stock_rows enable row level security;
alter table staging.legacy_usage_rows enable row level security;
alter table ops.legacy_source_imports enable row level security;

revoke all on staging.legacy_material_rows, staging.legacy_stock_rows,
  staging.legacy_usage_rows, ops.legacy_source_imports from public, anon, authenticated;
grant all on staging.legacy_material_rows, staging.legacy_stock_rows,
  staging.legacy_usage_rows, ops.legacy_source_imports to service_role;

revoke all on function public.m11_import_legacy_actual(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.m11_legacy_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.m11_import_legacy_actual(text, text, jsonb, jsonb) to authenticated;
grant execute on function public.m11_legacy_dispatch(text, text, jsonb, jsonb, text) to authenticated;

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607160011', 'M02-M07-M09-M10',
  'Governed import and Web visibility for real legacy Material, warehouse Stock and CMP/monthly usage sources.',
  'supabase/migrations/202607160011_legacy_actual_sources.sql'
)
on conflict (version) do update
set description = excluded.description, source_file = excluded.source_file;

commit;
