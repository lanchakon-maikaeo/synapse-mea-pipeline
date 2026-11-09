-- P02: reserve a per-user request before a paid LLM call.
begin;

create table audit.vmi_chat_admissions (
  admission_id bigint generated always as identity primary key,
  request_id uuid not null unique,
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp()
);
create index vmi_chat_admissions_actor_time
  on audit.vmi_chat_admissions(actor_id, created_at);
alter table audit.vmi_chat_admissions enable row level security;
revoke all on audit.vmi_chat_admissions from public, anon, authenticated;
create trigger vmi_chat_admissions_append_only before update or delete
  on audit.vmi_chat_admissions for each row
  execute function audit.reject_append_only_mutation();

create function public.vmi_chat_admit(p_request_id uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog
set statement_timeout = '2s'
set lock_timeout = '1s'
as $$
declare
  actor uuid := auth.uid();
  actor_role text;
  actor_district text;
begin
  if actor is null or p_request_id is null then
    raise sqlstate '28000' using message = 'Authentication required';
  end if;

  select role::text, district_id
    into actor_role, actor_district
    from public.user_profiles
    where user_id = actor and is_active;
  if actor_role is null then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('vmi-chat-admit:' || actor::text, 0));
  if (select count(*) from audit.vmi_chat_admissions
      where actor_id = actor
        and created_at > clock_timestamp() - interval '1 minute') >= 10 then
    return jsonb_build_object('status', 'unavailable',
      'warnings', jsonb_build_array('rate_limited'));
  end if;

  insert into audit.vmi_chat_admissions(request_id, actor_id)
    values(p_request_id, actor);
  return jsonb_build_object('status', 'ok', 'scope',
    jsonb_build_object('role', actor_role, 'district_id', actor_district));
end;
$$;

revoke all on function public.vmi_chat_admit(uuid) from public, anon, authenticated;
grant execute on function public.vmi_chat_admit(uuid) to authenticated;
comment on function public.vmi_chat_admit(uuid) is
  'P02 pre-inference admission. Caller-derived identity, 10 requests/minute, no prompt storage.';

insert into ops.schema_migrations(version,module,description,source_file)
values('202611100003','P02','Pre-inference per-user admission for paid chat calls.',
  'supabase/migrations/202611100003_p02_chat_admission.sql');
notify pgrst, 'reload schema';
commit;
