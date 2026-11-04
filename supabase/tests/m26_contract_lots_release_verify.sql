\set ON_ERROR_STOP on

-- M26: รวมสัญญา matched with 105 and Stock; planner releases passed-inspection lots.
begin;

create temporary table m26_checks (check_name text primary key, passed boolean not null);
create temporary table m26_state (k text primary key, v jsonb);
grant select, insert, update on m26_checks, m26_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('26000000-0000-4000-8000-000000000001', '{"display_name":"M26 Planner"}'),
  ('26000000-0000-4000-8000-000000000002', '{"display_name":"M26 Viewer"}');
update public.user_profiles set role = 'planner' where user_id = '26000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'viewer' where user_id = '26000000-0000-4000-8000-000000000002';

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('26000000-0000-4000-8000-000000000010', 'm26-test', 'm26.csv', 'm26', repeat('6', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, unit, is_vmi, master_source, data_quality_status, source_batch_id) values
  ('260000000001', '260000000001', 'M26 clamp', 'EA', true, 'material_master', 'valid', '26000000-0000-4000-8000-000000000010'),
  ('260000000002', '260000000002', 'M26 bolt', 'EA', true, 'material_master', 'valid', '26000000-0000-4000-8000-000000000010'),
  ('260000000003', '260000000003', 'M26 not ours', 'EA', true, 'material_master', 'valid', '26000000-0000-4000-8000-000000000010');

insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet,
  expected_row_count, status, created_by, committed_by, committed_at) values
  ('26000000-0000-4000-8000-000000000101', 'contracts', 'รวมสัญญา.xlsx', repeat('a', 64), 10, 'Sheet1', 7, 'committed',
   '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('26000000-0000-4000-8000-000000000102', 'receipts_105', '105 old.xlsx', repeat('b', 64), 10, 'Sheet1', 3, 'committed',
   '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000001', now() - interval '3 hours'),
  ('26000000-0000-4000-8000-000000000103', 'receipts_105', '105 new.xlsx', repeat('c', 64), 10, 'Sheet1', 2, 'committed',
   '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000001', now() - interval '2 hours'),
  ('26000000-0000-4000-8000-000000000104', 'stock', 'Stock KT.xlsx', repeat('d', 64), 10, 'Sheet1', 1, 'committed',
   '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000001', now() - interval '2 hours');

insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  -- A: contract, 3 installments
  ('contracts', 'c1', '{"material_code":"260000000001","purchase_order":"1400000001","contract_number":"MA9-TEST-WGA","line_item":"1","quantity":"50","unit":"EA","delivery_date":"2026-07-15","acceptance_date":"2026-07-10","vendor":"V1"}',
   md5('c1'), 2, '26000000-0000-4000-8000-000000000101', '26000000-0000-4000-8000-000000000101'),
  ('contracts', 'c2', '{"material_code":"260000000001","purchase_order":"1400000001","contract_number":"MA9-TEST-WGA","line_item":"2","quantity":"60","unit":"EA","delivery_date":"2026-10-30","acceptance_date":"2026-10-20","vendor":"V1"}',
   md5('c2'), 3, '26000000-0000-4000-8000-000000000101', '26000000-0000-4000-8000-000000000101'),
  ('contracts', 'c3', '{"material_code":"260000000001","purchase_order":"1400000001","contract_number":"MA9-TEST-WGA","line_item":"3","quantity":"70","unit":"EA","delivery_date":"2026-01-01","acceptance_date":"","vendor":"V1"}',
   md5('c3'), 4, '26000000-0000-4000-8000-000000000101', '26000000-0000-4000-8000-000000000101'),
  -- B: order (ใบสั่ง, no contract number), not in stock, 105 only in an older export
  ('contracts', 'c4', '{"material_code":"260000000002","purchase_order":"1300000002","contract_number":"","line_item":"1","quantity":"10","unit":"EA","delivery_date":"2026-08-05","acceptance_date":"2026-08-01"}',
   md5('c4'), 5, '26000000-0000-4000-8000-000000000101', '26000000-0000-4000-8000-000000000101'),
  ('contracts', 'c5', '{"material_code":"260000000002","purchase_order":"1300000002","contract_number":"","line_item":"2","quantity":"10","unit":"EA","delivery_date":"2025-01-05","acceptance_date":"2025-01-01"}',
   md5('c5'), 6, '26000000-0000-4000-8000-000000000101', '26000000-0000-4000-8000-000000000101'),
  -- C: someone else's contract
  ('contracts', 'c6', '{"material_code":"260000000003","purchase_order":"1400000003","contract_number":"MA9-OTHER-WGA","line_item":"1","quantity":"5","unit":"EA","delivery_date":"2026-10-05","acceptance_date":"2026-10-01"}',
   md5('c6'), 7, '26000000-0000-4000-8000-000000000101', '26000000-0000-4000-8000-000000000101'),
  -- 105
  ('receipts_105', 'r1', '{"material_code":"260000000001","purchase_order":"1400000001","item":"1","po_item":"1","material_document":"5000000001","quantity":"50","unit":"EA","posting_date":"2026-07-10","source_layout":"sap_105_13"}',
   md5('r1'), 2, '26000000-0000-4000-8000-000000000103', '26000000-0000-4000-8000-000000000103'),
  ('receipts_105', 'r2', '{"material_code":"260000000002","purchase_order":"1300000002","item":"1","po_item":"1","material_document":"5000000002","quantity":"10","unit":"EA","posting_date":"2026-08-01","source_layout":"sap_105_13"}',
   md5('r2'), 3, '26000000-0000-4000-8000-000000000102', '26000000-0000-4000-8000-000000000102'),
  -- the same receipt seen again under another key must not double count
  ('receipts_105', 'r2b', '{"material_code":"260000000002","purchase_order":"1300000002","item":"1","po_item":"1","material_document":"5000000002","gr_gi_slip":"DDS1","quantity":"10","unit":"EA","posting_date":"2026-08-01","source_layout":"sap_105_17"}',
   md5('r2b'), 2, '26000000-0000-4000-8000-000000000103', '26000000-0000-4000-8000-000000000103'),
  -- 105 lot whose PO is not in รวมสัญญา
  ('receipts_105', 'r3', '{"material_code":"260000000001","purchase_order":"1400000099","item":"1","po_item":"1","material_document":"5000000003","quantity":"7","unit":"EA","posting_date":"2026-09-01","source_layout":"sap_105_13"}',
   md5('r3'), 3, '26000000-0000-4000-8000-000000000103', '26000000-0000-4000-8000-000000000103'),
  ('stock', 's1', '{"sap_plant_code":"2401","storage_location_code":"0001","material_id":"260000000001","unrestricted_qty":100,"warehouse_id":"WH-KT","snapshot_date":"2026-10-25"}',
   md5('s1'), 2, '26000000-0000-4000-8000-000000000104', '26000000-0000-4000-8000-000000000104');

