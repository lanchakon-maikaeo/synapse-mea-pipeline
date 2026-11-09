\set ON_ERROR_STOP on

-- M34: at most 30 new access requests per hour; a pending request is still returned.
begin;

create temporary table m34_checks (check_name text primary key, passed boolean not null);
create temporary table m34_state (k text primary key, v jsonb);
grant select, insert on m34_checks, m34_state to anon;

set local role anon;
insert into m34_state
select 'req-' || n, public.m15_submit_access_request(
  'M34 Person ' || n, 'M34-' || n, 'm34-' || n || '@example.test', 'M34 Unit', 'viewer', 'M34 limit test request')
from generate_series(1, 31) as n;
insert into m34_state values ('again-1', public.m15_submit_access_request(
  'M34 Person 1', 'M34-1', 'm34-1@example.test', 'M34 Unit', 'viewer', 'M34 limit test request'));
reset role;

insert into m34_checks select 'first 30 requests are accepted',
  (select count(*) from m34_state where k like 'req-%' and v ? 'request_number') = 30;
insert into m34_checks select 'request 31 in the same hour is refused',
  (select v ? 'message' and not v ? 'request_number' from m34_state where k = 'req-31');
insert into m34_checks select 'only 30 rows were written',
  (select count(*) from ops.access_requests where employee_id like 'M34-%') = 30;
insert into m34_checks select 'a pending request is still returned after the limit',
  (select v ->> 'request_number' from m34_state where k = 'again-1')
  = (select v ->> 'request_number' from m34_state where k = 'req-1');

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m34_checks where not passed;
  if v_failed is not null then raise exception 'M34 checks failed: %', v_failed; end if;
  if (select count(*) from m34_checks) <> 4 then raise exception 'M34: expected 4 checks'; end if;
end
$$;

select check_name, passed from m34_checks order by check_name;
rollback;
