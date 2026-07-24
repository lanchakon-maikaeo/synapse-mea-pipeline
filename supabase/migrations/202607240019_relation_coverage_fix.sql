-- SYNAPSE M19: relation coverage must count each source row once even when
-- that row has multiple typed relation edges.

begin;

create or replace view analytics.v_reference_relation_coverage
with (security_invoker = true)
as
select
  artifact.source_path,
  nullif(artifact.source_sheet, '') as source_sheet,
  artifact.data_class,
  count(distinct source_row.source_row_id)::bigint as source_rows,
  count(distinct edge.source_row_id)::bigint as linked_rows,
  count(edge.relation_edge_id)::bigint as relation_edges,
  count(distinct source_row.source_row_id)
    - count(distinct edge.source_row_id) as unlinked_rows
from reference_data.source_artifacts artifact
left join reference_data.source_rows source_row
  on source_row.artifact_id = artifact.artifact_id
left join reference_data.relation_edges edge
  on edge.source_row_id = source_row.source_row_id
group by
  artifact.source_path,
  artifact.source_sheet,
  artifact.data_class;

revoke all on analytics.v_reference_relation_coverage
  from public, anon, authenticated;
grant select on analytics.v_reference_relation_coverage
  to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607240019',
  'M19',
  'Correct relation coverage to count each source row once across multiple edges.',
  'supabase/migrations/202607240019_relation_coverage_fix.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
