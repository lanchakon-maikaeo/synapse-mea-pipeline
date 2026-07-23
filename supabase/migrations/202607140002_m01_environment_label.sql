-- Align the environment registry with the requested project name test-synapse-mea.

begin;

insert into ops.environment_registry (
  environment_name,
  project_ref,
  region,
  deployment_profile,
  notes
)
values (
  'test',
  'mklnbumfwojxhqscthjd',
  'ap-northeast-1',
  'managed-supabase-free',
  'Managed test environment for SYNAPSE; project display name is test-synapse-mea.'
)
on conflict (environment_name) do update
set project_ref = excluded.project_ref,
    region = excluded.region,
    deployment_profile = excluded.deployment_profile,
    notes = excluded.notes,
    updated_at = now();

delete from ops.environment_registry
where environment_name = 'production'
  and project_ref = 'mklnbumfwojxhqscthjd';

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607140002',
  'M01',
  'Register project mklnbumfwojxhqscthjd as the test environment and align its display name.',
  'supabase/migrations/202607140002_m01_environment_label.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
