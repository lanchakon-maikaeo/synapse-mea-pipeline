-- Bound the largest dashboard read payload and preserve the v14 dispatcher as
-- a protected implementation detail. This keeps the production UI responsive
-- while retaining role and district scope.

begin;

alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
  rename to m09_dispatch_v14;

revoke all on function public.m09_dispatch_v14(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;

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
set search_path = pg_catalog, public, core, analytics, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_district_id text;
  v_limit integer;
  v_offset integer;
  v_count integer;
  v_payload jsonb;
begin
  if upper(coalesce(p_method, '')) = 'GET'
     and p_path = '/v1/stock-health' then
    if v_user_id is null then
      return public.m09_error(
        401,
        'unauthorized',
        'Missing or invalid bearer token',
        p_request_id
      );
    end if;

    select role::text, district_id
    into v_role, v_district_id
    from public.user_profiles
    where user_id = v_user_id
      and is_active;
    if v_role is null then
      return public.m09_error(
        403,
        'forbidden',
        'No active application role is assigned',
        p_request_id
      );
    end if;

    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 250);
    v_offset := coalesce(nullif(p_query ->> 'offset', '')::integer, 0);
    if v_limit not between 1 and 500 or v_offset < 0 then
      return public.m09_error(
        422,
        'validation_error',
        'Invalid limit or offset',
        p_request_id
      );
    end if;

    insert into ops.api_rate_limit_windows (
      user_id,
      window_start,
      request_count
    )
    values (
      v_user_id,
      date_trunc('minute', clock_timestamp()),
      1
    )
    on conflict (user_id, window_start) do update
    set request_count = ops.api_rate_limit_windows.request_count + 1,
        updated_at = now()
    returning request_count into v_count;
    if v_count > 120 then
      return public.m09_error(
        429,
        'rate_limited',
        'Too many requests',
        p_request_id
      );
    end if;

    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select *
      from analytics.v_stock_health
      where v_role <> 'district'
         or district_id = v_district_id
      order by months_available nulls last, district_id, material_id
      limit v_limit
      offset v_offset
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  return public.m09_dispatch_v14(
    p_method,
    p_path,
    p_query,
    p_body,
    p_request_id
  );
exception
  when invalid_text_representation
    or datetime_field_overflow
    or numeric_value_out_of_range then
    return public.m09_error(
      422,
      'validation_error',
      'Request contains an invalid value',
      p_request_id
    );
  when others then
    return public.m09_error(
      400,
      'bad_request',
      left(sqlerrm, 500),
      p_request_id
    );
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607230015',
  'M09',
  'Paginated stock-health API for resilient production dashboard reads.',
  'supabase/migrations/202607230015_dashboard_read_resilience.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
