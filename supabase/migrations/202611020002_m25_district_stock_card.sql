-- M25: separate Import Center cards for Stock คลังคลองเตย and Stock เขต.
--
-- The team updates Khlong Toei stock (SAP export, plant 2401) every day and
-- district stock (update-stock sheet, all plants) on its own schedule. With one
-- "stock" source a Khlong Toei-only file marked every district row as missing.
-- New source kind district_stock keeps the two apart; promotion takes warehouse
-- rows from the latest Stock คลังคลองเตย file and district rows from the latest
-- Stock เขต file (falling back to district rows of the Stock file when no
-- Stock เขต file has been saved yet). Each keeps its own snapshot date.

begin;

alter table ops.source_import_runs drop constraint if exists source_import_runs_source_kind_check;
alter table ops.source_import_runs add constraint source_import_runs_source_kind_check
  check (source_kind in ('stock', 'district_stock', 'contracts', 'receipts_105', 'usage'));
alter table ops.source_current_rows drop constraint if exists source_current_rows_source_kind_check;
alter table ops.source_current_rows add constraint source_current_rows_source_kind_check
  check (source_kind in ('stock', 'district_stock', 'contracts', 'receipts_105', 'usage'));

-- Teach the existing Import Center functions the new kind (patched in place)
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('ops.srcimp_business_key(text,jsonb)'::regprocedure);
  if position('district_stock' in v_def) = 0 then
    v_new := replace(v_def, $q$when 'stock' then$q$, $q$when 'stock', 'district_stock' then$q$);
    v_new := replace(v_new, $q$p_kind in ('stock', 'usage')$q$, $q$p_kind in ('stock', 'district_stock', 'usage')$q$);
    if length(v_new) - length(v_def) <> 36 then
      raise exception 'M25: srcimp_business_key did not match the expected text';
    end if;
    execute v_new;
  end if;

  v_def := pg_get_functiondef('public.srcimp_dispatch(text,text,jsonb,jsonb,text)'::regprocedure);
  if position('district_stock' in v_def) = 0 then
    v_new := replace(v_def, $q$'stock', 'contracts', 'receipts_105', 'usage'$q$,
      $q$'stock', 'district_stock', 'contracts', 'receipts_105', 'usage'$q$);
    if length(v_new) - length(v_def) <> 54 then
      raise exception 'M25: srcimp_dispatch did not match the expected text';
    end if;
    execute v_new;
  end if;
end
$$;

