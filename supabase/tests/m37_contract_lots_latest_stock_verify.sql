\set ON_ERROR_STOP on

-- M37: contract lots use the newest Khlong Toei stock file only.
begin;

create temporary table m37_checks (check_name text primary key, passed boolean not null);

insert into auth.users (id, raw_user_meta_data) values ('37000000-0000-4000-8000-000000000001', '{"display_name":"M37"}');
insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('37000000-0000-4000-8000-000000000010', 'm37-test', 'm37.csv', 'm37', repeat('7', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, unit, is_vmi, master_source, data_quality_status, source_batch_id)
select id, id, 'M37 ' || id, 'EA', true, 'material_master', 'valid', '37000000-0000-4000-8000-000000000010'
from unnest(array['370000000001', '370000000002']) id;
insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet,
  expected_row_count, status, created_by) values
  ('37000000-0000-4000-8000-000000000101', 'contracts', 'c.xlsx', repeat('e', 64), 1, 'Sheet1', 2, 'staged', '37000000-0000-4000-8000-000000000001');
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('contracts', 'm37c1', '{"material_code":"370000000001","purchase_order":"1400003701","contract_number":"MP9-M37-A","line_item":"1","quantity":"100","unit":"EA","acceptance_date":"2031-03-01"}',
   md5('m37c1'), 2, '37000000-0000-4000-8000-000000000101', '37000000-0000-4000-8000-000000000101'),
  ('contracts', 'm37c2', '{"material_code":"370000000002","purchase_order":"1400003702","contract_number":"MP9-M37-B","line_item":"1","quantity":"100","unit":"EA","acceptance_date":"2031-03-01"}',
   md5('m37c2'), 3, '37000000-0000-4000-8000-000000000101', '37000000-0000-4000-8000-000000000101');

-- material 1 only in an old file; material 2 in the newest file (2031-03-05)
insert into core.stock_snapshots (material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality) values
  ('370000000001', 'WH-KT', 100, '2031-01-08 23:59+07', '37000000-0000-4000-8000-000000000010', 'actual', 'source_observed'),
  ('370000000002', 'WH-KT', 40, '2031-03-05 23:59+07', '37000000-0000-4000-8000-000000000010', 'actual', 'source_observed');

-- a release on material 2, with a 105 posted on the stock file's own date
insert into ops.passed_test_releases (material_id, purchase_order, line_item, quantity, confirmed_by, confirmed_by_name)
values ('370000000002', '1400003702', '1', 100, '37000000-0000-4000-8000-000000000001', 'M37');
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('receipts_105', 'm37r1', '{"material_code":"370000000002","purchase_order":"1400003702","item":"1","po_item":"1","material_document":"5000003701","quantity":"100","unit":"EA","posting_date":"2031-03-05","source_layout":"sap_105_13"}',
   md5('m37r1'), 2, '37000000-0000-4000-8000-000000000101', '37000000-0000-4000-8000-000000000101');

create temporary table m37_rows as select * from core.m26_lot_rows() where material_id like '37%';

insert into m37_checks select 'a code missing from the newest stock file has no stock',
  kt_stock_qty = 0 and not in_stock from m37_rows where material_id = '370000000001';
insert into m37_checks select 'a code in the newest file shows that quantity',
  kt_stock_qty = 40 and in_stock and kt_stock_date = '2031-03-05' from m37_rows where material_id = '370000000002';
insert into m37_checks select 'a 105 posted on the stock file date is not in that file: release still counts',
  release_counting from m37_rows where material_id = '370000000002';

-- a newer stock file arrives: the release stops counting
insert into core.stock_snapshots (material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality)
values ('370000000002', 'WH-KT', 140, '2031-03-06 23:59+07', '37000000-0000-4000-8000-000000000010', 'actual', 'source_observed');
insert into m37_checks select 'after a newer stock file the release stops counting',
  not release_counting and kt_stock_qty = 140 from core.m26_lot_rows() where material_id = '370000000002';

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m37_checks where not passed;
  if v_failed is not null then raise exception 'M37 checks failed: %', v_failed; end if;
  if (select count(*) from m37_checks) <> 4 then raise exception 'M37: expected 4 checks, got %', (select count(*) from m37_checks); end if;
end
$$;

select check_name, passed from m37_checks order by check_name;
rollback;
