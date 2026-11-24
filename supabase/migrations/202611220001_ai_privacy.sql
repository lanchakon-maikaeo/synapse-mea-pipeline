-- การปิดข้อมูลก่อนส่ง AI (docs/adr/0001-mask-personal-data-before-every-ai-call.md).
-- People registries stop being chat sources and user-id columns stop reaching the model.
-- The server masks with ชื่อที่ระบบรู้จัก and คำที่ต้องปิดเสมอ from ai_privacy_terms(), and keeps
-- only how many values of each kind it hid per Bangkok day and task, for one year.
begin;

delete from ops.chat_sources
where source_id in ('ops.access_requests', 'public.user_profiles', 'audit.change_log');

update ops.chat_sources
set columns = (
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from jsonb_each(columns)
  where key !~ '_by$' and key not in ('actor_id', 'user_id')
)
where exists (
  select 1 from jsonb_object_keys(columns) k
  where k ~ '_by$' or k in ('actor_id', 'user_id')
);

-- คำที่ต้องปิดเสมอ: any role adds a word, only an admin removes one, and who did it is kept.
create table if not exists ops.ai_mask_words (
  word_id uuid primary key default gen_random_uuid(),
  word text not null check (char_length(btrim(word)) between 2 and 100),
  reason text not null default '' check (char_length(reason) <= 500),
  added_by uuid not null,
  added_at timestamptz not null default now(),
  removed_by uuid,
  removed_at timestamptz,
  removal_reason text check (char_length(removal_reason) <= 500),
  check ((removed_at is null) = (removed_by is null))
);
create unique index if not exists ai_mask_words_active
  on ops.ai_mask_words (lower(btrim(word))) where removed_at is null;
alter table ops.ai_mask_words enable row level security;
revoke all on ops.ai_mask_words from public, anon, authenticated;

create table if not exists ops.ai_mask_counts (
  day date not null,
  task text not null check (task in ('chat', 'alerts', 'search')),
  kind text not null check (kind in ('secret', 'word', 'email', 'link', 'line', 'national_id',
    'phone', 'plate', 'employee', 'name')),
  count bigint not null check (count >= 0),
  primary key (day, task, kind)
);
alter table ops.ai_mask_counts enable row level security;
revoke all on ops.ai_mask_counts from public, anon, authenticated;

create or replace function public.ai_privacy_terms() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise insufficient_privilege; end if;
  return jsonb_build_object(
    'names', (select coalesce(jsonb_agg(distinct name order by name), '[]'::jsonb) from (
      select btrim(display_name) as name from core.drivers
      union all select btrim(driver_name) from core.transport_vehicles
      union all select btrim(driver_name) from ops.transport_trips
      union all select btrim(display_name) from public.user_profiles
      union all select btrim(full_name) from ops.access_requests
      union all select btrim(requester_name) from core.replenishment_items
      union all select btrim(requester_name) from ops.ad_hoc_issues
      union all select btrim(requester_name) from ops.district_change_requests
    ) people where coalesce(name, '') <> ''),
    'words', (select coalesce(jsonb_agg(word order by word), '[]'::jsonb)
      from ops.ai_mask_words where removed_at is null));
end;
$$;

create or replace function public.ai_record_mask_counts(p_task text, p_counts jsonb) returns void
language plpgsql security definer set search_path = pg_catalog as $$
declare
  today date := (now() at time zone 'Asia/Bangkok')::date;
  entry_kind text;
  amount jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise insufficient_privilege; end if;
  if p_task is null or p_task not in ('chat', 'alerts', 'search') or jsonb_typeof(p_counts) is distinct from 'object' then
    raise invalid_parameter_value;
  end if;
  for entry_kind, amount in select key, value from jsonb_each(p_counts) loop
    if entry_kind not in ('secret', 'word', 'email', 'link', 'line', 'national_id', 'phone', 'plate', 'employee', 'name')
       or jsonb_typeof(amount) <> 'number' or amount::numeric <> trunc(amount::numeric)
       or amount::numeric not between 0 and 100000 then
      raise invalid_parameter_value;
    end if;
    insert into ops.ai_mask_counts (day, task, kind, count) values (today, p_task, entry_kind, amount::bigint)
    on conflict (day, task, kind) do update set count = ops.ai_mask_counts.count + excluded.count;
  end loop;
  delete from ops.ai_mask_counts where day < today - 365;
end;
$$;

revoke all on function public.ai_privacy_terms(), public.ai_record_mask_counts(text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_privacy_terms(), public.ai_record_mask_counts(text, jsonb) to service_role;

insert into ops.schema_migrations (version, module, description, source_file)
values ('202611220001', 'AGENT', 'Mask personal data before every AI call: people registries out of the chat catalog, user ids dropped, masking terms and mask counts.',
  'supabase/migrations/202611220001_ai_privacy.sql')
on conflict do nothing;

notify pgrst, 'reload schema';
commit;