create or replace function core.m24_promotion_readiness()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  with stock_run as (
    select * from ops.source_import_runs
    where source_kind = 'stock' and status = 'committed'
    order by committed_at desc nulls last, created_at desc limit 1
  ), district_run as (
    select * from ops.source_import_runs
    where source_kind = 'district_stock' and status = 'committed'
    order by committed_at desc nulls last, created_at desc limit 1
  ), usage_run as (
    select * from ops.source_import_runs
    where source_kind = 'usage' and status = 'committed'
    order by committed_at desc nulls last, created_at desc limit 1
  ), wh_stock as (
    select c.payload from ops.source_current_rows c
    where c.source_kind = 'stock' and c.missing_since_run_id is null
      and c.payload ->> 'warehouse_id' = 'WH-KT'
  ), district_stock as (
    -- Stock เขต card; before it existed, district rows could only come with the Stock file
    select c.payload from ops.source_current_rows c
    where c.missing_since_run_id is null and c.payload ->> 'district_id' is not null
      and c.source_kind = case when exists (select 1 from district_run) then 'district_stock' else 'stock' end
  ), stock as (
    select payload from wh_stock union all select payload from district_stock
  ), stock_key as (
    select encode(digest(convert_to(coalesce((select file_sha256 from stock_run), '-') || ':'
      || coalesce((select file_sha256 from district_run), '-'), 'UTF8'), 'sha256'), 'hex') as sha
  ), usage as (
    select c.payload from ops.source_current_rows c
    where c.source_kind = 'usage' and c.missing_since_run_id is null
  ), latest_import as (
    select * from ops.actual_workbook_imports where status = 'succeeded'
    order by finished_at desc nulls last, started_at desc limit 1
  )
  select jsonb_build_object(
    'stock_file', (select jsonb_build_object('import_run_id', import_run_id, 'file_name', file_name,
      'committed_at', committed_at, 'sha256', file_sha256) from stock_run),
    'usage_file', (select jsonb_build_object('import_run_id', import_run_id, 'file_name', file_name,
      'committed_at', committed_at, 'sha256', file_sha256) from usage_run),
    'district_stock_file', (select jsonb_build_object('import_run_id', import_run_id, 'file_name', file_name,
      'committed_at', committed_at, 'sha256', file_sha256) from district_run),
    'stock_date', (select max(payload ->> 'snapshot_date') from wh_stock),
    'district_stock_date', (select max(payload ->> 'snapshot_date') from district_stock),
    'usage_as_of', (select max(payload ->> 'as_of_date') from usage),
    'stock_rows', (select count(*) from stock),
    'stock_district_rows', (select count(*) from stock where payload ->> 'district_id' is not null),
    'stock_districts', (select count(distinct payload ->> 'district_id') from stock where payload ->> 'district_id' is not null),
    'stock_warehouse_rows', (select count(*) from stock where payload ->> 'warehouse_id' is not null),
    'usage_rows', (select count(*) from usage),
    'usage_district_rows', (select count(*) from usage where payload ->> 'district_id' is not null),
    'usage_districts', (select count(distinct payload ->> 'district_id') from usage where payload ->> 'district_id' is not null),
    'materials_not_in_master', (select count(distinct m) from (
        select payload ->> 'material_id' m from stock union select payload ->> 'material_id' from usage) x
      where not exists (select 1 from core.materials mm where mm.material_id = x.m)),
    'current_import', (select jsonb_build_object('actual_workbook_import_id', actual_workbook_import_id,
      'finished_at', finished_at, 'attested_by', attested_by, 'source', coalesce(source_counts ->> 'source', 'workbook_pipeline'),
      'stock_sha256', stock_checksum, 'usage_sha256', usage_checksum) from latest_import),
    'already_promoted', exists (
      select 1 from latest_import li, stock_key s, usage_run u
      where li.stock_checksum = s.sha and li.usage_checksum = u.file_sha256),
    'blocking', to_jsonb(array_remove(array[
      case when not exists (select 1 from district_stock) then 'ยังไม่มี Stock เขต: นำเข้าไฟล์ Stock (ชีท update-stock) ที่การ์ด Stock เขต แล้วกดบันทึก ถ้าไม่มี ระบบจะคิดว่าทุกเขตมีของ 0 และสั่งจ่ายเต็ม 6 เดือน' end,
      case when not exists (select 1 from usage_run) then 'ยังไม่มีไฟล์อัตราการใช้งาน (CMP) ที่บันทึกใน Import Center' end,
      case when exists (select 1 from usage_run)
            and (select count(*) from usage where payload ->> 'district_id' is not null) = 0
        then 'ไฟล์อัตราการใช้งานไม่มีข้อมูลของ 18 เขต' end
    ], null)),
    'warnings', to_jsonb(array_remove(array[
      case when not exists (select 1 from wh_stock) then 'ยังไม่มี Stock คลังคลองเตย: ระบบคำนวณการจ่ายได้ แต่ยังไม่เห็นของพร้อมจ่ายที่คลัง' end,
      case when (select max(payload ->> 'snapshot_date') from wh_stock) is distinct from (select max(payload ->> 'snapshot_date') from district_stock)
            and exists (select 1 from wh_stock) and exists (select 1 from district_stock)
        then 'Stock คลังและ Stock เขตเป็นยอดคนละวัน' end,
      case when (select count(distinct payload ->> 'district_id') from stock where payload ->> 'district_id' is not null) between 1 and 17
        then 'ไฟล์ Stock มี Stock เขตไม่ครบ 18 เขต: เขตที่ไม่มีในไฟล์จะถูกคิดว่ามีของ 0' end,
      case when (select count(distinct payload ->> 'district_id') from usage where payload ->> 'district_id' is not null) between 1 and 17
        then 'ไฟล์อัตราการใช้งานมีไม่ครบ 18 เขต' end
    ], null))
  );
$$;

