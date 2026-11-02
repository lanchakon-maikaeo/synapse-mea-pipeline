-- M24: send Import Center files to the calculation.
--
-- Import Center (ops.source_import_runs / ops.source_current_rows) keeps every
-- uploaded file, but the weekly calculation reads core.stock_snapshots and
-- core.usage_rates through analytics.stock_health_at(), which only trusts
-- rows linked (observation evidence) to the latest successful
-- ops.actual_workbook_imports row. This migration adds that link:
--
--   GET  /v1/source-imports/promotion   readiness of the latest committed Stock + CMP files
--   POST /v1/source-imports/promotion   promote them (admin, planner)
--
-- Promotion creates one new "actual workbook import" from the latest committed
-- Stock and usage/CMP files. Because the calculation only uses the newest
-- successful import, older Stock/CMP stop being used at once; nothing is deleted.
-- It refuses a Stock file that has no district stock, because the calculation
-- would then assume every district holds zero and order six months everywhere.
-- Old weekly plans that are still open are cancelled with a reason.

begin;

create or replace function core.m24_promotion_readiness()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
  with stock_run as (
    select * from ops.source_import_runs
    where source_kind = 'stock' and status = 'committed'
    order by committed_at desc nulls last, created_at desc limit 1
  ), usage_run as (
    select * from ops.source_import_runs
    where source_kind = 'usage' and status = 'committed'
    order by committed_at desc nulls last, created_at desc limit 1
  ), stock as (
    select c.payload from ops.source_current_rows c
    where c.source_kind = 'stock' and c.missing_since_run_id is null
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
    'stock_date', (select max(payload ->> 'snapshot_date') from stock),
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
      select 1 from latest_import li, stock_run s, usage_run u
      where li.stock_checksum = s.file_sha256 and li.usage_checksum = u.file_sha256),
    'blocking', to_jsonb(array_remove(array[
      case when not exists (select 1 from stock_run) then 'ยังไม่มีไฟล์ Stock ที่บันทึกใน Import Center' end,
      case when not exists (select 1 from usage_run) then 'ยังไม่มีไฟล์อัตราการใช้งาน (CMP) ที่บันทึกใน Import Center' end,
      case when exists (select 1 from stock_run)
            and (select count(*) from stock where payload ->> 'district_id' is not null) = 0
        then 'ไฟล์ Stock ไม่มี Stock ของเขต (มีเฉพาะคลัง) ถ้าส่งเข้าไป ระบบจะคิดว่าทุกเขตมีของ 0 และสั่งจ่ายเต็ม 6 เดือน ต้องใช้ไฟล์ Stock ทุกโรงงาน' end,
      case when exists (select 1 from usage_run)
            and (select count(*) from usage where payload ->> 'district_id' is not null) = 0
        then 'ไฟล์อัตราการใช้งานไม่มีข้อมูลของ 18 เขต' end
    ], null)),
    'warnings', to_jsonb(array_remove(array[
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
  select * into v_usage from ops.source_import_runs
  where source_kind = 'usage' and status = 'committed' order by committed_at desc nulls last, created_at desc limit 1;
  select file_sha256 into v_contract_sha from ops.source_import_runs
  where source_kind = 'contracts' and status = 'committed' order by committed_at desc nulls last, created_at desc limit 1;
  select coalesce(v_contract_sha, contract_checksum), warehouse_checksum into v_contract_sha, v_warehouse_sha
  from ops.actual_workbook_imports where status = 'succeeded'
  order by finished_at desc nulls last, started_at desc limit 1;
  v_contract_sha := coalesce(v_contract_sha, v_stock.file_sha256);
  v_warehouse_sha := coalesce(v_warehouse_sha, v_stock.file_sha256);

  perform pg_advisory_xact_lock(hashtextextended('m24-promotion', 0));

  -- Batches and artifacts (one per file)
  insert into raw.import_batches (source_system, source_file, source_sheet, source_checksum, source_file_size_bytes,
    row_count, status, imported_at, started_at, finished_at, metadata, connector_name, source_entity)
  values ('import_center', v_stock.file_name, 'import-center:stock', v_stock.file_sha256, v_stock.file_size_bytes,
    (v_ready ->> 'stock_rows')::int, 'succeeded', now(), now(), now(),
    jsonb_build_object('import_run_id', v_stock.import_run_id), 'import_center', 'stock')
  on conflict (source_checksum, source_sheet) do update set updated_at = now()
  returning batch_id into v_stock_batch;
  insert into raw.import_batches (source_system, source_file, source_sheet, source_checksum, source_file_size_bytes,
    row_count, status, imported_at, started_at, finished_at, metadata, connector_name, source_entity)
  values ('import_center', v_usage.file_name, 'import-center:usage', v_usage.file_sha256, v_usage.file_size_bytes,
    (v_ready ->> 'usage_rows')::int, 'succeeded', now(), now(), now(),
    jsonb_build_object('import_run_id', v_usage.import_run_id), 'import_center', 'usage')
  on conflict (source_checksum, source_sheet) do update set updated_at = now()
  returning batch_id into v_usage_batch;

  insert into reference_data.source_artifacts (source_path, source_sheet, source_checksum, source_file_size_bytes,
    data_class, expected_rows, metadata)
  values ('import-center/stock/' || v_stock.file_name, coalesce(v_stock.source_sheet, 'stock'), v_stock.file_sha256,
    coalesce(v_stock.file_size_bytes, 0), 'actual', (v_ready ->> 'stock_rows')::int,
    jsonb_build_object('import_run_id', v_stock.import_run_id, 'source', 'import_center'))
  on conflict (source_path, source_sheet, source_checksum) do update set updated_at = now()
  returning artifact_id into v_stock_artifact;
  insert into reference_data.source_artifacts (source_path, source_sheet, source_checksum, source_file_size_bytes,
    data_class, expected_rows, metadata)
  values ('import-center/usage/' || v_usage.file_name, coalesce(v_usage.source_sheet, 'Check CMP'), v_usage.file_sha256,
    coalesce(v_usage.file_size_bytes, 0), 'actual', (v_ready ->> 'usage_rows')::int,
    jsonb_build_object('import_run_id', v_usage.import_run_id, 'source', 'import_center'))
  on conflict (source_path, source_sheet, source_checksum) do update set updated_at = now()
  returning artifact_id into v_usage_artifact;

  insert into reference_data.source_rows (artifact_id, source_row_number, natural_key, payload, row_hash,
    material_id, district_id, warehouse_id)
  select v_stock_artifact, row_number() over (order by c.source_row_number, c.business_key), c.business_key, c.payload,
    encode(digest(c.payload::text, 'sha256'), 'hex'),
    c.payload ->> 'material_id', c.payload ->> 'district_id', c.payload ->> 'warehouse_id'
  from ops.source_current_rows c
  where c.source_kind = 'stock' and c.missing_since_run_id is null
  on conflict (artifact_id, source_row_number) do nothing;
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
  values (v_contract_sha, v_stock.file_sha256, v_usage.file_sha256, v_warehouse_sha,
    'running', v_actor,
    coalesce(nullif(btrim(p_note), ''), 'ส่งไฟล์จาก Import Center เข้าระบบคำนวณ: ' || v_stock.file_name || ' + ' || v_usage.file_name),
    v_ticket,
    jsonb_build_object('source', 'import_center', 'stock_rows', v_ready -> 'stock_rows', 'usage_rows', v_ready -> 'usage_rows',
      'stock_import_run_id', v_stock.import_run_id, 'usage_import_run_id', v_usage.import_run_id),
    '{}'::jsonb, now())
  returning actual_workbook_import_id into v_import_id;

  -- Stock: one snapshot per material and location (district plants summed over storage locations)
  v_snapshot_at := ((v_ready ->> 'stock_date')::date + time '23:59') at time zone 'Asia/Bangkok';
  create temporary table m24_stock on commit drop as
  select r.source_row_id, r.payload ->> 'material_id' as material_id,
    case when r.payload ->> 'district_id' is not null then 'DIST-' || (r.payload ->> 'district_id') else 'WH-KT' end as location_id,
    case when r.payload ->> 'district_id' is not null then 'district' else 'warehouse' end as scope,
    greatest(coalesce((r.payload ->> 'unrestricted_qty')::numeric, 0), 0) as qty
  from reference_data.source_rows r
  join core.materials m on m.material_id = r.payload ->> 'material_id'
  where r.artifact_id = v_stock_artifact
    and (r.payload ->> 'district_id' is not null or r.payload ->> 'warehouse_id' = 'WH-KT')
    and exists (select 1 from core.locations l where l.location_id =
      case when r.payload ->> 'district_id' is not null then 'DIST-' || (r.payload ->> 'district_id') else 'WH-KT' end);

  insert into core.stock_snapshots (material_id, location_id, quantity_on_hand, snapshot_at, source_batch_id, data_class, source_quality)
  select material_id, location_id, sum(qty), v_snapshot_at, v_stock_batch, 'actual', 'source_observed'
  from m24_stock group by material_id, location_id
  on conflict (material_id, location_id, snapshot_at) do nothing;

  insert into reference_data.stock_observation_evidence (stock_snapshot_id, source_artifact_id, source_row_id,
    verification_status, aggregation_scope, observed_quantity, aggregation_rule, source_checksum, change_ticket,
    verified_by, verified_at, actual_workbook_import_id, evidence_basis)
  select s.snapshot_id, v_stock_artifact, x.source_row_id, 'source_observed', x.scope, x.qty,
    'SUM(unrestricted) per material and plant; negative counted as 0', v_stock.file_sha256, v_ticket,
    v_actor, now(), v_import_id, 'source_row_observed'
  from m24_stock x
  join core.stock_snapshots s on s.material_id = x.material_id and s.location_id = x.location_id and s.snapshot_at = v_snapshot_at
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
    'usage_rows_skipped', (v_ready ->> 'usage_rows')::int - (select count(*) from m24_usage),
    'plans_cancelled', v_cancelled);

  update ops.actual_workbook_imports
  set status = 'succeeded', finished_at = now(), observation_counts = v_counts
  where actual_workbook_import_id = v_import_id;

  return jsonb_build_object('promoted', true, 'actual_workbook_import_id', v_import_id, 'change_ticket', v_ticket,
    'counts', v_counts, 'readiness', v_ready);
end;
$$;

revoke all on function core.m24_promotion_readiness() from public, anon, authenticated;
revoke all on function core.m24_promote_import_center(text, text) from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m24(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text) rename to m09_dispatch_impl_m24;
  end if;
end
$$;

create or replace function public.m09_dispatch(
  p_method text,
  p_path text,
  p_query jsonb default '{}'::jsonb,
  p_body jsonb default '{}'::jsonb,
  p_request_id text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_name text;
begin
  if p_path = '/v1/source-imports/promotion' then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text, display_name into v_role, v_name
    from public.user_profiles where user_id = v_user_id and is_active;
    if coalesce(v_role, '') not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Admin or planner role is required', p_request_id);
    end if;
    if upper(p_method) = 'GET' then
      return public.m09_result(200, core.m24_promotion_readiness());
    end if;
    if upper(p_method) = 'POST' then
      return public.m09_result(200, core.m24_promote_import_center(
        coalesce(v_name, v_user_id::text), p_body ->> 'note'));
    end if;
    return public.m09_error(405, 'method_not_allowed', 'Method not allowed', p_request_id);
  end if;
  return public.m09_dispatch_impl_m24(p_method, p_path, p_query, p_body, p_request_id);
exception
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text) to authenticated;

commit;

select core.m24_promotion_readiness() as readiness;
