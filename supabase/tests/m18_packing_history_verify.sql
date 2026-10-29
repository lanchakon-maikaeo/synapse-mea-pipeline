\set ON_ERROR_STOP on

-- M18: packing worklist / save and legacy issue history import.
begin;

create temporary table m18_checks (check_name text primary key, passed boolean not null);
create temporary table m18_state (
  worklist jsonb, save_result jsonb, save_bad jsonb, viewer_save jsonb,
  import_result jsonb, import_again jsonb, summary jsonb, picker_import jsonb
);
insert into m18_state default values;
grant select, insert, update on m18_checks, m18_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('18000000-0000-4000-8000-000000000001', '{"display_name":"M18 Admin"}'),
  ('18000000-0000-4000-8000-000000000002', '{"display_name":"M18 Picker"}'),
  ('18000000-0000-4000-8000-000000000003', '{"display_name":"M18 Viewer"}');
update public.user_profiles set role = 'admin', district_id = null
where user_id = '18000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'picker', district_id = null
where user_id = '18000000-0000-4000-8000-000000000002';
update public.user_profiles set role = 'viewer', district_id = null
where user_id = '18000000-0000-4000-8000-000000000003';

insert into raw.import_batches (
  batch_id, source_system, source_file, source_sheet, source_checksum,
  row_count, status, imported_at, metadata
) values (
  '18000000-0000-4000-8000-000000000010', 'm18-contract-test', 'm18.csv', 'm18',
  repeat('f', 64), 2, 'succeeded', now(), '{"isolated":true}'::jsonb
);
insert into core.materials (
  material_id, sap_material_id, material_name, category, unit,
  weight_per_unit_kg, is_vmi, master_source, data_quality_status, source_batch_id
) values
  ('918000000001', '918000000001', 'M18 fuse link', 'TEST', 'EA', 1, true,
   'material_master', 'valid', '18000000-0000-4000-8000-000000000010'),
  ('918000000002', '918000000002', 'M18 bolt', 'TEST', 'EA', 1, true,
   'material_master', 'valid', '18000000-0000-4000-8000-000000000010');

insert into ops.source_import_runs (
  import_run_id, source_kind, file_name, file_sha256, expected_row_count,
  status, created_by, committed_by, committed_at
) values
  ('18000000-0000-4000-8000-000000000101', 'contracts', 'contracts.xlsx', repeat('a', 64), 2,
   'committed', '18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000001', now()),
  ('18000000-0000-4000-8000-000000000102', 'receipts_105', '105.xlsx', repeat('b', 64), 2,
   'committed', '18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000001', now());

insert into ops.source_current_rows (
  source_kind, business_key, payload, row_hash, first_import_run_id, last_changed_run_id
) values
  ('contracts', 'm18-c1', '{"material_code":"000000918000000001","purchase_order":"4500918001","line_item":"10","contract_number":"C-918","vendor":"Vendor Alpha","item_description":"FUSE LINK","unit":"EA","acceptance_date":"2026-10-01"}',
   md5('c1'), '18000000-0000-4000-8000-000000000101', '18000000-0000-4000-8000-000000000101'),
  ('contracts', 'm18-c2', '{"material_code":"918000000002","purchase_order":"4500918002","line_item":"10","contract_number":"C-919","vendor":"Vendor Beta","item_description":"BOLT","unit":"EA"}',
   md5('c2'), '18000000-0000-4000-8000-000000000101', '18000000-0000-4000-8000-000000000101'),
  ('receipts_105', 'm18-r1', '{"material_code":"918000000001","purchase_order":"4500918001","material_document":"5000001","quantity":"1,200","posting_date":"2026-10-02","unit":"EA"}',
   md5('r1'), '18000000-0000-4000-8000-000000000102', '18000000-0000-4000-8000-000000000102'),
  ('receipts_105', 'm18-r2', '{"material_code":"918000000001","purchase_order":"4500918001","material_document":"5000002","quantity":"800","posting_date":"2026-10-09","unit":"EA"}',
   md5('r2'), '18000000-0000-4000-8000-000000000102', '18000000-0000-4000-8000-000000000102');

-- Picker saves packing for the received lot.
select set_config('request.jwt.claim.sub', '18000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update m18_state set worklist = public.m09_dispatch('GET', '/v1/packing/worklist', '{}', '{}', 'm18-w1');
update m18_state set save_result = public.m09_dispatch('POST', '/v1/packing/profiles', '{}',
  '{"profile":{"material_id":"918000000001","vendor_name":"Vendor Alpha","contract_no":"C-918",
    "purchase_order":"4500918001","package_type":"BOX","units_per_package":100,
    "box_length_cm":40,"box_width_cm":30,"box_height_cm":25,"box_gross_weight_kg":12.5,
    "boxes_per_layer":8,"stack_layers":5,"boxes_per_pallet":40,"units_per_pallet":4000,
    "pallet_length_m":1.2,"pallet_width_m":1.0,"load_height_m":1.4,"pallet_tare_kg":20,
    "calculated_pallet_gross_kg":520,"assumption_status":"VERIFIED",
    "source_reference":"วัดจริง ล็อต 2026-10-02"}}', 'm18-s1');
update m18_state set save_bad = public.m09_dispatch('POST', '/v1/packing/profiles', '{}',
  '{"profile":{"material_id":"918000000001","purchase_order":"4500918001","package_type":"BOX","units_per_package":0}}', 'm18-s2');
reset role;

select set_config('request.jwt.claim.sub', '18000000-0000-4000-8000-000000000003', true);
set local role authenticated;
update m18_state set viewer_save = public.m09_dispatch('POST', '/v1/packing/profiles', '{}',
  '{"profile":{"material_id":"918000000001","package_type":"BOX","units_per_package":10}}', 'm18-s3');
