\set ON_ERROR_STOP on

-- M31: dispatch history, recommendation from real usage, district usage routes.
begin;

create temporary table m31_checks (check_name text primary key, passed boolean not null);
create temporary table m31_state (k text primary key, v jsonb);
grant select, insert, update on m31_checks, m31_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('31000000-0000-4000-8000-000000000001', '{"display_name":"M31 Planner"}'),
  ('31000000-0000-4000-8000-000000000002', '{"display_name":"M31 District"}');
update public.user_profiles set role = 'planner', district_id = null where user_id = '31000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'district', district_id = '5503' where user_id = '31000000-0000-4000-8000-000000000002';

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('31000000-0000-4000-8000-000000000010', 'm31-test', 'm31.csv', 'm31', repeat('3', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, unit, is_vmi, master_source, data_quality_status, source_batch_id)
select id, id, 'M31 ' || id, 'EA', true, 'material_master', 'valid', '31000000-0000-4000-8000-000000000010'
from unnest(array['310000000001', '310000000002', '310000000003', '310000000004', '310000000005']) id;

insert into ops.source_import_runs (import_run_id, source_kind, file_name, file_sha256, file_size_bytes, source_sheet, expected_row_count, status, created_by) values
  ('31000000-0000-4000-8000-000000000101', 'usage', 'usage.xlsx', repeat('e', 64), 10, 'Check CMP', 5, 'staged', '31000000-0000-4000-8000-000000000001');

-- สามเสน (5502, plant 5601), 12 months to Sep 2026
insert into ops.source_current_rows (source_kind, business_key, payload, row_hash, source_row_number, first_import_run_id, last_changed_run_id)
select 'usage', id || '|5601', jsonb_build_object('material_id', id, 'sap_plant_code', '5601', 'district_id', '5502',
  'as_of_date', '2026-09-30', 'monthly_usage', u), md5(id), n, '31000000-0000-4000-8000-000000000101', '31000000-0000-4000-8000-000000000101'
from (values
  -- regular with a spike (124) and a falling trend
  (1, '310000000001', '{"2025-10":51,"2025-11":91,"2025-12":124,"2026-01":36,"2026-02":45,"2026-03":9,"2026-04":22,"2026-05":49,"2026-06":15,"2026-07":24,"2026-08":5,"2026-09":5}'::jsonb),
  -- occasional: 20, 70, 62, 25
  (2, '310000000002', '{"2025-10":"-","2026-02":20,"2026-05":70,"2026-06":62,"2026-07":0,"2026-08":25,"2026-09":0}'),
  -- once
  (3, '310000000003', '{"2026-06":36,"2026-07":0}'),
  -- never
  (4, '310000000004', '{"2026-06":"-","2026-07":0}'),
  -- regular, refused before
  (5, '310000000005', '{"2025-10":10,"2025-11":10,"2025-12":10,"2026-01":10,"2026-02":10,"2026-03":10,"2026-04":10,"2026-05":10,"2026-06":10,"2026-07":10,"2026-08":10,"2026-09":10}')
) as t(n, id, u);

-- ประวัติจากระบบเดิม: one row keyed by plant code (older import), two by district
insert into ops.legacy_issue_history (row_key, district_id, district_name, material_id, plan_date, actual_date,
  planned_qty, issued_qty, outcome, fill_type, note, refused_by, source_sheet, source_file) values
  ('m31-1', '5601', 'เขตสามเสน', '310000000001', '2026-02-09', '2026-02-10', 100, 100, 'issued', 'vmi', null, null, 'History จ่ายได้ตามแผน', 'คลังคลองเตย.xlsx'),
  ('m31-2', '5502', 'เขตสามเสน', '310000000005', '2026-03-01', null, 60, 0, 'refused', 'vmi', 'ยังเหลือเยอะ', 'ผู้รับ', 'History ไม่รับของ', 'คลังคลองเตย.xlsx'),
  ('m31-3', '5503', 'เขตนนทบุรี', '310000000001', '2026-09-01', '2026-09-02', 10, 10, 'issued', 'district_request', null, null, 'นนทบุรี', 'คลังคลองเตย.xlsx');

-- 1. Rules -----------------------------------------------------------------------
insert into m31_checks select 'regular: adjusted CMP from median and last 4 months, spikes capped',
  v ->> 'rule' = 'regular' and (v ->> 'cmp_adjusted')::numeric = 21 and (v ->> 'qty')::numeric = 100
  and (v ->> 'spikes')::int = 2 and (v ->> 'months_used')::int = 12
from (select core.m31_suggest('310000000001', '5502', 26) v) s;
insert into m31_checks select 'occasional: one typical use minus district stock',
  v ->> 'rule' = 'occasional' and (v ->> 'qty')::numeric = 44 and (v ->> 'typical')::numeric = 43.5
from (select core.m31_suggest('310000000002', '5502', 0) v) s;
insert into m31_checks select 'used once: not filled',
  v ->> 'rule' = 'once' and (v ->> 'qty')::numeric = 0
from (select core.m31_suggest('310000000003', '5502', 3) v) s;
insert into m31_checks select 'no use in 12 months: not filled',
  v ->> 'rule' = 'none' and (v ->> 'qty')::numeric = 0
from (select core.m31_suggest('310000000004', '5502', 0) v) s;
insert into m31_checks select 'refused before: at most 4 months',
  (v ->> 'qty')::numeric = 30 and v ->> 'reason' like '%ยังเหลือเยอะ%'
from (select core.m31_suggest('310000000005', '5502', 10, 'ยังเหลือเยอะ') v) s;
insert into m31_checks select 'no usage row: no quantity',
  v ->> 'rule' = 'no_usage' and v -> 'qty' = 'null'::jsonb
from (select core.m31_suggest('310000000001', '5501', 0) v) s;

-- 2. Routes ----------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000001', true);
set local role authenticated;
insert into m31_state values ('usage', public.m09_dispatch('GET', '/v1/district-usage', '{"district_id":"5502"}', '{}', 'm31-1'));
insert into m31_state values ('history', public.m09_dispatch('GET', '/v1/district-usage/history', '{"district_id":"5502"}', '{}', 'm31-2'));
insert into m31_state values ('summary', public.m09_dispatch('GET', '/v1/district-usage/summary', '{}', '{}', 'm31-3'));
reset role;
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000002', true);
set local role authenticated;
insert into m31_state values ('district', public.m09_dispatch('GET', '/v1/district-usage/history', '{"district_id":"5502"}', '{}', 'm31-4'));
reset role;

insert into m31_checks select 'district usage lists the materials with history and suggestion',
  exists (select 1 from m31_state s, jsonb_array_elements(s.v -> 'body') e where s.k = 'usage'
    and e ->> 'material_id' = '310000000001' and (e ->> 'issued_lines')::int = 1
    and e #>> '{suggestion,rule}' = 'regular')
  and exists (select 1 from m31_state s, jsonb_array_elements(s.v -> 'body') e where s.k = 'usage'
    and e ->> 'material_id' = '310000000005' and (e ->> 'refused_lines')::int = 1 and e ->> 'last_refusal' = 'ยังเหลือเยอะ'
    and (e #>> '{suggestion,reason}') like '%เคยไม่รับ%');
insert into m31_checks select 'history of one district',
  (select jsonb_array_length(v -> 'body') from m31_state where k = 'history') = 2;
insert into m31_checks select 'summary has 18 districts',
  (select jsonb_array_length(v -> 'body') from m31_state where k = 'summary') = 18
  and exists (select 1 from m31_state s, jsonb_array_elements(s.v -> 'body') e where s.k = 'summary'
    and e ->> 'district_id' = '5502' and (e ->> 'issued_lines')::int = 1 and (e ->> 'refused_lines')::int = 1);
insert into m31_checks select 'district user sees only their own district',
  (select jsonb_agg(distinct e ->> 'district_id') from m31_state s, jsonb_array_elements(s.v -> 'body') e where s.k = 'district') = '["5503"]';

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m31_checks where not passed;
  if v_failed is not null then raise exception 'M31 checks failed: %', v_failed; end if;
  if (select count(*) from m31_checks) <> 10 then raise exception 'M31: expected 10 checks, got %', (select count(*) from m31_checks); end if;
end
$$;

select check_name, passed from m31_checks order by check_name;
rollback;
