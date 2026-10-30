\set ON_ERROR_STOP on

-- M23: plan codes KT01-W33-100869, running per warehouse and Buddhist year, revisions keep the root code.
begin;

create temporary table m23_checks (check_name text primary key, passed boolean not null);

insert into auth.users (id, raw_user_meta_data) values ('23000000-0000-4000-8000-000000000001', '{"display_name":"M23"}');
insert into ops.replenishment_runs (replenishment_run_id, policy_version, snapshot_cutoff_at, status, candidate_count, initiated_by, finished_at)
select ('23000000-0000-4000-8000-00000000010' || n)::uuid, 'v1.0.0', now(), 'succeeded', 1, '23000000-0000-4000-8000-000000000001', now()
from generate_series(1, 4) n;

-- Old-style numbers get replaced on insert
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date, version_no,
  origin_location_id, status, response_due_at, created_by) values
  ('23000000-0000-4000-8000-000000000201', '23000000-0000-4000-8000-000000000101', 'RP-2030-33-ABCD0001', '2030-08-12', 1,
   'WH-KT', 'cancelled', now(), '23000000-0000-4000-8000-000000000001');
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date, version_no,
  origin_location_id, status, response_due_at, created_by) values
  ('23000000-0000-4000-8000-000000000202', '23000000-0000-4000-8000-000000000102', 'RP-2030-34-ABCD0002', '2030-08-19', 1,
   'WH-KT', 'draft', now(), '23000000-0000-4000-8000-000000000001');
-- Revision of the second plan
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date, version_no,
  parent_plan_id, origin_location_id, status, response_due_at, created_by) values
  ('23000000-0000-4000-8000-000000000203', '23000000-0000-4000-8000-000000000103', 'RP-2030-34-ABCD0002', '2030-08-19', 2,
   '23000000-0000-4000-8000-000000000202', 'WH-KT', 'draft', now(), '23000000-0000-4000-8000-000000000001');
-- Next calendar year restarts at 001
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date, version_no,
  origin_location_id, status, response_due_at, created_by) values
  ('23000000-0000-4000-8000-000000000204', '23000000-0000-4000-8000-000000000104', 'RP-2031-02-ABCD0004', '2031-01-06', 1,
   'WH-KT', 'cancelled', now(), '23000000-0000-4000-8000-000000000001');

create temporary table m23_p as
select replenishment_plan_id::text as id, plan_number, version_no from core.replenishment_plans
where replenishment_plan_id::text like '23000000-%';

insert into m23_checks select 'format KTnn-Wweek-ddmmyy (Buddhist year)',
  plan_number ~ '^KT\d{2}-W33-120873$' from m23_p where id like '%0201';
insert into m23_checks select 'running number increments',
  (select substring(plan_number from '^KT(\d+)-')::int from m23_p where id like '%0202')
  = (select substring(plan_number from '^KT(\d+)-')::int from m23_p where id like '%0201') + 1
  and (select plan_number from m23_p where id like '%0202') like '%-W34-190873';
insert into m23_checks select 'revision keeps root code',
  (select plan_number from m23_p where id like '%0203') = (select plan_number from m23_p where id like '%0202');
insert into m23_checks select 'new Buddhist year restarts numbering',
  plan_number = 'KT01-W02-060174' from m23_p where id like '%0204';
insert into m23_checks select 'code helper',
  core.m23_plan_code('KT', 7, '2026-08-10') = 'KT07-W33-100869'
  and core.m23_plan_code('KT', 123, '2026-08-10') = 'KT123-W33-100869';
insert into m23_checks select 'warehouse code from location', core.m23_warehouse_code('WH-KT') = 'KT';
insert into m23_checks select 'hand-set numbers are kept',
  core.m23_plan_code('KT', 1, '2026-08-10') <> 'RP-M21' and 'RP-M21' !~ '^RP-\d{4}-\d{2}-[0-9A-F]{8}$';

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m23_checks where not passed;
  if v_failed is not null then raise exception 'M23 checks failed: %', v_failed; end if;
  if (select count(*) from m23_checks) <> 7 then raise exception 'M23: expected 7 checks, got %', (select count(*) from m23_checks); end if;
end
$$;

select check_name, passed from m23_checks order by check_name;
rollback;
