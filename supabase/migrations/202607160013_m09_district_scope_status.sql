-- Return an explicit authorization status for cross-district confirmations.
-- The original dispatcher is retained as a non-browser-callable implementation.

begin;

do $$
begin
  if to_regprocedure(
    'public.m09_dispatch_impl(text,text,jsonb,jsonb,text)'
  ) is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl;
  end if;
end
$$;

create or replace function public.m09_dispatch(
  p_method text,
  p_path text,
  p_query jsonb default '{}'::jsonb,
  p_body jsonb default '{}'::jsonb,
  p_request_id text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core
as $$
declare
  v_user_id uuid := auth.uid();
  v_role public.app_role;
  v_profile_district text;
  v_item_district text;
  v_item_id uuid;
begin
  if upper(coalesce(p_method, '')) = 'POST'
     and p_path ~ '^/v1/replenishment/items/[0-9a-fA-F-]{36}/confirm$' then
    select role, district_id
    into v_role, v_profile_district
    from public.user_profiles
    where user_id = v_user_id
      and is_active;

    if v_role = 'district' then
      v_item_id := substring(
        p_path
        from '^/v1/replenishment/items/([0-9a-fA-F-]{36})/confirm$'
      )::uuid;

      select district_id
      into v_item_district
      from core.replenishment_items
      where replenishment_item_id = v_item_id;

      if v_item_district is not null
         and v_item_district <> v_profile_district then
        return public.m09_error(
          403,
          'forbidden',
          'District may only confirm its own replenishment items',
          p_request_id
        );
      end if;
    end if;
  end if;

  return public.m09_dispatch_impl(
    p_method,
    p_path,
    p_query,
    p_body,
    p_request_id
  );
end;
$$;

revoke all on function public.m09_dispatch_impl(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch_impl(text, text, jsonb, jsonb, text)
  to service_role;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated, service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607160013',
  'M09',
  'Explicit 403 response for cross-district replenishment confirmation and protected dispatcher implementation.',
  'supabase/migrations/202607160013_m09_district_scope_status.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
