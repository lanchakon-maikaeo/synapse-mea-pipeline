-- SYNAPSE M16: governed TEST_FIXTURE data for UAT.
-- Dummy workbook values may fill test-environment gaps, but must never be
-- presented as Actual SAP evidence or overwrite an existing actual record.

begin;

alter table core.stock_snapshots
  add column if not exists data_class text not null default 'actual';
alter table core.stock_snapshots
  drop constraint if exists stock_snapshots_data_class_check;
alter table core.stock_snapshots
  add constraint stock_snapshots_data_class_check
  check (data_class in ('actual', 'test_fixture'));

alter table core.usage_rates
  add column if not exists data_class text not null default 'actual';
alter table core.usage_rates
  drop constraint if exists usage_rates_data_class_check;
alter table core.usage_rates
  add constraint usage_rates_data_class_check
  check (data_class in ('actual', 'test_fixture'));

alter table core.packaging_profiles
  add column if not exists data_class text not null default 'actual',
  add column if not exists source_batch_id uuid references raw.import_batches (batch_id) on delete restrict;
alter table core.packaging_profiles
  drop constraint if exists packaging_profiles_data_class_check;
alter table core.packaging_profiles
  add constraint packaging_profiles_data_class_check
  check (data_class in ('actual', 'test_fixture'));

alter table core.replenishment_items
  add column if not exists input_data_class text not null default 'actual';
alter table core.replenishment_items
  drop constraint if exists replenishment_items_input_data_class_check;
alter table core.replenishment_items
  add constraint replenishment_items_input_data_class_check
  check (input_data_class in ('actual', 'test_fixture', 'mixed'));

alter table ops.quantity_recommendations
  drop constraint if exists quantity_recommendations_source_freshness_status_check;
alter table ops.quantity_recommendations
  add constraint quantity_recommendations_source_freshness_status_check
  check (
    source_freshness_status in (
      'fresh',
      'source_missing_assumed_zero',
      'stale',
      'test_fixture',
      'mixed_fixture'
    )
  );