-- the old 105 export was replaced by a newer one covering fewer dates
update ops.source_current_rows set missing_since_run_id = '26000000-0000-4000-8000-000000000103'
where source_kind = 'receipts_105' and business_key = 'r2';
-- a shorter รวมสัญญา export left out installment 3: it keeps its last values (M26b)
update ops.source_current_rows set missing_since_run_id = '26000000-0000-4000-8000-000000000103'
where source_kind = 'contracts' and business_key = 'c3';

insert into core.stock_snapshots (material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality)
values ('260000000001', 'WH-KT', 100, '2026-10-25 12:00+07', '26000000-0000-4000-8000-000000000010', 'actual', 'source_observed');

create temporary table m26_rows as select * from core.m26_lot_rows();
insert into m26_state values ('relevant', core.m26_contract_lots());
insert into m26_state values ('all', core.m26_contract_lots('all'));

-- viewer reads but cannot confirm
select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000002', true);
set local role authenticated;
insert into m26_state values ('viewer_get', public.m09_dispatch('GET', '/v1/contract-lots', '{}', '{}', 'm26-0'));
insert into m26_state values ('viewer_confirm', public.m09_dispatch('POST', '/v1/contract-lots/confirm', '{}',
  '{"purchase_order":"1400000001","material_id":"260000000001","line_item":"2","quantity":60}', 'm26-1'));
reset role;

select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000001', true);
set local role authenticated;
insert into m26_state values ('ready_confirm', public.m09_dispatch('POST', '/v1/contract-lots/confirm', '{}',
  '{"purchase_order":"1400000001","material_id":"260000000001","line_item":"1","quantity":50}', 'm26-2'));
insert into m26_state values ('too_much', public.m09_dispatch('POST', '/v1/contract-lots/confirm', '{}',
  '{"purchase_order":"1400000001","material_id":"260000000001","line_item":"2","quantity":61}', 'm26-3'));
insert into m26_state values ('not_accepted', public.m09_dispatch('POST', '/v1/contract-lots/confirm', '{}',
  '{"purchase_order":"1400000001","material_id":"260000000001","line_item":"3","quantity":10}', 'm26-4'));
insert into m26_state values ('confirm', public.m09_dispatch('POST', '/v1/contract-lots/confirm', '{}',
  '{"purchase_order":"1400000001","material_id":"260000000001","line_item":"2","quantity":60,"note":"ของอยู่ในคลังแล้ว"}', 'm26-5'));
insert into m26_state values ('again', public.m09_dispatch('POST', '/v1/contract-lots/confirm', '{}',
  '{"purchase_order":"1400000001","material_id":"260000000001","line_item":"2","quantity":60}', 'm26-6'));
insert into m26_state values ('stock_released', public.m09_dispatch('GET', '/v1/warehouse-stock', '{}', '{}', 'm26-7'));
reset role;

-- 105 for installment 2 posted after the stock snapshot: still counted
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('receipts_105', 'r4', '{"material_code":"260000000001","purchase_order":"1400000001","item":"1","po_item":"2","material_document":"5000000004","quantity":"60","unit":"EA","posting_date":"2026-10-28","source_layout":"sap_105_13"}',
   md5('r4'), 4, '26000000-0000-4000-8000-000000000103', '26000000-0000-4000-8000-000000000103');
