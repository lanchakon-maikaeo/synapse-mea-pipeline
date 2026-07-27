-- SYNAPSE M14c: single-use, short-lived capability for an already-governed
-- queued route job. Only the SHA-256 digest is stored; the Production server
-- consumes it atomically before invoking its server-only worker credential.

begin;

create table if not exists ops.one_time_worker_triggers (
  one_time_worker_trigger_id uuid primary key default gen_random_uuid(),
  route_job_id uuid not null unique
    references ops.route_jobs (route_job_id) on delete restrict,
  token_sha256 text not null unique
    check (token_sha256 ~ '^[0-9a-f]{64}$'),
  purpose text not null
    check (purpose = 'production_route_canary'),
  created_by uuid not null references auth.users (id) on delete restrict,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '30 minutes'),
  check (consumed_at is null or consumed_at >= created_at)
);

create index if not exists one_time_worker_triggers_expiry_idx
  on ops.one_time_worker_triggers (expires_at)
  where consumed_at is null;

alter table ops.one_time_worker_triggers enable row level security;
revoke all on ops.one_time_worker_triggers
  from public, anon, authenticated;
grant all on ops.one_time_worker_triggers to service_role;

create or replace function public.m14c_create_worker_trigger(
  p_route_job_id uuid,
  p_token_sha256 text,
  p_expires_at timestamptz,
  p_created_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_trigger_id uuid;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M14c capability creation requires service_role';
  end if;
  if coalesce(p_token_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid capability digest';
  end if;
  if p_expires_at <= clock_timestamp()
     or p_expires_at > clock_timestamp() + interval '30 minutes' then
    raise exception 'Capability expiry must be within 30 minutes';
  end if;
  if not exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = p_created_by
      and profile.is_active
      and profile.role::text = 'admin'
  ) then
    raise exception 'An active Production admin creator is required';
  end if;
  if not exists (
    select 1
    from ops.route_jobs route_job
    join ops.background_jobs job using (job_id)
    where route_job.route_job_id = p_route_job_id
      and job.status = 'queued'
      and route_job.requested_by = p_created_by
  ) then
    raise exception 'Capability requires the admin creator''s queued route job';
  end if;

  insert into ops.one_time_worker_triggers (
    route_job_id,
    token_sha256,
    purpose,
    created_by,
    expires_at
  )
  values (
    p_route_job_id,
    p_token_sha256,
    'production_route_canary',
    p_created_by,
    p_expires_at
  )
  returning one_time_worker_trigger_id into v_trigger_id;

  return jsonb_build_object(
    'one_time_worker_trigger_id', v_trigger_id,
    'route_job_id', p_route_job_id,
    'expires_at', p_expires_at,
    'status', 'created'
  );
end;
$$;

revoke all on function public.m14c_create_worker_trigger(
  uuid, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.m14c_create_worker_trigger(
  uuid, text, timestamptz, uuid
) to service_role;

create or replace function public.m14c_consume_worker_trigger(
  p_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_trigger ops.one_time_worker_triggers%rowtype;
begin
  if coalesce(p_token_sha256, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('accepted', false);
  end if;

  select capability.*
  into v_trigger
  from ops.one_time_worker_triggers capability
  join ops.route_jobs route_job using (route_job_id)
  join ops.background_jobs job using (job_id)
  where capability.token_sha256 = p_token_sha256
    and capability.consumed_at is null
    and capability.expires_at > clock_timestamp()
    and capability.purpose = 'production_route_canary'
    and job.status = 'queued'
  for update of capability;

  if not found then
    return jsonb_build_object('accepted', false);
  end if;

  update ops.one_time_worker_triggers
  set consumed_at = clock_timestamp()
  where one_time_worker_trigger_id =
    v_trigger.one_time_worker_trigger_id;

  return jsonb_build_object(
    'accepted', true,
    'route_job_id', v_trigger.route_job_id
  );
end;
$$;

revoke all on function public.m14c_consume_worker_trigger(text)
  from public;
grant execute on function public.m14c_consume_worker_trigger(text)
  to anon, authenticated, service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607270003',
  'M14c',
  'Atomic single-use Production capability for invoking one already-governed queued OR-Tools route job without exposing server worker credentials.',
  'supabase/migrations/202607270003_m14c_one_time_worker_trigger.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
