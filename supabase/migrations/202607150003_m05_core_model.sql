-- SYNAPSE Wave 1 / M05: Normalized Core model and business views.

begin;

create table if not exists core.districts (
  district_id text primary key check (district_id ~ '^55(0[1-9]|1[0-8])$'),
  sap_plant_code text not null unique,
  district_name_th text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.warehouses (
  warehouse_id text primary key,
  warehouse_name_th text not null unique,
  sap_plant_code text not null,
  storage_location text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sap_plant_code, storage_location)
);

create table if not exists core.locations (
  location_id text primary key,
  location_type text not null check (location_type in ('WAREHOUSE', 'DISTRICT')),
  location_name_th text not null,
  warehouse_id text references core.warehouses (warehouse_id),
  district_id text references core.districts (district_id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint locations_type_reference_check check (
    (location_type = 'WAREHOUSE' and warehouse_id is not null and district_id is null)
    or (location_type = 'DISTRICT' and warehouse_id is null and district_id is not null)
  )
);

create table if not exists core.vendors (
  vendor_id bigint generated always as identity primary key,
  vendor_name text not null,
  normalized_name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.materials (
  material_id text primary key,
  sap_material_id text,
  material_name text,
  category text,
  unit text,
  weight_per_unit_kg numeric,
  lot_size numeric,
  moq numeric,
  is_vmi boolean not null default false,
  master_source text not null check (master_source in ('material_master', 'contracts')),
  data_quality_status text not null default 'valid'
    check (data_quality_status in ('valid', 'warning')),
  source_batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.contracts (
  contract_id bigint generated always as identity primary key,
  contract_key text not null unique,
  purchase_order bigint not null unique,
  contract_number text,
  procurement_code text not null,
  vendor_id bigint references core.vendors (vendor_id),
  start_date date,
  record_date date not null,
  bid_open_date date,
  document_date date not null,
  end_date date,
  source_item_count integer not null check (source_item_count > 0),
  source_batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists core_contracts_contract_number_idx
  on core.contracts (contract_number) where contract_number is not null;

create index if not exists core_contracts_source_batch_idx
  on core.contracts (source_batch_id, is_current);

create table if not exists core.contract_items (
  contract_item_id bigint generated always as identity primary key,
  contract_id bigint not null references core.contracts (contract_id) on delete restrict,
  material_id text references core.materials (material_id) on delete restrict,
  source_row_id bigint not null unique references raw.source_rows (source_row_id) on delete restrict,
  source_row_number integer not null,
  line_item integer not null,
  item_description text not null,
  unit text not null,
  quantity numeric not null check (quantity > 0),
  delivery_date date,
  acceptance_date date,
  validation_status text not null check (validation_status in ('valid', 'warning')),
  source_batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_batch_id, source_row_number)
);

create index if not exists core_contract_items_contract_idx
  on core.contract_items (contract_id, is_current);

create index if not exists core_contract_items_material_idx
  on core.contract_items (material_id, is_current) where material_id is not null;

create table if not exists core.inventory_transactions (
  transaction_id uuid primary key default gen_random_uuid(),
  material_id text not null references core.materials (material_id) on delete restrict,
  location_id text not null references core.locations (location_id) on delete restrict,
  transaction_type text not null
    check (transaction_type in ('RECEIPT', 'ISSUE', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT')),
  quantity_delta numeric not null check (quantity_delta <> 0),
  occurred_at timestamptz not null,
  reference_type text,
  reference_id text,
  source_batch_id uuid references raw.import_batches (batch_id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists inventory_transactions_lookup_idx
  on core.inventory_transactions (material_id, location_id, occurred_at desc);

create table if not exists core.stock_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  material_id text not null references core.materials (material_id) on delete restrict,
  location_id text not null references core.locations (location_id) on delete restrict,
  quantity_on_hand numeric not null check (quantity_on_hand >= 0),
  snapshot_at timestamptz not null,
  source_batch_id uuid references raw.import_batches (batch_id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (material_id, location_id, snapshot_at)
);

create index if not exists stock_snapshots_latest_idx
  on core.stock_snapshots (material_id, location_id, snapshot_at desc);

create table if not exists core.delivery_events (
  delivery_event_id uuid primary key default gen_random_uuid(),
  contract_item_id bigint references core.contract_items (contract_item_id) on delete restrict,
  event_type text not null
    check (event_type in ('SCHEDULED', 'DISPATCHED', 'DELIVERED', 'INSPECTED', 'ACCEPTED', 'REJECTED')),
  event_date timestamptz not null,
  quantity numeric check (quantity is null or quantity >= 0),
  note text,
  source_batch_id uuid references raw.import_batches (batch_id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into core.districts (district_id, sap_plant_code, district_name_th, is_active)
select district_id, sap_plant_code, district_name_th, is_active
from staging.sap_plant_district_map
on conflict (district_id) do update
set sap_plant_code = excluded.sap_plant_code,
    district_name_th = excluded.district_name_th,
    is_active = excluded.is_active,
    updated_at = now();

insert into core.warehouses (
  warehouse_id, warehouse_name_th, sap_plant_code, storage_location, is_active
)
values ('WH-KT', 'คลองเตย', '2401', '1', true)
on conflict (warehouse_id) do update
set warehouse_name_th = excluded.warehouse_name_th,
    sap_plant_code = excluded.sap_plant_code,
    storage_location = excluded.storage_location,
    is_active = excluded.is_active,
    updated_at = now();

insert into core.locations (
  location_id, location_type, location_name_th, warehouse_id, district_id, is_active
)
values ('WH-KT', 'WAREHOUSE', 'คลัง VMI คลองเตย', 'WH-KT', null, true)
on conflict (location_id) do update
set location_name_th = excluded.location_name_th,
    warehouse_id = excluded.warehouse_id,
    district_id = excluded.district_id,
    is_active = excluded.is_active,
    updated_at = now();

insert into core.locations (
  location_id, location_type, location_name_th, warehouse_id, district_id, is_active
)
select 'DIST-' || district_id, 'DISTRICT', district_name_th, null, district_id, is_active
from core.districts
on conflict (location_id) do update
set location_name_th = excluded.location_name_th,
    warehouse_id = excluded.warehouse_id,
    district_id = excluded.district_id,
    is_active = excluded.is_active,
    updated_at = now();

create or replace function core.refresh_contract_foundation(
  p_contract_batch_id uuid,
  p_material_batch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, staging, raw
as $$
declare
  result jsonb;
begin
  insert into core.vendors (vendor_name, normalized_name)
  select distinct
    s.vendor,
    lower(regexp_replace(btrim(s.vendor), '[[:space:]]+', ' ', 'g'))
  from staging.contract_rows s
  where s.batch_id = p_contract_batch_id
    and s.validation_status <> 'rejected'
    and s.vendor is not null
  on conflict (normalized_name) do update
  set vendor_name = excluded.vendor_name,
      is_active = true,
      updated_at = now();

  insert into core.materials (
    material_id, sap_material_id, material_name, category, unit,
    weight_per_unit_kg, lot_size, moq, is_vmi, master_source,
    data_quality_status, source_batch_id
  )
  select
    s.material_id,
    coalesce(s.sap_material_id,
      case when s.material_id ~ '^[0-9]{12}$' then s.material_id end),
    s.material_name,
    s.category,
    s.unit,
    s.weight_per_unit_kg,
    s.lot_size,
    s.moq,
    true,
    'material_master',
    case when s.validation_status = 'warning' then 'warning' else 'valid' end,
    s.batch_id
  from staging.material_rows s
  where s.batch_id = p_material_batch_id
    and s.validation_status <> 'rejected'
    and s.material_id is not null
  on conflict (material_id) do update
  set sap_material_id = coalesce(excluded.sap_material_id, core.materials.sap_material_id),
      material_name = coalesce(excluded.material_name, core.materials.material_name),
      category = coalesce(excluded.category, core.materials.category),
      unit = coalesce(excluded.unit, core.materials.unit),
      weight_per_unit_kg = coalesce(excluded.weight_per_unit_kg, core.materials.weight_per_unit_kg),
      lot_size = coalesce(excluded.lot_size, core.materials.lot_size),
      moq = coalesce(excluded.moq, core.materials.moq),
      is_vmi = true,
      master_source = 'material_master',
      data_quality_status = excluded.data_quality_status,
      source_batch_id = excluded.source_batch_id,
      updated_at = now();

  with grouped as (
    select
      s.material_code,
      s.item_description,
      s.unit,
      count(*) as occurrences,
      max(s.source_row_number) as latest_source_row
    from staging.contract_rows s
    where s.batch_id = p_contract_batch_id
      and s.validation_status <> 'rejected'
      and s.material_code is not null
    group by s.material_code, s.item_description, s.unit
  ), ranked as (
    select grouped.*,
           row_number() over (
             partition by material_code
             order by occurrences desc, latest_source_row desc
           ) as preference_rank
    from grouped
  )
  insert into core.materials (
    material_id, sap_material_id, material_name, unit,
    is_vmi, master_source, data_quality_status, source_batch_id
  )
  select
    material_code,
    case when material_code ~ '^[0-9]{12}$' then material_code end,
    item_description,
    unit,
    false,
    'contracts',
    case when material_code ~ '^[0-9]{12}$' then 'valid' else 'warning' end,
    p_contract_batch_id
  from ranked
  where preference_rank = 1
  on conflict (material_id) do update
  set sap_material_id = coalesce(core.materials.sap_material_id, excluded.sap_material_id),
      material_name = coalesce(core.materials.material_name, excluded.material_name),
      unit = coalesce(core.materials.unit, excluded.unit),
      data_quality_status = case
        when core.materials.data_quality_status = 'warning' and excluded.data_quality_status = 'valid'
          then 'valid'
        else core.materials.data_quality_status
      end,
      updated_at = now();

  update core.contracts set is_current = false where is_current;
  update core.contract_items set is_current = false where is_current;

  with contract_headers as (
    select
      s.contract_key,
      s.purchase_order,
      max(s.contract_number) as contract_number,
      min(s.procurement_code) as procurement_code,
      min(s.vendor) as vendor,
      min(s.start_date) as start_date,
      min(s.record_date) as record_date,
      min(s.bid_open_date) as bid_open_date,
      min(s.document_date) as document_date,
      max(s.end_date) as end_date,
      count(*)::integer as source_item_count
    from staging.contract_rows s
    where s.batch_id = p_contract_batch_id
      and s.validation_status <> 'rejected'
    group by s.contract_key, s.purchase_order
  )
  insert into core.contracts (
    contract_key, purchase_order, contract_number, procurement_code,
    vendor_id, start_date, record_date, bid_open_date, document_date,
    end_date, source_item_count, source_batch_id, is_current
  )
  select
    h.contract_key,
    h.purchase_order,
    h.contract_number,
    h.procurement_code,
    v.vendor_id,
    h.start_date,
    h.record_date,
    h.bid_open_date,
    h.document_date,
    h.end_date,
    h.source_item_count,
    p_contract_batch_id,
    true
  from contract_headers h
  left join core.vendors v
    on v.normalized_name = lower(regexp_replace(btrim(h.vendor), '[[:space:]]+', ' ', 'g'))
  on conflict (purchase_order) do update
  set contract_key = excluded.contract_key,
      contract_number = excluded.contract_number,
      procurement_code = excluded.procurement_code,
      vendor_id = excluded.vendor_id,
      start_date = excluded.start_date,
      record_date = excluded.record_date,
      bid_open_date = excluded.bid_open_date,
      document_date = excluded.document_date,
      end_date = excluded.end_date,
      source_item_count = excluded.source_item_count,
      source_batch_id = excluded.source_batch_id,
      is_current = true,
      updated_at = now();

  insert into core.contract_items (
    contract_id, material_id, source_row_id, source_row_number,
    line_item, item_description, unit, quantity, delivery_date,
    acceptance_date, validation_status, source_batch_id, is_current
  )
  select
    c.contract_id,
    s.material_code,
    s.source_row_id,
    s.source_row_number,
    s.line_item,
    s.item_description,
    s.unit,
    s.quantity,
    s.delivery_date,
    s.acceptance_date,
    s.validation_status,
    s.batch_id,
    true
  from staging.contract_rows s
  join core.contracts c on c.purchase_order = s.purchase_order
  where s.batch_id = p_contract_batch_id
    and s.validation_status <> 'rejected'
  on conflict (source_row_id) do update
  set contract_id = excluded.contract_id,
      material_id = excluded.material_id,
      source_row_number = excluded.source_row_number,
      line_item = excluded.line_item,
      item_description = excluded.item_description,
      unit = excluded.unit,
      quantity = excluded.quantity,
      delivery_date = excluded.delivery_date,
      acceptance_date = excluded.acceptance_date,
      validation_status = excluded.validation_status,
      source_batch_id = excluded.source_batch_id,
      is_current = true,
      updated_at = now();

  select jsonb_build_object(
    'districts', (select count(*) from core.districts),
    'locations', (select count(*) from core.locations),
    'materials', (select count(*) from core.materials),
    'contracts', (select count(*) from core.contracts where is_current),
    'contract_items', (select count(*) from core.contract_items where is_current),
    'vendors', (select count(*) from core.vendors)
  ) into result;

  return result;
end;
$$;

do $$
declare
  contract_batch uuid;
  material_batch uuid;
begin
  select batch_id into contract_batch
  from raw.import_batches
  where source_checksum = '8ea7b0e712726e6cc1990f33b0031be231a91cc01fb4f8d96e6146d83e3cf9dd'
    and source_sheet = 'รวมสัญญา';

  select batch_id into material_batch
  from raw.import_batches
  where source_checksum = '39c0735fea5e32c4c9056fdd75830f1e47bde43a71a51a67ca4e86e5bc557126'
    and source_sheet = 'DB_Material';

  perform core.refresh_contract_foundation(contract_batch, material_batch);
end;
$$;

create or replace view analytics.v_contract_status
with (security_invoker = true)
as
select
  c.contract_id,
  c.contract_key,
  c.purchase_order,
  c.contract_number,
  c.procurement_code,
  v.vendor_name,
  c.start_date,
  c.document_date,
  c.end_date,
  case
    when c.end_date is not null and c.end_date < current_date then 'EXPIRED'
    when c.start_date is not null and c.start_date > current_date then 'PLANNED'
    when c.start_date is null and c.end_date is null then 'UNKNOWN'
    else 'ACTIVE'
  end as contract_status,
  c.source_item_count,
  count(i.contract_item_id) filter (where i.material_id is not null) as material_line_count,
  count(i.contract_item_id) filter (where i.material_id is null) as service_or_unmapped_line_count,
  count(i.contract_item_id) filter (where i.validation_status = 'warning') as warning_line_count,
  c.source_batch_id,
  c.updated_at
from core.contracts c
left join core.vendors v using (vendor_id)
left join core.contract_items i on i.contract_id = c.contract_id and i.is_current
where c.is_current
group by c.contract_id, v.vendor_name;

create or replace view analytics.v_current_stock
with (security_invoker = true)
as
select distinct on (s.material_id, s.location_id)
  s.material_id,
  m.material_name,
  s.location_id,
  l.location_name_th,
  s.quantity_on_hand,
  s.snapshot_at,
  s.source_batch_id
from core.stock_snapshots s
join core.materials m using (material_id)
join core.locations l using (location_id)
order by s.material_id, s.location_id, s.snapshot_at desc;

create or replace view analytics.v_contract_reconciliation
with (security_invoker = true)
as
select
  (select count(*) from public.contracts) as legacy_rows,
  (select count(*) from raw.source_rows where source_entity = 'contracts') as raw_rows,
  (select count(*) from staging.contract_rows) as staging_rows,
  (select count(*) from staging.contract_rows where validation_status = 'rejected') as rejected_rows,
  (select count(*) from core.contract_items where is_current) as core_item_rows,
  (select count(*) from core.contracts where is_current) as core_contract_rows,
  (select count(*) from core.materials) as core_material_rows,
  (select count(*) from core.districts) as district_rows,
  (select count(*) from core.locations) as location_rows;

create or replace view analytics.v_material_master_coverage
with (security_invoker = true)
as
select
  count(*) as material_count,
  count(*) filter (where is_vmi) as vmi_material_count,
  count(*) filter (where not is_vmi) as contract_only_material_count,
  count(*) filter (where material_name is null) as missing_name_count,
  count(*) filter (where data_quality_status = 'warning') as warning_count
from core.materials;

create or replace function audit.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, audit
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_pk text;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;

  v_pk := coalesce(
    v_new ->> 'id', v_old ->> 'id',
    v_new ->> 'contract_id', v_old ->> 'contract_id',
    v_new ->> 'material_id', v_old ->> 'material_id',
    v_new ->> 'vendor_id', v_old ->> 'vendor_id',
    v_new ->> 'district_id', v_old ->> 'district_id',
    v_new ->> 'warehouse_id', v_old ->> 'warehouse_id',
    v_new ->> 'location_id', v_old ->> 'location_id',
    v_new ->> 'user_id', v_old ->> 'user_id',
    v_new ->> 'source_row_number', v_old ->> 'source_row_number'
  );

  insert into audit.change_log (
    schema_name, table_name, record_pk, operation,
    old_data, new_data, changed_by, database_role
  ) values (
    tg_table_schema, tg_table_name, v_pk, tg_op,
    v_old, v_new, auth.uid(), current_user
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'districts', 'warehouses', 'locations', 'vendors',
    'materials', 'contracts', 'contract_items'
  ]
  loop
    execute format('drop trigger if exists set_%I_updated_at on core.%I', table_name, table_name);
    execute format(
      'create trigger set_%I_updated_at before update on core.%I for each row execute function audit.set_updated_at()',
      table_name, table_name
    );
  end loop;

  foreach table_name in array array[
    'districts', 'warehouses', 'locations', 'vendors', 'materials', 'contracts'
  ]
  loop
    execute format('drop trigger if exists audit_%I_changes on core.%I', table_name, table_name);
    execute format(
      'create trigger audit_%I_changes after insert or update or delete on core.%I for each row execute function audit.log_row_change()',
      table_name, table_name
    );
  end loop;
end;
$$;

alter table core.districts enable row level security;
alter table core.warehouses enable row level security;
alter table core.locations enable row level security;
alter table core.vendors enable row level security;
alter table core.materials enable row level security;
alter table core.contracts enable row level security;
alter table core.contract_items enable row level security;
alter table core.inventory_transactions enable row level security;
alter table core.stock_snapshots enable row level security;
alter table core.delivery_events enable row level security;

revoke all on all tables in schema core from public, anon, authenticated;
grant all on all tables in schema core to service_role;
grant usage, select on all sequences in schema core to service_role;
grant select on analytics.v_contract_status,
  analytics.v_current_stock,
  analytics.v_contract_reconciliation,
  analytics.v_material_master_coverage
  to service_role;

revoke all on function core.refresh_contract_foundation(uuid, uuid) from public, anon, authenticated;
grant execute on function core.refresh_contract_foundation(uuid, uuid) to service_role;

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607150003',
  'M05',
  'Normalized contracts, items, materials, locations, inventory foundations and reconciliation/business views.',
  'supabase/migrations/202607150003_m05_core_model.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
