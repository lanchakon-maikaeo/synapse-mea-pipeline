-- M20: User management for the administrator.
--
--   GET  /v1/admin/users                              users + access requests + change history
--   POST /v1/admin/users/{user_id}                    change name / role / district / active
--   POST /v1/admin/access-requests/{request_id}/review approve or reject a request
--
-- Rules
--   * admin only; the admin role itself is never granted or removed here
--     (single-admin policy stays a deliberate database decision)
--   * an admin cannot deactivate or re-role their own account (no lock-out)
--   * district role requires a district 5501-5518; other roles carry none
--   * approving a request for an email that has no login yet stores the decision;
--     it is applied automatically when the login is created with that email
--   * changes are recorded by the existing audit trigger on public.user_profiles

begin;

alter table ops.access_requests
  add column if not exists approved_role public.app_role,
  add column if not exists approved_district_id text,
  add column if not exists linked_user_id uuid references auth.users (id) on delete set null,
  add column if not exists applied_at timestamptz;

create index if not exists access_requests_approved_email_idx
  on ops.access_requests (lower(work_email))
  where status = 'approved' and applied_at is null;

-- ------------------------------------------------------------------
-- New login: create the profile, then apply an approved request if any.
-- (email is read through to_jsonb so the function works on any auth.users shape)
-- ------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_email text := lower(nullif(btrim(to_jsonb(new) ->> 'email'), ''));
  v_request record;
