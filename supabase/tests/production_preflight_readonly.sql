\set ON_ERROR_STOP on

select 'database' as check_name, current_database()::text as result
union all
select 'database_user', current_user::text
union all
select 'server_version', current_setting('server_version')
union all
select 'database_size', pg_size_pretty(pg_database_size(current_database()))
union all
select 'synapse_registry', coalesce(to_regclass('ops.schema_migrations')::text, 'absent')
union all
select 'environment_registry', coalesce(to_regclass('ops.environment_registry')::text, 'absent')
union all
select 'public_contracts', coalesce(to_regclass('public.contracts')::text, 'absent')
union all
select 'auth_users', count(*)::text from auth.users
union all
select 'non_system_tables', count(*)::text
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema not in ('pg_catalog', 'information_schema')
union all
select 'application_schemas', coalesce(string_agg(schema_name, ',' order by schema_name), 'absent')
from information_schema.schemata
where schema_name in (
  'raw',
  'staging',
  'core',
  'analytics',
  'ops',
  'audit',
  'reference_data'
);
