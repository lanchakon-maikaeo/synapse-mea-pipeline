do $$
declare
  failure_count integer;
begin
  select count(*) into failure_count
  from (
    select to_regclass('reference_data.source_artifacts') is null
    union all
    select to_regclass('reference_data.source_rows') is null
    union all
    select to_regclass('reference_data.relation_edges') is null
    union all
    select to_regclass('analytics.v_source_artifact_inventory') is null
    union all
    select to_regclass('analytics.v_reference_relation_coverage') is null
    union all
    select to_regprocedure(
      'public.m18_import_source_rows(text,text,text,bigint,text,jsonb,jsonb)'
    ) is null
    union all
    select to_regprocedure(
      'public.m18_import_contract_chunk(text,bigint,jsonb,jsonb)'
    ) is null
    union all
    select to_regprocedure('public.m18_finalize_contract_import(text)') is null
    union all
    select to_regprocedure('public.m18_rebuild_reference_relations()') is null
  ) checks(failed)
  where failed;

  if failure_count > 0 then
    raise exception 'M18 relational source contract failed: % checks', failure_count;
  end if;
end
$$;

select 'M18 relational source contract passed' as result;
