\set ON_ERROR_STOP on

-- M28: confirming a Stock คลังคลองเตย file sets the VMI list to the materials in that file.
begin;

create temporary table m28_checks (check_name text primary key, passed boolean not null);

insert into auth.users (id, raw_user_meta_data) values ('28000000-0000-4000-8000-000000000001', '{"display_name":"M28 Admin"}');
insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('28000000-0000-4000-8000-000000000010', 'm28-test', 'm28.csv', 'm28', repeat('8', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, unit, is_vmi, master_source, data_quality_status, source_batch_id) values
  ('280000000001', '280000000001', 'in stock, not VMI yet', 'EA', false, 'material_master', 'valid', '28000000-0000-4000-8000-000000000010'),
  ('280000000002', '280000000002', 'VMI, no longer in stock file', 'EA', true, 'material_master', 'valid', '28000000-0000-4000-8000-000000000010');

-- Nothing else is VMI in this test
update core.materials set is_vmi = false where material_id not like '28000000000%';

insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet,
  expected_row_count, status, created_by)
values ('28000000-0000-4000-8000-000000000101', 'stock', 'EXPORT คลองเตย 6-11-69.XLSX', repeat('a', 64), 10, 'Sheet1', 3, 'staged',
  '28000000-0000-4000-8000-000000000001');
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('stock', '2401|0001|280000000001', '{"sap_plant_code":"2401","storage_location_code":"0001","material_id":"280000000001","unrestricted_qty":5,"warehouse_id":"WH-KT"}',
   md5('a'), 2, '28000000-0000-4000-8000-000000000101', '28000000-0000-4000-8000-000000000101'),
  ('stock', '2401|0002|280000000001', '{"sap_plant_code":"2401","storage_location_code":"0002","material_id":"280000000001","unrestricted_qty":0,"warehouse_id":"WH-KT"}',
   md5('b'), 3, '28000000-0000-4000-8000-000000000101', '28000000-0000-4000-8000-000000000101'),
  ('stock', '2401|0001|280000000003', '{"sap_plant_code":"2401","storage_location_code":"0001","material_id":"280000000003","material_name":"NEW FROM STOCK","base_unit":"M","unrestricted_qty":9,"warehouse_id":"WH-KT"}',
   md5('c'), 4, '28000000-0000-4000-8000-000000000101', '28000000-0000-4000-8000-000000000101'),
  ('stock', '5501|0001|280000000002', '{"sap_plant_code":"5501","storage_location_code":"0001","material_id":"280000000002","unrestricted_qty":9,"district_id":"5501"}',
   md5('d'), 5, '28000000-0000-4000-8000-000000000101', '28000000-0000-4000-8000-000000000101');

insert into m28_checks select 'not VMI before the file is confirmed',
  not is_vmi from core.materials where material_id = '280000000001';

update ops.source_import_runs set status = 'committed', committed_by = '28000000-0000-4000-8000-000000000001', committed_at = now()
where import_run_id = '28000000-0000-4000-8000-000000000101';

insert into m28_checks select 'material in the Khlong Toei file becomes VMI',
  is_vmi from core.materials where material_id = '280000000001';
insert into m28_checks select 'material not in the file is no longer VMI (district rows do not count)',
  not is_vmi from core.materials where material_id = '280000000002';
insert into m28_checks select 'unknown code added from the stock file as VMI',
  is_vmi and material_name = 'NEW FROM STOCK' and unit = 'M' from core.materials where material_id = '280000000003';
insert into m28_checks select 'VMI list is exactly the file',
  (select count(*) from core.materials where is_vmi) = 2;

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m28_checks where not passed;
  if v_failed is not null then raise exception 'M28 checks failed: %', v_failed; end if;
  if (select count(*) from m28_checks) <> 5 then raise exception 'M28: expected 5 checks, got %', (select count(*) from m28_checks); end if;
end
$$;

select check_name, passed from m28_checks order by check_name;
rollback;
