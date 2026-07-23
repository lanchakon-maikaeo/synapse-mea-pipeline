with checks as (
  select 'migration_registered' as check_name,
         exists(select 1 from ops.schema_migrations where version = '202607150009') as passed
  union all
  select 'dispatch_exists', to_regprocedure('public.m09_dispatch(text,text,jsonb,jsonb,text)') is not null
  union all
  select 'health_exists', to_regprocedure('public.m09_health()') is not null
  union all
  select 'rate_limit_table_exists', to_regclass('ops.api_rate_limit_windows') is not null
  union all
  select 'rate_limit_rls_enabled', exists(
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'ops' and c.relname = 'api_rate_limit_windows' and c.relrowsecurity
  )
  union all
  select 'anon_cannot_dispatch', not has_function_privilege('anon', 'public.m09_dispatch(text,text,jsonb,jsonb,text)', 'execute')
  union all
  select 'authenticated_can_dispatch', has_function_privilege('authenticated', 'public.m09_dispatch(text,text,jsonb,jsonb,text)', 'execute')
  union all
  select 'anon_health_allowed', has_function_privilege('anon', 'public.m09_health()', 'execute')
)
select check_name, passed from checks order by check_name;
