\set ON_ERROR_STOP on

-- Acceptance contract for 202610200001_source_file_import_history.sql.
-- Runs the full upload → stage → commit workflow twice for one source kind
-- and verifies history, missing-row handling, role gates and immutability.

begin;

create temporary table srcimp_checks (
  check_name text primary key,
  passed boolean not null
);

insert into auth.users (id, raw_user_meta_data)
values
  ('20000000-0000-4000-8000-000000000001', '{"display_name":"Import Admin"}'),
  ('20000000-0000-4000-8000-000000000002', '{"display_name":"Import Planner"}'),
  ('20000000-0000-4000-8000-000000000003', '{"display_name":"Import Viewer"}')
on conflict (id) do nothing;

update public.user_profiles set role = 'admin', district_id = null, is_active = true
where user_id = '20000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'planner', district_id = null, is_active = true
where user_id = '20000000-0000-4000-8000-000000000002';
update public.user_profiles set role = 'viewer', district_id = null, is_active = true
where user_id = '20000000-0000-4000-8000-000000000003';

create function pg_temp.call_as(p_user uuid, p_method text, p_path text, p_body jsonb default '{}'::jsonb,
  p_query jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  return public.srcimp_dispatch(p_method, p_path, p_query, p_body, 'srcimp-test');
end;
$$;

create temporary table srcimp_state (
  name text primary key,
  value jsonb
);

-- Run 1 (planner uploads, admin commits): three stock rows.
insert into srcimp_state
select 'run1', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST', '/v1/source-imports/runs',
  jsonb_build_object(
    'source_kind', 'stock', 'file_name', 'Stock.xlsx',
    'file_sha256', repeat('a', 64), 'file_size_bytes', 1000,
    'source_sheet', 'update-stock', 'expected_row_count', 3,
    'source_metadata', jsonb_build_object('snapshot_date', '2026-10-19')
  ));

insert into srcimp_state
select 'run1_rows', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run1') || '/rows',
  jsonb_build_object('rows', jsonb_build_array(
    jsonb_build_object('row_number', 2, 'payload', jsonb_build_object(
      'sap_plant_code', '5501', 'storage_location_code', '0001', 'material_id', '000000000001', 'unrestricted_qty', 10)),
    jsonb_build_object('row_number', 3, 'payload', jsonb_build_object(
      'sap_plant_code', '5501', 'storage_location_code', '0001', 'material_id', '000000000002', 'unrestricted_qty', 20)),
    jsonb_build_object('row_number', 4, 'payload', jsonb_build_object(
      'sap_plant_code', '5601', 'storage_location_code', '0001', 'material_id', '000000000001', 'unrestricted_qty', 30))
  )));

insert into srcimp_state
select 'run1_stage', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run1') || '/stage');

insert into srcimp_state
select 'run1_planner_commit', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run1') || '/commit');

insert into srcimp_state
select 'run1_commit', pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run1') || '/commit');

-- Run 2: row 1 unchanged, row 2 changed, row 3 absent (missing), row 4 new.
insert into srcimp_state
select 'run2', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST', '/v1/source-imports/runs',
  jsonb_build_object(
    'source_kind', 'stock', 'file_name', 'Stock.xlsx',
    'file_sha256', repeat('b', 64), 'expected_row_count', 3,
    'parser_warnings', jsonb_build_array('1 row has stock in transfer')
  ));

insert into srcimp_state
select 'run2_rows', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run2') || '/rows',
  jsonb_build_object('rows', jsonb_build_array(
    jsonb_build_object('row_number', 5, 'payload', jsonb_build_object(
      'sap_plant_code', '5501', 'storage_location_code', '0001', 'material_id', '000000000001', 'unrestricted_qty', 10)),
    jsonb_build_object('row_number', 2, 'payload', jsonb_build_object(
      'sap_plant_code', '5501', 'storage_location_code', '0001', 'material_id', '000000000002', 'unrestricted_qty', 25)),
    jsonb_build_object('row_number', 3, 'payload', jsonb_build_object(
      'sap_plant_code', '5701', 'storage_location_code', '0001', 'material_id', '000000000003', 'unrestricted_qty', 5))
  )));

insert into srcimp_state
select 'run2_stage', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run2') || '/stage');

