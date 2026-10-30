\set ON_ERROR_STOP on

-- M21: delivery calendar slots, extra-request routing, abnormal-request alerts.
begin;

create temporary table m21_checks (check_name text primary key, passed boolean not null);
create temporary table m21_state (
  calendar jsonb, no_note jsonb, created jsonb, normal_req jsonb, rep1 jsonb, rep2 jsonb,
  preview jsonb, district_alerts jsonb, planner_alerts jsonb, review_no_note jsonb, review_ok jsonb,
  review_again jsonb, report jsonb, viewer_cal_update jsonb
);
insert into m21_state default values;
grant select, insert, update on m21_checks, m21_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('21000000-0000-4000-8000-000000000001', '{"display_name":"M21 Planner"}'),
  ('21000000-0000-4000-8000-000000000002', '{"display_name":"M21 District"}'),
  ('21000000-0000-4000-8000-000000000003', '{"display_name":"M21 Viewer"}');
update public.user_profiles set role = 'planner', district_id = null where user_id = '21000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'district', district_id = '5506' where user_id = '21000000-0000-4000-8000-000000000002';
update public.user_profiles set role = 'viewer', district_id = null where user_id = '21000000-0000-4000-8000-000000000003';

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum,
  row_count, status, imported_at, metadata)
values ('21000000-0000-4000-8000-000000000010', 'm21-test', 'm21.csv', 'm21', repeat('2', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, category, unit, weight_per_unit_kg,
  is_vmi, master_source, data_quality_status, source_batch_id)
values ('M21-A', 'M21-A', 'M21 cable', 'TEST', 'M', 1, true, 'material_master', 'valid', '21000000-0000-4000-8000-000000000010');

-- Baseline: issued 100 twice to ลาดกระบัง (5506), CMP 50, district stock 20
insert into ops.legacy_issue_history (row_key, district_id, material_id, plan_date, actual_date, planned_qty,
  issued_qty, outcome, fill_type, source_file) values
  (md5('m21-1'), '5506', 'M21-A', current_date - 60, current_date - 59, 100, 100, 'issued', 'vmi', 't'),
  (md5('m21-2'), '5506', 'M21-A', current_date - 30, current_date - 29, 100, 90, 'adjusted', 'vmi', 't');
insert into core.usage_rates (usage_rate_id, material_id, district_id, as_of_date, cmp_monthly, avg_ly, avg_12m,
  avg_6m, avg_4m, source_batch_id, data_class, source_quality, created_at, updated_at)
values ('21000000-0000-4000-8000-000000000411', 'M21-A', '5506', current_date - 1, 50, 50, 50, 50, 50,
  '21000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', now(), now());
insert into core.stock_snapshots (snapshot_id, material_id, location_id, quantity_on_hand, snapshot_at,
  source_batch_id, data_class, source_quality, created_at)
values ('21000000-0000-4000-8000-000000000401', 'M21-A', 'DIST-5506', 20, now() - interval '1 day',
  '21000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived', now() - interval '1 day');

update ops.environment_controls set operational_writes_enabled = true, updated_at = now() where singleton;

-- Slot rules (ลาดกระบัง = zone E, Tuesday; cut-off Monday 14:00; reserve Friday)
insert into m21_checks select 'before cut-off rides this week zone run',
  s ->> 'mode' = 'zone_run' and s ->> 'delivery_date' = '2026-11-03' and s ->> 'zone' = 'E'
from (select core.m21_next_slot('5506', false, timestamptz '2026-11-02 10:00+07') s) x;
insert into m21_checks select 'after cut-off not urgent goes next week',
  s ->> 'mode' = 'next_week_run' and s ->> 'delivery_date' = '2026-11-10'
from (select core.m21_next_slot('5506', false, timestamptz '2026-11-02 15:00+07') s) x;
insert into m21_checks select 'after cut-off urgent goes to friday reserve',
  s ->> 'mode' = 'reserve_run' and s ->> 'delivery_date' = '2026-11-06'
from (select core.m21_next_slot('5506', true, timestamptz '2026-11-02 15:00+07') s) x;
insert into m21_checks select 'urgent after reserve cut-off is express next working day',
  s ->> 'mode' = 'express' and s ->> 'delivery_date' = '2026-11-06'
from (select core.m21_next_slot('5506', true, timestamptz '2026-11-05 15:00+07') s) x;
insert into m21_checks select 'friday afternoon express skips weekend',
  s ->> 'mode' = 'express' and s ->> 'delivery_date' = '2026-11-09'
from (select core.m21_next_slot('5506', true, timestamptz '2026-11-06 16:00+07') s) x;

-- Assessment
insert into m21_checks select 'normal quantity is not flagged',
  core.m21_assess_request('5506', 'M21-A', 120, null) ->> 'level' = 'normal';
insert into m21_checks select 'large quantity flagged high with history and cmp',
  (select a ->> 'level' = 'high'
     and a -> 'signals' @> '[{"code":"over_history"}]' and a -> 'signals' @> '[{"code":"over_cmp"}]'
     and (a #>> '{baseline,history_max}')::numeric = 100 and (a #>> '{baseline,cmp}')::numeric = 50
   from (select core.m21_assess_request('5506', 'M21-A', 400, null) a) x);
insert into m21_checks select 'never issued and no cmp flagged',
  core.m21_assess_request('5501', 'M21-A', 5, null) -> 'signals' @> '[{"code":"no_baseline"}]';

-- District creates requests
select set_config('request.jwt.claim.sub', '21000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update m21_state set calendar = public.m09_dispatch('GET', '/v1/delivery/calendar', '{}', '{}', 'm21-1');
update m21_state set preview = public.m09_dispatch('POST', '/v1/ad-hoc/preview', '{}',
  '{"district_id":"5506","material_id":"M21-A","requested_qty":400,"urgency_code":"outage"}', 'm21-2');
update m21_state set no_note = public.m09_dispatch('POST', '/v1/ad-hoc/issues', '{}',
  '{"material_id":"M21-A","district_id":"5506","requested_qty":400,"reason":"ไฟดับ","requester_name":"นาย ข","urgency_code":"outage"}', 'm21-3');
update m21_state set created = public.m09_dispatch('POST', '/v1/ad-hoc/issues', '{}',
  '{"material_id":"M21-A","district_id":"5506","requested_qty":400,"reason":"ไฟดับซ่อมด่วน","requester_name":"นาย ข","urgency_code":"outage","urgency_note":"สายขาดจากพายุ ถ.ร่มเกล้า"}', 'm21-4');
update m21_state set normal_req = public.m09_dispatch('POST', '/v1/ad-hoc/issues', '{}',
  '{"material_id":"M21-A","district_id":"5506","requested_qty":60,"reason":"ใช้งานปกติ","requester_name":"นาย ข"}', 'm21-5');
update m21_state set rep1 = public.m09_dispatch('POST', '/v1/ad-hoc/issues', '{}',
  '{"material_id":"M21-A","district_id":"5506","requested_qty":50,"reason":"ใช้งานปกติ","requester_name":"นาย ข"}', 'm21-6');
update m21_state set district_alerts = public.m09_dispatch('GET', '/v1/request-alerts', '{}', '{}', 'm21-7');
reset role;

-- Change request also produces an alert
insert into ops.replenishment_runs (replenishment_run_id, policy_version, snapshot_cutoff_at, status,
  candidate_count, initiated_by, finished_at)
values ('21000000-0000-4000-8000-000000000101', 'v1.0.0', now(), 'succeeded', 1, '21000000-0000-4000-8000-000000000001', now());
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date,
  version_no, origin_location_id, status, response_due_at, created_by)
values ('21000000-0000-4000-8000-000000000201', '21000000-0000-4000-8000-000000000101', 'RP-M21',
  date_trunc('week', current_date)::date + 7, 1, 'WH-KT', 'pending_district_confirmation', now() + interval '1 day',
  '21000000-0000-4000-8000-000000000001');
insert into core.replenishment_items (replenishment_item_id, replenishment_plan_id, material_id, district_id,
  current_stock_qty, cmp_monthly, months_available, min_fill_qty, max_fill_qty, suggested_qty, requested_qty,
  final_qty, projected_months_after, source_stock_missing, priority_score, priority_band, status)
values ('21000000-0000-4000-8000-000000000301', '21000000-0000-4000-8000-000000000201', 'M21-A', '5506',
  20, 50, 0.4, 180, 280, 180, 180, 180, 4, false, 8, 'critical', 'pending');
insert into ops.district_change_requests (change_request_id, replenishment_item_id, baseline_qty, requested_qty,
  projected_months_after, exceeds_six_months, special_approval_required, risk_level, abnormal_signals, reason,
  requester_name, requested_by, requested_at, status)
values ('21000000-0000-4000-8000-000000000501', '21000000-0000-4000-8000-000000000301', 180, 900, 18.4, true, true,
  'high', '[]', 'มีงานโครงการ', 'นาย ข', '21000000-0000-4000-8000-000000000002', now(), 'pending_review');

select a.alert_id as cr_alert from ops.request_alerts a where a.source = 'change_request'
  and a.source_id = '21000000-0000-4000-8000-000000000501' \gset
select set_config('request.jwt.claim.sub', '21000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m21_state set planner_alerts = public.m09_dispatch('GET', '/v1/request-alerts', '{}', '{}', 'm21-8');
update m21_state set rep2 = public.m09_dispatch('POST', '/v1/ad-hoc/issues', '{}',
  '{"material_id":"M21-A","district_id":"5506","requested_qty":40,"reason":"ขาดอีก","requester_name":"นาย ข"}', 'm21-9');
update m21_state set review_no_note = public.m09_dispatch('POST',
  '/v1/request-alerts/' || :'cr_alert' || '/review', '{}', '{"decision":"acknowledge"}', 'm21-10');
update m21_state set review_ok = public.m09_dispatch('POST',
  '/v1/request-alerts/' || :'cr_alert' || '/review', '{}',
  '{"decision":"acknowledge","note":"โทรยืนยันกับเขตแล้ว งานโครงการจริง"}', 'm21-11');
update m21_state set review_again = public.m09_dispatch('POST',
  '/v1/request-alerts/' || :'cr_alert' || '/review', '{}',
  '{"decision":"dismiss","note":"ซ้ำ"}', 'm21-12');
update m21_state set report = public.m09_dispatch('GET', '/v1/extra-requests/report', '{}', '{}', 'm21-13');
reset role;

select set_config('request.jwt.claim.sub', '21000000-0000-4000-8000-000000000003', true);
set local role authenticated;
update m21_state set viewer_cal_update = public.m09_dispatch('POST', '/v1/delivery/calendar', '{}',
  '{"zones":[{"zone_code":"E","weekday":5}]}', 'm21-14');
reset role;

insert into m21_checks select 'calendar has 7 zones and all 18 districts',
  (calendar ->> 'status')::int = 200 and jsonb_array_length(calendar #> '{body,zones}') = 7
  and jsonb_array_length(calendar #> '{body,unzoned}') = 0
from m21_state;
insert into m21_checks select 'preview returns slot and high check',
  (preview ->> 'status')::int = 200 and preview #>> '{body,check,level}' = 'high'
  and preview #>> '{body,slot,zone}' = 'E'
from m21_state;
insert into m21_checks select 'urgent request requires urgency note', (no_note ->> 'status')::int = 422 from m21_state;
insert into m21_checks select 'urgent request stored with slot and alert',
  (created ->> 'status')::int = 201 and created #>> '{body,check,level}' = 'high'
  and exists (select 1 from ops.ad_hoc_issues h where h.ad_hoc_issue_id = (created #>> '{body,ad_hoc_issue_id}')::uuid
    and h.urgency_code = 'outage' and h.delivery_mode in ('zone_run', 'reserve_run', 'express')
    and h.delivery_date is not null and h.alert_level = 'high')
from m21_state;
insert into m21_checks select 'normal request gets no alert',
  (normal_req ->> 'status')::int = 201 and normal_req #>> '{body,check,level}' = 'normal'
  and normal_req #>> '{body,slot,mode}' in ('zone_run', 'next_week_run')
from m21_state;
insert into m21_checks select 'third request in 30 days flagged as repeated',
  rep2 -> 'body' -> 'check' -> 'signals' @> '[{"code":"repeated"}]'
from m21_state;
insert into m21_checks select 'change request creates alert',
  exists (select 1 from ops.request_alerts a where a.source = 'change_request'
    and a.source_id = '21000000-0000-4000-8000-000000000501' and a.level = 'high');
insert into m21_checks select 'district sees own alerts',
  (district_alerts ->> 'status')::int = 200
  and (select bool_and(x ->> 'district_id' = '5506') from jsonb_array_elements(district_alerts -> 'body') x)
from m21_state;
insert into m21_checks select 'planner sees change request alert with reference',
  exists (select 1 from jsonb_array_elements(planner_alerts -> 'body') x
    where x ->> 'source' = 'change_request' and x ->> 'reference' = 'RP-M21')
from m21_state;
insert into m21_checks select 'review requires note, then once only',
  (review_no_note ->> 'status')::int = 400 and review_ok #>> '{body,status}' = 'acknowledged'
  and (review_again ->> 'status')::int = 400
from m21_state;
insert into m21_checks select 'report counts repeats',
  (report ->> 'status')::int = 200
  and exists (select 1 from jsonb_array_elements(report #> '{body,repeats}') x
    where x ->> 'material_id' = 'M21-A' and (x ->> 'requests')::int >= 4)
from m21_state;
insert into m21_checks select 'viewer cannot change calendar', (viewer_cal_update ->> 'status')::int = 403 from m21_state;

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m21_checks where not passed;
  if v_failed is not null then raise exception 'M21 checks failed: %', v_failed; end if;
  if (select count(*) from m21_checks) <> 20 then raise exception 'M21: expected 20 checks, got %', (select count(*) from m21_checks); end if;
end
$$;

select check_name, passed from m21_checks order by check_name;
rollback;
