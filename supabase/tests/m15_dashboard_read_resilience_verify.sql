\set ON_ERROR_STOP on

select
  'migration_registered' as check_name,
  exists (
    select 1
    from ops.schema_migrations
    where version = '202607230015'
  ) as passed
union all
select
  'dispatcher_wrapper_exists',
  to_regprocedure(
    'public.m09_dispatch(text,text,jsonb,jsonb,text)'
  ) is not null
union all
select
  'v14_dispatcher_is_protected',
  not has_function_privilege(
    'authenticated',
    'public.m09_dispatch_v14(text,text,jsonb,jsonb,text)',
    'execute'
  )
union all
select
  'authenticated_uses_bounded_dispatcher',
  has_function_privilege(
    'authenticated',
    'public.m09_dispatch(text,text,jsonb,jsonb,text)',
    'execute'
  );