insert into srcimp_state
select 'run2_changes', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'GET',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run2') || '/changes',
  '{}'::jsonb, '{"type":"changed"}'::jsonb);

insert into srcimp_state
select 'run2_commit_no_ack', pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run2') || '/commit');

insert into srcimp_state
select 'run2_commit', pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run2') || '/commit',
  '{"acknowledge_warnings": true}'::jsonb);

-- Duplicate key in one upload is rejected; viewer cannot use imports.
insert into srcimp_state
select 'dup_run', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST', '/v1/source-imports/runs',
  jsonb_build_object('source_kind', 'usage', 'file_name', 'usage.xlsx',
    'file_sha256', repeat('c', 64), 'expected_row_count', 2));
insert into srcimp_state
select 'dup_rows', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'dup_run') || '/rows',
  jsonb_build_object('rows', jsonb_build_array(
    jsonb_build_object('row_number', 2, 'payload', jsonb_build_object('material_id', '1', 'sap_plant_code', '5501')),
    jsonb_build_object('row_number', 3, 'payload', jsonb_build_object('material_id', '1', 'sap_plant_code', '5501'))
  )));
insert into srcimp_state
select 'viewer_list', pg_temp.call_as('20000000-0000-4000-8000-000000000003', 'GET', '/v1/source-imports/runs');
insert into srcimp_state
select 'current', pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'GET', '/v1/source-imports/current');
insert into srcimp_state
select 'current_rows', pg_temp.call_as('20000000-0000-4000-8000-000000000002', 'GET',
  '/v1/source-imports/current-rows', '{}'::jsonb, '{"source_kind":"stock"}'::jsonb);

-- Stale check: run 3 is staged, then run 4 commits first; run 3 must re-check.
insert into srcimp_state
select 'run3', pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST', '/v1/source-imports/runs',
  jsonb_build_object('source_kind', 'contracts', 'file_name', 'c.xlsx', 'file_sha256', repeat('d', 64), 'expected_row_count', 1));
insert into srcimp_state
select 'run4', pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST', '/v1/source-imports/runs',
  jsonb_build_object('source_kind', 'contracts', 'file_name', 'c2.xlsx', 'file_sha256', repeat('e', 64), 'expected_row_count', 1));
select pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = run) || '/rows',
  jsonb_build_object('rows', jsonb_build_array(jsonb_build_object('row_number', 2, 'payload',
    jsonb_build_object('material_code', '614507415400', 'purchase_order', '1400004829', 'line_item', '0001', 'quantity', '10')))))
