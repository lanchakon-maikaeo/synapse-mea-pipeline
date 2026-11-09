-- M33: write out in full the functions that M25-M30 changed by text replacement.
--
-- M25, M26b, M27, M27b, M28, M29 and M30 changed live functions with
-- replace(pg_get_functiondef(...)). Their current definition was in no file,
-- so a later "create or replace" copied from the original migration would
-- silently drop those changes. This migration re-creates each function with
-- exactly its current text (taken from a database built from all migrations
-- up to M32). Behaviour does not change; from here on these definitions are
-- the ones to edit. scripts/check_migrations.sh rejects new text patches.
--
-- reserve_fifo was written out in M32.

begin;

CREATE OR REPLACE FUNCTION core.m26_lot_rows()
 RETURNS TABLE(material_id text, material_name text, unit text, purchase_order text, order_kind text, contract_number text, line_item text, installment_count integer, vendor text, quantity numeric, delivery_date date, acceptance_date date, received_qty numeric, receipt_count integer, first_receipt date, last_receipt date, in_stock boolean, kt_stock_qty numeric, kt_stock_date date, relevant boolean, status text, release_id uuid, release_qty numeric, release_counting boolean, released_by text, released_at timestamp with time zone, release_note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops'
AS $function$
  with params as (
    select (now() at time zone 'Asia/Bangkok')::date as today
  ), contracts as (
    select
      right(regexp_replace(c.payload ->> 'material_code', '\D', '', 'g'), 12) as material_id,
      regexp_replace(coalesce(c.payload ->> 'purchase_order', ''), '\D', '', 'g') as purchase_order,
      regexp_replace(btrim(coalesce(c.payload ->> 'line_item', '')), '^0+(?=\d)', '') as line_item,
      nullif(btrim(c.payload ->> 'contract_number'), '') as contract_number,
      nullif(btrim(c.payload ->> 'vendor'), '') as vendor,
      nullif(btrim(c.payload ->> 'item_description'), '') as description,
      nullif(btrim(c.payload ->> 'unit'), '') as unit,
      coalesce(nullif(regexp_replace(c.payload ->> 'quantity', '[^0-9.\-]', '', 'g'), '')::numeric, 0) as quantity,
      case when c.payload ->> 'delivery_date' ~ '^\d{4}-\d{2}-\d{2}'
        then left(c.payload ->> 'delivery_date', 10)::date end as delivery_date,
      case when c.payload ->> 'acceptance_date' ~ '^\d{4}-\d{2}-\d{2}'
        then left(c.payload ->> 'acceptance_date', 10)::date end as acceptance_date
    from ops.source_current_rows c
    where c.source_kind = 'contracts' -- contracts_cumulative: missing lines keep their last values
      and regexp_replace(coalesce(c.payload ->> 'material_code', ''), '\D', '', 'g') <> ''
  ), receipts_raw as (
    select distinct on (
      r.payload ->> 'material_document',
      coalesce(nullif(r.payload ->> 'material_document_item', ''), r.payload ->> 'item', ''),
      right(regexp_replace(r.payload ->> 'material_code', '\D', '', 'g'), 12))
      right(regexp_replace(r.payload ->> 'material_code', '\D', '', 'g'), 12) as material_id,
      regexp_replace(coalesce(r.payload ->> 'purchase_order', ''), '\D', '', 'g') as purchase_order,
      nullif(regexp_replace(btrim(coalesce(
        nullif(r.payload ->> 'po_item', ''),
        case when coalesce(r.payload ->> 'source_layout', '') = '' then r.payload ->> 'item' end,
        '')), '^0+(?=\d)', ''), '') as line_item,
      coalesce(nullif(regexp_replace(r.payload ->> 'quantity', '[^0-9.\-]', '', 'g'), '')::numeric, 0) as quantity,
      case when r.payload ->> 'posting_date' ~ '^\d{4}-\d{2}-\d{2}'
        then left(r.payload ->> 'posting_date', 10)::date end as posting_date,
      nullif(btrim(r.payload ->> 'item_description'), '') as description,
      nullif(btrim(r.payload ->> 'unit'), '') as unit
    from ops.source_current_rows r
    where r.source_kind = 'receipts_105'
    order by
      r.payload ->> 'material_document',
      coalesce(nullif(r.payload ->> 'material_document_item', ''), r.payload ->> 'item', ''),
      right(regexp_replace(r.payload ->> 'material_code', '\D', '', 'g'), 12),
      r.last_changed_run_id
  ), receipts as (
    -- 105 layouts without the PO line: the installment accepted on the posting
    -- date, else the first installment of that PO + material
    select r.material_id, r.purchase_order, r.quantity, r.posting_date, r.description, r.unit,
      coalesce(r.line_item, (
        select c.line_item from contracts c
        where c.material_id = r.material_id and c.purchase_order = r.purchase_order
        order by (c.acceptance_date = r.posting_date) desc nulls last,
          nullif(regexp_replace(c.line_item, '\D', '', 'g'), '')::numeric nulls last
        limit 1), '') as line_item
    from receipts_raw r
  ), receipt_totals as (
    select material_id, purchase_order, line_item,
      sum(quantity) as received_qty, count(*)::integer as receipt_count,
      min(posting_date) as first_receipt, max(posting_date) as last_receipt,
      max(description) as description, max(unit) as unit
    from receipts
    group by 1, 2, 3
  ), coverage as (
    select min(posting_date) as start_date from receipts
  ), kt_import as (
    select right(regexp_replace(s.payload ->> 'material_id', '\D', '', 'g'), 12) as material_id,
      sum(coalesce(nullif(regexp_replace(s.payload ->> 'unrestricted_qty', '[^0-9.\-]', '', 'g'), '')::numeric, 0)) as qty,
      max(s.payload ->> 'material_name') as material_name
    from ops.source_current_rows s
    where s.source_kind = 'stock' and s.missing_since_run_id is null
      and s.payload ->> 'warehouse_id' = 'WH-KT'
    group by 1
  ), kt_core as (
    select distinct on (s.material_id) s.material_id, s.quantity_on_hand,
      (s.snapshot_at at time zone 'Asia/Bangkok')::date as snapshot_date
    from core.stock_snapshots s
    where s.location_id = 'WH-KT'
    order by s.material_id, s.snapshot_at desc
  ), lines as (
    select c.material_id, c.purchase_order, c.line_item, c.contract_number, c.vendor,
      c.description, c.unit, c.quantity, c.delivery_date, c.acceptance_date
    from contracts c
    union all
    -- 105 lots with no contract line at all
    select t.material_id, t.purchase_order, t.line_item, null, null,
      t.description, t.unit, null, null, null
    from receipt_totals t
    where not exists (select 1 from contracts c
      where c.material_id = t.material_id and c.purchase_order = t.purchase_order
        and c.line_item = t.line_item)
  ), counted as (
    select l.*,
      count(*) over (partition by l.material_id, l.purchase_order) as installment_count,
      bool_or(t.receipt_count is not null) over (partition by l.material_id, l.purchase_order) as po_received
    from lines l
    left join receipt_totals t using (material_id, purchase_order, line_item)
  )
  select
    l.material_id,
    coalesce(m.material_name, l.description, ki.material_name) as material_name,
    coalesce(l.unit, m.unit) as unit,
    l.purchase_order,
    case when l.quantity is null then 'no_contract'
      when l.contract_number is not null then 'contract' else 'order' end as order_kind,
    l.contract_number,
    l.line_item,
    l.installment_count::integer,
    l.vendor,
    l.quantity,
    l.delivery_date,
    l.acceptance_date,
    coalesce(t.received_qty, 0),
    coalesce(t.receipt_count, 0),
    t.first_receipt,
    t.last_receipt,
    (ki.material_id is not null or kc.material_id is not null) as in_stock,
    coalesce(ki.qty, kc.quantity_on_hand, 0) as kt_stock_qty,
    kc.snapshot_date,
    (ki.material_id is not null or kc.material_id is not null or l.po_received or rel.release_id is not null) as relevant,
    case
      when t.receipt_count is not null then 'ready'
      when l.acceptance_date is not null and rel.release_id is not null then 'confirmed'
      when l.acceptance_date is not null
        and l.acceptance_date >= coalesce((select start_date from coverage), l.acceptance_date) then 'awaiting_105'
      when l.acceptance_date is not null then 'accepted_before'
      when l.delivery_date is not null and l.delivery_date < (select today from params) then 'overdue'
      else 'pending'
    end as status,
    rel.release_id,
    rel.quantity,
    (rel.release_id is not null and not exists (
      select 1 from receipts r
      where r.material_id = l.material_id and r.purchase_order = l.purchase_order
        and r.line_item = l.line_item
        and r.posting_date <= coalesce(kc.snapshot_date, 'infinity'::date))) as release_counting,
    rel.confirmed_by_name,
    rel.confirmed_at,
    rel.note
  from counted l
  left join receipt_totals t using (material_id, purchase_order, line_item)
  left join core.materials m on m.material_id = l.material_id
  left join kt_import ki on ki.material_id = l.material_id
  left join kt_core kc on kc.material_id = l.material_id
  left join ops.passed_test_releases rel
    on rel.material_id = l.material_id and rel.purchase_order = l.purchase_order
   and rel.line_item = l.line_item and rel.cancelled_at is null;
$function$
;

CREATE OR REPLACE FUNCTION ops.srcimp_business_key(p_kind text, p_payload jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_parts text[];
begin
  case p_kind
    when 'stock', 'district_stock' then
      -- Matches pipeline/actual_workbooks.py: absent storage is "<missing>".
      v_parts := array[
        p_payload ->> 'sap_plant_code',
        coalesce(nullif(btrim(p_payload ->> 'storage_location_code'), ''), '<missing>'),
        p_payload ->> 'material_id'
      ];
      -- Repeated plant+storage+material rows in one SAP export keep their
      -- file order as an occurrence suffix (#2, #3, …) and are flagged.
      if coalesce((p_payload ->> 'duplicate_occurrence')::integer, 1) > 1 then
        v_parts[3] := v_parts[3] || '#' || (p_payload ->> 'duplicate_occurrence');
      end if;
    when 'materials' then
      v_parts := array[p_payload ->> 'material_id'];
    when 'usage' then
      v_parts := array[p_payload ->> 'material_id', p_payload ->> 'sap_plant_code'];
    when 'contracts' then
      v_parts := array[
        coalesce(p_payload ->> 'material_code', ''),
        p_payload ->> 'purchase_order',
        regexp_replace(coalesce(p_payload ->> 'line_item', ''), '^0+(?=\d)', '')
      ];
    when 'receipts_105' then
      v_parts := array[
        p_payload ->> 'material_document',
        p_payload ->> 'material_code',
        p_payload ->> 'purchase_order',
        coalesce(p_payload ->> 'gr_gi_slip', ''),
        coalesce(p_payload ->> 'item', ''),
        coalesce(p_payload ->> 'storage_location', ''),
        coalesce(p_payload ->> 'posting_date', '')
      ];
      if p_payload ->> 'source_layout' = 'sap_105_14' then
        v_parts := v_parts || array[coalesce(p_payload ->> 'quantity', '')];
      end if;
    else
      raise exception 'Unsupported source kind %', p_kind;
  end case;

  if p_kind in ('stock', 'district_stock', 'usage', 'materials') and exists (
    select 1 from unnest(v_parts) part where nullif(btrim(part), '') is null
  ) then
    raise exception 'Row is missing an identity field for %', p_kind;
  end if;
  if p_kind = 'contracts' and (v_parts[2] is null or v_parts[3] = '') then
    raise exception 'Contract row requires purchase_order and line_item';
  end if;
  if p_kind = 'receipts_105' and (v_parts[1] is null or v_parts[2] is null or v_parts[3] is null) then
    raise exception 'Receipt row requires material_document, material_code and purchase_order';
  end if;

  return array_to_string(v_parts, '|');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.srcimp_dispatch(p_method text, p_path text, p_query jsonb DEFAULT '{}'::jsonb, p_body jsonb DEFAULT '{}'::jsonb, p_request_id text DEFAULT 'unknown'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '60s'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_method text := upper(coalesce(p_method, ''));
  v_count integer;
  v_match text[];
  v_run_id uuid;
  v_run ops.source_import_runs;
  v_payload jsonb;
  v_limit integer;
  v_offset integer;
  v_parts text[];
begin
  if v_user_id is null then
    return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
  end if;
  v_role := ops.srcimp_actor_role();
  if v_role is null then
    return public.m09_error(403, 'forbidden', 'No application role is assigned', p_request_id);
  end if;
  if v_role not in ('admin', 'planner') then
    return public.m09_error(403, 'forbidden', 'Admin or planner role is required for source imports', p_request_id);
  end if;

  insert into ops.api_rate_limit_windows (user_id, window_start, request_count)
  values (v_user_id, date_trunc('minute', clock_timestamp()), 1)
  on conflict (user_id, window_start) do update
  set request_count = ops.api_rate_limit_windows.request_count + 1,
      updated_at = now()
  returning request_count into v_count;
  if v_count > 120 then
    return public.m09_error(429, 'rate_limited', 'Too many requests', p_request_id);
  end if;

  if v_method = 'GET' and p_path = '/v1/source-imports/runs' then
    v_limit := least(greatest(coalesce(nullif(p_query ->> 'limit', '')::integer, 30), 1), 200);
    select coalesce(jsonb_agg(ops.srcimp_run_json(r) order by r.created_at desc), '[]'::jsonb)
    into v_payload
    from (
      select * from ops.source_import_runs
      where (nullif(p_query ->> 'source_kind', '') is null or source_kind = p_query ->> 'source_kind')
      order by created_at desc
      limit v_limit
    ) r;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/source-imports/current' then
    select coalesce(jsonb_object_agg(kind, jsonb_build_object(
      'accepted_rows', (select count(*) from ops.source_current_rows c
        where c.source_kind = kind and c.missing_since_run_id is null),
      'missing_rows', (select count(*) from ops.source_current_rows c
        where c.source_kind = kind and c.missing_since_run_id is not null),
      'latest_commit', (select ops.srcimp_run_json(r) from ops.source_import_runs r
        where r.import_run_id = ops.srcimp_latest_commit(kind))
    )), '{}'::jsonb)
    into v_payload
    from unnest(array['stock', 'district_stock', 'contracts', 'receipts_105', 'usage', 'materials']) kind;
    return public.m09_result(200, v_payload);
  end if;

  -- Accepted rows for the material summary on the Import page. Vendor names
  -- stay hidden (Business Rules v1) and the monthly usage history is left out
  -- to keep the response small; both remain in the stored history.
  if v_method = 'GET' and p_path = '/v1/source-imports/current-rows' then
    if coalesce(p_query ->> 'source_kind', '') not in ('stock', 'district_stock', 'contracts', 'receipts_105', 'usage', 'materials') then
      return public.m09_error(422, 'validation_error', 'source_kind is invalid', p_request_id);
    end if;
    v_limit := least(greatest(coalesce(nullif(p_query ->> 'limit', '')::integer, 5000), 1), 5000);
    v_offset := greatest(coalesce(nullif(p_query ->> 'offset', '')::integer, 0), 0);
    select jsonb_build_object(
      'source_kind', p_query ->> 'source_kind',
      'total', (select count(*) from ops.source_current_rows c
        where c.source_kind = p_query ->> 'source_kind' and c.missing_since_run_id is null),
      'rows', coalesce(jsonb_agg(c.payload - 'vendor' - 'monthly_usage' order by c.business_key), '[]'::jsonb)
    )
    into v_payload
    from (
      select business_key, payload from ops.source_current_rows
      where source_kind = p_query ->> 'source_kind' and missing_since_run_id is null
      order by business_key
      limit v_limit offset v_offset
    ) c;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path = '/v1/source-imports/runs' then
    if coalesce(p_body ->> 'source_kind', '') not in ('stock', 'district_stock', 'contracts', 'receipts_105', 'usage', 'materials') then
      return public.m09_error(422, 'validation_error', 'source_kind is invalid', p_request_id);
    end if;
    if coalesce(p_body ->> 'file_sha256', '') !~ '^[0-9a-fA-F]{64}$' then
      return public.m09_error(422, 'validation_error', 'file_sha256 must be a SHA-256 hex digest', p_request_id);
    end if;
    if nullif(btrim(p_body ->> 'file_name'), '') is null then
      return public.m09_error(422, 'validation_error', 'file_name is required', p_request_id);
    end if;
    if coalesce(p_body ->> 'expected_row_count', '') !~ '^\d+$' then
      return public.m09_error(422, 'validation_error', 'expected_row_count is required', p_request_id);
    end if;
    v_run := ops.srcimp_create_run(p_body);
    return public.m09_result(201, ops.srcimp_run_json(v_run));
  end if;

  v_match := regexp_match(
    p_path,
    '^/v1/source-imports/runs/([0-9a-fA-F-]{36})(?:/(rows|stage|commit|discard|changes))?$'
  );
  if v_match is null then
    return public.m09_error(404, 'not_found', 'Source import path not found', p_request_id);
  end if;
  v_run_id := v_match[1]::uuid;

  if v_method = 'GET' and v_match[2] is null then
    select * into v_run from ops.source_import_runs where import_run_id = v_run_id;
    if not found then
      return public.m09_error(404, 'not_found', 'Import run not found', p_request_id);
    end if;
    return public.m09_result(200, ops.srcimp_run_json(v_run));
  end if;

  if v_method = 'GET' and v_match[2] = 'changes' then
    v_limit := least(greatest(coalesce(nullif(p_query ->> 'limit', '')::integer, 50), 1), 500);
    v_offset := greatest(coalesce(nullif(p_query ->> 'offset', '')::integer, 0), 0);
    return public.m09_result(200, ops.srcimp_changes(
      v_run_id, coalesce(nullif(p_query ->> 'type', ''), 'changed'), v_limit, v_offset));
  end if;

  if v_method = 'POST' and v_match[2] = 'rows' then
    return public.m09_result(200, ops.srcimp_append_rows(v_run_id, p_body -> 'rows'));
  end if;

  if v_method = 'POST' and v_match[2] = 'stage' then
    v_run := ops.srcimp_stage(v_run_id);
    return public.m09_result(200, ops.srcimp_run_json(v_run));
  end if;

  if v_method = 'POST' and v_match[2] = 'commit' then
    if v_role <> 'admin' then
      return public.m09_error(403, 'forbidden', 'Admin role is required to confirm an import', p_request_id);
    end if;
    v_run := ops.srcimp_commit(v_run_id, coalesce((p_body ->> 'acknowledge_warnings')::boolean, false));
    return public.m09_result(200, ops.srcimp_run_json(v_run));
  end if;

  if v_method = 'POST' and v_match[2] = 'discard' then
    v_run := ops.srcimp_discard(v_run_id, p_body ->> 'reason');
    return public.m09_result(200, ops.srcimp_run_json(v_run));
  end if;

  return public.m09_error(405, 'method_not_allowed', 'Method not allowed for this path', p_request_id);
exception
  when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
    return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when others then
    if sqlerrm like 'srcimp:%' then
      v_parts := regexp_match(sqlerrm, '^srcimp:(\d{3}):(.*)$');
      return public.m09_error(
        v_parts[1]::integer,
        case v_parts[1]
          when '403' then 'forbidden'
          when '404' then 'not_found'
          when '409' then 'conflict'
          else 'validation_error'
        end,
        left(v_parts[2], 500),
        p_request_id
      );
    end if;
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$function$
;

CREATE OR REPLACE FUNCTION core.m24_promote_import_center(p_actor text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops', 'raw', 'reference_data', 'extensions'
AS $function$
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
  on conflict (stock_snapshot_id, source_row_id) do update
    set actual_workbook_import_id = excluded.actual_workbook_import_id, -- M30: observed again
        change_ticket = excluded.change_ticket, verified_by = excluded.verified_by, verified_at = excluded.verified_at;

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
  on conflict (usage_rate_id, source_row_id) do update
    set actual_workbook_import_id = excluded.actual_workbook_import_id, -- M30: observed again
        change_ticket = excluded.change_ticket, verified_by = excluded.verified_by, verified_at = excluded.verified_at;

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
$function$
;

CREATE OR REPLACE FUNCTION core.m27_apply_material_master(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops', 'raw'
AS $function$
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
  v_has_vmi := false; -- M28: VMI comes from the Stock คลังคลองเตย file
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
  select r.material_id, r.material_id, r.material_name, r.category, r.unit, false,
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
$function$
;

CREATE OR REPLACE FUNCTION core.issue_replenishment_plan(p_replenishment_plan_id uuid)
 RETURNS core.replenishment_plans
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'public', 'ops'
AS $function$
declare
  v_plan core.replenishment_plans%rowtype;
  v_role public.app_role;
  v_allocation record;
  v_destination_id text;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'picker') then
    raise exception 'Only picker or admin may issue locked plans';
  end if;

  select * into v_plan
  from core.replenishment_plans
  where replenishment_plan_id = p_replenishment_plan_id
  for update;
  if not found or v_plan.status <> 'locked' then
    raise exception 'Locked replenishment plan not found';
  end if;

  for v_allocation in
    select
      a.*,
      i.material_id,
      i.district_id,
      hu.receipt_lot_id,
      hu.location_id
    from ops.fifo_allocations a
    join core.replenishment_items i using (replenishment_item_id)
    join core.handling_units hu using (handling_unit_id)
    where i.replenishment_plan_id = v_plan.replenishment_plan_id
      and a.status = 'reserved'
    order by i.district_id, i.material_id, a.allocation_sequence
    for update of a, hu
  loop
    select location_id into v_destination_id
    from core.locations
    where district_id = v_allocation.district_id
      and location_type = 'DISTRICT'
      and is_active
    order by location_id
    limit 1;
    if v_destination_id is null then
      raise exception 'Active district destination is missing for %', v_allocation.district_id;
    end if;

    update core.handling_units
    set available_qty = available_qty - v_allocation.allocated_qty,
        reserved_qty = reserved_qty - v_allocation.allocated_qty,
        opening_status = case
          when available_qty - v_allocation.allocated_qty = 0 then 'DEPLETED'
          else 'OPEN'
        end,
        opened_at = case
          when available_qty - v_allocation.allocated_qty > 0
            then coalesce(opened_at, now())
          else opened_at
        end,
        updated_at = now()
    where handling_unit_id = v_allocation.handling_unit_id;

    update core.receipt_lots
    set remaining_qty = remaining_qty - v_allocation.allocated_qty,
        updated_at = now()
    where receipt_lot_id = v_allocation.receipt_lot_id;

    update ops.fifo_allocations
    set status = 'issued',
        issued_by = auth.uid(),
        issued_at = now()
    where fifo_allocation_id = v_allocation.fifo_allocation_id;

    insert into core.inventory_movements (
      movement_type,
      material_id,
      handling_unit_id,
      from_location_id,
      to_location_id,
      quantity,
      replenishment_item_id,
      idempotency_key,
      reason,
      performed_by
    )
    values (
      'ISSUE',
      v_allocation.material_id,
      v_allocation.handling_unit_id,
      v_allocation.location_id,
      v_destination_id,
      v_allocation.allocated_qty,
      v_allocation.replenishment_item_id,
      'issue:' || v_allocation.fifo_allocation_id::text,
      'Locked weekly replenishment issue',
      auth.uid()
    );
  end loop;

  if not found and not exists (
    -- M29: FIFO guidance from contract lots counts as the plan's allocation
    select 1 from ops.m29_fifo_guidance g
    where g.replenishment_plan_id = v_plan.replenishment_plan_id and g.status = 'reserved'
  ) then
    raise exception 'Plan has no reserved FIFO allocations';
  end if;

  update core.replenishment_items
  set status = case
        when status = 'district_rejected' then status
        else 'issued'
      end,
      updated_at = now()
  where replenishment_plan_id = v_plan.replenishment_plan_id;

  update core.replenishment_plans
  set status = 'completed',
      updated_at = now()
  where replenishment_plan_id = v_plan.replenishment_plan_id
  returning * into v_plan;
  return v_plan;
end;
$function$
;

commit;

notify pgrst, 'reload schema';
