\set ON_ERROR_STOP on

-- M29: FIFO from รวมสัญญา + 105 without handling units, plan recalculation
-- with the latest stock, Khlong Toei stock on plan lines.
begin;

create temporary table m29_checks (check_name text primary key, passed boolean not null);
create temporary table m29_state (k text primary key, v jsonb);
grant select, insert, update on m29_checks, m29_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('29000000-0000-4000-8000-000000000001', '{"display_name":"M29 Planner"}'),
  ('29000000-0000-4000-8000-000000000002', '{"display_name":"M29 Academic"}'),
  ('29000000-0000-4000-8000-000000000003', '{"display_name":"M29 Picker"}');
update public.user_profiles set role = 'planner', district_id = null where user_id = '29000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'academic', district_id = null where user_id = '29000000-0000-4000-8000-000000000002';
update public.user_profiles set role = 'picker', district_id = null where user_id = '29000000-0000-4000-8000-000000000003';

update ops.environment_controls set operational_writes_enabled = true, updated_at = now() where singleton;

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('29000000-0000-4000-8000-000000000010', 'm29-test', 'm29.csv', 'm29', repeat('9', 64), 1, 'succeeded', now(), '{}');

insert into core.materials (material_id, sap_material_id, material_name, category, unit, weight_per_unit_kg, is_vmi,
  master_source, data_quality_status, source_batch_id)
select id, id, 'M29 ' || id, 'TEST', 'EA', 1, true, 'material_master', 'valid', '29000000-0000-4000-8000-000000000010'
from unnest(array['290000000001', '290000000002']) as id;

-- Khlong Toei 150 of A; district 5501 has 10 of A (CMP 20) and 100 of B (CMP 10)
insert into core.stock_snapshots (snapshot_id, material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality, created_at) values
  ('29000000-0000-4000-8000-000000000401', '290000000001', 'WH-KT', 150, statement_timestamp() - interval '2 hours',
   '29000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', statement_timestamp() - interval '2 hours'),
  ('29000000-0000-4000-8000-000000000402', '290000000001', 'DIST-5501', 10, statement_timestamp() - interval '2 hours',
   '29000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', statement_timestamp() - interval '2 hours'),
  ('29000000-0000-4000-8000-000000000403', '290000000002', 'DIST-5501', 100, statement_timestamp() - interval '2 hours',
   '29000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', statement_timestamp() - interval '2 hours');
insert into core.usage_rates (usage_rate_id, material_id, district_id, as_of_date, cmp_monthly, avg_ly, avg_12m, avg_6m, avg_4m,
  source_batch_id, data_class, source_quality, created_at, updated_at) values
  ('29000000-0000-4000-8000-000000000411', '290000000001', '5501', current_date - 1, 20, 20, 20, 20, 20,
   '29000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', statement_timestamp() - interval '2 hours', statement_timestamp() - interval '2 hours'),
  ('29000000-0000-4000-8000-000000000412', '290000000002', '5501', current_date - 1, 10, 10, 10, 10, 10,
   '29000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', statement_timestamp() - interval '2 hours', statement_timestamp() - interval '2 hours');

-- รวมสัญญา + 105 for A: an older order (2025) and a newer one (2026), 100 each
insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet, expected_row_count, status, created_by) values
  ('29000000-0000-4000-8000-000000000101', 'contracts', 'รวมสัญญา.xlsx', repeat('b', 64), 10, 'Sheet1', 2, 'staged', '29000000-0000-4000-8000-000000000001'),
  ('29000000-0000-4000-8000-000000000102', 'receipts_105', '105.xlsx', repeat('c', 64), 10, 'Sheet1', 2, 'staged', '29000000-0000-4000-8000-000000000001');
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('contracts', 'm29-c1', '{"material_code":"290000000001","purchase_order":"1300000001","line_item":"1","quantity":100,"acceptance_date":"2025-03-01"}',
   md5('c1'), 2, '29000000-0000-4000-8000-000000000101', '29000000-0000-4000-8000-000000000101'),
  ('contracts', 'm29-c2', '{"material_code":"290000000001","purchase_order":"1400000002","line_item":"1","contract_number":"MA9-TEST","quantity":100,"acceptance_date":"2026-01-10"}',
   md5('c2'), 3, '29000000-0000-4000-8000-000000000101', '29000000-0000-4000-8000-000000000101'),
  ('receipts_105', 'm29-r1', '{"material_document":"5000000001","material_document_item":"1","material_code":"290000000001","purchase_order":"1300000001","po_item":"1","quantity":100,"posting_date":"2025-03-01"}',
   md5('r1'), 2, '29000000-0000-4000-8000-000000000102', '29000000-0000-4000-8000-000000000102'),
  ('receipts_105', 'm29-r2', '{"material_document":"5000000002","material_document_item":"1","material_code":"290000000001","purchase_order":"1400000002","po_item":"1","quantity":100,"posting_date":"2026-01-10"}',
   md5('r2'), 3, '29000000-0000-4000-8000-000000000102', '29000000-0000-4000-8000-000000000102');

