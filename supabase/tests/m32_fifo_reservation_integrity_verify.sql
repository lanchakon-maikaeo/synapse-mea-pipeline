\set ON_ERROR_STOP on

-- M32: handling-unit reservations and contract-lot guidance share one
-- Khlong Toei stock, and FIFO reservations take one lock.
begin;

create temporary table m32_checks (check_name text primary key, passed boolean not null);
create temporary table m32_state (k text primary key, v jsonb);
grant select, insert, update on m32_checks, m32_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('32000000-0000-4000-8000-000000000002', '{"display_name":"M32 Academic"}');
update public.user_profiles set role = 'academic', district_id = null where user_id = '32000000-0000-4000-8000-000000000002';

update ops.environment_controls set operational_writes_enabled = true, updated_at = now() where singleton;

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('32000000-0000-4000-8000-000000000010', 'm32-test', 'm32.csv', 'm32', repeat('3', 64), 1, 'succeeded', now(), '{}');

-- A: Khlong Toei 100, of which one sealed HU holds 60. B: Khlong Toei 10, no HU.
insert into core.materials (material_id, sap_material_id, material_name, category, unit, weight_per_unit_kg, is_vmi,
  master_source, data_quality_status, source_batch_id)
select id, id, 'M32 ' || id, 'TEST', 'EA', 1, true, 'material_master', 'valid', '32000000-0000-4000-8000-000000000010'
from unnest(array['320000000001', '320000000002']) as id;

insert into core.stock_snapshots (snapshot_id, material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality, created_at) values
  ('32000000-0000-4000-8000-000000000401', '320000000001', 'WH-KT', 100, statement_timestamp() - interval '2 hours',
   '32000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', statement_timestamp() - interval '2 hours'),
  ('32000000-0000-4000-8000-000000000402', '320000000002', 'WH-KT', 10, statement_timestamp() - interval '2 hours',
   '32000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', statement_timestamp() - interval '2 hours');

-- 105 receipt of 100 for A, so all of A's Khlong Toei stock is one contract lot
insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet, expected_row_count, status, created_by) values
  ('32000000-0000-4000-8000-000000000101', 'contracts', 'รวมสัญญา.xlsx', repeat('d', 64), 10, 'Sheet1', 1, 'staged', '32000000-0000-4000-8000-000000000002'),
  ('32000000-0000-4000-8000-000000000102', 'receipts_105', '105.xlsx', repeat('e', 64), 10, 'Sheet1', 1, 'staged', '32000000-0000-4000-8000-000000000002');
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('contracts', 'm32-c1', '{"material_code":"320000000001","purchase_order":"1500000001","line_item":"1","quantity":100,"acceptance_date":"2026-02-01"}',
   md5('m32c1'), 2, '32000000-0000-4000-8000-000000000101', '32000000-0000-4000-8000-000000000101'),
  ('receipts_105', 'm32-r1', '{"material_document":"5000003201","material_document_item":"1","material_code":"320000000001","purchase_order":"1500000001","po_item":"1","quantity":100,"posting_date":"2026-02-01"}',
   md5('m32r1'), 2, '32000000-0000-4000-8000-000000000102', '32000000-0000-4000-8000-000000000102');

-- The packed HU of A (60 of the 100) at Khlong Toei
with source_row as (
  insert into raw.source_rows (batch_id, source_entity, source_sheet, source_row_number, row_hash, payload)
  values ('32000000-0000-4000-8000-000000000010', 'm32_contract', 'm32', 1, repeat('a', 64), '{}')
  returning source_row_id
), contract as (
  insert into core.contracts (contract_key, purchase_order, procurement_code, record_date, document_date, source_item_count, source_batch_id)
  values ('M32-CONTRACT', 1500000001, 'M32', current_date - 300, current_date - 300, 1, '32000000-0000-4000-8000-000000000010')
  returning contract_id
), item as (
  insert into core.contract_items (contract_id, material_id, source_row_id, source_row_number, line_item, item_description,
    unit, quantity, acceptance_date, validation_status, source_batch_id)
  select contract_id, '320000000001', source_row_id, 1, 1, 'M32 A', 'EA', 100, current_date - 280, 'valid',
    '32000000-0000-4000-8000-000000000010'
  from contract, source_row
  returning contract_item_id
), lot as (
  insert into core.receipt_lots (receipt_lot_id, lot_code, contract_item_id, warehouse_id, acceptance_date, received_qty,
    remaining_qty, traceability_status, source_batch_id, source_reference)
  select '32000000-0000-4000-8000-000000000301', 'M32-LOT', contract_item_id, 'WH-KT', current_date - 280, 100, 100,
    'complete', '32000000-0000-4000-8000-000000000010', 'm32-test'
  from item
  returning receipt_lot_id
)
insert into core.handling_units (handling_unit_id, handling_unit_code, receipt_lot_id, material_id, location_id, unit_type,
  opening_status, received_qty, available_qty, reserved_qty, source_reference)
