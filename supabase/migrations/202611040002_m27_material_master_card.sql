-- M27: Material Master card in Import Center.
--
-- The weekly calculation only covers materials flagged VMI in core.materials,
-- and until now that list could only change through the July setup import.
-- New source kind "materials": one row per material from the MASTER sheet
-- (รหัส / InventoryName / UNIT / กลุ่ม ...) with is_vmi = listed in the
-- "VMI คลองเตย" sheet of the same workbook.
--
-- When an admin confirms a materials file (Import Center commit), the rows are
-- applied to core.materials in the same transaction:
--   * new codes are added, names / units / categories are updated
--   * is_vmi follows the file: listed → true; every other material → false
--   * lot size, weight, MOQ and packaging are left as they are

begin;

alter table ops.source_import_runs drop constraint if exists source_import_runs_source_kind_check;
alter table ops.source_import_runs add constraint source_import_runs_source_kind_check
  check (source_kind in ('stock', 'district_stock', 'contracts', 'receipts_105', 'usage', 'materials'));
alter table ops.source_current_rows drop constraint if exists source_current_rows_source_kind_check;
alter table ops.source_current_rows add constraint source_current_rows_source_kind_check
  check (source_kind in ('stock', 'district_stock', 'contracts', 'receipts_105', 'usage', 'materials'));

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('ops.srcimp_business_key(text,jsonb)'::regprocedure);
  if position('''materials''' in v_def) = 0 then
    v_new := replace(v_def, $q$    when 'usage' then$q$,
      $q$    when 'materials' then
      v_parts := array[p_payload ->> 'material_id'];
    when 'usage' then$q$);
    v_new := replace(v_new, $q$p_kind in ('stock', 'district_stock', 'usage')$q$,
      $q$p_kind in ('stock', 'district_stock', 'usage', 'materials')$q$);
    if length(v_new) - length(v_def) <> 92 then
      raise exception 'M27: srcimp_business_key did not match the expected text (%)', length(v_new) - length(v_def);
    end if;
    execute v_new;
  end if;

  v_def := pg_get_functiondef('public.srcimp_dispatch(text,text,jsonb,jsonb,text)'::regprocedure);
  if position('''materials''' in v_def) = 0 then
    v_new := replace(v_def, $q$'stock', 'district_stock', 'contracts', 'receipts_105', 'usage'$q$,
      $q$'stock', 'district_stock', 'contracts', 'receipts_105', 'usage', 'materials'$q$);
    if length(v_new) - length(v_def) <> 3 * 13 then
      raise exception 'M27: srcimp_dispatch did not match the expected text (%)', length(v_new) - length(v_def);
    end if;
    execute v_new;
  end if;
end
$$;

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
begin
  select * into v_run from ops.source_import_runs where import_run_id = p_run_id;
  if v_run.source_kind is distinct from 'materials' then
    raise exception 'M27: run % is not a materials file', p_run_id;
  end if;

  select count(*) into v_vmi from ops.source_current_rows
  where source_kind = 'materials' and missing_since_run_id is null and (payload ->> 'is_vmi')::boolean;
  if v_vmi = 0 then
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
    coalesce((payload ->> 'is_vmi')::boolean, false) as is_vmi
  from ops.source_current_rows
  where source_kind = 'materials' and missing_since_run_id is null
    and payload ->> 'material_id' ~ '^\d{12}$';

  select count(*) into v_vmi_on from core.materials m join m27_rows r using (material_id)
  where r.is_vmi and not m.is_vmi;
  select count(*) into v_vmi_off from core.materials m
  where m.is_vmi and not exists (select 1 from m27_rows r where r.material_id = m.material_id and r.is_vmi);

  insert into core.materials (material_id, sap_material_id, material_name, category, unit, is_vmi,
    master_source, data_quality_status, source_batch_id)
  select r.material_id, r.material_id, r.material_name, r.category, r.unit, r.is_vmi,
    'material_master', 'valid', v_batch
  from m27_rows r
  where not exists (select 1 from core.materials m where m.material_id = r.material_id);
  get diagnostics v_added = row_count;

  update core.materials m
  set material_name = coalesce(r.material_name, m.material_name),
      unit = coalesce(r.unit, m.unit),
      category = coalesce(r.category, m.category),
      is_vmi = r.is_vmi,
      master_source = 'material_master',
      source_batch_id = v_batch,
      updated_at = now()
  from m27_rows r
  where r.material_id = m.material_id
    and (m.material_name is distinct from coalesce(r.material_name, m.material_name)
      or m.unit is distinct from coalesce(r.unit, m.unit)
      or m.category is distinct from coalesce(r.category, m.category)
      or m.is_vmi is distinct from r.is_vmi);
  get diagnostics v_updated = row_count;

  update core.materials m
  set is_vmi = false, updated_at = now()
  where m.is_vmi and not exists (select 1 from m27_rows r where r.material_id = m.material_id);

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'vmi', v_vmi,
    'vmi_turned_on', v_vmi_on, 'vmi_turned_off', v_vmi_off);
end;
$$;

revoke all on function core.m27_apply_material_master(uuid) from public, anon, authenticated;

create or replace function core.m27_on_materials_commit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
begin
  perform core.m27_apply_material_master(new.import_run_id);
  return null;
end;
$$;

revoke all on function core.m27_on_materials_commit() from public, anon, authenticated;

drop trigger if exists m27_apply_materials_on_commit on ops.source_import_runs;
create trigger m27_apply_materials_on_commit
  after update of status on ops.source_import_runs
  for each row
  when (new.source_kind = 'materials' and new.status = 'committed' and old.status is distinct from 'committed')
  execute function core.m27_on_materials_commit();

commit;

select count(*) filter (where is_vmi) as vmi_materials, count(*) as materials from core.materials;
