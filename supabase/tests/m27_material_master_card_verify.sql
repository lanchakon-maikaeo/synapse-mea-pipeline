\set ON_ERROR_STOP on

-- M27: Material Master card — confirming a materials file adds codes and updates names / units in core.materials.
begin;

create temporary table m27_checks (check_name text primary key, passed boolean not null);
create temporary table m27_state (k text primary key, v jsonb);
grant select, insert, update on m27_checks, m27_state to authenticated;

insert into auth.users (id, raw_user_meta_data) values ('27000000-0000-4000-8000-000000000001', '{"display_name":"M27 Admin"}');
update public.user_profiles set role = 'admin' where user_id = '27000000-0000-4000-8000-000000000001';

insert into raw.import_batches (batch_id, source_system, source_file, source_sheet, source_checksum, row_count, status, imported_at, metadata)
values ('27000000-0000-4000-8000-000000000010', 'm27-test', 'm27.csv', 'm27', repeat('7', 64), 1, 'succeeded', now(), '{}');
insert into core.materials (material_id, sap_material_id, material_name, unit, lot_size, is_vmi, master_source, data_quality_status, source_batch_id) values
  ('270000000001', '270000000001', 'old name', 'EA', 100, false, 'material_master', 'valid', '27000000-0000-4000-8000-000000000010'),
  ('270000000002', '270000000002', 'stays VMI?', 'EA', null, true, 'material_master', 'valid', '27000000-0000-4000-8000-000000000010');

create function pg_temp.api(p_method text, p_path text, p_body jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000001', true);
  return public.srcimp_dispatch(p_method, p_path, '{}'::jsonb, p_body, 'm27');
end;
$$;

insert into m27_checks select 'business key is the material code',
  ops.srcimp_business_key('materials', '{"material_id":"270000000001"}') = '270000000001';

set local role authenticated;
insert into m27_state values ('run', pg_temp.api('POST', '/v1/source-imports/runs', jsonb_build_object(
  'source_kind', 'materials', 'file_name', 'คลังคลองเตย.xlsx', 'file_sha256', repeat('c', 64),
  'file_size_bytes', 100, 'source_sheet', 'MASTER', 'expected_row_count', 3)));
insert into m27_state values ('rows', pg_temp.api('POST',
  '/v1/source-imports/runs/' || (select v #>> '{body,import_run_id}' from m27_state where k = 'run') || '/rows',
  jsonb_build_object('rows', jsonb_build_array(
    jsonb_build_object('row_number', 2, 'payload', jsonb_build_object('material_id', '270000000001',
      'material_name', 'CLAMP NEW', 'unit', 'EA', 'category', 'POLE LINE', 'is_vmi', true)),
    jsonb_build_object('row_number', 3, 'payload', jsonb_build_object('material_id', '270000000003',
      'material_name', 'NEW VMI ITEM', 'unit', 'M', 'category', 'CABLE', 'is_vmi', true)),
    jsonb_build_object('row_number', 4, 'payload', jsonb_build_object('material_id', '270000000004',
      'material_name', 'MASTER ONLY', 'unit', 'EA', 'is_vmi', false))))));
insert into m27_state values ('stage', pg_temp.api('POST',
  '/v1/source-imports/runs/' || (select v #>> '{body,import_run_id}' from m27_state where k = 'run') || '/stage'));
insert into m27_state values ('commit', pg_temp.api('POST',
  '/v1/source-imports/runs/' || (select v #>> '{body,import_run_id}' from m27_state where k = 'run') || '/commit',
  '{"acknowledge_warnings":true}'));
insert into m27_state values ('current', pg_temp.api('GET', '/v1/source-imports/current'));
reset role;

insert into m27_checks select 'run created, staged and committed',
  (select (v ->> 'status')::int from m27_state where k = 'run') = 201
  and (select v #>> '{body,status}' from m27_state where k = 'commit') = 'committed';
-- Since M28 the VMI list comes from the Stock คลังคลองเตย file; a materials
-- file (with or without a VMI sheet) only adds codes and updates names / units.
insert into m27_checks select 'existing material renamed, VMI and lot size kept',
  material_name = 'CLAMP NEW' and category = 'POLE LINE' and not is_vmi and lot_size = 100
from core.materials where material_id = '270000000001';
insert into m27_checks select 'new material added without VMI',
  material_name = 'NEW VMI ITEM' and unit = 'M' and not is_vmi and master_source = 'material_master'
from core.materials where material_id = '270000000003';
insert into m27_checks select 'master-only material added without VMI',
  not is_vmi from core.materials where material_id = '270000000004';
insert into m27_checks select 'VMI not in the file is kept',
  is_vmi from core.materials where material_id = '270000000002';
insert into m27_checks select 'current lists the materials card',
  (v #>> '{body,materials,accepted_rows}')::int = 3 from m27_state where k = 'current';

-- A Master material list without the VMI sheet: names update, VMI flags stay
update ops.source_current_rows set payload = (payload - 'is_vmi') || '{"material_name":"CLAMP RENAMED"}'
where source_kind = 'materials' and business_key = '270000000001';
update ops.source_current_rows set payload = payload - 'is_vmi'
where source_kind = 'materials' and business_key <> '270000000001';
select core.m27_apply_material_master((select import_run_id from ops.source_import_runs where source_kind = 'materials' limit 1));
insert into m27_checks select 'list without VMI sheet keeps VMI flags',
  (select material_name = 'CLAMP RENAMED' and not is_vmi from core.materials where material_id = '270000000001')
  and (select is_vmi from core.materials where material_id = '270000000002');

do $$
declare v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed from m27_checks where not passed;
  if v_failed is not null then raise exception 'M27 checks failed: %', v_failed; end if;
  if (select count(*) from m27_checks) <> 8 then raise exception 'M27: expected 8 checks, got %', (select count(*) from m27_checks); end if;
end
$$;

select check_name, passed from m27_checks order by check_name;
rollback;
