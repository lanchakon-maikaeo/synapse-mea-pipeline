\set ON_ERROR_STOP on

-- M19: unified operation history (events + weekly + by district).
begin;

create temporary table m19_checks (check_name text primary key, passed boolean not null);
create temporary table m19_state (
  all_result jsonb, district_result jsonb, issue_only jsonb, legacy_only jsonb,
  search_result jsonb, paged jsonb, bad_source jsonb, anon_result jsonb
);
insert into m19_state default values;
grant select, insert, update on m19_checks, m19_state to authenticated, anon;

insert into auth.users (id, raw_user_meta_data) values
  ('19000000-0000-4000-8000-000000000001', '{"display_name":"M19 Planner"}'),
  ('19000000-0000-4000-8000-000000000002', '{"display_name":"M19 District"}');
update public.user_profiles set role = 'planner', district_id = null
where user_id = '19000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'district', district_id = '5501'
where user_id = '19000000-0000-4000-8000-000000000002';

insert into raw.import_batches (
  batch_id, source_system, source_file, source_sheet, source_checksum,
  row_count, status, imported_at, metadata
) values (
  '19000000-0000-4000-8000-000000000010', 'm19-test', 'm19.csv', 'm19',
  repeat('9', 64), 2, 'succeeded', now(), '{"isolated":true}'::jsonb
);
insert into core.materials (
  material_id, sap_material_id, material_name, category, unit,
  weight_per_unit_kg, is_vmi, master_source, data_quality_status, source_batch_id
) values
  ('M19-A', 'M19-A', 'M19 fuse cutout', 'TEST', 'EA', 1, true, 'material_master', 'valid',
   '19000000-0000-4000-8000-000000000010'),
  ('M19-B', 'M19-B', 'M19 bolt', 'TEST', 'EA', 1, true, 'material_master', 'valid',
   '19000000-0000-4000-8000-000000000010');

insert into ops.replenishment_runs (
  replenishment_run_id, policy_version, snapshot_cutoff_at, status,
  candidate_count, initiated_by, finished_at
) values ('19000000-0000-4000-8000-000000000101', 'v1.0.0', now(), 'succeeded', 3,
  '19000000-0000-4000-8000-000000000001', now());

insert into core.replenishment_plans (
  replenishment_plan_id, replenishment_run_id, plan_number, week_start_date,
  version_no, origin_location_id, status, response_due_at, created_by
) values ('19000000-0000-4000-8000-000000000201', '19000000-0000-4000-8000-000000000101',
  'RP-M19', date '2026-10-05', 1, 'WH-KT', 'pending_district_confirmation',
  now() + interval '1 day', '19000000-0000-4000-8000-000000000001');

insert into core.replenishment_items (
  replenishment_item_id, replenishment_plan_id, material_id, district_id,
  current_stock_qty, cmp_monthly, months_available, min_fill_qty, max_fill_qty,
  suggested_qty, requested_qty, final_qty, projected_months_after,
  source_stock_missing, priority_score, priority_band, status, district_decision
) values
  ('19000000-0000-4000-8000-000000000301', '19000000-0000-4000-8000-000000000201',
   'M19-A', '5501', 20, 20, 1, 60, 100, 100, 100, 100, 6, false, 8, 'critical', 'district_confirmed', 'confirm'),
  ('19000000-0000-4000-8000-000000000302', '19000000-0000-4000-8000-000000000201',
   'M19-B', '5501', 10, 10, 1, 30, 50, 50, 50, 0, 6, false, 8, 'critical', 'district_rejected', 'reject'),
  ('19000000-0000-4000-8000-000000000303', '19000000-0000-4000-8000-000000000201',
   'M19-A', '5502', 20, 20, 1, 60, 100, 100, 100, 100, 6, false, 8, 'critical', 'district_confirmed', 'confirm');

insert into ops.plan_approvals (
  replenishment_plan_id, replenishment_item_id, district_id, approval_stage, decision, note, actor_id, actor_role, acted_at
) values
  ('19000000-0000-4000-8000-000000000201', '19000000-0000-4000-8000-000000000301', '5501',
   'district_response', 'confirmed', null, '19000000-0000-4000-8000-000000000002', 'district', timestamptz '2026-10-06 09:00+07'),
  ('19000000-0000-4000-8000-000000000201', '19000000-0000-4000-8000-000000000302', '5501',
   'district_response', 'rejected', 'ยังมีของพอ', '19000000-0000-4000-8000-000000000002', 'district', timestamptz '2026-10-06 09:05+07'),
  ('19000000-0000-4000-8000-000000000201', null, null,
   'planner', 'approved', 'ok', '19000000-0000-4000-8000-000000000001', 'planner', timestamptz '2026-10-07 10:00+07');

