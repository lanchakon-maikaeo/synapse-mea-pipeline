\set ON_ERROR_STOP on

-- M25: Stock คลังคลองเตย and Stock เขต are separate Import Center sources with their own dates.
begin;

create temporary table m25_checks (check_name text primary key, passed boolean not null);
create temporary table m25_state (created jsonb, current jsonb, ready jsonb, promoted jsonb);
insert into m25_state default values;
grant select, insert, update on m25_checks, m25_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values ('25000000-0000-4000-8000-000000000001', '{"display_name":"M25 Admin"}');
update public.user_profiles set role = 'admin' where user_id = '25000000-0000-4000-8000-000000000001';

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('25000000-0000-4000-8000-000000000010', 'm25-test', 'm25.csv', 'm25', repeat('5', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, unit, is_vmi, master_source, data_quality_status, source_batch_id)
values ('M25-A', 'M25-A', 'M25 fuse', 'EA', true, 'material_master', 'valid', '25000000-0000-4000-8000-000000000010');

insert into m25_checks select 'business key accepts district_stock',
  ops.srcimp_business_key('district_stock', '{"sap_plant_code":"5501","storage_location_code":"0001","material_id":"M25-A"}') = '5501|0001|M25-A';

-- District file committed first (26 Oct), then a newer Khlong Toei-only file (2 Nov)
insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet,
  expected_row_count, status, created_by, committed_by, committed_at) values
  ('25000000-0000-4000-8000-000000000101', 'district_stock', 'Stock.xlsx', repeat('d', 64), 10, 'update-stock', 1, 'committed',
   '25000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('25000000-0000-4000-8000-000000000102', 'stock', 'Stock update 02.11.69.XLSX', repeat('e', 64), 10, 'Sheet1', 1, 'committed',
   '25000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000001', now() - interval '1 hour'),
  ('25000000-0000-4000-8000-000000000103', 'usage', 'usage.xlsx', repeat('f', 64), 10, 'Check CMP', 1, 'committed',
   '25000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000001', now() - interval '3 hours');
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('district_stock', '5501|0001|M25-A', '{"sap_plant_code":"5501","storage_location_code":"0001","material_id":"M25-A","unrestricted_qty":7,"district_id":"5501","snapshot_date":"2026-10-26"}',
   md5('d1'), 2, '25000000-0000-4000-8000-000000000101', '25000000-0000-4000-8000-000000000101'),
  ('stock', '2401|0001|M25-A', '{"sap_plant_code":"2401","storage_location_code":"0001","material_id":"M25-A","unrestricted_qty":900,"warehouse_id":"WH-KT","district_id":null,"snapshot_date":"2026-11-02"}',
   md5('k1'), 2, '25000000-0000-4000-8000-000000000102', '25000000-0000-4000-8000-000000000102'),
  ('usage', 'M25-A|5501', '{"material_id":"M25-A","sap_plant_code":"5501","district_id":"5501","avg_ly_raw":4,"avg_12m_raw":4,"avg_6m_raw":4,"avg_4m_raw":4,"as_of_date":"2026-09-30"}',
   md5('u1'), 2, '25000000-0000-4000-8000-000000000103', '25000000-0000-4000-8000-000000000103');

select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m25_state set current = public.srcimp_dispatch('GET', '/v1/source-imports/current', '{}', '{}', 'm25-1');
update m25_state set ready = public.m09_dispatch('GET', '/v1/source-imports/promotion', '{}', '{}', 'm25-2');
update m25_state set promoted = public.m09_dispatch('POST', '/v1/source-imports/promotion', '{}', '{}', 'm25-3');
update m25_state set created = public.srcimp_dispatch('POST', '/v1/source-imports/runs', '{}',
  jsonb_build_object('source_kind', 'district_stock', 'file_name', 'Stock.xlsx', 'file_sha256', repeat('9', 64),
    'expected_row_count', 1, 'source_sheet', 'update-stock'), 'm25-4');
reset role;

insert into m25_checks select 'current lists the district_stock card',
  (current ->> 'status')::int = 200 and (current #>> '{body,district_stock,accepted_rows}')::int = 1 from m25_state;
insert into m25_checks select 'readiness keeps both files and their dates',
  ready #>> '{body,stock_date}' = '2026-11-02' and ready #>> '{body,district_stock_date}' = '2026-10-26'
  and (ready #>> '{body,stock_districts}')::int = 1 and jsonb_array_length(ready #> '{body,blocking}') = 0
  and ready #> '{body,warnings}' @> '["Stock คลังและ Stock เขตเป็นยอดคนละวัน"]' from m25_state;
insert into m25_checks select 'promotion uses each file with its own date',
  (promoted ->> 'status')::int = 200
  and exists (select 1 from core.stock_snapshots where material_id = 'M25-A' and location_id = 'DIST-5501'
    and quantity_on_hand = 7 and snapshot_at = '2026-10-26 23:59+07')
  and exists (select 1 from core.stock_snapshots where material_id = 'M25-A' and location_id = 'WH-KT'
    and quantity_on_hand = 900 and snapshot_at = '2026-11-02 23:59+07') from m25_state;
insert into m25_checks select 'calculation sees district stock',
  current_stock_qty = 7 and not source_stock_missing
from analytics.stock_health_at(now()) where material_id = 'M25-A' and district_id = '5501';
insert into m25_checks select 'district_stock run can be created', (created ->> 'status')::int = 201 from m25_state;

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m25_checks where not passed;
  if v_failed is not null then raise exception 'M25 checks failed: %', v_failed; end if;
  if (select count(*) from m25_checks) <> 6 then raise exception 'M25: expected 6 checks, got %', (select count(*) from m25_checks); end if;
end
$$;

select check_name, passed from m25_checks order by check_name;
rollback;
