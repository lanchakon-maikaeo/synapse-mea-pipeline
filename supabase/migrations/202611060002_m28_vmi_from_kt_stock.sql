-- M28: the VMI list (materials Khlong Toei calculates for the districts) is
-- the set of materials in the latest Stock คลังคลองเตย file (plant 2401) in
-- Import Center. The separate "VMI คลองเตย" sheet is no longer used.
--
--   * on every confirmed Stock คลังคลองเตย file: materials in the file → is_vmi,
--     every other material → not VMI; codes missing from Material Master are
--     added with the name and unit from the Stock file
--   * the Material Master card only adds codes and updates names / units
--   * runs once now on the Stock file already in the system

begin;

create or replace function core.m28_sync_vmi_from_kt_stock()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops, raw
as $$
declare
  v_run ops.source_import_runs;
  v_batch uuid;
  v_codes integer;
  v_added integer := 0;
  v_on integer;
  v_off integer;
begin
  drop table if exists pg_temp.m28_kt;
  create temporary table m28_kt on commit drop as
  select right(regexp_replace(payload ->> 'material_id', '\D', '', 'g'), 12) as material_id,
    max(nullif(btrim(payload ->> 'material_name'), '')) as material_name,
    max(nullif(btrim(payload ->> 'base_unit'), '')) as unit
  from ops.source_current_rows
  where source_kind = 'stock' and missing_since_run_id is null
    and payload ->> 'warehouse_id' = 'WH-KT'
    and right(regexp_replace(payload ->> 'material_id', '\D', '', 'g'), 12) ~ '^\d{12}$'
  group by 1;

  select count(*) into v_codes from m28_kt;
  if v_codes = 0 then
    -- No Khlong Toei stock file yet: leave the VMI list as it is
    return jsonb_build_object('synced', false, 'reason', 'no Stock คลังคลองเตย rows');
  end if;

  -- A cut-down Stock file would switch most of the list off: refuse it
  if (select count(*) from core.materials where is_vmi) >= 40
     and v_codes * 2 < (select count(*) from core.materials where is_vmi) then
    raise exception 'ไฟล์ Stock คลังคลองเตยมี % รหัส น้อยกว่าครึ่งของรายการ VMI ปัจจุบัน (% รหัส) · ต้องเป็นไฟล์เต็มจาก SAP (โรงงาน 2401) จึงจะใช้กำหนดรายการ VMI ได้',
      v_codes, (select count(*) from core.materials where is_vmi);
  end if;

  if exists (select 1 from m28_kt k where not exists (select 1 from core.materials m where m.material_id = k.material_id)) then
    select * into v_run from ops.source_import_runs
    where source_kind = 'stock' and status = 'committed'
    order by committed_at desc limit 1;
    insert into raw.import_batches (source_system, source_file, source_sheet, source_checksum, source_file_size_bytes,
      row_count, status, imported_at, started_at, finished_at, metadata, connector_name, source_entity)
    values ('import_center', coalesce(v_run.file_name, 'Stock คลังคลองเตย'), 'import-center:stock-vmi',
      coalesce(v_run.file_sha256, md5(now()::text) || md5(now()::text)), v_run.file_size_bytes,
      v_codes, 'succeeded', now(), now(), now(),
      jsonb_build_object('import_run_id', v_run.import_run_id), 'import_center', 'materials')
    on conflict (source_checksum, source_sheet) do update set updated_at = now()
    returning batch_id into v_batch;

    insert into core.materials (material_id, sap_material_id, material_name, unit, is_vmi,
      master_source, data_quality_status, source_batch_id)
    select k.material_id, k.material_id, k.material_name, k.unit, true, 'material_master', 'valid', v_batch
    from m28_kt k
    where not exists (select 1 from core.materials m where m.material_id = k.material_id);
    get diagnostics v_added = row_count;
  end if;

  update core.materials m set is_vmi = true, updated_at = now()
  where not m.is_vmi and exists (select 1 from m28_kt k where k.material_id = m.material_id);
  get diagnostics v_on = row_count;
  update core.materials m set is_vmi = false, updated_at = now()
  where m.is_vmi and not exists (select 1 from m28_kt k where k.material_id = m.material_id);
  get diagnostics v_off = row_count;

  return jsonb_build_object('synced', true, 'vmi', v_codes, 'added', v_added,
    'turned_on', v_on, 'turned_off', v_off);
end;
$$;

revoke all on function core.m28_sync_vmi_from_kt_stock() from public, anon, authenticated;

create or replace function core.m28_on_stock_commit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
begin
  perform core.m28_sync_vmi_from_kt_stock();
  return null;
end;
$$;

revoke all on function core.m28_on_stock_commit() from public, anon, authenticated;

drop trigger if exists m28_vmi_on_stock_commit on ops.source_import_runs;
create trigger m28_vmi_on_stock_commit
  after update of status on ops.source_import_runs
  for each row
  when (new.source_kind = 'stock' and new.status = 'committed' and old.status is distinct from 'committed')
  execute function core.m28_on_stock_commit();

-- Material Master card: names / units only, never the VMI flag
do $$
declare
  v_def text := pg_get_functiondef('core.m27_apply_material_master(uuid)'::regprocedure);
  v_new text;
begin
  if position('M28: VMI comes from' in v_def) = 0 then
    v_new := replace(v_def, $q$  into v_has_vmi;$q$,
      $q$  into v_has_vmi;
  v_has_vmi := false; -- M28: VMI comes from the Stock คลังคลองเตย file$q$);
    v_new := replace(v_new, $q$r.unit, coalesce(r.is_vmi, false),$q$, $q$r.unit, false,$q$);
    if length(v_new) - length(v_def) <> 72 - 20 then
      raise exception 'M28: m27_apply_material_master did not match the expected text (%)', length(v_new) - length(v_def);
    end if;
    execute v_new;
  end if;
end
$$;

select core.m28_sync_vmi_from_kt_stock() as vmi_sync;

commit;