begin
  insert into public.user_profiles (user_id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (user_id) do nothing;

  if v_email is not null then
    select * into v_request
    from ops.access_requests r
    where r.status = 'approved'
      and r.applied_at is null
      and lower(r.work_email) = v_email
    order by r.reviewed_at desc nulls last
    limit 1;

    if found and v_request.approved_role is not null and v_request.approved_role <> 'admin' then
      update public.user_profiles
      set role = v_request.approved_role,
          district_id = case when v_request.approved_role = 'district'
            then v_request.approved_district_id end,
          display_name = coalesce(nullif(btrim(display_name), ''), v_request.full_name),
          is_active = true
      where user_id = new.id;

      update ops.access_requests
      set linked_user_id = new.id,
          applied_at = now()
      where request_id = v_request.request_id;
    end if;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------
-- Read: users, requests, history
-- ------------------------------------------------------------------
create or replace function core.m20_admin_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, core, ops, audit
as $$
declare
  v_result jsonb;
begin
  with accounts as (
    select
      p.user_id,
      p.role::text as role,
      p.district_id,
      p.display_name,
      p.is_active,
      p.created_at,
      p.updated_at,
      lower(nullif(to_jsonb(u) ->> 'email', '')) as email,
      nullif(to_jsonb(u) ->> 'last_sign_in_at', '')::timestamptz as last_sign_in_at,
      nullif(to_jsonb(u) ->> 'created_at', '')::timestamptz as account_created_at
    from public.user_profiles p
    join auth.users u on u.id = p.user_id
  ),
  names as (
    select user_id, coalesce(nullif(display_name, ''), email, user_id::text) as label
    from accounts
  ),
  history as (
    select
      c.audit_id,
      c.occurred_at,
      c.operation,
      c.changed_by,
      coalesce(c.new_data ->> 'user_id', c.old_data ->> 'user_id') as target_id,
      c.old_data,
      c.new_data
    from audit.change_log c
    where c.schema_name = 'public' and c.table_name = 'user_profiles'
    order by c.occurred_at desc, c.audit_id desc
    limit 300
  )
  select jsonb_build_object(
    'me', auth.uid(),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', a.user_id,
        'email', a.email,
        'display_name', a.display_name,
        'role', a.role,
        'district_id', a.district_id,
        'district_name', d.district_name_th,
        'is_active', a.is_active,
        'last_sign_in_at', a.last_sign_in_at,
        'created_at', coalesce(a.account_created_at, a.created_at),
        'updated_at', a.updated_at
      ) order by a.is_active desc, a.role, coalesce(a.display_name, a.email))
      from accounts a
      left join core.districts d on d.district_id = a.district_id
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'request_id', r.request_id,
        'request_number', r.request_number,
        'full_name', r.full_name,
        'employee_id', r.employee_id,
        'work_email', r.work_email,
        'organization_unit', r.organization_unit,
        'requested_role', r.requested_role,
        'reason', r.reason,
        'status', r.status,
        'submitted_at', r.submitted_at,
        'reviewed_at', r.reviewed_at,
        'reviewed_by_name', rn.label,
        'review_note', r.review_note,
        'approved_role', r.approved_role,
        'approved_district_id', r.approved_district_id,
        'applied_at', r.applied_at,
        'account_user_id', acc.user_id,
        'account_role', acc.role,
        'account_active', acc.is_active
      ) order by (r.status = 'pending') desc, r.submitted_at desc)
      from ops.access_requests r
      left join accounts acc on acc.email = lower(r.work_email)
      left join names rn on rn.user_id = r.reviewed_by
      where r.status = 'pending' or r.submitted_at > now() - interval '180 days'
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'audit_id', h.audit_id,
        'occurred_at', h.occurred_at,
        'operation', h.operation,
        'actor', coalesce(an.label, case when h.changed_by is null then 'ระบบ' end),
        'target_user_id', h.target_id,
        'target', coalesce(tn.label, h.new_data ->> 'display_name', h.old_data ->> 'display_name', h.target_id),
        'changes', (
          select coalesce(jsonb_object_agg(k, jsonb_build_array(h.old_data -> k, h.new_data -> k)), '{}'::jsonb)
          from unnest(array['role', 'district_id', 'is_active', 'display_name']) k
          where h.operation <> 'UPDATE' or (h.old_data -> k) is distinct from (h.new_data -> k)
        )
      ) order by h.occurred_at desc, h.audit_id desc)
      from history h
      left join names an on an.user_id = h.changed_by
      left join names tn on tn.user_id::text = h.target_id
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- ------------------------------------------------------------------
-- Update one user
-- ------------------------------------------------------------------
create or replace function core.m20_update_user(p_user_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core
as $$
declare
  v_actor uuid := auth.uid();
  v_target public.user_profiles%rowtype;
  v_role text;
  v_district text;
  v_name text;
  v_active boolean;
begin
  select * into v_target from public.user_profiles where user_id = p_user_id for update;
  if not found then
    raise exception 'ไม่พบผู้ใช้นี้';
  end if;

  v_role := coalesce(nullif(btrim(p_patch ->> 'role'), ''), v_target.role::text);
  v_active := coalesce((p_patch ->> 'is_active')::boolean, v_target.is_active);
  v_name := case when p_patch ? 'display_name'
    then nullif(btrim(p_patch ->> 'display_name'), '') else v_target.display_name end;
  v_district := case
    when v_role <> 'district' then null
    when p_patch ? 'district_id' then nullif(btrim(p_patch ->> 'district_id'), '')
    else v_target.district_id
  end;

  if v_role not in ('admin', 'planner', 'district', 'viewer', 'academic', 'picker') then
    raise exception 'บทบาทไม่ถูกต้อง';
  end if;
  if v_name is not null and char_length(v_name) not between 2 and 120 then
    raise exception 'ชื่อต้องยาว 2–120 ตัวอักษร';
  end if;
  if (v_role = 'admin') <> (v_target.role = 'admin') then
    raise exception 'การให้หรือถอนสิทธิ์ผู้ดูแลระบบ (admin) ทำจากหน้านี้ไม่ได้';
  end if;
  if v_target.role = 'admin' and not v_active then
    raise exception 'ระงับบัญชีผู้ดูแลระบบจากหน้านี้ไม่ได้';
  end if;
  if p_user_id = v_actor and (v_role <> v_target.role::text or not v_active) then
    raise exception 'เปลี่ยนบทบาทหรือระงับบัญชีของตัวเองไม่ได้';
  end if;
  if v_role = 'district' and (v_district is null or v_district !~ '^55(0[1-9]|1[0-8])$') then
    raise exception 'บทบาทเขตต้องเลือกเขต 5501–5518';
  end if;

  update public.user_profiles
  set role = v_role::public.app_role,
      district_id = v_district,
      display_name = v_name,
      is_active = v_active
  where user_id = p_user_id
  returning * into v_target;

  return to_jsonb(v_target);
end;
$$;

-- ------------------------------------------------------------------
-- Review an access request
-- ------------------------------------------------------------------
create or replace function core.m20_review_access_request(p_request_id uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core, ops
as $$
declare
  v_actor uuid := auth.uid();
  v_request ops.access_requests%rowtype;
  v_decision text := lower(coalesce(p_body ->> 'decision', ''));
  v_note text := nullif(btrim(p_body ->> 'note'), '');
  v_role text;
  v_district text;
  v_name text;
  v_user_id uuid;
  v_user_role text;
begin
  select * into v_request from ops.access_requests where request_id = p_request_id for update;
  if not found then
    raise exception 'ไม่พบคำขอนี้';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'คำขอนี้ดำเนินการไปแล้ว (%)', v_request.status;
  end if;
  if v_decision not in ('approve', 'reject') then
    raise exception 'decision ต้องเป็น approve หรือ reject';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'หมายเหตุยาวเกิน 1000 ตัวอักษร';
  end if;

  if v_decision = 'reject' then
    if v_note is null then
      raise exception 'กรุณาระบุเหตุผลที่ไม่อนุมัติ';
    end if;
    update ops.access_requests
    set status = 'rejected', reviewed_at = now(), reviewed_by = v_actor, review_note = v_note
    where request_id = p_request_id
    returning * into v_request;
    return jsonb_build_object('status', v_request.status, 'applied', false);
  end if;

  v_role := coalesce(nullif(btrim(p_body ->> 'role'), ''), v_request.requested_role::text);
  v_district := case when v_role = 'district' then nullif(btrim(p_body ->> 'district_id'), '') end;
  v_name := coalesce(nullif(btrim(p_body ->> 'display_name'), ''), v_request.full_name);
  if v_role not in ('planner', 'district', 'viewer', 'academic', 'picker') then
    raise exception 'อนุมัติได้เฉพาะบทบาท planner / academic / picker / district / viewer';
  end if;
  if v_role = 'district' and (v_district is null or v_district !~ '^55(0[1-9]|1[0-8])$') then
    raise exception 'บทบาทเขตต้องเลือกเขต 5501–5518';
  end if;

  select u.id, p.role::text into v_user_id, v_user_role
  from auth.users u
  join public.user_profiles p on p.user_id = u.id
  where lower(to_jsonb(u) ->> 'email') = lower(v_request.work_email)
  limit 1;

  if v_user_role = 'admin' then
    raise exception 'อีเมลนี้เป็นบัญชีผู้ดูแลระบบอยู่แล้ว';
  end if;

  update ops.access_requests
  set status = 'approved',
      reviewed_at = now(),
      reviewed_by = v_actor,
      review_note = v_note,
      approved_role = v_role::public.app_role,
      approved_district_id = v_district,
      linked_user_id = v_user_id,
      applied_at = case when v_user_id is not null then now() end
  where request_id = p_request_id
  returning * into v_request;

  if v_user_id is not null then
    update public.user_profiles
    set role = v_role::public.app_role,
        district_id = v_district,
        display_name = v_name,
        is_active = true
    where user_id = v_user_id;
  end if;

  return jsonb_build_object(
    'status', v_request.status,
    'applied', v_user_id is not null,
    'user_id', v_user_id
  );
end;
$$;

revoke all on function core.m20_admin_users() from public, anon, authenticated;
revoke all on function core.m20_update_user(uuid, jsonb) from public, anon, authenticated;
revoke all on function core.m20_review_access_request(uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Dispatcher
-- ------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m20(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl_m20;
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
  v_role text;
  v_method text := upper(coalesce(p_method, ''));
begin
  if p_path = '/v1/admin/users'
     or p_path ~ '^/v1/admin/users/[0-9a-fA-F-]{36}$'
     or p_path ~ '^/v1/admin/access-requests/[0-9a-fA-F-]{36}/review$' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text into v_role
    from public.user_profiles
    where user_id = v_user_id and is_active;
    if coalesce(v_role, '') <> 'admin' then
      return public.m09_error(403, 'forbidden', 'Admin role is required', p_request_id);
    end if;

    if v_method = 'GET' and p_path = '/v1/admin/users' then
      return public.m09_result(200, core.m20_admin_users());
    end if;
    if v_method = 'POST' and p_path ~ '^/v1/admin/users/[0-9a-fA-F-]{36}$' then
      if jsonb_typeof(p_body) is distinct from 'object' then
        return public.m09_error(422, 'validation_error', 'body must be an object', p_request_id);
      end if;
      return public.m09_result(200, core.m20_update_user(
        split_part(p_path, '/', 5)::uuid, p_body));
    end if;
    if v_method = 'POST' and p_path ~ '^/v1/admin/access-requests/[0-9a-fA-F-]{36}/review$' then
      if jsonb_typeof(p_body) is distinct from 'object' then
        return public.m09_error(422, 'validation_error', 'body must be an object', p_request_id);
      end if;
      return public.m09_result(200, core.m20_review_access_request(
        split_part(p_path, '/', 5)::uuid, p_body));
    end if;
    return public.m09_error(405, 'method_not_allowed', 'Method not allowed', p_request_id);
  end if;

  return public.m09_dispatch_impl_m20(p_method, p_path, p_query, p_body, p_request_id);
exception
  when invalid_text_representation or numeric_value_out_of_range
    or invalid_datetime_format or datetime_field_overflow then
    return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated;

commit;

-- Post-check (read only)
select
  to_regprocedure('core.m20_admin_users()') is not null as users_ready,
  (select count(*) from public.user_profiles) as profiles,
  (select count(*) from ops.access_requests where status = 'pending') as pending_requests;