-- A plan made with older stock: A@5501 (40 in stock then), B@5501 (needed then), B@5502 already confirmed
insert into ops.replenishment_runs (replenishment_run_id, policy_version, snapshot_cutoff_at, status, candidate_count, initiated_by, finished_at)
values ('29000000-0000-4000-8000-000000000501', 'v1.0.0', now() - interval '1 day', 'succeeded', 3, '29000000-0000-4000-8000-000000000001', now());
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date, version_no,
  origin_location_id, status, response_due_at, created_by)
values ('29000000-0000-4000-8000-000000000601', '29000000-0000-4000-8000-000000000501', 'RP-M29', date_trunc('week', current_date)::date + 140, 1,
  'WH-KT', 'pending_district_confirmation', now() + interval '1 day', '29000000-0000-4000-8000-000000000001');
insert into core.replenishment_items (replenishment_item_id, replenishment_plan_id, material_id, district_id, current_stock_qty, cmp_monthly,
  months_available, min_fill_qty, max_fill_qty, suggested_qty, requested_qty, final_qty, projected_months_after, source_stock_missing,
  priority_score, priority_band, status) values
  ('29000000-0000-4000-8000-000000000701', '29000000-0000-4000-8000-000000000601', '290000000001', '5501', 40, 20, 2, 40, 80, 80, 80, 80, 6, false, 6, 'high', 'pending'),
  ('29000000-0000-4000-8000-000000000702', '29000000-0000-4000-8000-000000000601', '290000000002', '5501', 10, 10, 1, 30, 50, 50, 50, 50, 6, false, 8, 'critical', 'pending'),
  ('29000000-0000-4000-8000-000000000703', '29000000-0000-4000-8000-000000000601', '290000000002', '5502', 10, 10, 1, 30, 50, 50, 50, 50, 6, false, 8, 'critical', 'district_confirmed');

-- 1. Recalculate with the latest stock ------------------------------------
select set_config('request.jwt.claim.sub', '29000000-0000-4000-8000-000000000001', true);
set local role authenticated;
insert into m29_state values ('recalc', public.m09_dispatch('POST',
  '/v1/replenishment/plans/29000000-0000-4000-8000-000000000601/recalculate', '{}'::jsonb, '{}'::jsonb, 'm29-recalc'));
insert into m29_state values ('fifo', public.m09_dispatch('GET', '/v1/inventory/fifo', '{"material_id":"290000000001"}'::jsonb, '{}'::jsonb, 'm29-fifo'));
reset role;

insert into m29_checks select 'recalculate answers 200',
  (v ->> 'status')::int = 200 from m29_state where k = 'recalc';
insert into m29_checks select 'unconfirmed line takes the latest stock',
  current_stock_qty = 10 and suggested_qty = 110 and final_qty = 110 and status = 'pending'
from core.replenishment_items where replenishment_item_id = '29000000-0000-4000-8000-000000000701';
insert into m29_checks select 'line no longer needed is cancelled',
  status = 'cancelled' from core.replenishment_items where replenishment_item_id = '29000000-0000-4000-8000-000000000702';
insert into m29_checks select 'district-confirmed line is kept as it was',
  status = 'district_confirmed' and suggested_qty = 50 and current_stock_qty = 10
from core.replenishment_items where replenishment_item_id = '29000000-0000-4000-8000-000000000703';
insert into m29_checks select 'recalculation is recorded with new inputs',
  exists (select 1 from ops.m29_plan_recalculations where replenishment_plan_id = '29000000-0000-4000-8000-000000000601')
  and exists (select 1 from ops.m29_recalculated_inputs where replenishment_item_id = '29000000-0000-4000-8000-000000000701'
    and (input_payload ->> 'current_stock_qty')::numeric = 10);