create or replace function core.m24_promote_import_center(p_actor text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops, raw, reference_data, extensions
as $$
declare
  v_ready jsonb := core.m24_promotion_readiness();
  v_stock ops.source_import_runs%rowtype;
  v_district ops.source_import_runs%rowtype;
  v_district_kind text;
  v_stock_key text;
  v_district_batch uuid;
  v_district_artifact uuid;
  v_district_snapshot_at timestamptz;
  v_usage ops.source_import_runs%rowtype;
  v_contract_sha text;
  v_warehouse_sha text;
  v_import_id uuid;
  v_stock_batch uuid;
  v_usage_batch uuid;
  v_stock_artifact uuid;
  v_usage_artifact uuid;
  v_ticket text := 'IMPORT-CENTER-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMMDD-HH24MI');
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'import-center');
  v_snapshot_at timestamptz;
  v_counts jsonb;
  v_cancelled integer := 0;
begin
  if jsonb_array_length(v_ready -> 'blocking') > 0 then
    raise exception '%', v_ready -> 'blocking' ->> 0;
  end if;
  if (v_ready ->> 'already_promoted')::boolean then
    return v_ready || jsonb_build_object('promoted', false, 'message', 'ไฟล์ชุดนี้ส่งเข้าระบบคำนวณแล้ว');
  end if;

  select * into v_stock from ops.source_import_runs
  where source_kind = 'stock' and status = 'committed' order by committed_at desc nulls last, created_at desc limit 1;
  select * into v_district from ops.source_import_runs
  where source_kind = 'district_stock' and status = 'committed' order by committed_at desc nulls last, created_at desc limit 1;
  v_district_kind := case when v_district.import_run_id is not null then 'district_stock' else 'stock' end;
  if v_district.import_run_id is null then
    v_district := v_stock;
  end if;
  v_stock_key := encode(digest(convert_to(coalesce(v_stock.file_sha256, '-') || ':'
    || coalesce(case when v_district_kind = 'district_stock' then v_district.file_sha256 end, '-'), 'UTF8'), 'sha256'), 'hex');
  select * into v_usage from ops.source_import_runs
  where source_kind = 'usage' and status = 'committed' order by committed_at desc nulls last, created_at desc limit 1;
  select file_sha256 into v_contract_sha from ops.source_import_runs
  where source_kind = 'contracts' and status = 'committed' order by committed_at desc nulls last, created_at desc limit 1;
  select coalesce(v_contract_sha, contract_checksum), warehouse_checksum into v_contract_sha, v_warehouse_sha
  from ops.actual_workbook_imports where status = 'succeeded'
  order by finished_at desc nulls last, started_at desc limit 1;
  v_contract_sha := coalesce(v_contract_sha, v_stock_key);
  v_warehouse_sha := coalesce(v_warehouse_sha, v_stock_key);

  perform pg_advisory_xact_lock(hashtextextended('m24-promotion', 0));

  -- Batches and artifacts (one per file)
  if v_stock.import_run_id is not null then
  insert into raw.import_batches (source_system, source_file, source_sheet, source_checksum, source_file_size_bytes,
    row_count, status, imported_at, started_at, finished_at, metadata, connector_name, source_entity)
  values ('import_center', v_stock.file_name, 'import-center:stock', v_stock.file_sha256, v_stock.file_size_bytes,
    (v_ready ->> 'stock_rows')::int, 'succeeded', now(), now(), now(),
    jsonb_build_object('import_run_id', v_stock.import_run_id), 'import_center', 'stock')
  on conflict (source_checksum, source_sheet) do update set updated_at = now()
  returning batch_id into v_stock_batch;
  end if;
  if v_district_kind = 'district_stock' then
    insert into raw.import_batches (source_system, source_file, source_sheet, source_checksum, source_file_size_bytes,
      row_count, status, imported_at, started_at, finished_at, metadata, connector_name, source_entity)
    values ('import_center', v_district.file_name, 'import-center:district_stock', v_district.file_sha256, v_district.file_size_bytes,
      (v_ready ->> 'stock_district_rows')::int, 'succeeded', now(), now(), now(),
      jsonb_build_object('import_run_id', v_district.import_run_id), 'import_center', 'district_stock')
    on conflict (source_checksum, source_sheet) do update set updated_at = now()
    returning batch_id into v_district_batch;
  else
    v_district_batch := v_stock_batch;
  end if;
  insert into raw.import_batches (source_system, source_file, source_sheet, source_checksum, source_file_size_bytes,
    row_count, status, imported_at, started_at, finished_at, metadata, connector_name, source_entity)
  values ('import_center', v_usage.file_name, 'import-center:usage', v_usage.file_sha256, v_usage.file_size_bytes,
    (v_ready ->> 'usage_rows')::int, 'succeeded', now(), now(), now(),
    jsonb_build_object('import_run_id', v_usage.import_run_id), 'import_center', 'usage')
  on conflict (source_checksum, source_sheet) do update set updated_at = now()
  returning batch_id into v_usage_batch;

  if v_stock.import_run_id is not null then
  insert into reference_data.source_artifacts (source_path, source_sheet, source_checksum, source_file_size_bytes,
    data_class, expected_rows, metadata)
  values ('import-center/stock/' || v_stock.file_name, coalesce(v_stock.source_sheet, 'stock'), v_stock.file_sha256,
    coalesce(v_stock.file_size_bytes, 0), 'actual', (v_ready ->> 'stock_rows')::int,
    jsonb_build_object('import_run_id', v_stock.import_run_id, 'source', 'import_center'))
  on conflict (source_path, source_sheet, source_checksum) do update set updated_at = now()
  returning artifact_id into v_stock_artifact;
  end if;
  if v_district_kind = 'district_stock' then
    insert into reference_data.source_artifacts (source_path, source_sheet, source_checksum, source_file_size_bytes,
      data_class, expected_rows, metadata)
    values ('import-center/district_stock/' || v_district.file_name, coalesce(v_district.source_sheet, 'update-stock'),
      v_district.file_sha256, coalesce(v_district.file_size_bytes, 0), 'actual', (v_ready ->> 'stock_district_rows')::int,
      jsonb_build_object('import_run_id', v_district.import_run_id, 'source', 'import_center'))
    on conflict (source_path, source_sheet, source_checksum) do update set updated_at = now()
    returning artifact_id into v_district_artifact;
  else
    v_district_artifact := v_stock_artifact;
  end if;
  insert into reference_data.source_artifacts (source_path, source_sheet, source_checksum, source_file_size_bytes,
    data_class, expected_rows, metadata)
  values ('import-center/usage/' || v_usage.file_name, coalesce(v_usage.source_sheet, 'Check CMP'), v_usage.file_sha256,
    coalesce(v_usage.file_size_bytes, 0), 'actual', (v_ready ->> 'usage_rows')::int,
    jsonb_build_object('import_run_id', v_usage.import_run_id, 'source', 'import_center'))
  on conflict (source_path, source_sheet, source_checksum) do update set updated_at = now()
  returning artifact_id into v_usage_artifact;

  if v_stock_artifact is not null then
    insert into reference_data.source_rows (artifact_id, source_row_number, natural_key, payload, row_hash,
      material_id, district_id, warehouse_id)
    select v_stock_artifact, row_number() over (order by c.source_row_number, c.business_key), c.business_key, c.payload,
      encode(digest(c.payload::text, 'sha256'), 'hex'),
      c.payload ->> 'material_id', c.payload ->> 'district_id', c.payload ->> 'warehouse_id'
    from ops.source_current_rows c
    where c.source_kind = 'stock' and c.missing_since_run_id is null
    on conflict (artifact_id, source_row_number) do nothing;
  end if;
  if v_district_kind = 'district_stock' then
    insert into reference_data.source_rows (artifact_id, source_row_number, natural_key, payload, row_hash,
      material_id, district_id, warehouse_id)
    select v_district_artifact, row_number() over (order by c.source_row_number, c.business_key), c.business_key, c.payload,
      encode(digest(c.payload::text, 'sha256'), 'hex'),
      c.payload ->> 'material_id', c.payload ->> 'district_id', c.payload ->> 'warehouse_id'
    from ops.source_current_rows c
    where c.source_kind = 'district_stock' and c.missing_since_run_id is null
    on conflict (artifact_id, source_row_number) do nothing;
  end if;
  insert into reference_data.source_rows (artifact_id, source_row_number, natural_key, payload, row_hash,
    material_id, district_id)
  select v_usage_artifact, row_number() over (order by c.source_row_number, c.business_key), c.business_key, c.payload,
    encode(digest(c.payload::text, 'sha256'), 'hex'),
    c.payload ->> 'material_id', c.payload ->> 'district_id'
  from ops.source_current_rows c
  where c.source_kind = 'usage' and c.missing_since_run_id is null
  on conflict (artifact_id, source_row_number) do nothing;

  insert into ops.actual_workbook_imports (contract_checksum, stock_checksum, usage_checksum, warehouse_checksum,
    status, attested_by, attestation_text, change_ticket, source_counts, observation_counts, started_at)
  values (v_contract_sha, v_stock_key, v_usage.file_sha256, v_warehouse_sha,
    'running', v_actor,
    coalesce(nullif(btrim(p_note), ''), 'ส่งไฟล์จาก Import Center เข้าระบบคำนวณ: '
      || concat_ws(' + ', v_stock.file_name, case when v_district_kind = 'district_stock' then v_district.file_name end, v_usage.file_name)),
    v_ticket,
    jsonb_build_object('source', 'import_center', 'stock_rows', v_ready -> 'stock_rows', 'usage_rows', v_ready -> 'usage_rows',
      'stock_import_run_id', v_stock.import_run_id, 'district_stock_import_run_id',
      case when v_district_kind = 'district_stock' then v_district.import_run_id end,
      'stock_file_sha256', v_stock.file_sha256, 'usage_import_run_id', v_usage.import_run_id),
    '{}'::jsonb, now())
  returning actual_workbook_import_id into v_import_id;

  -- Stock: one snapshot per material and location (district plants summed over storage locations)
  v_snapshot_at := ((coalesce(v_ready ->> 'stock_date', v_ready ->> 'district_stock_date'))::date + time '23:59') at time zone 'Asia/Bangkok';
  v_district_snapshot_at := ((v_ready ->> 'district_stock_date')::date + time '23:59') at time zone 'Asia/Bangkok';
  create temporary table m24_stock on commit drop as
  select r.source_row_id, r.artifact_id, r.payload ->> 'material_id' as material_id,
    case when r.artifact_id = v_district_artifact and r.payload ->> 'district_id' is not null
      then 'DIST-' || (r.payload ->> 'district_id') else 'WH-KT' end as location_id,
    case when r.artifact_id = v_district_artifact and r.payload ->> 'district_id' is not null
      then 'district' else 'warehouse' end as scope,
    greatest(coalesce((r.payload ->> 'unrestricted_qty')::numeric, 0), 0) as qty
  from reference_data.source_rows r
  join core.materials m on m.material_id = r.payload ->> 'material_id'
  where (r.artifact_id = v_district_artifact and r.payload ->> 'district_id' is not null
         and exists (select 1 from core.locations l where l.location_id = 'DIST-' || (r.payload ->> 'district_id')))
     or (r.artifact_id = v_stock_artifact and r.payload ->> 'warehouse_id' = 'WH-KT');

  insert into core.stock_snapshots (material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality)
  select material_id, location_id, sum(qty),
    case when scope = 'district' then v_district_snapshot_at else v_snapshot_at end,
    case when scope = 'district' then v_district_batch else v_stock_batch end, 'actual', 'source_observed'
  from m24_stock group by material_id, location_id, scope
  on conflict (material_id, location_id, snapshot_at) do nothing;

  insert into reference_data.stock_observation_evidence (stock_snapshot_id, source_artifact_id, source_row_id,
    verification_status, aggregation_scope, observed_quantity, aggregation_rule, source_checksum, change_ticket,
    verified_by, verified_at, actual_workbook_import_id, evidence_basis)
  select s.snapshot_id, x.artifact_id, x.source_row_id, 'source_observed', x.scope, x.qty,
    'SUM(unrestricted) per material and plant; negative counted as 0',
    case when x.scope = 'district' then v_district.file_sha256 else v_stock.file_sha256 end, v_ticket,
    v_actor, now(), v_import_id, 'source_row_observed'
  from m24_stock x
  join core.stock_snapshots s on s.material_id = x.material_id and s.location_id = x.location_id
    and s.snapshot_at = case when x.scope = 'district' then v_district_snapshot_at else v_snapshot_at end
  on conflict (stock_snapshot_id, source_row_id) do nothing;

  -- Usage / CMP: district rows only; CMP is recomputed by the business-rule trigger
  create temporary table m24_usage on commit drop as
  select r.source_row_id, r.payload ->> 'material_id' as material_id, r.payload ->> 'district_id' as district_id,
    (r.payload ->> 'as_of_date')::date as as_of_date,
    greatest(coalesce((r.payload ->> 'avg_ly_raw')::numeric, 0), 0) as avg_ly,
    greatest(coalesce((r.payload ->> 'avg_12m_raw')::numeric, 0), 0) as avg_12m,
    greatest(coalesce((r.payload ->> 'avg_6m_raw')::numeric, 0), 0) as avg_6m,
    greatest(coalesce((r.payload ->> 'avg_4m_raw')::numeric, 0), 0) as avg_4m,
    (select count(*) from jsonb_each(coalesce(r.payload -> 'monthly_usage', '{}'::jsonb)) e where e.value = '"-"'::jsonb)::int as dashes,
    (select count(*) from jsonb_each(coalesce(r.payload -> 'monthly_usage', '{}'::jsonb)) e
      where jsonb_typeof(e.value) = 'number' and (e.value #>> '{}')::numeric < 0)::int as negatives
  from reference_data.source_rows r
  join core.materials m on m.material_id = r.payload ->> 'material_id'
  join core.districts d on d.district_id = r.payload ->> 'district_id'
  where r.artifact_id = v_usage_artifact;

  insert into core.usage_rates (material_id, district_id, as_of_date, cmp_monthly, avg_ly, avg_12m, avg_6m, avg_4m,
    source_batch_id, data_class, source_quality)
  select material_id, district_id, as_of_date, 0, avg_ly, avg_12m, avg_6m, avg_4m, v_usage_batch, 'actual', 'source_observed'
  from m24_usage
  on conflict (material_id, district_id, as_of_date) do nothing;

  insert into reference_data.usage_observation_evidence (usage_rate_id, source_artifact_id, source_row_id,
    verification_status, normalized_dash_count, excluded_negative_month_count, source_checksum, change_ticket,
    verified_by, verified_at, actual_workbook_import_id, evidence_basis)
  select u.usage_rate_id, v_usage_artifact, x.source_row_id, 'source_observed', x.dashes, x.negatives,
    v_usage.file_sha256, v_ticket, v_actor, now(), v_import_id, 'source_row_observed'
  from m24_usage x
  join core.usage_rates u on u.material_id = x.material_id and u.district_id = x.district_id and u.as_of_date = x.as_of_date
  on conflict (usage_rate_id, source_row_id) do nothing;

  -- Open plans built from the previous data are cancelled (locked / completed plans are kept)
  update core.replenishment_plans p
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
      cancellation_reason = 'ข้อมูล Stock/CMP ชุดใหม่ถูกส่งเข้าระบบคำนวณ (' || v_ticket || ')'
  where p.status in ('draft', 'pending_district_confirmation', 'pending_planner_approval', 'pending_academic_approval');
  get diagnostics v_cancelled = row_count;

  v_counts := jsonb_build_object(
    'stock_snapshots', (select count(*) from reference_data.stock_observation_evidence e
      join core.stock_snapshots s on s.snapshot_id = e.stock_snapshot_id
      where e.actual_workbook_import_id = v_import_id and e.aggregation_scope = 'district'),
    'warehouse_snapshots', (select count(distinct e.stock_snapshot_id) from reference_data.stock_observation_evidence e
      where e.actual_workbook_import_id = v_import_id and e.aggregation_scope = 'warehouse'),
    'district_snapshots', (select count(distinct e.stock_snapshot_id) from reference_data.stock_observation_evidence e
      where e.actual_workbook_import_id = v_import_id and e.aggregation_scope = 'district'),
    'usage_rates', (select count(distinct usage_rate_id) from reference_data.usage_observation_evidence
      where actual_workbook_import_id = v_import_id),
    'stock_rows_skipped', (v_ready ->> 'stock_rows')::int - (select count(*) from m24_stock),
    'district_stock_date', v_ready ->> 'district_stock_date', 'warehouse_stock_date', v_ready ->> 'stock_date',
    'usage_rows_skipped', (v_ready ->> 'usage_rows')::int - (select count(*) from m24_usage),
    'plans_cancelled', v_cancelled);

  update ops.actual_workbook_imports
  set status = 'succeeded', finished_at = now(), observation_counts = v_counts
  where actual_workbook_import_id = v_import_id;

  return jsonb_build_object('promoted', true, 'actual_workbook_import_id', v_import_id, 'change_ticket', v_ticket,
    'counts', v_counts, 'readiness', v_ready);
end;
$$;

commit;

select core.m24_promotion_readiness() as readiness;
