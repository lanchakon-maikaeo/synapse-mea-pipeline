-- Read-only acceptance checks for the real legacy-source import contract.
select 'material_staging' as check_name, to_regclass('staging.legacy_material_rows') is not null as passed
union all select 'stock_staging', to_regclass('staging.legacy_stock_rows') is not null
union all select 'usage_staging', to_regclass('staging.legacy_usage_rows') is not null
union all select 'source_control', to_regclass('ops.legacy_source_imports') is not null
union all select 'importer_function', to_regprocedure('public.m11_import_legacy_actual(text,text,jsonb,jsonb)') is not null
union all select 'dispatcher_function', to_regprocedure('public.m11_legacy_dispatch(text,text,jsonb,jsonb,text)') is not null
union all select 'authenticated_dispatch', has_function_privilege('authenticated','public.m11_legacy_dispatch(text,text,jsonb,jsonb,text)','EXECUTE')
union all select 'anonymous_dispatch_blocked', not has_function_privilege('anon','public.m11_legacy_dispatch(text,text,jsonb,jsonb,text)','EXECUTE')
union all select 'material_rls', coalesce((select relrowsecurity from pg_class where oid='staging.legacy_material_rows'::regclass),false)
union all select 'stock_rls', coalesce((select relrowsecurity from pg_class where oid='staging.legacy_stock_rows'::regclass),false)
union all select 'usage_rls', coalesce((select relrowsecurity from pg_class where oid='staging.legacy_usage_rows'::regclass),false)
union all select 'source_control_rls', coalesce((select relrowsecurity from pg_class where oid='ops.legacy_source_imports'::regclass),false)
union all select 'migration_registered', exists(select 1 from ops.schema_migrations where version='202607160011');