reset role;

-- Picker cannot import history; admin can, and re-import is idempotent.
select set_config('request.jwt.claim.sub', '18000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update m18_state set picker_import = public.m09_dispatch('POST', '/v1/admin/legacy-issue-history', '{}',
  '{"rows":[{"district_id":"5501","material_id":"918000000001","outcome":"issued"}]}', 'm18-i0');
reset role;

select set_config('request.jwt.claim.sub', '18000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m18_state set import_result = public.m09_dispatch('POST', '/v1/admin/legacy-issue-history', '{}',
  '{"source_file":"legacy.xlsx","rows":[
    {"district_id":"5501","district_name":"เขตนวลจันทร์","material_id":"918000000001","plan_date":"2026-02-04","actual_date":"2026-02-05","planned_qty":100,"issued_qty":100,"outcome":"issued","fill_type":"vmi","lot_size_text":"(1กล่อง@100)","source_sheet":"History จ่ายได้ตามแผน","source_row":2},
    {"district_id":"5701","material_id":"918000000002","plan_date":"2026-02-05","planned_qty":2000,"outcome":"refused","fill_type":"passed_test","note":"ใช้งานน้อย","refused_by":"นาง ก","review_flags":["missing_actual"]},
    {"district_id":"5701","material_id":"918000000002","plan_date":"2026-03-05","planned_qty":300,"issued_qty":600,"outcome":"adjusted","fill_type":"district_request","note":"ขอเพิ่ม"},
    {"district_id":"","material_id":"918000000002","outcome":"issued"}
  ]}', 'm18-i1');
update m18_state set import_again = public.m09_dispatch('POST', '/v1/admin/legacy-issue-history', '{}',
  '{"source_file":"legacy.xlsx","rows":[
    {"district_id":"5501","material_id":"918000000001","plan_date":"2026-02-04","actual_date":"2026-02-05","planned_qty":100,"issued_qty":100,"outcome":"issued","fill_type":"vmi","note":"แก้หมายเหตุ"}
  ]}', 'm18-i2');
update m18_state set summary = public.m09_dispatch('GET', '/v1/admin/legacy-issue-history', '{}', '{}', 'm18-i3');
update m18_state set worklist = public.m09_dispatch('GET', '/v1/packing/worklist', '{}', '{}', 'm18-w2');
reset role;

insert into m18_checks select 'worklist lists received and accepted lots',
  (worklist ->> 'status')::int = 200
  and exists (select 1 from jsonb_array_elements(worklist -> 'body') e
    where e ->> 'material_id' = '918000000001' and e ->> 'purchase_order' = '4500918001'
      and (e ->> 'received_qty')::numeric = 2000 and (e ->> 'receipt_lines')::int = 2
      and e ->> 'vendor_name' = 'Vendor Alpha' and e ->> 'contract_no' = 'C-918')
from m18_state;
insert into m18_checks select 'unreceived, unaccepted contract line excluded',
  not exists (select 1 from jsonb_array_elements(worklist -> 'body') e
    where e ->> 'material_id' = '918000000002')
from m18_state;
insert into m18_checks select 'picker saves packing',
  (save_result ->> 'status')::int = 200 from m18_state;
insert into m18_checks select 'saved profile is verified with dimensions',
  count(*) = 1 and bool_and(assumption_status = 'VERIFIED' and verified
    and box_length_cm = 40 and boxes_per_pallet = 40 and units_per_pallet = 4000
    and vendor_alias = 'Vendor Alpha')
from core.packaging_master_profiles where material_id = '918000000001';
insert into m18_checks select 'worklist shows verified status after save',
  exists (select 1 from jsonb_array_elements(worklist -> 'body') e
    where e ->> 'material_id' = '918000000001' and e ->> 'packing_status' = 'verified'
      and (e -> 'profile' ->> 'units_per_package')::numeric = 100)
from m18_state;
insert into m18_checks select 'zero units rejected', (save_bad ->> 'status')::int = 400 from m18_state;
insert into m18_checks select 'viewer cannot save packing', (viewer_save ->> 'status')::int = 403 from m18_state;
insert into m18_checks select 'picker cannot import history', (picker_import ->> 'status')::int = 403 from m18_state;
insert into m18_checks select 'history imported, invalid row skipped',
  (import_result ->> 'status')::int = 200
  and (import_result #>> '{body,inserted}')::int = 3
  and (import_result #>> '{body,skipped}')::int = 1
from m18_state;
insert into m18_checks select 're-import updates instead of duplicating',
  (import_again #>> '{body,inserted}')::int = 0 and (import_again #>> '{body,updated}')::int = 1
  and (select count(*) from ops.legacy_issue_history where material_id like '9180%') = 3
  and (select note from ops.legacy_issue_history where district_id = '5501' and material_id = '918000000001') = 'แก้หมายเหตุ'
from m18_state;
insert into m18_checks select 'history summary counts outcomes',
  (summary ->> 'status')::int = 200 and (summary #>> '{body,refused}')::int >= 1
  and (summary #>> '{body,adjusted}')::int >= 1
from m18_state;
insert into m18_checks select 'refusal keeps reason and flags',
  exists (select 1 from ops.legacy_issue_history where outcome = 'refused'
    and note = 'ใช้งานน้อย' and refused_by = 'นาง ก' and review_flags = array['missing_actual']
    and fill_type = 'passed_test');

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m18_checks where not passed;
  if v_failed is not null then raise exception 'M18 checks failed: %', v_failed; end if;
  if (select count(*) from m18_checks) <> 12 then raise exception 'M18: expected 12 checks'; end if;
end
$$;

select check_name, passed from m18_checks order by check_name;
rollback;
