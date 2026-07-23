-- Read-only verification for SYNAPSE M01.
-- Expected result: every row has passed = true.

with checks as (
  select 'required_schemas_exist' as check_name,
         count(*) = 7 as passed,
         count(*)::text || '/7 schemas' as detail
  from information_schema.schemata
  where schema_name in ('raw', 'staging', 'core', 'analytics', 'rag', 'ops', 'audit')

  union all

  select 'contracts_row_count_preserved',
         count(*) = 6305,
         count(*)::text || ' rows'
  from public.contracts

  union all

  select 'contracts_source_trace_complete',
         count(*) filter (where source_batch_id is null or source_checksum is null) = 0,
         count(*) filter (where source_batch_id is null or source_checksum is null)::text || ' missing links'
  from public.contracts

  union all

  select 'contracts_rls_enabled',
         c.relrowsecurity,
         'relrowsecurity=' || c.relrowsecurity::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'contracts'

  union all

  select 'contracts_policies_installed',
         count(*) = 4,
         count(*)::text || '/4 policies'
  from pg_policies
  where schemaname = 'public' and tablename = 'contracts'

  union all

  select 'profiles_rls_enabled',
         c.relrowsecurity,
         'relrowsecurity=' || c.relrowsecurity::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'user_profiles'

  union all

  select 'anon_has_no_contract_access',
         not (
           has_table_privilege('anon', 'public.contracts', 'select')
           or has_table_privilege('anon', 'public.contracts', 'insert')
           or has_table_privilege('anon', 'public.contracts', 'update')
           or has_table_privilege('anon', 'public.contracts', 'delete')
         ),
         'anon privileges removed'

  union all

  select 'baseline_batch_reconciled',
         count(*) = 1 and max(row_count) = 6305 and bool_and(status = 'succeeded'),
         count(*)::text || ' matching batch'
  from raw.import_batches
  where source_checksum = '8ea7b0e712726e6cc1990f33b0031be231a91cc01fb4f8d96e6146d83e3cf9dd'

  union all

  select 'test_environment_registered',
         count(*) = 1 and max(project_ref) = 'mklnbumfwojxhqscthjd',
         count(*)::text || ' matching environment'
  from ops.environment_registry
  where environment_name = 'test'
)
select check_name, passed, detail
from checks
order by check_name;
