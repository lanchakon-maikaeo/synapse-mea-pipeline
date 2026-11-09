-- M34: the public access-request form accepts at most 30 new requests per hour.
--
-- public.m15_submit_access_request is callable with the publishable anon key
-- and only de-duplicated by employee id / e-mail, so a script with random
-- values could add any number of pending requests to the admin queue.
-- A person who already has a pending request still gets it back as before;
-- only brand-new requests count toward the hourly limit.

begin;

CREATE OR REPLACE FUNCTION public.m15_submit_access_request(p_full_name text, p_employee_id text, p_work_email text, p_organization_unit text, p_requested_role text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- M34: the form is public; cap new requests so a script cannot flood the queue
  if (select count(*) from ops.access_requests
      where submitted_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('message',
      'มีคำขอเข้ามามากเกินไป กรุณาลองใหม่ในอีก 1 ชั่วโมง หรือติดต่อ Admin');
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
$function$;

commit;

notify pgrst, 'reload schema';
