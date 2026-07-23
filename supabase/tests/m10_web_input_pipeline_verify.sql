-- Read-only acceptance checks for governed Web input contracts.
select 'staging_table' as check_name,
       to_regclass('staging.vmi_input_rows') is not null as passed
union all
select 'submission_table' as check_name,
       to_regclass('ops.web_input_submissions') is not null as passed
union all
select 'publisher_function' as check_name,
       to_regprocedure('core.publish_vmi_web_input(jsonb)') is not null as passed
union all
select 'input_dispatch_function' as check_name,
       to_regprocedure('public.m10_input_dispatch(text,text,jsonb,jsonb,text)') is not null as passed
union all
select 'authenticated_dispatch_execute' as check_name,
       has_function_privilege('authenticated', 'public.m10_input_dispatch(text,text,jsonb,jsonb,text)', 'EXECUTE') as passed
union all
select 'anonymous_dispatch_blocked' as check_name,
       not has_function_privilege('anon', 'public.m10_input_dispatch(text,text,jsonb,jsonb,text)', 'EXECUTE') as passed
union all
select 'publisher_not_browser_callable' as check_name,
       not has_function_privilege('authenticated', 'core.publish_vmi_web_input(jsonb)', 'EXECUTE') as passed
union all
select 'staging_rls' as check_name,
       coalesce((select relrowsecurity from pg_class where oid='staging.vmi_input_rows'::regclass), false) as passed
union all
select 'submission_rls' as check_name,
       coalesce((select relrowsecurity from pg_class where oid='ops.web_input_submissions'::regclass), false) as passed
union all
select 'migration_registered' as check_name,
       exists (select 1 from ops.schema_migrations where version='202607160010') as passed;