create temporary table m26_after105 as select * from core.m26_lot_rows() where purchase_order = '1400000001' and line_item = '2';

-- newer stock snapshot already contains it: the release stops counting
insert into core.stock_snapshots (material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality)
values ('260000000001', 'WH-KT', 160, '2026-10-30 12:00+07', '26000000-0000-4000-8000-000000000010', 'actual', 'source_observed');
select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000001', true);
set local role authenticated;
insert into m26_state values ('stock_after', public.m09_dispatch('GET', '/v1/warehouse-stock', '{}', '{}', 'm26-8'));
insert into m26_state values ('cancel', public.m09_dispatch('POST', '/v1/contract-lots/cancel', '{}',
  jsonb_build_object('release_id', (select v #>> '{body,release_id}' from m26_state where k = 'confirm'), 'reason', 'ทดสอบ'), 'm26-9'));
reset role;

insert into m26_checks select 'installment with 105 is ready',
  status = 'ready' and received_qty = 50 and order_kind = 'contract' and contract_number = 'MA9-TEST-WGA'
from m26_rows where purchase_order = '1400000001' and line_item = '1';
insert into m26_checks select 'accepted without 105 awaits planner',
  status = 'awaiting_105' from m26_rows where purchase_order = '1400000001' and line_item = '2';
insert into m26_checks select 'not accepted and late is overdue, kept when missing from a newer export',
  status = 'overdue' from m26_rows where purchase_order = '1400000001' and line_item = '3';
insert into m26_checks select 'order without contract number, 105 kept from older export, counted once',
  status = 'ready' and order_kind = 'order' and relevant and received_qty = 10 and receipt_count = 1
from m26_rows where purchase_order = '1300000002' and line_item = '1';
insert into m26_checks select 'accepted before 105 history is not actionable',
  status = 'accepted_before' from m26_rows where purchase_order = '1300000002' and line_item = '2';
insert into m26_checks select 'other contracts are not ours',
  not relevant from m26_rows where purchase_order = '1400000003';
insert into m26_checks select '105 without contract line is listed',
  order_kind = 'no_contract' and status = 'ready' and received_qty = 7 from m26_rows where purchase_order = '1400000099';
insert into m26_checks select 'relevant scope hides other contracts',
  not exists (select 1 from jsonb_array_elements(v -> 'rows') r where r ->> 'purchase_order' = '1400000003')
  and (v #>> '{summary,awaiting_105}')::int = 1 and (v #>> '{summary,relevant_lines}')::int = 5
from m26_state where k = 'relevant';
insert into m26_checks select 'all scope shows them',
  exists (select 1 from jsonb_array_elements(v -> 'rows') r where r ->> 'purchase_order' = '1400000003')
from m26_state where k = 'all';
insert into m26_checks select 'viewer reads, cannot confirm',
  (select (v ->> 'status')::int from m26_state where k = 'viewer_get') = 200
  and (select (v ->> 'status')::int from m26_state where k = 'viewer_confirm') = 403;
insert into m26_checks select 'confirm refuses ready, too much, not accepted, duplicate',
  (select (v ->> 'status')::int from m26_state where k = 'ready_confirm') = 400
  and (select (v ->> 'status')::int from m26_state where k = 'too_much') = 400
  and (select (v ->> 'status')::int from m26_state where k = 'not_accepted') = 400
  and (select (v ->> 'status')::int from m26_state where k = 'again') = 400;
insert into m26_checks select 'planner confirms',
  (v ->> 'status')::int = 200 and (v #>> '{body,quantity}')::numeric = 60 from m26_state where k = 'confirm';
insert into m26_checks select 'released quantity added to Khlong Toei stock',
  exists (select 1 from jsonb_array_elements(v -> 'body') r where r ->> 'material_id' = '260000000001'
    and r ->> 'location_id' = 'WH-KT' and (r ->> 'quantity_on_hand')::numeric = 160
    and (r ->> 'sap_quantity')::numeric = 100 and (r ->> 'passed_test_qty')::numeric = 60)
from m26_state where k = 'stock_released';
insert into m26_checks select '105 after snapshot keeps counting',
  status = 'ready' and release_counting from m26_after105;
insert into m26_checks select 'newer snapshot stops double counting',
  exists (select 1 from jsonb_array_elements(v -> 'body') r where r ->> 'material_id' = '260000000001'
    and r ->> 'location_id' = 'WH-KT' and (r ->> 'quantity_on_hand')::numeric = 160 and r -> 'passed_test_qty' is null)
from m26_state where k = 'stock_after';
insert into m26_checks select 'planner cancels release',
  (v ->> 'status')::int = 200 and exists (select 1 from ops.passed_test_releases
    where cancelled_at is not null and cancel_reason = 'ทดสอบ' and confirmed_by_name = 'M26 Planner')
from m26_state where k = 'cancel';

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m26_checks where not passed;
  if v_failed is not null then raise exception 'M26 checks failed: %', v_failed; end if;
  if (select count(*) from m26_checks) <> 16 then raise exception 'M26: expected 16 checks, got %', (select count(*) from m26_checks); end if;
end
$$;

select check_name, passed from m26_checks order by check_name;
rollback;