select '32000000-0000-4000-8000-000000000311', 'M32-HU-1', receipt_lot_id, '320000000001', 'WH-KT', 'BOX',
  'SEALED', 60, 60, 0, 'm32-test'
from lot;

-- One plan: B first (takes the lot snapshot before any HU is reserved),
-- then A@5501 60 (the HU), then A@5502 100 (only 40 left in Khlong Toei).
insert into ops.replenishment_runs (replenishment_run_id, policy_version, snapshot_cutoff_at, status, candidate_count, initiated_by, finished_at)
values ('32000000-0000-4000-8000-000000000501', 'v1.0.0', now() - interval '1 day', 'succeeded', 3, '32000000-0000-4000-8000-000000000002', now());
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date, version_no,
  origin_location_id, status, response_due_at, created_by)
values ('32000000-0000-4000-8000-000000000601', '32000000-0000-4000-8000-000000000501', 'RP-M32', date_trunc('week', current_date)::date + 147, 1,
  'WH-KT', 'pending_academic_approval', now() + interval '1 day', '32000000-0000-4000-8000-000000000002');
insert into core.replenishment_items (replenishment_item_id, replenishment_plan_id, material_id, district_id, current_stock_qty, cmp_monthly,
  months_available, min_fill_qty, max_fill_qty, suggested_qty, requested_qty, final_qty, projected_months_after, source_stock_missing,
  priority_score, priority_band, status) values
  ('32000000-0000-4000-8000-000000000700', '32000000-0000-4000-8000-000000000601', '320000000002', '5501', 0, 5, 0, 5, 5, 5, 5, 5, 1, false, 9, 'critical', 'planner_approved'),
  ('32000000-0000-4000-8000-000000000701', '32000000-0000-4000-8000-000000000601', '320000000001', '5501', 0, 20, 0, 60, 60, 60, 60, 60, 3, false, 8, 'critical', 'planner_approved'),
  ('32000000-0000-4000-8000-000000000702', '32000000-0000-4000-8000-000000000601', '320000000001', '5502', 0, 20, 0, 100, 100, 100, 100, 100, 5, false, 7, 'high', 'planner_approved');

select set_config('request.jwt.claim.sub', '32000000-0000-4000-8000-000000000002', true);
set local role authenticated;
insert into m32_state values ('lock', public.m09_dispatch('POST',
  '/v1/replenishment/plans/32000000-0000-4000-8000-000000000601/approve', '{}'::jsonb, '{"note":"m32"}'::jsonb, 'm32-lock'));
reset role;

insert into m32_checks select 'plan locks',
  status = 'locked' from core.replenishment_plans where replenishment_plan_id = '32000000-0000-4000-8000-000000000601';
insert into m32_checks select 'first A line takes the HU',
  (select sum(allocated_qty) from ops.fifo_allocations where replenishment_item_id = '32000000-0000-4000-8000-000000000701') = 60;
insert into m32_checks select 'second A line is guided only what the HU left',
  coalesce((select sum(quantity) from ops.m29_fifo_guidance
    where replenishment_item_id = '32000000-0000-4000-8000-000000000702' and lot_kind <> 'short'), 0) = 40;
insert into m32_checks select 'the rest of the second A line is short',
  coalesce((select sum(quantity) from ops.m29_fifo_guidance
    where replenishment_item_id = '32000000-0000-4000-8000-000000000702' and lot_kind = 'short'), 0) = 60;
insert into m32_checks select 'HU plus guidance never exceeds Khlong Toei stock',
  (select sum(allocated_qty) from ops.fifo_allocations a
     join core.replenishment_items i using (replenishment_item_id)
    where i.replenishment_plan_id = '32000000-0000-4000-8000-000000000601' and i.material_id = '320000000001')
  + (select sum(quantity) from ops.m29_fifo_guidance
    where replenishment_plan_id = '32000000-0000-4000-8000-000000000601' and material_id = '320000000001' and lot_kind <> 'short')
  = 100;
-- A new transaction sees no free stock of A left (HU reserved 60 + guided 40)
insert into m32_checks select 'lot list shows A fully used',
  (select coalesce(sum(free_qty), 0) from core.m29_fifo_holds() where material_id = '320000000001') = 0
  and (select sum(used_qty) from core.m29_fifo_holds() where material_id = '320000000001') = 100;
insert into m32_checks select 'reservations take the FIFO lock',
  position('synapse:fifo-reservation' in pg_get_functiondef('core.reserve_fifo(text,text,numeric,uuid,uuid)'::regprocedure)) > 0
  and position('synapse:fifo-reservation' in pg_get_functiondef('core.m29_guide_item(uuid,text,numeric)'::regprocedure)) > 0;

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m32_checks where not passed;
  if v_failed is not null then
    raise exception 'M32 checks failed: % / lock %', v_failed, (select v from m32_state where k = 'lock');
  end if;
  if (select count(*) from m32_checks) <> 7 then raise exception 'M32: expected 7 checks, got %', (select count(*) from m32_checks); end if;
end
$$;

select check_name, passed from m32_checks order by check_name;
rollback;