create table if not exists ops.test_fixture_imports (
  source_key text primary key
    check (source_key in ('materials', 'packaging', 'district_stock', 'usage')),
  batch_id uuid not null unique references raw.import_batches (batch_id) on delete restrict,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  source_sheet text not null,
  expected_rows integer not null check (expected_rows >= 0),
  loaded_rows integer not null default 0 check (loaded_rows >= 0),
  promoted_rows integer not null default 0 check (promoted_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'rolled_back')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rolled_back_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists ops.test_fixture_material_overrides (
  override_id bigint generated always as identity primary key,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  material_id text not null references core.materials (material_id) on delete restrict,
  previous_values jsonb not null check (jsonb_typeof(previous_values) = 'object'),
  applied_values jsonb not null check (jsonb_typeof(applied_values) = 'object'),
  applied_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  unique (batch_id, material_id)
);

create or replace function core.classify_replenishment_item_input()
returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
declare
  v_stock_class text;
  v_usage_class text;
begin
  select data_class into v_stock_class
  from core.stock_snapshots
  where snapshot_id = new.source_stock_snapshot_id;

  select data_class into v_usage_class
  from core.usage_rates
  where usage_rate_id = new.source_usage_rate_id;

  new.input_data_class := case
    when v_stock_class = 'test_fixture' and v_usage_class = 'test_fixture'
      then 'test_fixture'
    when v_stock_class = 'test_fixture' or v_usage_class = 'test_fixture'
      then 'mixed'
    else 'actual'
  end;
  return new;
end;
$$;

drop trigger if exists classify_replenishment_item_input on core.replenishment_items;
create trigger classify_replenishment_item_input
  before insert or update of source_stock_snapshot_id, source_usage_rate_id
  on core.replenishment_items
  for each row execute function core.classify_replenishment_item_input();

create or replace function ops.classify_quantity_recommendation_source()
returns trigger
language plpgsql
set search_path = pg_catalog, core, ops
as $$
declare
  v_input_data_class text;
begin
  select input_data_class into v_input_data_class
  from core.replenishment_items
  where replenishment_item_id = new.replenishment_item_id;

  if v_input_data_class = 'test_fixture' then
    new.source_freshness_status := 'test_fixture';
  elsif v_input_data_class = 'mixed' then
    new.source_freshness_status := 'mixed_fixture';
  end if;
  return new;
end;
$$;

drop trigger if exists classify_quantity_recommendation_source on ops.quantity_recommendations;
create trigger classify_quantity_recommendation_source
  before insert or update of replenishment_item_id, source_freshness_status
  on ops.quantity_recommendations
  for each row execute function ops.classify_quantity_recommendation_source();

create or replace view analytics.v_stock_health
with (security_invoker = true)
as
with latest_location_snapshot as (
  select distinct on (s.material_id, s.location_id)
    s.snapshot_id,
    s.material_id,
    s.location_id,
    l.district_id,
    s.quantity_on_hand,
    s.snapshot_at,
    s.source_batch_id,
    s.data_class
  from core.stock_snapshots s
  join core.locations l using (location_id)
  where l.location_type = 'DISTRICT'
  order by s.material_id, s.location_id, s.snapshot_at desc, s.snapshot_id
), district_stock as (
  select
    material_id,
    district_id,
    (array_agg(snapshot_id order by snapshot_at desc, snapshot_id))[1] as snapshot_id,
    sum(quantity_on_hand) as quantity_on_hand,
    max(snapshot_at) as snapshot_at,
    (array_agg(source_batch_id order by snapshot_at desc)
      filter (where source_batch_id is not null))[1] as source_batch_id,
    case
      when count(distinct data_class) > 1 then 'mixed'
      when bool_or(data_class = 'test_fixture') then 'test_fixture'
      else 'actual'
    end as data_class
  from latest_location_snapshot
  group by material_id, district_id
), latest_usage as (
  select distinct on (u.material_id, u.district_id)
    u.usage_rate_id,
    u.material_id,
    u.district_id,
    u.as_of_date,
    u.cmp_monthly,
    u.avg_ly,
    u.avg_12m,
    u.avg_6m,
    u.avg_4m,
    u.source_batch_id,
    u.data_class
  from core.usage_rates u
  order by u.material_id, u.district_id, u.as_of_date desc, u.updated_at desc
)
select
  s.snapshot_id,
  u.usage_rate_id,
  m.material_id,
  m.material_name,
  d.district_id,
  d.district_name_th,
  coalesce(s.quantity_on_hand, 0) as current_stock_qty,
  s.snapshot_at,
  u.as_of_date as usage_as_of_date,
  u.cmp_monthly,
  u.avg_4m,
  u.avg_6m,
  case
    when u.cmp_monthly > 0
      then round(coalesce(s.quantity_on_hand, 0) / u.cmp_monthly, 1)
  end as months_available,
  case
    when u.cmp_monthly is null or u.cmp_monthly = 0 then 'unknown'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly < 1.5 then 'critical'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly < 3.5 then 'watch'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly > 6 then 'overstock'
    else 'healthy'
  end as health_band,
  u.avg_ly,
  u.avg_12m,
  s.snapshot_id is null as source_stock_missing,
  case
    when s.snapshot_id is null then 'Source Missing / Assumed 0'
    when s.data_class in ('test_fixture', 'mixed')
      then 'TEST FIXTURE — Not Actual SAP Stock'
    else 'Actual Unrestricted Stock'
  end as stock_source_status,
  s.source_batch_id as stock_source_batch_id,
  u.source_batch_id as usage_source_batch_id,
  coalesce(s.data_class, 'source_missing') as stock_data_class,
  coalesce(u.data_class, 'source_missing') as usage_data_class,
  case
    when s.data_class = 'test_fixture' and u.data_class = 'test_fixture'
      then 'test_fixture'
    when s.data_class = 'test_fixture' or u.data_class = 'test_fixture'
      then 'mixed'
    else 'actual'
  end as input_data_class,
  coalesce(s.data_class = 'test_fixture', false)
    or coalesce(u.data_class = 'test_fixture', false) as fixture_backed
from core.materials m
cross join core.districts d
left join district_stock s
  on s.material_id = m.material_id and s.district_id = d.district_id
left join latest_usage u
  on u.material_id = m.material_id and u.district_id = d.district_id
where m.is_vmi
  and d.is_active;

create or replace function public.m16_import_test_fixture(
  p_source_key text,
  p_source_checksum text,
  p_rows jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, raw, core, ops, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_batch_id uuid;
  v_row jsonb;
  v_payload jsonb;
  v_source_row_id bigint;
  v_row_number integer;
  v_expected_rows integer;
  v_loaded_rows integer;
  v_promoted_rows integer;
  v_source_sheet text;
  v_source_entity text;
  v_material_id text;
  v_district_id text;
  v_location_id text;
  v_affected integer;
  v_status text;
  v_previous jsonb;
  v_applied jsonb;
begin
  if not exists (
    select 1 from ops.environment_registry
    where environment_name = 'test' and project_ref = 'mklnbumfwojxhqscthjd'
  ) then
    raise exception 'TEST_FIXTURE import is allowed only in the registered test environment';
  end if;

  if v_user_id is not null then
    select role::text into v_role
    from public.user_profiles
    where user_id = v_user_id and is_active;
    if v_role <> 'admin' then
      raise exception 'Only admin may import TEST_FIXTURE data';
    end if;
  elsif current_user not in ('postgres', 'service_role') then
    raise exception 'Missing authenticated admin';
  end if;

  if coalesce(p_source_key, '') not in ('materials', 'packaging', 'district_stock', 'usage') then
    raise exception 'Unsupported TEST_FIXTURE source_key';
  end if;
  if coalesce(p_source_checksum, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid source checksum';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'rows must contain 1-500 records';
  end if;
  if jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be an object';
  end if;

  v_expected_rows := coalesce(
    nullif(p_metadata ->> 'total_rows', '')::integer,
    jsonb_array_length(p_rows)
  );
  v_source_sheet := case p_source_key
    when 'materials' then 'DB_Material'
    when 'packaging' then 'DB_Contract_Static'
    when 'district_stock' then 'DB_Stock-DISTRICT'
    else 'DB_SAP_Monthly'
  end;
  v_source_entity := 'test_fixture_' || p_source_key;

  insert into raw.import_batches (
    source_system, source_file, source_sheet, source_checksum,
    source_file_size_bytes, row_count, status, imported_at,
    connector_name, source_entity, started_at, metadata
  ) values (
    'test_fixture_excel',
    coalesce(nullif(p_metadata ->> 'source_file', ''), 'MEA_VMI_Dummy_Klongtoey.xlsx'),
    v_source_sheet,
    p_source_checksum,
    nullif(p_metadata ->> 'source_file_size_bytes', '')::bigint,
    v_expected_rows,
    'running',
    now(),
    'test-fixture-xlsx',
    v_source_entity,
    now(),
    p_metadata || jsonb_build_object(
      'data_class', 'TEST_FIXTURE',
      'not_actual_sap', true,
      'imported_by', v_user_id
    )
  )
  on conflict (source_checksum, source_sheet) do update
  set row_count = excluded.row_count,
      status = case
        when raw.import_batches.status = 'succeeded' then 'succeeded'
        else 'running'
      end,
      metadata = raw.import_batches.metadata || excluded.metadata,
      error_message = null,
      updated_at = now()
  returning batch_id into v_batch_id;

  insert into ops.test_fixture_imports (
    source_key, batch_id, source_checksum, source_sheet,
    expected_rows, status, metadata
  ) values (
    p_source_key, v_batch_id, p_source_checksum, v_source_sheet,
    v_expected_rows, 'running', p_metadata
  )
  on conflict (source_key) do update
  set batch_id = excluded.batch_id,
      source_checksum = excluded.source_checksum,
      source_sheet = excluded.source_sheet,
      expected_rows = excluded.expected_rows,
      status = case
        when ops.test_fixture_imports.batch_id = excluded.batch_id
          and ops.test_fixture_imports.status = 'succeeded'
          then 'succeeded'
        else 'running'
      end,
      metadata = ops.test_fixture_imports.metadata || excluded.metadata,
      finished_at = null,
      rolled_back_at = null,
      updated_at = now();

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'Each row must be an object';
    end if;
    v_row_number := (v_row ->> 'row_number')::integer;
    if v_row_number < 1 or v_row_number > v_expected_rows then
      raise exception 'row_number is out of range';
    end if;
    v_payload := v_row - 'row_number';

    insert into raw.source_rows (
      batch_id, source_entity, source_sheet, source_row_number, row_hash, payload
    ) values (
      v_batch_id, v_source_entity, v_source_sheet, v_row_number,
      encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex'),
      v_payload
    )
    on conflict (batch_id, source_entity, source_row_number) do update
    set row_hash = excluded.row_hash,
        payload = excluded.payload;

    v_material_id := btrim(coalesce(v_row ->> 'material_id', ''));
    if v_material_id = '' then
      raise exception 'material_id is required';
    end if;

    if p_source_key = 'materials' then
      select jsonb_build_object(
        'material_name', material_name,
        'category', category,
        'unit', unit,
        'weight_per_unit_kg', weight_per_unit_kg,
        'lot_size', lot_size,
        'moq', moq,
        'data_quality_status', data_quality_status
      )
      into v_previous
      from core.materials
      where material_id = v_material_id;

      if v_previous is not null then
        select jsonb_build_object(
          'material_name', coalesce(nullif(v_previous ->> 'material_name', ''), nullif(v_row ->> 'material_name', '')),
          'category', coalesce(nullif(v_previous ->> 'category', ''), nullif(v_row ->> 'category', '')),
          'unit', coalesce(nullif(v_previous ->> 'unit', ''), nullif(v_row ->> 'unit', '')),
          'weight_per_unit_kg', case
            when coalesce(nullif(v_previous ->> 'weight_per_unit_kg', '')::numeric, 0) <= 0
              then nullif(v_row ->> 'weight_per_unit_kg', '')::numeric
            else (v_previous ->> 'weight_per_unit_kg')::numeric
          end,
          'lot_size', case
            when coalesce(nullif(v_previous ->> 'lot_size', '')::numeric, 0) <= 0
              then nullif(v_row ->> 'lot_size', '')::numeric
            else (v_previous ->> 'lot_size')::numeric
          end,
          'moq', case
            when coalesce(nullif(v_previous ->> 'moq', '')::numeric, 0) <= 0
              then nullif(v_row ->> 'moq', '')::numeric
            else (v_previous ->> 'moq')::numeric
          end,
          'data_quality_status', 'warning'
        ) into v_applied;

        if (v_previous - 'data_quality_status')
           is distinct from (v_applied - 'data_quality_status') then
          insert into ops.test_fixture_material_overrides (
            batch_id, material_id, previous_values, applied_values
          ) values (
            v_batch_id, v_material_id, v_previous, v_applied
          )
          on conflict (batch_id, material_id) do update
          set applied_values = excluded.applied_values,
              rolled_back_at = null;

          update core.materials
          set material_name = v_applied ->> 'material_name',
              category = v_applied ->> 'category',
              unit = v_applied ->> 'unit',
              weight_per_unit_kg = nullif(v_applied ->> 'weight_per_unit_kg', '')::numeric,
              lot_size = nullif(v_applied ->> 'lot_size', '')::numeric,
              moq = nullif(v_applied ->> 'moq', '')::numeric,
              data_quality_status = 'warning',
              updated_at = now()
          where material_id = v_material_id;
        end if;
      end if;

    elsif p_source_key = 'packaging' then
      insert into core.packaging_profiles (
        material_id, full_pallet_qty, inner_pack_qty, base_uom,
        allows_partial_issue, source_reference, verified_at,
        data_class, source_batch_id
      )
      select
        m.material_id,
        nullif(v_row ->> 'full_pallet_qty', '')::numeric,
        nullif(v_row ->> 'inner_pack_qty', '')::numeric,
        coalesce(nullif(v_row ->> 'base_uom', ''), m.unit, 'EA'),
        true,
        'TEST_FIXTURE:MEA_VMI_Dummy_Klongtoey.xlsx#DB_Contract_Static',
        null,
        'test_fixture',
        v_batch_id
      from core.materials m
      where m.material_id = v_material_id
      on conflict (material_id) do update
      set full_pallet_qty = excluded.full_pallet_qty,
          inner_pack_qty = excluded.inner_pack_qty,
          base_uom = excluded.base_uom,
          allows_partial_issue = excluded.allows_partial_issue,
          source_reference = excluded.source_reference,
          data_class = excluded.data_class,
          source_batch_id = excluded.source_batch_id,
          updated_at = now()
      where core.packaging_profiles.data_class = 'test_fixture';

    elsif p_source_key = 'district_stock' then
      v_district_id := btrim(coalesce(v_row ->> 'district_id', ''));
      v_location_id := 'DIST-' || v_district_id;
      insert into core.stock_snapshots (
        material_id, location_id, quantity_on_hand, snapshot_at,
        source_batch_id, data_class
      )
      select
        v_material_id,
        v_location_id,
        (v_row ->> 'quantity_on_hand')::numeric,
        (v_row ->> 'snapshot_at')::timestamptz,
        v_batch_id,
        'test_fixture'
      where exists (
        select 1 from core.materials where material_id = v_material_id
      )
      and exists (
        select 1 from core.locations
        where location_id = v_location_id
          and district_id = v_district_id
          and location_type = 'DISTRICT'
          and is_active
      )
      on conflict (material_id, location_id, snapshot_at) do update
      set quantity_on_hand = excluded.quantity_on_hand,
          source_batch_id = excluded.source_batch_id,
          data_class = excluded.data_class
      where core.stock_snapshots.data_class = 'test_fixture';

    else
      v_district_id := btrim(coalesce(v_row ->> 'district_id', ''));
      insert into core.usage_rates (
        material_id, district_id, as_of_date, cmp_monthly,
        avg_ly, avg_12m, avg_6m, avg_4m, source_batch_id, data_class
      )
      select
        v_material_id,
        v_district_id,
        (v_row ->> 'as_of_date')::date,
        (v_row ->> 'cmp_monthly')::numeric,
        nullif(v_row ->> 'avg_ly', '')::numeric,
        nullif(v_row ->> 'avg_12m', '')::numeric,
        nullif(v_row ->> 'avg_6m', '')::numeric,
        nullif(v_row ->> 'avg_4m', '')::numeric,
        v_batch_id,
        'test_fixture'
      where exists (
        select 1 from core.materials where material_id = v_material_id
      )
      and exists (
        select 1 from core.districts
        where district_id = v_district_id and is_active
      )
      on conflict (material_id, district_id, as_of_date) do update
      set cmp_monthly = excluded.cmp_monthly,
          avg_ly = excluded.avg_ly,
          avg_12m = excluded.avg_12m,
          avg_6m = excluded.avg_6m,
          avg_4m = excluded.avg_4m,
          source_batch_id = excluded.source_batch_id,
          data_class = excluded.data_class,
          updated_at = now()
      where core.usage_rates.data_class = 'test_fixture';
    end if;
  end loop;

  select count(*) into v_loaded_rows
  from raw.source_rows
  where batch_id = v_batch_id and source_entity = v_source_entity;

  v_promoted_rows := case p_source_key
    when 'materials' then (
      select count(*) from ops.test_fixture_material_overrides
      where batch_id = v_batch_id and rolled_back_at is null
    )
    when 'packaging' then (
      select count(*) from core.packaging_profiles
      where source_batch_id = v_batch_id and data_class = 'test_fixture'
    )
    when 'district_stock' then (
      select count(*) from core.stock_snapshots
      where source_batch_id = v_batch_id and data_class = 'test_fixture'
    )
    else (
      select count(*) from core.usage_rates
      where source_batch_id = v_batch_id and data_class = 'test_fixture'
    )
  end;
  v_status := case
    when v_loaded_rows >= v_expected_rows then 'succeeded'
    else 'running'
  end;

  update raw.import_batches
  set row_count = v_expected_rows,
      status = v_status,
      imported_at = case when v_status = 'succeeded' then now() else imported_at end,
      finished_at = case when v_status = 'succeeded' then now() else null end,
      updated_at = now()
  where batch_id = v_batch_id;

  update ops.test_fixture_imports
  set loaded_rows = v_loaded_rows,
      promoted_rows = v_promoted_rows,
      skipped_rows = greatest(v_loaded_rows - v_promoted_rows, 0),
      status = v_status,
      finished_at = case when v_status = 'succeeded' then now() else null end,
      updated_at = now()
  where source_key = p_source_key;

  return jsonb_build_object(
    'source_key', p_source_key,
    'batch_id', v_batch_id,
    'expected_rows', v_expected_rows,
    'loaded_rows', v_loaded_rows,
    'promoted_rows', v_promoted_rows,
    'skipped_rows', greatest(v_loaded_rows - v_promoted_rows, 0),
    'status', v_status,
    'data_class', 'TEST_FIXTURE'
  );
exception when others then
  if v_batch_id is not null then
    update raw.import_batches
    set status = 'failed',
        error_message = left(sqlerrm, 1000),
        finished_at = now(),
        updated_at = now()
    where batch_id = v_batch_id;

    update ops.test_fixture_imports
    set status = 'failed',
        finished_at = now(),
        updated_at = now()
    where batch_id = v_batch_id;
  end if;
  raise;
end;
$$;

create or replace function public.m16_rollback_test_fixture(p_source_checksum text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, raw, core, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_batch_ids uuid[];
  v_stock_deleted integer := 0;
  v_usage_deleted integer := 0;
  v_packaging_deleted integer := 0;
  v_materials_restored integer := 0;
begin
  if v_user_id is not null then
    select role::text into v_role
    from public.user_profiles
    where user_id = v_user_id and is_active;
    if v_role <> 'admin' then
      raise exception 'Only admin may roll back TEST_FIXTURE data';
    end if;
  elsif current_user not in ('postgres', 'service_role') then
    raise exception 'Missing authenticated admin';
  end if;

  select array_agg(batch_id) into v_batch_ids
  from ops.test_fixture_imports
  where source_checksum = p_source_checksum
    and status <> 'rolled_back';
  if v_batch_ids is null then
    raise exception 'No active TEST_FIXTURE import found for checksum';
  end if;

  if exists (
    select 1
    from core.replenishment_items i
    left join core.stock_snapshots s on s.snapshot_id = i.source_stock_snapshot_id
    left join core.usage_rates u on u.usage_rate_id = i.source_usage_rate_id
    where s.source_batch_id = any(v_batch_ids)
       or u.source_batch_id = any(v_batch_ids)
  ) then
    raise exception 'Rollback blocked: replenishment items reference TEST_FIXTURE inputs';
  end if;

  delete from core.stock_snapshots
  where source_batch_id = any(v_batch_ids) and data_class = 'test_fixture';
  get diagnostics v_stock_deleted = row_count;

  delete from core.usage_rates
  where source_batch_id = any(v_batch_ids) and data_class = 'test_fixture';
  get diagnostics v_usage_deleted = row_count;

  delete from core.packaging_profiles
  where source_batch_id = any(v_batch_ids) and data_class = 'test_fixture';
  get diagnostics v_packaging_deleted = row_count;

  with restored as (
    update core.materials m
    set material_name = case
          when to_jsonb(m.material_name) is not distinct from o.applied_values -> 'material_name'
            then o.previous_values ->> 'material_name'
          else m.material_name
        end,
        category = case
          when to_jsonb(m.category) is not distinct from o.applied_values -> 'category'
            then o.previous_values ->> 'category'
          else m.category
        end,
        unit = case
          when to_jsonb(m.unit) is not distinct from o.applied_values -> 'unit'
            then o.previous_values ->> 'unit'
          else m.unit
        end,
        weight_per_unit_kg = case
          when to_jsonb(m.weight_per_unit_kg) is not distinct from o.applied_values -> 'weight_per_unit_kg'
            then nullif(o.previous_values ->> 'weight_per_unit_kg', '')::numeric
          else m.weight_per_unit_kg
        end,
        lot_size = case
          when to_jsonb(m.lot_size) is not distinct from o.applied_values -> 'lot_size'
            then nullif(o.previous_values ->> 'lot_size', '')::numeric
          else m.lot_size
        end,
        moq = case
          when to_jsonb(m.moq) is not distinct from o.applied_values -> 'moq'
            then nullif(o.previous_values ->> 'moq', '')::numeric
          else m.moq
        end,
        data_quality_status = case
          when to_jsonb(m.data_quality_status) is not distinct from o.applied_values -> 'data_quality_status'
            then coalesce(o.previous_values ->> 'data_quality_status', m.data_quality_status)
          else m.data_quality_status
        end,
        updated_at = now()
    from ops.test_fixture_material_overrides o
    where o.batch_id = any(v_batch_ids)
      and o.material_id = m.material_id
      and o.rolled_back_at is null
    returning m.material_id
  )
  select count(*) into v_materials_restored from restored;

  update ops.test_fixture_material_overrides
  set rolled_back_at = now()
  where batch_id = any(v_batch_ids) and rolled_back_at is null;

  update ops.test_fixture_imports
  set status = 'rolled_back',
      rolled_back_at = now(),
      updated_at = now()
  where batch_id = any(v_batch_ids);

  return jsonb_build_object(
    'source_checksum', p_source_checksum,
    'stock_deleted', v_stock_deleted,
    'usage_deleted', v_usage_deleted,
    'packaging_deleted', v_packaging_deleted,
    'materials_restored', v_materials_restored,
    'raw_lineage_preserved', true
  );
end;
$$;

alter table ops.test_fixture_imports enable row level security;
alter table ops.test_fixture_material_overrides enable row level security;

revoke all on ops.test_fixture_imports,
  ops.test_fixture_material_overrides from public, anon, authenticated;
grant all on ops.test_fixture_imports,
  ops.test_fixture_material_overrides to service_role;

revoke all on function public.m16_import_test_fixture(text, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.m16_rollback_test_fixture(text)
  from public, anon, authenticated;
grant execute on function public.m16_import_test_fixture(text, text, jsonb, jsonb)
  to authenticated, service_role;
grant execute on function public.m16_rollback_test_fixture(text)
  to authenticated, service_role;

grant select on analytics.v_stock_health to service_role;

insert into ops.schema_migrations (
  version, module, description, source_file
)
values (
  '202607240016',
  'M03/M05/M06',
  'Governed TEST_FIXTURE import, provenance labels, replenishment isolation and reversible UAT data promotion.',
  'supabase/migrations/202607240016_test_fixture_governance.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
