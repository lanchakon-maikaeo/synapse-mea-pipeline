-- M36: the planner's work in คำนวณการจ่าย is saved on the server, per plan and
-- per district, so it survives a closed browser, another computer, and is
-- shared between planners working on the same plan.
--
--   GET  /v1/replenishment/plans/{id}/draft   every saved district slice
--   POST /v1/replenishment/plans/{id}/draft   {slices:[{district_id, payload, base_updated_at?}]}
--        payload null removes the slice. base_updated_at (optional) is the
--        updated_at the client last saw; a newer server row is not
--        overwritten and is returned as a conflict instead.

begin;

create table if not exists ops.planner_draft_slices (
  replenishment_plan_id uuid not null references core.replenishment_plans (replenishment_plan_id) on delete cascade,
  district_id text not null check (district_id ~ '^55(0[1-9]|1[0-8])$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_name text,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (replenishment_plan_id, district_id)
);

alter table ops.planner_draft_slices enable row level security;
revoke all on ops.planner_draft_slices from public, anon, authenticated;

create or replace function core.m36_draft(p_plan_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, ops
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'district_id', s.district_id,
      'payload', s.payload,
      'updated_by_name', s.updated_by_name,
      'updated_at', s.updated_at)
    order by s.district_id), '[]'::jsonb)
  from ops.planner_draft_slices s
  where s.replenishment_plan_id = p_plan_id;
$$;
revoke all on function core.m36_draft(uuid) from public, anon, authenticated;

create or replace function core.m36_save_draft(p_plan_id uuid, p_slices jsonb, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_slice jsonb;
  v_district text;
  v_base timestamptz;
  v_current timestamptz;
  v_name text;
  v_conflicts jsonb := '[]'::jsonb;
  v_saved jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from core.replenishment_plans
    where replenishment_plan_id = p_plan_id
      and status not in ('cancelled', 'completed', 'rejected')
  ) then
    raise exception 'plan is not open' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_slices) is distinct from 'array' or jsonb_array_length(p_slices) > 18 then
    raise exception 'slices must be an array of at most 18 districts' using errcode = '22023';
  end if;
  if octet_length(p_slices::text) > 2000000 then
    raise exception 'draft too large' using errcode = '22023';
  end if;

  select coalesce(nullif(display_name, ''), '') into v_name
  from public.user_profiles where user_id = p_user_id;

  for v_slice in select value from jsonb_array_elements(p_slices) loop
    v_district := v_slice ->> 'district_id';
    if coalesce(v_district, '') !~ '^55(0[1-9]|1[0-8])$' then
      raise exception 'district_id % is not one of the 18 districts', v_district using errcode = '22023';
    end if;
    if v_slice -> 'payload' is not null and jsonb_typeof(v_slice -> 'payload') not in ('object', 'null') then
      raise exception 'payload must be an object or null' using errcode = '22023';
    end if;
    v_base := nullif(v_slice ->> 'base_updated_at', '')::timestamptz;

    select updated_at into v_current
    from ops.planner_draft_slices
    where replenishment_plan_id = p_plan_id and district_id = v_district
    for update;

    -- someone else saved this district after the client last read it
    if v_current is not null and v_base is not null and v_current > v_base + interval '1 millisecond' then
      v_conflicts := v_conflicts || to_jsonb(v_district);
      continue;
    end if;

    if v_slice -> 'payload' is null or jsonb_typeof(v_slice -> 'payload') = 'null' then
      delete from ops.planner_draft_slices
      where replenishment_plan_id = p_plan_id and district_id = v_district;
    else
      insert into ops.planner_draft_slices (replenishment_plan_id, district_id, payload, updated_by, updated_by_name, updated_at)
      values (p_plan_id, v_district, v_slice -> 'payload', p_user_id, v_name, clock_timestamp())
      on conflict (replenishment_plan_id, district_id) do update
        set payload = excluded.payload,
            updated_by = excluded.updated_by,
            updated_by_name = excluded.updated_by_name,
            updated_at = excluded.updated_at;
    end if;
    v_saved := v_saved || to_jsonb(v_district);
  end loop;

  return jsonb_build_object('saved', v_saved, 'conflicts', v_conflicts, 'slices', core.m36_draft(p_plan_id));
end;
$$;
revoke all on function core.m36_save_draft(uuid, jsonb, uuid) from public, anon, authenticated;

-- Dispatcher -------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m36(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text) rename to m09_dispatch_impl_m36;
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
set statement_timeout = '60s'
as $$
declare
  v_user_id uuid := auth.uid();
  v_method text := upper(coalesce(p_method, ''));
  v_role text;
  v_plan uuid;
  v_match text[];
begin
  v_match := regexp_match(p_path, '^/v1/replenishment/plans/([0-9a-fA-F-]{36})/draft$');
  if v_match is not null then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text into v_role from public.user_profiles where user_id = v_user_id and is_active;
    if coalesce(v_role, '') not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Planner or admin role is required', p_request_id);
    end if;
    begin
      v_plan := v_match[1]::uuid;
    exception when invalid_text_representation then
      return public.m09_error(422, 'validation_error', 'plan id must be a uuid', p_request_id);
    end;

    if v_method = 'GET' then
      return public.m09_result(200, core.m36_draft(v_plan));
    end if;
    if v_method = 'POST' then
      begin
        return public.m09_result(200, core.m36_save_draft(v_plan, p_body -> 'slices', v_user_id));
      exception
        when sqlstate 'P0002' then
          return public.m09_error(409, 'conflict', SQLERRM, p_request_id);
        when sqlstate '22023' or invalid_datetime_format or datetime_field_overflow then
          return public.m09_error(422, 'validation_error', SQLERRM, p_request_id);
      end;
    end if;
    return public.m09_error(405, 'method_not_allowed', 'Use GET or POST', p_request_id);
  end if;

  return public.m09_dispatch_impl_m36(p_method, p_path, p_query, p_body, p_request_id);
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text) to authenticated;
revoke all on function public.m09_dispatch_impl_m36(text, text, jsonb, jsonb, text) from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
