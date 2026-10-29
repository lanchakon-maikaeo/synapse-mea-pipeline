\set ON_ERROR_STOP on

-- M20: admin user management.
begin;

-- Local auth.users stub may not carry email / sign-in columns (Supabase does).
alter table auth.users add column if not exists email text;
alter table auth.users add column if not exists last_sign_in_at timestamptz;

create temporary table m20_checks (check_name text primary key, passed boolean not null);
create temporary table m20_state (
  listing jsonb, planner_listing jsonb, to_district jsonb, district_no_area jsonb,
  make_admin jsonb, self_demote jsonb, deactivate jsonb, approve_existing jsonb,
  approve_new jsonb, reject_no_note jsonb, reject_ok jsonb, again jsonb, after jsonb
);
insert into m20_state default values;
grant select, insert, update on m20_checks, m20_state to authenticated;

insert into auth.users (id, raw_user_meta_data, email, last_sign_in_at) values
  ('20000000-0000-4000-8000-000000000001', '{"display_name":"M20 Admin"}', 'm20.admin@mea.test', now()),
  ('20000000-0000-4000-8000-000000000002', '{"display_name":"M20 Planner"}', 'm20.planner@mea.test', null),
  ('20000000-0000-4000-8000-000000000003', '{"display_name":"M20 Staff"}', 'm20.staff@mea.test', null);
update public.user_profiles set role = 'admin', district_id = null
where user_id = '20000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'planner', district_id = null
where user_id = '20000000-0000-4000-8000-000000000002';

insert into ops.access_requests (request_id, request_number, full_name, employee_id, work_email,
  organization_unit, requested_role, reason) values
  ('20000000-0000-4000-8000-000000000101', 'AR-M20-1', 'สมหญิง เขตนวล', 'E1001', 'm20.staff@mea.test',
   'เขตนวลจันทร์', 'district', 'ต้องยืนยันรายการพัสดุของเขต'),
  ('20000000-0000-4000-8000-000000000102', 'AR-M20-2', 'สมชาย คลัง', 'E1002', 'm20.newbie@mea.test',
   'กองคลังพัสดุ', 'picker', 'รับพัสดุเข้าคลังและจ่ายตาม FIFO'),
  ('20000000-0000-4000-8000-000000000103', 'AR-M20-3', 'ผู้ขอทั่วไป', 'E1003', 'm20.other@mea.test',
   'ภายนอก', 'viewer', 'อยากดูข้อมูลภาพรวมของระบบ');

-- Planner cannot use admin routes
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update m20_state set planner_listing = public.m09_dispatch('GET', '/v1/admin/users', '{}', '{}', 'm20-0');
reset role;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m20_state set listing = public.m09_dispatch('GET', '/v1/admin/users', '{}', '{}', 'm20-1');
update m20_state set to_district = public.m09_dispatch('POST',
  '/v1/admin/users/20000000-0000-4000-8000-000000000002', '{}',
  '{"role":"district","district_id":"5503","display_name":"คุณ ก (นนทบุรี)"}', 'm20-2');
update m20_state set district_no_area = public.m09_dispatch('POST',
  '/v1/admin/users/20000000-0000-4000-8000-000000000003', '{}', '{"role":"district"}', 'm20-3');
update m20_state set make_admin = public.m09_dispatch('POST',
  '/v1/admin/users/20000000-0000-4000-8000-000000000003', '{}', '{"role":"admin"}', 'm20-4');
update m20_state set self_demote = public.m09_dispatch('POST',
  '/v1/admin/users/20000000-0000-4000-8000-000000000001', '{}', '{"is_active":false}', 'm20-5');
update m20_state set deactivate = public.m09_dispatch('POST',
  '/v1/admin/users/20000000-0000-4000-8000-000000000002', '{}', '{"is_active":false}', 'm20-6');
update m20_state set approve_existing = public.m09_dispatch('POST',
  '/v1/admin/access-requests/20000000-0000-4000-8000-000000000101/review', '{}',
  '{"decision":"approve","role":"district","district_id":"5501"}', 'm20-7');
update m20_state set approve_new = public.m09_dispatch('POST',
  '/v1/admin/access-requests/20000000-0000-4000-8000-000000000102/review', '{}',
  '{"decision":"approve"}', 'm20-8');
