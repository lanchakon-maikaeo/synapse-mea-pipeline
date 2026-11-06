-- M27b: Material Master card also takes the full "Master material" list.
-- 1. A materials file without a VMI sheet only adds codes and updates names /
--    units; VMI flags are left as they are. A file whose VMI sheet is empty is
--    still refused.
-- 2. Import Center requests (srcimp_dispatch) get 60 s like m09_dispatch: the
--    full Master material list has ~39,000 rows.

begin;

alter function public.srcimp_dispatch(text, text, jsonb, jsonb, text) set statement_timeout = '60s';

create or replace function core.m27_apply_material_master(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops, raw
as $$
declare
  v_run ops.source_import_runs;
  v_batch uuid;
  v_vmi integer;
  v_added integer;
  v_updated integer;
  v_vmi_on integer;
  v_vmi_off integer;
  v_has_vmi boolean;
begin
  select * into v_run from ops.source_import_runs where import_run_id = p_run_id;
  if v_run.source_kind is distinct from 'materials' then
    raise exception 'M27: run % is not a materials file', p_run_id;
  end if;

  -- A file without a VMI sheet (e.g. the full Master material list) only adds
  -- codes and updates names / units; VMI flags stay as they are.
  select exists (select 1 from ops.source_current_rows
    where source_kind = 'materials' and missing_since_run_id is null and payload ? 'is_vmi'
      and jsonb_typeof(payload -> 'is_vmi') = 'boolean')
  into v_has_vmi;
  select count(*) into v_vmi from ops.source_current_rows
  where source_kind = 'materials' and missing_since_run_id is null
    and jsonb_typeof(payload -> 'is_vmi') = 'boolean' and (payload ->> 'is_vmi')::boolean;
  if v_has_vmi and v_vmi = 0 then
    raise exception 'ไฟล์ Material Master ไม่มีรายการ VMI (ชีท VMI คลองเตย) ระบบจะไม่ปิด VMI ทั้งหมด';
  end if;

  insert into raw.import_batches (source_system, source_file, source_sheet, source_checksum, source_file_size_bytes,
    row_count, status, imported_at, started_at, finished_at, metadata, connector_name, source_entity)
  values ('import_center', v_run.file_name, 'import-center:materials', v_run.file_sha256, v_run.file_size_bytes,
    coalesce(v_run.expected_row_count, 0), 'succeeded', now(), now(), now(),
    jsonb_build_object('import_run_id', v_run.import_run_id), 'import_center', 'materials')
  on conflict (source_checksum, source_sheet) do update set updated_at = now()
  returning batch_id into v_batch;

  drop table if exists pg_temp.m27_rows;
  create temporary table m27_rows on commit drop as
  select
    payload ->> 'material_id' as material_id,
    nullif(btrim(payload ->> 'material_name'), '') as material_name,
    nullif(btrim(payload ->> 'unit'), '') as unit,
    nullif(btrim(payload ->> 'category'), '') as category,
    case when jsonb_typeof(payload -> 'is_vmi') = 'boolean' then (payload ->> 'is_vmi')::boolean end as is_vmi
  from ops.source_current_rows
  where source_kind = 'materials' and missing_since_run_id is null
    and payload ->> 'material_id' ~ '^\d{12}$';

  select count(*) into v_vmi_on from core.materials m join m27_rows r using (material_id)
  where v_has_vmi and r.is_vmi and not m.is_vmi;
  select count(*) into v_vmi_off from core.materials m
  where v_has_vmi and m.is_vmi
    and not exists (select 1 from m27_rows r where r.material_id = m.material_id and r.is_vmi);

  insert into core.materials (material_id, sap_material_id, material_name, category, unit, is_vmi,
    master_source, data_quality_status, source_batch_id)
  select r.material_id, r.material_id, r.material_name, r.category, r.unit, coalesce(r.is_vmi, false),
    'material_master', 'valid', v_batch
  from m27_rows r
  where not exists (select 1 from core.materials m where m.material_id = r.material_id);
  get diagnostics v_added = row_count;

  update core.materials m
  set material_name = coalesce(r.material_name, m.material_name),
      unit = coalesce(r.unit, m.unit),
      category = coalesce(r.category, m.category),
      is_vmi = case when v_has_vmi then coalesce(r.is_vmi, false) else m.is_vmi end,
      master_source = 'material_master',
      source_batch_id = v_batch,
      updated_at = now()
  from m27_rows r
  where r.material_id = m.material_id
    and (m.material_name is distinct from coalesce(r.material_name, m.material_name)
      or m.unit is distinct from coalesce(r.unit, m.unit)
      or m.category is distinct from coalesce(r.category, m.category)
      or (v_has_vmi and m.is_vmi is distinct from coalesce(r.is_vmi, false)));
  get diagnostics v_updated = row_count;

  if v_has_vmi then
    update core.materials m
    set is_vmi = false, updated_at = now()
    where m.is_vmi and not exists (select 1 from m27_rows r where r.material_id = m.material_id);
  end if;

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'vmi', v_vmi, 'vmi_from_file', v_has_vmi,
    'vmi_turned_on', v_vmi_on, 'vmi_turned_off', v_vmi_off);
end;
$$;

revoke all on function core.m27_apply_material_master(uuid) from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';