-- 2. FIFO list from contract lots: Khlong Toei 150 = newest 100 + 50 of the older order
insert into m29_checks select 'FIFO lists contract lots oldest first',
  (select jsonb_agg(jsonb_build_array(e ->> 'purchase_order', (e ->> 'allocatable_qty')::numeric) order by (e ->> 'fifo_sequence')::int)
   from m29_state s, jsonb_array_elements(s.v -> 'body') e where s.k = 'fifo')
  = '[["1300000001", 50], ["1400000002", 100]]'::jsonb;

-- 3. Lock without handling units --------------------------------------------
update core.replenishment_items set status = 'planner_approved', final_qty = 110
where replenishment_item_id = '29000000-0000-4000-8000-000000000701';
update core.replenishment_items set status = 'planner_approved'
where replenishment_item_id = '29000000-0000-4000-8000-000000000703';
update core.replenishment_plans set status = 'pending_academic_approval'
where replenishment_plan_id = '29000000-0000-4000-8000-000000000601';

select set_config('request.jwt.claim.sub', '29000000-0000-4000-8000-000000000002', true);
set local role authenticated;
insert into m29_state values ('lock', public.m09_dispatch('POST',
  '/v1/replenishment/plans/29000000-0000-4000-8000-000000000601/approve', '{}'::jsonb, '{"note":"m29"}'::jsonb, 'm29-lock'));
insert into m29_state values ('queue', public.m09_dispatch('GET', '/v1/replenishment/queue', '{}'::jsonb, '{}'::jsonb, 'm29-queue'));
reset role;

insert into m29_checks select 'plan locks without handling units',
  status = 'locked' from core.replenishment_plans where replenishment_plan_id = '29000000-0000-4000-8000-000000000601';
insert into m29_checks select 'FIFO guidance: 50 older order then 60 newer',
  (select jsonb_agg(jsonb_build_array(purchase_order, quantity) order by sequence_no) from ops.m29_fifo_guidance
   where replenishment_item_id = '29000000-0000-4000-8000-000000000701') = '[["1300000001", 50], ["1400000002", 60]]'::jsonb;
insert into m29_checks select 'no Khlong Toei stock of B: recorded as short',
  (select sum(quantity) from ops.m29_fifo_guidance where replenishment_item_id = '29000000-0000-4000-8000-000000000703' and lot_kind = 'short') = 50;
insert into m29_checks select 'queue shows Khlong Toei stock and guided quantity',
  exists (select 1 from m29_state s, jsonb_array_elements(s.v -> 'body') e
    where s.k = 'queue' and e ->> 'replenishment_item_id' = '29000000-0000-4000-8000-000000000701'
      and (e ->> 'kt_stock_qty')::numeric = 150 and (e ->> 'allocated_qty')::numeric = 110);

-- 4. Issue the locked plan ------------------------------------------------------
select set_config('request.jwt.claim.sub', '29000000-0000-4000-8000-000000000003', true);
set local role authenticated;
insert into m29_state values ('issue', public.m09_dispatch('POST',
  '/v1/replenishment/plans/29000000-0000-4000-8000-000000000601/issue', '{}'::jsonb, '{}'::jsonb, 'm29-issue'));
reset role;

insert into m29_checks select 'locked plan issues with guidance only',
  status = 'completed' from core.replenishment_plans where replenishment_plan_id = '29000000-0000-4000-8000-000000000601';
insert into m29_checks select 'guidance is issued with the line',
  not exists (select 1 from ops.m29_fifo_guidance where replenishment_plan_id = '29000000-0000-4000-8000-000000000601' and status = 'reserved');
insert into m29_checks select 'issued quantity stays used until the next Stock file',
  (select free_qty from core.m29_fifo_holds() where material_id = '290000000001' and purchase_order = '1400000002') = 40;

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m29_checks where not passed;
  if v_failed is not null then
    raise exception 'M29 checks failed: % / recalc % / lock %', v_failed,
      (select v from m29_state where k = 'recalc'), (select v from m29_state where k = 'lock');
  end if;
  if (select count(*) from m29_checks) <> 13 then raise exception 'M29: expected 13 checks, got %', (select count(*) from m29_checks); end if;
end
$$;

select check_name, passed from m29_checks order by check_name;
rollback;