insert into ops.district_change_requests (
  change_request_id, replenishment_item_id, baseline_qty, requested_qty, projected_months_after,
  exceeds_six_months, special_approval_required, risk_level, abnormal_signals, reason,
  requester_name, requested_by, requested_at, status, reviewed_by, reviewed_at, review_note
) values (
  '19000000-0000-4000-8000-000000000401', '19000000-0000-4000-8000-000000000303', 100, 400, 9,
  true, true, 'high', '[]'::jsonb, 'งานโครงการ', 'นาย ข',
  '19000000-0000-4000-8000-000000000001', timestamptz '2026-10-06 11:00+07', 'rejected',
  '19000000-0000-4000-8000-000000000001', timestamptz '2026-10-07 11:00+07', 'เกินความจำเป็น'
);

insert into core.inventory_movements (
  movement_type, material_id, quantity, replenishment_item_id, idempotency_key, reason,
  performed_by, occurred_at
) values (
  'ISSUE', 'M19-A', 100, '19000000-0000-4000-8000-000000000301', 'm19-issue-1', 'FIFO',
  '19000000-0000-4000-8000-000000000001', timestamptz '2026-10-08 08:00+07'
);

insert into ops.legacy_issue_history (
  row_key, district_id, district_name, material_id, material_name, unit, plan_date, actual_date,
  planned_qty, issued_qty, outcome, fill_type, note, refused_by, source_sheet, source_row, source_file
) values
  (md5('m19-l1'), '5501', 'เขตนวลจันทร์', 'M19-B', 'M19 bolt (old)', 'EA', date '2026-02-02', date '2026-02-03',
   200, 200, 'issued', 'vmi', '', '', 'History จ่ายได้ตามแผน', 2, 'legacy.xlsx'),
  (md5('m19-l2'), '5501', 'เขตนวลจันทร์', 'M19-B', '', 'EA', date '2026-02-09', null,
   300, 0, 'refused', 'passed_test', 'ใช้งานน้อย', 'นาง ก', 'History ไม่รับของ', 3, 'legacy.xlsx'),
  (md5('m19-l3'), '5601', 'เขตสามเสน', 'M19-A', '', 'EA', date '2026-02-09', date '2026-02-10',
   100, 60, 'adjusted', 'vmi', 'ขอลด', '', 'สามเสน', 9, 'legacy.xlsx');

-- Planner sees everything
select set_config('request.jwt.claim.sub', '19000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m19_state set all_result = public.m09_dispatch('GET', '/v1/history',
  '{"material":"M19"}', '{}', 'm19-1');
update m19_state set issue_only = public.m09_dispatch('GET', '/v1/history',
  '{"material":"M19","category":"issue"}', '{}', 'm19-2');
update m19_state set legacy_only = public.m09_dispatch('GET', '/v1/history',
  '{"material":"M19","source":"legacy","from":"2026-02-01","to":"2026-02-28"}', '{}', 'm19-3');
update m19_state set search_result = public.m09_dispatch('GET', '/v1/history',
  '{"q":"ใช้งานน้อย"}', '{}', 'm19-4');
update m19_state set paged = public.m09_dispatch('GET', '/v1/history',
  '{"material":"M19","limit":"2","offset":"1"}', '{}', 'm19-5');
update m19_state set bad_source = public.m09_dispatch('GET', '/v1/history',
  '{"source":"excel"}', '{}', 'm19-6');
reset role;

-- District user is forced to own district even when asking for another
select set_config('request.jwt.claim.sub', '19000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update m19_state set district_result = public.m09_dispatch('GET', '/v1/history',
  '{"material":"M19","district_id":"5502"}', '{}', 'm19-7');
reset role;

select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
update m19_state set anon_result = public.m09_dispatch('GET', '/v1/history', '{}', '{}', 'm19-8');
reset role;

