\set ON_ERROR_STOP on

-- M36: planner draft saved on the server per plan and district.
begin;

create temporary table m36_checks (check_name text primary key, passed boolean not null);
create temporary table m36_state (k text primary key, v jsonb);
grant select, insert, update on m36_checks, m36_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values
  ('36000000-0000-4000-8000-000000000001', '{"display_name":"M36 A"}'),
  ('36000000-0000-4000-8000-000000000002', '{"display_name":"M36 B"}'),
  ('36000000-0000-4000-8000-000000000003', '{"display_name":"M36 District"}');
update public.user_profiles set role = 'planner', district_id = null, display_name = 'Planner A'
where user_id = '36000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'planner', district_id = null, display_name = 'Planner B'
where user_id = '36000000-0000-4000-8000-000000000002';
update public.user_profiles set role = 'district', district_id = '5501'
where user_id = '36000000-0000-4000-8000-000000000003';

insert into ops.replenishment_runs (replenishment_run_id, policy_version, snapshot_cutoff_at, status, initiated_by)
values ('36000000-0000-4000-8000-000000000100', 'v1.0.0', now(), 'running', '36000000-0000-4000-8000-000000000001'),
       ('36000000-0000-4000-8000-000000000101', 'v1.0.0', now(), 'running', '36000000-0000-4000-8000-000000000001');
insert into core.replenishment_plans (replenishment_plan_id, replenishment_run_id, plan_number, week_start_date,
  version_no, origin_location_id, status, response_due_at, created_by) values
  ('36000000-0000-4000-8000-000000000200', '36000000-0000-4000-8000-000000000100', 'KT36-W01-M36',
   '2031-02-03', 1, 'WH-KT', 'draft', now() + interval '1 day', '36000000-0000-4000-8000-000000000001'),
  ('36000000-0000-4000-8000-000000000201', '36000000-0000-4000-8000-000000000101', 'KT36-W02-M36',
   '2031-02-10', 1, 'WH-KT', 'cancelled', now() + interval '1 day', '36000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '36000000-0000-4000-8000-000000000001', true);
set local role authenticated;
insert into m36_state values ('a_save', public.m09_dispatch('POST', '/v1/replenishment/plans/36000000-0000-4000-8000-000000000200/draft', '{}',
  '{"slices":[{"district_id":"5501","payload":{"selectedIds":{"x":true},"confirmed":"2026-11-12T10:00"}},{"district_id":"5502","payload":{"skipReasons":{"y":"ยังมีพอ"}}}]}', 'm36-1'));
reset role;

select set_config('request.jwt.claim.sub', '36000000-0000-4000-8000-000000000002', true);
set local role authenticated;
insert into m36_state values ('b_read', public.m09_dispatch('GET', '/v1/replenishment/plans/36000000-0000-4000-8000-000000000200/draft', '{}', '{}', 'm36-2'));
-- B saves 5502 with an old base: refused as a conflict; 5503 is new
insert into m36_state values ('b_stale', public.m09_dispatch('POST', '/v1/replenishment/plans/36000000-0000-4000-8000-000000000200/draft', '{}',
  '{"slices":[{"district_id":"5502","payload":{"skipReasons":{}},"base_updated_at":"2020-01-01T00:00:00Z"},{"district_id":"5503","payload":{"addedIds":{"z":true}}}]}', 'm36-3'));
-- B removes 5501 with the base it read
insert into m36_state select 'b_remove', public.m09_dispatch('POST', '/v1/replenishment/plans/36000000-0000-4000-8000-000000000200/draft', '{}',
  jsonb_build_object('slices', jsonb_build_array(jsonb_build_object('district_id', '5501', 'payload', null,
    'base_updated_at', (select e ->> 'updated_at' from m36_state s, jsonb_array_elements(s.v -> 'body') e where s.k = 'b_read' and e ->> 'district_id' = '5501')))), 'm36-4');
insert into m36_state values ('closed', public.m09_dispatch('POST', '/v1/replenishment/plans/36000000-0000-4000-8000-000000000201/draft', '{}',
  '{"slices":[{"district_id":"5501","payload":{}}]}', 'm36-5'));
insert into m36_state values ('bad', public.m09_dispatch('POST', '/v1/replenishment/plans/36000000-0000-4000-8000-000000000200/draft', '{}',
  '{"slices":[{"district_id":"9999","payload":{}}]}', 'm36-6'));
reset role;

select set_config('request.jwt.claim.sub', '36000000-0000-4000-8000-000000000003', true);
set local role authenticated;
insert into m36_state values ('district', public.m09_dispatch('GET', '/v1/replenishment/plans/36000000-0000-4000-8000-000000000200/draft', '{}', '{}', 'm36-7'));
reset role;

insert into m36_checks select 'planner A saves two districts',
  (select v ->> 'status' from m36_state where k = 'a_save') = '200'
  and (select v #> '{body,saved}' from m36_state where k = 'a_save') = '["5501", "5502"]';
insert into m36_checks select 'planner B on another computer reads them with who saved',
  (select jsonb_array_length(v -> 'body') from m36_state where k = 'b_read') = 2
  and exists (select 1 from m36_state s, jsonb_array_elements(s.v -> 'body') e where s.k = 'b_read'
    and e ->> 'district_id' = '5501' and e #>> '{payload,selectedIds,x}' = 'true' and e ->> 'updated_by_name' = 'Planner A');
insert into m36_checks select 'an older copy does not overwrite a newer save',
  (select v #> '{body,conflicts}' from m36_state where k = 'b_stale') = '["5502"]'
  and (select v #> '{body,saved}' from m36_state where k = 'b_stale') = '["5503"]'
  and exists (select 1 from m36_state s, jsonb_array_elements(s.v #> '{body,slices}') e where s.k = 'b_stale'
    and e ->> 'district_id' = '5502' and e #>> '{payload,skipReasons,y}' = 'ยังมีพอ');
insert into m36_checks select 'null payload removes a district',
  not exists (select 1 from m36_state s, jsonb_array_elements(s.v #> '{body,slices}') e where s.k = 'b_remove' and e ->> 'district_id' = '5501')
  and (select count(*) from ops.planner_draft_slices where replenishment_plan_id = '36000000-0000-4000-8000-000000000200') = 2;
insert into m36_checks select 'closed plan and bad district are refused',
  (select v ->> 'status' from m36_state where k = 'closed') = '409'
  and (select v ->> 'status' from m36_state where k = 'bad') = '422';
insert into m36_checks select 'district users cannot read planner drafts',
  (select v ->> 'status' from m36_state where k = 'district') = '403';

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m36_checks where not passed;
  if v_failed is not null then raise exception 'M36 checks failed: %', v_failed; end if;
  if (select count(*) from m36_checks) <> 6 then raise exception 'M36: expected 6 checks, got %', (select count(*) from m36_checks); end if;
end
$$;

select check_name, passed from m36_checks order by check_name;
rollback;
