-- M15: public access requests without exposing applicant data.

begin;

create table if not exists ops.access_requests (
  request_id uuid primary key default gen_random_uuid(),
  request_number text not null unique,
  full_name text not null check (char_length(full_name) between 2 and 120),
  employee_id text not null check (employee_id ~ '^[A-Za-z0-9._/-]{2,30}$'),
  work_email text not null check (
    char_length(work_email) <= 160
    and work_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  organization_unit text not null check (char_length(organization_unit) between 2 and 160),
  requested_role public.app_role not null check (requested_role <> 'admin'),
  reason text not null check (char_length(reason) between 10 and 800),
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'rejected', 'cancelled')
  ),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  review_note text check (review_note is null or char_length(review_note) <= 1000)
);

create unique index if not exists access_requests_pending_employee_uq
  on ops.access_requests (employee_id)
  where status = 'pending';
create unique index if not exists access_requests_pending_email_uq
  on ops.access_requests (lower(work_email))
  where status = 'pending';
create index if not exists access_requests_status_submitted_idx
  on ops.access_requests (status, submitted_at desc);
create index if not exists access_requests_reviewed_by_idx
  on ops.access_requests (reviewed_by);

alter table ops.access_requests enable row level security;
revoke all on ops.access_requests from public, anon, authenticated;

create or replace function public.m15_submit_access_request(
  p_full_name text,
  p_employee_id text,
  p_work_email text,
  p_organization_unit text,
  p_requested_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_request_number text;
  v_employee_id text := btrim(coalesce(p_employee_id, ''));
  v_work_email text := lower(btrim(coalesce(p_work_email, '')));
begin
  if char_length(btrim(coalesce(p_full_name, ''))) not between 2 and 120
     or v_employee_id !~ '^[A-Za-z0-9._/-]{2,30}$'
     or char_length(v_work_email) > 160
     or v_work_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(btrim(coalesce(p_organization_unit, ''))) not between 2 and 160
     or p_requested_role not in ('district', 'planner', 'academic', 'picker', 'viewer')
     or char_length(btrim(coalesce(p_reason, ''))) not between 10 and 800 then
    return jsonb_build_object('message', 'Invalid access request');
  end if;

  select request_id, request_number
  into v_request_id, v_request_number
  from ops.access_requests
  where status = 'pending'
    and (employee_id = v_employee_id or lower(work_email) = v_work_email)
  order by submitted_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'request_id', v_request_id,
      'request_number', v_request_number,
      'status', 'pending'
    );
  end if;

  v_request_id := gen_random_uuid();
  v_request_number := 'AR-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-'
    || upper(substr(replace(v_request_id::text, '-', ''), 1, 8));

  insert into ops.access_requests (
    request_id,
    request_number,
    full_name,
    employee_id,
    work_email,
    organization_unit,
    requested_role,
    reason
  )
  values (
    v_request_id,
    v_request_number,
    btrim(p_full_name),
    v_employee_id,
    v_work_email,
    btrim(p_organization_unit),
    p_requested_role::public.app_role,
    btrim(p_reason)
  );

  return jsonb_build_object(
    'request_id', v_request_id,
    'request_number', v_request_number,
    'status', 'pending'
  );
exception
  when unique_violation then
    select request_id, request_number
    into v_request_id, v_request_number
    from ops.access_requests
    where status = 'pending'
      and (employee_id = v_employee_id or lower(work_email) = v_work_email)
    order by submitted_at desc
    limit 1;
    if found then
      return jsonb_build_object(
        'request_id', v_request_id,
        'request_number', v_request_number,
        'status', 'pending'
      );
    end if;
    raise;
end;
$$;

revoke all on function public.m15_submit_access_request(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.m15_submit_access_request(text, text, text, text, text, text)
  to anon, authenticated;

comment on table ops.access_requests is
  'Private applicant records submitted before an administrator provisions an account.';

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202609010000',
  'M15',
  'Private, deduplicated public access requests with no direct table exposure.',
  'supabase/migrations/202609010000_m15_access_requests.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
