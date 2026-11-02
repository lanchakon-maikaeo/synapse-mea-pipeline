\set ON_ERROR_STOP on

-- M24: Import Center Stock + CMP promoted into the calculation; older data no longer used.
begin;

create temporary table m24_checks (check_name text primary key, passed boolean not null);
create temporary table m24_state (blocked jsonb, ready jsonb, promoted jsonb, again jsonb, viewer jsonb);
insert into m24_state default values;
grant select, insert, update on m24_checks, m24_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('24000000-0000-4000-8000-000000000001', '{"display_name":"M24 Planner"}'),
  ('24000000-0000-4000-8000-000000000002', '{"display_name":"M24 Viewer"}');
update public.user_profiles set role = 'planner' where user_id = '24000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'viewer' where user_id = '24000000-0000-4000-8000-000000000002';

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('24000000-0000-4000-8000-000000000010', 'm24-test', 'm24.csv', 'm24', repeat('4', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, unit, is_vmi, master_source, data_quality_status, source_batch_id) values
  ('M24-A', 'M24-A', 'M24 cable', 'M', true, 'material_master', 'valid', '24000000-0000-4000-8000-000000000010'),
  ('M24-B', 'M24-B', 'M24 old only', 'EA', true, 'material_master', 'valid', '24000000-0000-4000-8000-000000000010');

-- Old data (July): M24-B district stock and CMP that the new files no longer carry
insert into core.stock_snapshots (material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality)
values ('M24-B', 'DIST-5501', 999, '2026-07-20 12:00+07', '24000000-0000-4000-8000-000000000010', 'actual', 'source_observed');

-- Import Center: stock file with warehouse rows only (committed first), then usage
insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet,
  expected_row_count, status, created_by, committed_by, committed_at) values
  ('24000000-0000-4000-8000-000000000101', 'stock', 'Stock KT only.xlsx', repeat('a', 64), 10, 'Sheet1', 1, 'committed',
   '24000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', now() - interval '2 hours'),
  ('24000000-0000-4000-8000-000000000102', 'usage', 'usage.xlsx', repeat('b', 64), 10, 'Check CMP', 2, 'committed',
   '24000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', now() - interval '2 hours');
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('stock', '2401|0001|M24-A', '{"sap_plant_code":"2401","storage_location_code":"0001","material_id":"M24-A","unrestricted_qty":500,"warehouse_id":"WH-KT","district_id":null,"snapshot_date":"2026-10-20"}',
   md5('s1'), 2, '24000000-0000-4000-8000-000000000101', '24000000-0000-4000-8000-000000000101'),
  ('usage', 'M24-A|5501', '{"material_id":"M24-A","sap_plant_code":"5501","district_id":"5501","avg_ly_raw":100,"avg_12m_raw":120,"avg_6m_raw":-40,"avg_4m_raw":80,"monthly_usage":{"2026-09":"-","2026-08":-3},"as_of_date":"2026-09-30"}',
   md5('u1'), 2, '24000000-0000-4000-8000-000000000102', '24000000-0000-4000-8000-000000000102'),
  ('usage', 'M24-A|9999', '{"material_id":"M24-A","sap_plant_code":"9999","district_id":null,"avg_ly_raw":1,"avg_12m_raw":1,"avg_6m_raw":1,"avg_4m_raw":1,"as_of_date":"2026-09-30"}',
   md5('u2'), 3, '24000000-0000-4000-8000-000000000102', '24000000-0000-4000-8000-000000000102');

update m24_state set blocked = core.m24_promotion_readiness();

-- Full stock file (all plants) committed later
insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet,
  expected_row_count, status, created_by, committed_by, committed_at) values
  ('24000000-0000-4000-8000-000000000103', 'stock', 'Stock all plants.xlsx', repeat('c', 64), 10, 'Sheet1', 3, 'committed',
   '24000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', now() - interval '1 hour');
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id) values
  ('stock', '5501|0001|M24-A', '{"sap_plant_code":"5501","storage_location_code":"0001","material_id":"M24-A","unrestricted_qty":30,"warehouse_id":null,"district_id":"5501","snapshot_date":"2026-10-20"}',
   md5('s2'), 3, '24000000-0000-4000-8000-000000000103', '24000000-0000-4000-8000-000000000103'),
  ('stock', '5501|0002|M24-A', '{"sap_plant_code":"5501","storage_location_code":"0002","material_id":"M24-A","unrestricted_qty":12,"warehouse_id":null,"district_id":"5501","snapshot_date":"2026-10-20"}',
   md5('s3'), 4, '24000000-0000-4000-8000-000000000103', '24000000-0000-4000-8000-000000000103'),
  ('stock', '5501|0001|NOT-IN-MASTER', '{"sap_plant_code":"5501","storage_location_code":"0001","material_id":"NOPE","unrestricted_qty":5,"district_id":"5501","snapshot_date":"2026-10-20"}',
   md5('s4'), 5, '24000000-0000-4000-8000-000000000103', '24000000-0000-4000-8000-000000000103');

