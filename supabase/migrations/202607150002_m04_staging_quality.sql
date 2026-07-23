-- SYNAPSE Wave 1 / M04: Data Quality, Staging and master mappings.

begin;

create or replace function staging.clean_text(input_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select nullif(btrim(input_value), '')
$$;

create or replace function staging.try_bigint(input_value text)
returns bigint
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if staging.clean_text(input_value) is null then
    return null;
  end if;
  return trunc(input_value::numeric)::bigint;
exception when others then
  return null;
end;
$$;

create or replace function staging.try_integer(input_value text)
returns integer
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if staging.clean_text(input_value) is null then
    return null;
  end if;
  return trunc(input_value::numeric)::integer;
exception when others then
  return null;
end;
$$;

create or replace function staging.try_numeric(input_value text)
returns numeric
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  if staging.clean_text(input_value) is null then
    return null;
  end if;
  return input_value::numeric;
exception when others then
  return null;
end;
$$;

create or replace function staging.try_date(input_value text)
returns date
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  cleaned text := staging.clean_text(input_value);
begin
  if cleaned is null then
    return null;
  end if;
  if cleaned ~ '^[0-9]+([.][0-9]+)?$' then
    return date '1899-12-30' + trunc(cleaned::numeric)::integer;
  end if;
  return cleaned::date;
exception when others then
  return null;
end;
$$;

create table if not exists ops.data_quality_rules (
  rule_code text primary key,
  severity text not null check (severity in ('info', 'warning', 'error')),
  source_entity text not null,
  field_name text,
  description text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.data_quality_issues (
  issue_id bigint generated always as identity primary key,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  source_row_id bigint not null references raw.source_rows (source_row_id) on delete restrict,
  source_entity text not null,
  source_row_number integer not null,
  rule_code text not null references ops.data_quality_rules (rule_code),
  field_name text,
  raw_value text,
  issue_message text not null,
  created_at timestamptz not null default now(),
  unique (batch_id, source_row_id, rule_code, field_name)
);

create index if not exists data_quality_issues_batch_idx
  on ops.data_quality_issues (batch_id, source_entity, rule_code);

create table if not exists staging.sap_plant_district_map (
  sap_plant_code text primary key,
  district_id text not null unique check (district_id ~ '^55(0[1-9]|1[0-8])$'),
  district_name_th text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into staging.sap_plant_district_map (sap_plant_code, district_id, district_name_th)
values
  ('5501', '5501', 'นวลจันทร์'),
  ('5601', '5502', 'สามเสน'),
  ('5701', '5503', 'นนทบุรี'),
  ('5801', '5504', 'ธนบุรี'),
  ('5901', '5505', 'บางใหญ่'),
  ('6001', '5506', 'ลาดกระบัง'),
  ('6501', '5507', 'บางนา'),
  ('6601', '5508', 'วัดเลียบ'),
  ('6701', '5509', 'คลองเตย'),
  ('6801', '5510', 'ราษฎร์บูรณะ'),
  ('6901', '5511', 'ยานนาวา'),
  ('7001', '5512', 'บางขุนเทียน'),
  ('7501', '5513', 'บางบัวทอง'),
  ('7601', '5514', 'บางกะปิ'),
  ('7701', '5515', 'สมุทรปราการ'),
  ('7801', '5516', 'บางพลี'),
  ('7901', '5517', 'มีนบุรี'),
  ('8001', '5518', 'บางเขน')
on conflict (sap_plant_code) do update
set district_id = excluded.district_id,
    district_name_th = excluded.district_name_th,
    is_active = true,
    updated_at = now();

insert into ops.data_quality_rules (rule_code, severity, source_entity, field_name, description)
values
  ('CONTRACT_DESCRIPTION_REQUIRED', 'error', 'contracts', 'item_description', 'Item description is required.'),
  ('CONTRACT_UNIT_REQUIRED', 'error', 'contracts', 'unit', 'Unit is required.'),
  ('CONTRACT_PROCUREMENT_REQUIRED', 'error', 'contracts', 'procurement_code', 'Procurement code is required.'),
  ('CONTRACT_PURCHASE_ORDER_INVALID', 'error', 'contracts', 'purchase_order', 'Purchase order must be a valid integer.'),
  ('CONTRACT_LINE_ITEM_INVALID', 'error', 'contracts', 'line_item', 'Line item must be a valid integer.'),
  ('CONTRACT_QUANTITY_INVALID', 'error', 'contracts', 'quantity', 'Quantity must be numeric and greater than zero.'),
  ('CONTRACT_RECORD_DATE_INVALID', 'error', 'contracts', 'record_date', 'Record date is required and must be valid.'),
  ('CONTRACT_DOCUMENT_DATE_INVALID', 'error', 'contracts', 'document_date', 'Document date is required and must be valid.'),
  ('CONTRACT_MATERIAL_MISSING', 'warning', 'contracts', 'material_code', 'Source row has no material code; service or non-material line retained.'),
  ('CONTRACT_MATERIAL_FORMAT', 'warning', 'contracts', 'material_code', 'Material code is not a 12-digit SAP code.'),
  ('CONTRACT_NUMBER_MISSING', 'info', 'contracts', 'contract_number', 'Contract number is missing; purchase order is used as the contract grain.'),
  ('CONTRACT_END_BEFORE_START', 'error', 'contracts', 'end_date', 'End date is earlier than start date.'),
  ('CONTRACT_DELIVERY_BEFORE_DOCUMENT', 'warning', 'contracts', 'delivery_date', 'Delivery date is earlier than document date.'),
  ('MATERIAL_ID_REQUIRED', 'error', 'materials', 'Material_ID', 'Material ID is required.'),
  ('MATERIAL_ID_FORMAT', 'warning', 'materials', 'Material_ID', 'Material ID is not a 12-digit SAP code.'),
  ('MATERIAL_NAME_MISSING', 'warning', 'materials', 'Material_Name', 'Material name is missing and may be enriched from contracts.')
on conflict (rule_code) do update
set severity = excluded.severity,
    source_entity = excluded.source_entity,
    field_name = excluded.field_name,
    description = excluded.description,
    is_active = true,
    updated_at = now();

create table if not exists staging.contract_rows (
  source_row_id bigint primary key references raw.source_rows (source_row_id) on delete restrict,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  source_row_number integer not null,
  contract_key text,
  material_code text,
  item_description text,
  unit text,
  procurement_code text,
  purchase_order bigint,
  contract_number text,
  line_item integer,
  vendor text,
  start_date date,
  quantity numeric,
  record_date date,
  bid_open_date date,
  delivery_date date,
  acceptance_date date,
  document_date date,
  end_date date,
  row_hash text not null,
  validation_status text not null default 'valid'
    check (validation_status in ('valid', 'warning', 'rejected')),
  validation_messages jsonb not null default '[]'::jsonb,
  loaded_at timestamptz not null default now(),
  unique (batch_id, source_row_number)
);

create table if not exists staging.material_rows (
  source_row_id bigint primary key references raw.source_rows (source_row_id) on delete restrict,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  source_row_number integer not null,
  material_id text,
  sap_material_id text,
  material_name text,
  category text,
  unit text,
  weight_per_unit_kg numeric,
  lot_size numeric,
  moq numeric,
  row_hash text not null,
  validation_status text not null default 'valid'
    check (validation_status in ('valid', 'warning', 'rejected')),
  validation_messages jsonb not null default '[]'::jsonb,
  loaded_at timestamptz not null default now(),
  unique (batch_id, source_row_number)
);

create index if not exists staging_contract_rows_purchase_order_idx
  on staging.contract_rows (purchase_order);

create index if not exists staging_contract_rows_material_code_idx
  on staging.contract_rows (material_code) where material_code is not null;

create index if not exists staging_material_rows_material_id_idx
  on staging.material_rows (material_id);

create or replace function staging.refresh_contracts(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, raw, staging, ops
as $$
declare
  result jsonb;
begin
  delete from ops.data_quality_issues
  where batch_id = p_batch_id and source_entity = 'contracts';

  delete from staging.contract_rows where batch_id = p_batch_id;

  insert into staging.contract_rows (
    source_row_id, batch_id, source_row_number, contract_key,
    material_code, item_description, unit, procurement_code,
    purchase_order, contract_number, line_item, vendor, start_date,
    quantity, record_date, bid_open_date, delivery_date, acceptance_date,
    document_date, end_date, row_hash
  )
  select
    r.source_row_id,
    r.batch_id,
    r.source_row_number,
    case when staging.try_bigint(r.payload ->> 'purchase_order') is not null
      then 'PO-' || staging.try_bigint(r.payload ->> 'purchase_order')::text end,
    staging.clean_text(r.payload ->> 'material_code'),
    staging.clean_text(r.payload ->> 'item_description'),
    staging.clean_text(r.payload ->> 'unit'),
    staging.clean_text(r.payload ->> 'procurement_code'),
    staging.try_bigint(r.payload ->> 'purchase_order'),
    staging.clean_text(r.payload ->> 'contract_number'),
    staging.try_integer(r.payload ->> 'line_item'),
    staging.clean_text(r.payload ->> 'vendor'),
    staging.try_date(r.payload ->> 'start_date'),
    staging.try_numeric(r.payload ->> 'quantity'),
    staging.try_date(r.payload ->> 'record_date'),
    staging.try_date(r.payload ->> 'bid_open_date'),
    staging.try_date(r.payload ->> 'delivery_date'),
    staging.try_date(r.payload ->> 'acceptance_date'),
    staging.try_date(r.payload ->> 'document_date'),
    staging.try_date(r.payload ->> 'end_date'),
    r.row_hash
  from raw.source_rows r
  where r.batch_id = p_batch_id and r.source_entity = 'contracts';

  insert into ops.data_quality_issues (
    batch_id, source_row_id, source_entity, source_row_number,
    rule_code, field_name, raw_value, issue_message
  )
  select s.batch_id, s.source_row_id, 'contracts', s.source_row_number,
         checks.rule_code, checks.field_name, checks.raw_value, checks.issue_message
  from staging.contract_rows s
  cross join lateral (
    values
      ('CONTRACT_DESCRIPTION_REQUIRED', 'item_description', s.item_description,
       'Item description is blank.', s.item_description is null),
      ('CONTRACT_UNIT_REQUIRED', 'unit', s.unit,
       'Unit is blank.', s.unit is null),
      ('CONTRACT_PROCUREMENT_REQUIRED', 'procurement_code', s.procurement_code,
       'Procurement code is blank.', s.procurement_code is null),
      ('CONTRACT_PURCHASE_ORDER_INVALID', 'purchase_order', s.purchase_order::text,
       'Purchase order is missing or invalid.', s.purchase_order is null),
      ('CONTRACT_LINE_ITEM_INVALID', 'line_item', s.line_item::text,
       'Line item is missing or invalid.', s.line_item is null),
      ('CONTRACT_QUANTITY_INVALID', 'quantity', s.quantity::text,
       'Quantity is missing, invalid or non-positive.', s.quantity is null or s.quantity <= 0),
      ('CONTRACT_RECORD_DATE_INVALID', 'record_date', s.record_date::text,
       'Record date is missing or invalid.', s.record_date is null),
      ('CONTRACT_DOCUMENT_DATE_INVALID', 'document_date', s.document_date::text,
       'Document date is missing or invalid.', s.document_date is null),
      ('CONTRACT_MATERIAL_MISSING', 'material_code', s.material_code,
       'Material code is missing; row retained.', s.material_code is null),
      ('CONTRACT_MATERIAL_FORMAT', 'material_code', s.material_code,
       'Material code is not a 12-digit SAP code.', s.material_code is not null and s.material_code !~ '^[0-9]{12}$'),
      ('CONTRACT_NUMBER_MISSING', 'contract_number', s.contract_number,
       'Contract number is missing; purchase order is used.', s.contract_number is null),
      ('CONTRACT_END_BEFORE_START', 'end_date', s.end_date::text,
       'End date is earlier than start date.', s.start_date is not null and s.end_date is not null and s.end_date < s.start_date),
      ('CONTRACT_DELIVERY_BEFORE_DOCUMENT', 'delivery_date', s.delivery_date::text,
       'Delivery date is earlier than document date.', s.delivery_date is not null and s.document_date is not null and s.delivery_date < s.document_date)
  ) as checks(rule_code, field_name, raw_value, issue_message, failed)
  where checks.failed
  on conflict (batch_id, source_row_id, rule_code, field_name) do nothing;

  with issue_aggregate as (
    select
      i.source_row_id,
      case
        when bool_or(r.severity = 'error') then 'rejected'
        when bool_or(r.severity = 'warning') then 'warning'
        else 'valid'
      end as validation_status,
      jsonb_agg(
        jsonb_build_object(
          'rule_code', i.rule_code,
          'severity', r.severity,
          'field', i.field_name,
          'message', i.issue_message
        ) order by r.severity desc, i.rule_code
      ) as messages
    from ops.data_quality_issues i
    join ops.data_quality_rules r using (rule_code)
    where i.batch_id = p_batch_id and i.source_entity = 'contracts'
    group by i.source_row_id
  )
  update staging.contract_rows s
  set validation_status = a.validation_status,
      validation_messages = a.messages
  from issue_aggregate a
  where s.source_row_id = a.source_row_id;

  select jsonb_build_object(
    'rows', count(*),
    'valid', count(*) filter (where validation_status = 'valid'),
    'warning', count(*) filter (where validation_status = 'warning'),
    'rejected', count(*) filter (where validation_status = 'rejected')
  ) into result
  from staging.contract_rows
  where batch_id = p_batch_id;

  return result;
end;
$$;

create or replace function staging.refresh_materials(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, raw, staging, ops
as $$
declare
  result jsonb;
begin
  delete from ops.data_quality_issues
  where batch_id = p_batch_id and source_entity = 'materials';

  delete from staging.material_rows where batch_id = p_batch_id;

  insert into staging.material_rows (
    source_row_id, batch_id, source_row_number, material_id,
    sap_material_id, material_name, category, unit,
    weight_per_unit_kg, lot_size, moq, row_hash
  )
  select
    r.source_row_id,
    r.batch_id,
    r.source_row_number,
    staging.clean_text(r.payload ->> 'Material_ID'),
    staging.clean_text(r.payload ->> 'SAP_Material_ID'),
    staging.clean_text(r.payload ->> 'Material_Name'),
    staging.clean_text(r.payload ->> 'Category'),
    staging.clean_text(r.payload ->> 'Unit'),
    staging.try_numeric(r.payload ->> 'Weight_per_Unit_kg'),
    staging.try_numeric(r.payload ->> 'Lot_Size'),
    staging.try_numeric(r.payload ->> 'MOQ'),
    r.row_hash
  from raw.source_rows r
  where r.batch_id = p_batch_id and r.source_entity = 'materials';

  insert into ops.data_quality_issues (
    batch_id, source_row_id, source_entity, source_row_number,
    rule_code, field_name, raw_value, issue_message
  )
  select s.batch_id, s.source_row_id, 'materials', s.source_row_number,
         checks.rule_code, checks.field_name, checks.raw_value, checks.issue_message
  from staging.material_rows s
  cross join lateral (
    values
      ('MATERIAL_ID_REQUIRED', 'Material_ID', s.material_id,
       'Material ID is blank.', s.material_id is null),
      ('MATERIAL_ID_FORMAT', 'Material_ID', s.material_id,
       'Material ID is not a 12-digit SAP code.', s.material_id is not null and s.material_id !~ '^[0-9]{12}$'),
      ('MATERIAL_NAME_MISSING', 'Material_Name', s.material_name,
       'Material name is blank and may be enriched from contract descriptions.', s.material_name is null)
  ) as checks(rule_code, field_name, raw_value, issue_message, failed)
  where checks.failed
  on conflict (batch_id, source_row_id, rule_code, field_name) do nothing;

  with issue_aggregate as (
    select
      i.source_row_id,
      case
        when bool_or(r.severity = 'error') then 'rejected'
        when bool_or(r.severity = 'warning') then 'warning'
        else 'valid'
      end as validation_status,
      jsonb_agg(
        jsonb_build_object(
          'rule_code', i.rule_code,
          'severity', r.severity,
          'field', i.field_name,
          'message', i.issue_message
        ) order by r.severity desc, i.rule_code
      ) as messages
    from ops.data_quality_issues i
    join ops.data_quality_rules r using (rule_code)
    where i.batch_id = p_batch_id and i.source_entity = 'materials'
    group by i.source_row_id
  )
  update staging.material_rows s
  set validation_status = a.validation_status,
      validation_messages = a.messages
  from issue_aggregate a
  where s.source_row_id = a.source_row_id;

  select jsonb_build_object(
    'rows', count(*),
    'valid', count(*) filter (where validation_status = 'valid'),
    'warning', count(*) filter (where validation_status = 'warning'),
    'rejected', count(*) filter (where validation_status = 'rejected')
  ) into result
  from staging.material_rows
  where batch_id = p_batch_id;

  return result;
end;
$$;

create or replace view analytics.v_data_quality_summary
with (security_invoker = true)
as
select
  i.batch_id,
  b.source_file,
  b.source_sheet,
  i.source_entity,
  i.rule_code,
  r.severity,
  r.description,
  count(*) as issue_count,
  min(i.created_at) as first_detected_at,
  max(i.created_at) as last_detected_at
from ops.data_quality_issues i
join ops.data_quality_rules r using (rule_code)
join raw.import_batches b using (batch_id)
group by i.batch_id, b.source_file, b.source_sheet, i.source_entity,
         i.rule_code, r.severity, r.description;

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

  perform staging.refresh_contracts(contract_batch);
  perform staging.refresh_materials(material_batch);
end;
$$;

alter table ops.data_quality_rules enable row level security;
alter table ops.data_quality_issues enable row level security;
alter table staging.sap_plant_district_map enable row level security;
alter table staging.contract_rows enable row level security;
alter table staging.material_rows enable row level security;

revoke all on ops.data_quality_rules, ops.data_quality_issues,
  staging.sap_plant_district_map, staging.contract_rows, staging.material_rows
  from public, anon, authenticated;
grant all on ops.data_quality_rules, ops.data_quality_issues,
  staging.sap_plant_district_map, staging.contract_rows, staging.material_rows
  to service_role;
grant select on analytics.v_data_quality_summary to service_role;
grant usage, select on all sequences in schema ops, staging to service_role;

revoke all on function staging.refresh_contracts(uuid) from public, anon, authenticated;
revoke all on function staging.refresh_materials(uuid) from public, anon, authenticated;
grant execute on function staging.refresh_contracts(uuid) to service_role;
grant execute on function staging.refresh_materials(uuid) to service_role;

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607150002',
  'M04',
  'Typed staging tables, safe conversions, data quality issues, validation summaries and SAP plant-to-district mapping.',
  'supabase/migrations/202607150002_m04_staging_quality.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