update m20_state set reject_no_note = public.m09_dispatch('POST',
  '/v1/admin/access-requests/20000000-0000-4000-8000-000000000103/review', '{}',
  '{"decision":"reject"}', 'm20-9');
update m20_state set reject_ok = public.m09_dispatch('POST',
  '/v1/admin/access-requests/20000000-0000-4000-8000-000000000103/review', '{}',
  '{"decision":"reject","note":"ไม่ใช่บุคลากรที่เกี่ยวข้อง"}', 'm20-10');
update m20_state set again = public.m09_dispatch('POST',
  '/v1/admin/access-requests/20000000-0000-4000-8000-000000000103/review', '{}',
  '{"decision":"approve"}', 'm20-11');
reset role;

-- The approved newcomer's login is created later: role applies automatically.
insert into auth.users (id, raw_user_meta_data, email)
values ('20000000-0000-4000-8000-000000000004', '{}', 'M20.Newbie@mea.test');

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m20_state set after = public.m09_dispatch('GET', '/v1/admin/users', '{}', '{}', 'm20-12');
reset role;

insert into m20_checks select 'planner forbidden', (planner_listing ->> 'status')::int = 403 from m20_state;
insert into m20_checks select 'admin lists users and requests',
  (listing ->> 'status')::int = 200
  and exists (select 1 from jsonb_array_elements(listing #> '{body,users}') u
    where u ->> 'email' = 'm20.admin@mea.test' and u ->> 'role' = 'admin' and u ->> 'last_sign_in_at' is not null)
  and exists (select 1 from jsonb_array_elements(listing #> '{body,requests}') r
    where r ->> 'request_number' = 'AR-M20-1' and r ->> 'account_user_id' = '20000000-0000-4000-8000-000000000003')
from m20_state;
insert into m20_checks select 'change role to district with area',
  (to_district ->> 'status')::int = 200
  and (select role::text = 'district' and district_id = '5503' and display_name = 'คุณ ก (นนทบุรี)'
       from public.user_profiles where user_id = '20000000-0000-4000-8000-000000000002')
from m20_state;
insert into m20_checks select 'district role needs district', (district_no_area ->> 'status')::int = 400 from m20_state;
insert into m20_checks select 'cannot grant admin', (make_admin ->> 'status')::int = 400 from m20_state;
insert into m20_checks select 'cannot lock out self', (self_demote ->> 'status')::int = 400 from m20_state;
insert into m20_checks select 'deactivate user',
  (deactivate ->> 'status')::int = 200
  and not (select is_active from public.user_profiles where user_id = '20000000-0000-4000-8000-000000000002')
from m20_state;
insert into m20_checks select 'approve existing account applies now',
  (approve_existing #>> '{body,applied}')::boolean
  and (select role::text = 'district' and district_id = '5501' and display_name = 'สมหญิง เขตนวล'
       from public.user_profiles where user_id = '20000000-0000-4000-8000-000000000003')
from m20_state;
insert into m20_checks select 'approve without account waits',
  (approve_new ->> 'status')::int = 200 and not (approve_new #>> '{body,applied}')::boolean
from m20_state;
insert into m20_checks select 'new login gets approved role',
  (select role::text = 'picker' and is_active and display_name = 'สมชาย คลัง'
     from public.user_profiles where user_id = '20000000-0000-4000-8000-000000000004')
  and (select applied_at is not null and linked_user_id = '20000000-0000-4000-8000-000000000004'
     from ops.access_requests where request_id = '20000000-0000-4000-8000-000000000102');
insert into m20_checks select 'reject needs note then works',
  (reject_no_note ->> 'status')::int = 400 and (reject_ok #>> '{body,status}') = 'rejected'
from m20_state;
insert into m20_checks select 'reviewed request cannot be reviewed again', (again ->> 'status')::int = 400 from m20_state;
insert into m20_checks select 'history shows role change by admin',
  exists (select 1 from jsonb_array_elements(after #> '{body,history}') h
    where h ->> 'actor' = 'M20 Admin' and h #>> '{changes,role,1}' = 'district'
      and h #>> '{changes,role,0}' = 'planner')
from m20_state;

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m20_checks where not passed;
  if v_failed is not null then raise exception 'M20 checks failed: %', v_failed; end if;
  if (select count(*) from m20_checks) <> 13 then raise exception 'M20: expected 13 checks'; end if;
end
$$;

select check_name, passed from m20_checks order by check_name;
rollback;