insert into m19_checks select 'planner gets history', (all_result ->> 'status')::int = 200 from m19_state;
insert into m19_checks select 'all event kinds present',
  (select array_agg(distinct e ->> 'event_type' order by e ->> 'event_type')
   from jsonb_array_elements(all_result #> '{body,events}') e)
  @> array['district_confirmed','district_rejected','change_requested','change_rejected',
           'issue','legacy_issued','legacy_refused','legacy_adjusted']
from m19_state;
insert into m19_checks select 'district rejection keeps reason and actor',
  exists (select 1 from jsonb_array_elements(all_result #> '{body,events}') e
    where e ->> 'event_type' = 'district_rejected' and e ->> 'note' = 'ยังมีของพอ'
      and e ->> 'actor' = 'M19 District' and e ->> 'plan_number' = 'RP-M19'
      and e ->> 'material_name' = 'M19 bolt' and (e ->> 'ref_qty')::numeric = 50)
from m19_state;
insert into m19_checks select 'legacy keeps own name and refused_by',
  exists (select 1 from jsonb_array_elements(all_result #> '{body,events}') e
    where e ->> 'event_type' = 'legacy_issued' and e ->> 'material_name' = 'M19 bolt (old)'
      and e ->> 'source' = 'legacy')
  and exists (select 1 from jsonb_array_elements(all_result #> '{body,events}') e
    where e ->> 'event_type' = 'legacy_refused' and e ->> 'actor' = 'นาง ก'
      and e ->> 'category' = 'district' and e ->> 'event_date' = '2026-02-09')
from m19_state;
insert into m19_checks select 'events newest first',
  (all_result #>> '{body,events,0,event_date}') >= (all_result #>> '{body,events,1,event_date}')
from m19_state;
insert into m19_checks select 'category filter',
  (select bool_and(e ->> 'category' = 'issue') and count(*) = 3
   from jsonb_array_elements(issue_only #> '{body,events}') e)
from m19_state;
insert into m19_checks select 'source + date filter',
  (legacy_only #>> '{body,total}')::int = 3
  and (legacy_only #>> '{body,outcomes,planned_lines}')::int = 3
from m19_state;
insert into m19_checks select 'outcomes: on plan / adjusted / refused / pending',
  (all_result #>> '{body,outcomes,on_plan}')::int = 2
  and (all_result #>> '{body,outcomes,adjusted}')::int = 1
  and (all_result #>> '{body,outcomes,refused}')::int = 2
  and (all_result #>> '{body,outcomes,pending}')::int = 1
from m19_state;
insert into m19_checks select 'weekly issued qty',
  exists (select 1 from jsonb_array_elements(all_result #> '{body,weekly}') w
    where w ->> 'week_start' = '2026-10-05' and (w ->> 'issued_qty')::numeric = 100
      and (w ->> 'planned_lines')::int = 3 and (w ->> 'refused')::int = 1)
  and exists (select 1 from jsonb_array_elements(all_result #> '{body,weekly}') w
    where w ->> 'week_start' = '2026-02-02' and (w ->> 'issued_qty')::numeric = 200)
from m19_state;
insert into m19_checks select 'by district refusal',
  exists (select 1 from jsonb_array_elements(all_result #> '{body,by_district}') d
    where d ->> 'district_id' = '5501' and (d ->> 'refused')::int = 2 and (d ->> 'planned_lines')::int = 4)
from m19_state;
insert into m19_checks select 'free text search',
  (search_result #>> '{body,total}')::int = 1 from m19_state;
insert into m19_checks select 'paging',
  jsonb_array_length(paged #> '{body,events}') = 2
  and (paged #>> '{body,total}')::int = (all_result #>> '{body,total}')::int
from m19_state;
insert into m19_checks select 'bad source rejected', (bad_source ->> 'status')::int = 400 from m19_state;
insert into m19_checks select 'district scoped to own district',
  (district_result ->> 'status')::int = 200
  and district_result #>> '{body,scope_district_id}' = '5501'
  and (select bool_and(e ->> 'district_id' = '5501' or e ->> 'district_id' is null)
       from jsonb_array_elements(district_result #> '{body,events}') e)
  and not exists (select 1 from jsonb_array_elements(district_result #> '{body,events}') e
       where e ->> 'event_type' = 'legacy_adjusted')
from m19_state;
insert into m19_checks select 'legacy plant code mapped to district',
  (select district_id from ops.legacy_issue_history where row_key = md5('m19-l3')) = '5502'
  and exists (select 1 from jsonb_array_elements(all_result #> '{body,by_district}') d
    where d ->> 'district_id' = '5502' and (d ->> 'planned_lines')::int = 2
      and d ->> 'district_name' = 'สามเสน')
from m19_state;
insert into m19_checks select 'anonymous rejected', (anon_result ->> 'status')::int = 401 from m19_state;

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m19_checks where not passed;
  if v_failed is not null then raise exception 'M19 checks failed: %', v_failed; end if;
  if (select count(*) from m19_checks) <> 16 then raise exception 'M19: expected 16 checks'; end if;
end
$$;

select check_name, passed from m19_checks order by check_name;
rollback;