-- An open plan built from the old data
insert into ops.replenishment_runs (replenishment_run_id, policy_version, snapshot_cutoff_at, status, candidate_count, initiated_by, finished_at)
values ('24000000-0000-4000-8000-000000000201', 'v1.0.0', now(), 'succeeded', 1, '24000000-0000-4000-8000-000000000001', now());
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date, version_no,
  origin_location_id, status, response_due_at, created_by)
values ('24000000-0000-4000-8000-000000000301', '24000000-0000-4000-8000-000000000201', 'M24-OLD', '2026-08-10', 1,
  'WH-KT', 'pending_district_confirmation', now(), '24000000-0000-4000-8000-000000000001');

update m24_state set ready = core.m24_promotion_readiness();

select set_config('request.jwt.claim.sub', '24000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update m24_state set viewer = public.m09_dispatch('POST', '/v1/source-imports/promotion', '{}', '{}', 'm24-0');
reset role;

select set_config('request.jwt.claim.sub', '24000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m24_state set promoted = public.m09_dispatch('POST', '/v1/source-imports/promotion', '{}', '{"note":"UAT start"}', 'm24-1');
update m24_state set again = public.m09_dispatch('POST', '/v1/source-imports/promotion', '{}', '{}', 'm24-2');
reset role;

create temporary table m24_health as
select * from analytics.stock_health_at(now()) where material_id in ('M24-A', 'M24-B') and district_id = '5501';

insert into m24_checks select 'warehouse-only stock file is blocked',
  jsonb_array_length(blocked -> 'blocking') = 1 and blocked #>> '{blocking,0}' like '%ยังไม่มี Stock เขต%' from m24_state;
insert into m24_checks select 'readiness sees district stock',
  jsonb_array_length(ready -> 'blocking') = 0 and (ready ->> 'stock_districts')::int = 1
  and ready -> 'warnings' @> '["ไฟล์ Stock มี Stock เขตไม่ครบ 18 เขต: เขตที่ไม่มีในไฟล์จะถูกคิดว่ามีของ 0"]'
  and (ready ->> 'materials_not_in_master')::int = 1 from m24_state;
insert into m24_checks select 'viewer cannot promote', (viewer ->> 'status')::int = 403 from m24_state;
insert into m24_checks select 'planner promotes',
  (promoted ->> 'status')::int = 200 and (promoted #>> '{body,promoted}')::boolean
  and (promoted #>> '{body,counts,district_snapshots}')::int = 1
  and (promoted #>> '{body,counts,usage_rates}')::int = 1
  and (promoted #>> '{body,counts,stock_rows_skipped}')::int = 1
  and (promoted #>> '{body,counts,plans_cancelled}')::int = 1 from m24_state;
insert into m24_checks select 'import recorded as latest succeeded',
  exists (select 1 from ops.actual_workbook_imports where source_counts ->> 'stock_file_sha256' = repeat('c', 64) and usage_checksum = repeat('b', 64)
    and status = 'succeeded' and attested_by = 'M24 Planner');
insert into m24_checks select 'calculation uses new district stock (storage locations summed)',
  current_stock_qty = 42 and not source_stock_missing and snapshot_at = '2026-10-20 23:59+07'
from m24_health where material_id = 'M24-A';
insert into m24_checks select 'calculation uses new CMP (negatives counted as 0)',
  cmp_monthly = 75 and usage_as_of_date = '2026-09-30' from m24_health where material_id = 'M24-A';
insert into m24_checks select 'old stock no longer used',
  source_stock_missing and current_stock_qty = 0 from m24_health where material_id = 'M24-B';
insert into m24_checks select 'evidence keeps dash and negative counts',
  exists (select 1 from reference_data.usage_observation_evidence e join core.usage_rates u using (usage_rate_id)
    where u.material_id = 'M24-A' and e.normalized_dash_count = 1 and e.excluded_negative_month_count = 1);
insert into m24_checks select 'second promotion is a no-op',
  (again ->> 'status')::int = 200 and not (again #>> '{body,promoted}')::boolean from m24_state;
insert into m24_checks select 'old open plan cancelled with reason',
  status = 'cancelled' and cancellation_reason like 'ข้อมูล Stock/CMP ชุดใหม่%'
from core.replenishment_plans where replenishment_plan_id = '24000000-0000-4000-8000-000000000301';
insert into m24_checks select 'old data is kept',
  exists (select 1 from core.stock_snapshots where material_id = 'M24-B' and quantity_on_hand = 999);

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m24_checks where not passed;
  if v_failed is not null then raise exception 'M24 checks failed: %', v_failed; end if;
  if (select count(*) from m24_checks) <> 12 then raise exception 'M24: expected 12 checks, got %', (select count(*) from m24_checks); end if;
end
$$;

select check_name, passed from m24_checks order by check_name;
rollback;