from unnest(array['run3', 'run4']) run;
select pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = run) || '/stage')
from unnest(array['run3', 'run4']) run;
insert into srcimp_state
select 'run4_commit', pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run4') || '/commit');
insert into srcimp_state
select 'run3_commit', pg_temp.call_as('20000000-0000-4000-8000-000000000001', 'POST',
  '/v1/source-imports/runs/' || (select value #>> '{body,import_run_id}' from srcimp_state where name = 'run3') || '/commit');

create temporary view srcimp_v as select name, value from srcimp_state;

insert into srcimp_checks (check_name, passed)
select 'migration_registered',
  exists (select 1 from ops.schema_migrations where version = '202610200001')
union all
select 'dispatch_granted_to_authenticated_only',
  has_function_privilege('authenticated', 'public.srcimp_dispatch(text,text,jsonb,jsonb,text)', 'execute')
  and not has_function_privilege('anon', 'public.srcimp_dispatch(text,text,jsonb,jsonb,text)', 'execute')
union all
select 'tables_not_directly_readable',
  not has_table_privilege('authenticated', 'ops.source_current_rows', 'select')
  and not has_table_privilege('authenticated', 'ops.source_row_versions', 'select')
  and not has_table_privilege('anon', 'ops.source_import_runs', 'select')
union all
select 'run1_created_by_planner', (select (value ->> 'status')::int = 201 from srcimp_v where name = 'run1')
union all
select 'run1_staged_all_new',
  (select value #>> '{body,summary,new}' = '3' and value #>> '{body,status}' = 'staged' from srcimp_v where name = 'run1_stage')
union all
select 'planner_cannot_commit', (select (value ->> 'status')::int = 403 from srcimp_v where name = 'run1_planner_commit')
union all
select 'admin_commits_run1', (select value #>> '{body,status}' = 'committed' from srcimp_v where name = 'run1_commit')
union all
select 'run2_diff_summary',
  (select value #>> '{body,summary,unchanged}' = '1'
      and value #>> '{body,summary,changed}' = '1'
      and value #>> '{body,summary,new}' = '1'
      and value #>> '{body,summary,missing}' = '1'
   from srcimp_v where name = 'run2_stage')
union all
select 'run2_changes_show_before_after',
  (select value #>> '{body,rows,0,before,unrestricted_qty}' = '20'
      and value #>> '{body,rows,0,after,unrestricted_qty}' = '25'
   from srcimp_v where name = 'run2_changes')
union all
select 'warnings_require_acknowledgement',
  (select (value ->> 'status')::int = 422 from srcimp_v where name = 'run2_commit_no_ack')
union all
select 'admin_commits_run2', (select value #>> '{body,status}' = 'committed' from srcimp_v where name = 'run2_commit')
union all
select 'current_rows_updated',
  (select payload ->> 'unrestricted_qty' = '25' from ops.source_current_rows
   where source_kind = 'stock' and business_key = '5501|0001|000000000002')
union all
select 'missing_row_flagged_not_deleted',
  exists (select 1 from ops.source_current_rows
          where source_kind = 'stock' and business_key = '5601|0001|000000000001'
            and missing_since_run_id is not null)
union all
select 'history_versions_written',
  (select count(*) = 3 from ops.source_row_versions v
   join ops.source_import_runs r using (import_run_id)
   where r.file_sha256 = repeat('a', 64) and v.change_type = 'new')
  and (select array_agg(change_type order by change_type) = array['changed', 'missing', 'new']
       from ops.source_row_versions v
       join ops.source_import_runs r using (import_run_id)
       where r.file_sha256 = repeat('b', 64))
union all
select 'staging_rows_released_after_commit',
  not exists (select 1 from ops.source_import_staging_rows s
              join ops.source_import_runs r using (import_run_id)
              where r.status = 'committed')
union all
select 'duplicate_business_key_rejected',
  (select (value ->> 'status')::int = 422 from srcimp_v where name = 'dup_rows')
union all
select 'viewer_forbidden', (select (value ->> 'status')::int = 403 from srcimp_v where name = 'viewer_list')
union all
select 'current_summary_counts',
  (select value #>> '{body,stock,accepted_rows}' = '3'
      and value #>> '{body,stock,missing_rows}' = '1' from srcimp_v where name = 'current')
union all
select 'current_rows_exclude_missing',
  (select value #>> '{body,total}' = '3'
      and jsonb_array_length(value #> '{body,rows}') = 3
      and not exists (select 1 from jsonb_array_elements(value #> '{body,rows}') r
                      where r ->> 'sap_plant_code' = '5601')
   from srcimp_v where name = 'current_rows')
union all
select 'stale_run_must_recheck',
  (select value #>> '{body,status}' = 'committed' from srcimp_v where name = 'run4_commit')
  and (select (value ->> 'status')::int = 409 from srcimp_v where name = 'run3_commit');

-- Immutability: versions are append-only and committed runs are final.
do $$
begin
  begin
    update ops.source_row_versions set change_type = change_type;
    insert into srcimp_checks values ('versions_append_only', false);
  exception when others then
    insert into srcimp_checks values ('versions_append_only', true);
  end;
  begin
    update ops.source_import_runs set summary = '{}'::jsonb where status = 'committed';
    insert into srcimp_checks values ('committed_runs_final', not found);
  exception when others then
    insert into srcimp_checks values ('committed_runs_final', true);
  end;
  begin
    delete from ops.source_import_runs;
    insert into srcimp_checks values ('runs_not_deletable', false);
  exception when others then
    insert into srcimp_checks values ('runs_not_deletable', true);
  end;
end
$$;

table srcimp_checks;

do $$
begin
  if exists (select 1 from srcimp_checks where not passed) then
    raise exception 'Source file import contract failed: %',
      (select string_agg(check_name, ', ') from srcimp_checks where not passed);
  end if;
end
$$;

rollback;
