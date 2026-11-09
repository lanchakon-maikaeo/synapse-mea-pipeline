-- Chat assistant: the database side of /api/chat, in its final form.
--
-- Production already has these objects from the dev branch, so every
-- statement is safe to run again: tables and indexes are created only when
-- missing, functions and triggers are replaced with the same definitions, and
-- the chat source catalog is seeded only when it is empty.
begin;

create extension if not exists vector with schema extensions;

-- Chat requests audit (append-only).
create table if not exists audit.vmi_chat_requests (
  audit_id bigint generated always as identity primary key,
  request_id uuid not null,
  actor_id uuid not null references auth.users(id),
  tool text check (tool in ('get_stock_status', 'get_replenishment_recommendation',
    'get_plan_status', 'get_contract_status', 'get_traceability')),
  tool_version text not null check (tool_version = 'v1'),
  status text not null check (status in
    ('ok', 'no_data', 'forbidden', 'invalid_input', 'unavailable')),
  latency_ms integer not null check (latency_ms >= 0),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists vmi_chat_requests_actor_time on audit.vmi_chat_requests(actor_id, created_at);
alter table audit.vmi_chat_requests enable row level security;
revoke all on audit.vmi_chat_requests from public, anon, authenticated;
create or replace trigger vmi_chat_requests_append_only before update or delete
  on audit.vmi_chat_requests for each row execute function audit.reject_append_only_mutation();

-- Fixed, caller-scoped reads (stock, replenishment, plans, contracts, traceability).
create or replace function public.vmi_chat_read(
  p_tool text, p_args jsonb, p_request_id uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog
set statement_timeout = '5s'
set lock_timeout = '1s'
as $$
declare
  actor uuid := auth.uid();
  v_actor_role text;
  v_actor_district text;
  v_district text;
  started timestamptz := clock_timestamp();
  effective_request_id uuid := coalesce(p_request_id, gen_random_uuid());
  allowed text[];
  tool_name text;
  result_status text := 'ok';
  rows jsonb := '[]';
  warnings jsonb := '[]';
  sources jsonb := '[]';
  as_of jsonb := 'null';
  truncated boolean := false;
begin
  if actor is null then
    raise sqlstate '28000' using message = 'Authentication required';
  end if;
  select role::text, district_id into v_actor_role, v_actor_district
    from public.user_profiles where user_id = actor and is_active;
  if p_tool = any(array['get_stock_status', 'get_replenishment_recommendation',
      'get_plan_status', 'get_contract_status', 'get_traceability']) then
    tool_name := p_tool;
  end if;

  -- Serialize only this caller's request counter, including concurrent clients.
  perform pg_advisory_xact_lock(hashtextextended('vmi-chat:' || actor::text, 0));
  if (select count(*) from audit.vmi_chat_requests
      where actor_id = actor and created_at > clock_timestamp() - interval '1 minute') >= 10 then
    insert into audit.vmi_chat_requests(
      request_id, actor_id, tool, tool_version, status, latency_ms
    ) values (
      effective_request_id, actor, tool_name, 'v1', 'unavailable',
      greatest(0, floor(extract(epoch from clock_timestamp() - started) * 1000))::integer
    );
    return jsonb_build_object('request_id', effective_request_id, 'tool', tool_name,
      'status', 'unavailable', 'data', '[]'::jsonb, 'data_as_of', null,
      'scope', jsonb_build_object('role', v_actor_role, 'district_id', v_actor_district,
        'truncated', false), 'sources', '[]'::jsonb,
      'warnings', jsonb_build_array('rate_limited'));
  end if;

  begin
    if v_actor_role is null or (tool_name = 'get_contract_status'
        and v_actor_role not in ('admin', 'planner', 'viewer')) then
      raise insufficient_privilege;
    end if;
    if tool_name is null or p_request_id is null or p_args is null
        or jsonb_typeof(p_args) <> 'object' or octet_length(p_args::text) > 2000 then
      raise invalid_parameter_value;
    end if;
    allowed := case tool_name
      when 'get_stock_status' then array['material_id', 'scope', 'district_id']
      when 'get_replenishment_recommendation' then array['material_id', 'district_id']
      when 'get_plan_status' then array['plan_id']
      when 'get_contract_status' then array['contract_number', 'purchase_order']
      else array['issue_reference', 'handling_unit_code', 'purchase_order', 'material_id'] end;
    if exists(select 1 from jsonb_each(p_args) e
        where not (e.key = any(allowed)) or jsonb_typeof(e.value) <> 'string'
          or length(btrim(e.value #>> '{}')) not between 1 and 100) then
      raise invalid_parameter_value;
    end if;
    select coalesce(jsonb_object_agg(key, btrim(value #>> '{}')), '{}')
      into p_args from jsonb_each(p_args);
    if tool_name in ('get_stock_status', 'get_replenishment_recommendation')
        and not (p_args ? 'material_id') then raise invalid_parameter_value; end if;
    if tool_name in ('get_plan_status', 'get_contract_status', 'get_traceability')
        and (select count(*) from jsonb_object_keys(p_args)) <> 1 then
      raise invalid_parameter_value;
    end if;
    if tool_name = 'get_stock_status' and
        (not (p_args ? 'scope') or p_args->>'scope' not in ('warehouse','district')
        or (p_args->>'scope' = 'warehouse' and p_args ? 'district_id')) then
      raise invalid_parameter_value;
    end if;
    if p_args ? 'purchase_order' then
      if p_args->>'purchase_order' !~ '^[0-9]{1,19}$' then raise invalid_parameter_value; end if;
      perform (p_args->>'purchase_order')::bigint;
    end if;
    if p_args ? 'plan_id' then perform (p_args->>'plan_id')::uuid; end if;
    if p_args ? 'district_id' and p_args->>'district_id' !~ '^55(0[1-9]|1[0-8])$' then
      raise invalid_parameter_value;
    end if;
    v_district := p_args->>'district_id';
    if v_actor_role = 'district' then
      if v_actor_district is null
          or (v_district is not null and v_district <> v_actor_district) then
        raise insufficient_privilege;
      end if;
      v_district := v_actor_district;
    end if;
    if (tool_name = 'get_replenishment_recommendation'
        or (tool_name = 'get_stock_status' and p_args->>'scope' = 'district'))
        and v_district is null then raise invalid_parameter_value; end if;

    if tool_name = 'get_stock_status' and p_args->>'scope' = 'warehouse' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]') into rows from (
        select distinct on (s.material_id, s.location_id)
          s.material_id, m.material_name, m.unit, s.location_id, l.location_name_th,
          s.quantity_on_hand, s.snapshot_at, s.source_batch_id, s.data_class, s.source_quality
        from core.stock_snapshots s join core.materials m using(material_id)
        join core.locations l using(location_id)
        where s.material_id = p_args->>'material_id' and l.location_type = 'WAREHOUSE'
        order by s.material_id, s.location_id, s.snapshot_at desc, s.snapshot_id
        limit 21
      ) q;
      sources := jsonb_build_array('core.stock_snapshots');
    elsif tool_name = 'get_stock_status' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]') into rows from (
        select h.snapshot_id, h.usage_rate_id, h.material_id, h.material_name, m.unit,
          h.district_id, h.district_name_th, h.current_stock_qty, h.snapshot_at,
          h.usage_as_of_date, h.cmp_monthly, h.avg_4m, h.avg_6m, h.months_available,
          h.health_band, h.avg_ly, h.avg_12m, h.source_stock_missing, h.stock_source_status,
          h.stock_source_batch_id, h.usage_source_batch_id, h.stock_data_class,
          h.usage_data_class, h.input_data_class, h.fixture_backed
        from analytics.v_stock_health h join core.materials m using(material_id)
        where h.material_id = p_args->>'material_id' and h.district_id = v_district
        order by h.material_id, h.district_id limit 21
      ) q;
      sources := jsonb_build_array('analytics.v_stock_health');
    elsif tool_name = 'get_replenishment_recommendation' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]') into rows from (
        select r.recommendation_id, r.replenishment_item_id, r.replenishment_plan_id,
          r.plan_number, r.version_no, r.material_id, r.material_name, m.unit,
          r.district_id, r.district_name_th, r.method, r.recommended_qty,
          r.current_stock_qty, r.cmp_monthly, r.months_available, r.min_fill_qty,
          r.max_fill_qty, r.evidence, r.source_freshness_status, r.created_at,
          s.snapshot_at, u.as_of_date as usage_as_of_date,
          s.source_batch_id as stock_source_batch_id, u.source_batch_id as usage_source_batch_id,
          s.data_class as stock_data_class, u.data_class as usage_data_class,
          r.evidence->>'policy_version' as rule_version
        from analytics.v_quantity_recommendations r join core.materials m using(material_id)
        join core.replenishment_items i using(replenishment_item_id)
        left join core.stock_snapshots s on s.snapshot_id = i.source_stock_snapshot_id
        left join core.usage_rates u on u.usage_rate_id = i.source_usage_rate_id
        where r.material_id = p_args->>'material_id' and r.district_id = v_district
        order by r.created_at desc, r.recommendation_id limit 21
      ) q;
      if jsonb_array_length(rows) = 0 then
        select coalesce(jsonb_agg(to_jsonb(q)), '[]') into rows from (
          select null::uuid as recommendation_id, null::uuid as replenishment_item_id,
            null::uuid as replenishment_plan_id, null::text as plan_number,
            null::integer as version_no, h.material_id, h.material_name, m.unit,
            h.district_id, h.district_name_th, null::text as method,
            null::numeric as recommended_qty, h.current_stock_qty, h.cmp_monthly,
            h.months_available, null::numeric as min_fill_qty, null::numeric as max_fill_qty,
            jsonb_build_object('reason', 'cmp_zero_not_eligible') as evidence,
            h.input_data_class as source_freshness_status, null::timestamptz as created_at,
            h.snapshot_at, h.usage_as_of_date, h.stock_source_batch_id,
            h.usage_source_batch_id, h.stock_data_class, h.usage_data_class,
            (select cp.policy_version from ops.calculation_policies cp
              where cp.is_active order by cp.created_at desc limit 1) as rule_version
          from analytics.v_stock_health h join core.materials m using(material_id)
          where h.material_id = p_args->>'material_id' and h.district_id = v_district
            and h.cmp_monthly = 0
          order by h.snapshot_at desc nulls last limit 1
        ) q;
      end if;
      sources := jsonb_build_array('analytics.v_quantity_recommendations',
        'analytics.v_stock_health');
    elsif tool_name = 'get_plan_status' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]') into rows from (
        select p.replenishment_plan_id, p.replenishment_run_id, p.status as plan_status,
          p.plan_number, p.week_start_date, p.version_no, p.parent_plan_id,
          p.response_due_at, p.planner_approved_at, p.academic_approved_at,
          p.locked_at, p.created_at, p.updated_at,
          a.plan_approval_id, a.replenishment_item_id, a.district_id,
          a.approval_stage, a.decision, a.note, a.actor_id, a.actor_role, a.acted_at
        from core.replenishment_plans p
        left join ops.plan_approvals a on a.replenishment_plan_id = p.replenishment_plan_id
          and (v_actor_role <> 'district' or a.district_id = v_district)
        where p.replenishment_plan_id = (p_args->>'plan_id')::uuid
          and (v_actor_role <> 'district' or exists(
            select 1 from core.replenishment_items i
            where i.replenishment_plan_id = p.replenishment_plan_id
              and i.district_id = v_district))
        order by a.acted_at desc nulls last, a.plan_approval_id limit 21
      ) q;
      sources := jsonb_build_array('core.replenishment_plans', 'ops.plan_approvals');
    elsif tool_name = 'get_contract_status' then
      select coalesce(jsonb_agg(to_jsonb(q)), '[]') into rows from (
        select c.contract_id, c.contract_key, c.purchase_order::text, c.contract_number,
          c.procurement_code, c.vendor_name, c.start_date, c.document_date, c.end_date,
          c.contract_status, c.source_item_count, c.material_line_count,
          c.service_or_unmapped_line_count, c.warning_line_count, c.source_batch_id, c.updated_at,
          i.contract_item_id, i.material_id, i.source_row_number, i.line_item,
          i.item_description, i.unit, i.quantity, i.delivery_date, i.acceptance_date,
          i.validation_status, i.source_batch_id as line_source_batch_id
        from analytics.v_contract_status c left join core.contract_items i
          on i.contract_id = c.contract_id and i.is_current
        where (p_args ? 'purchase_order' and c.purchase_order = (p_args->>'purchase_order')::bigint)
          or (p_args ? 'contract_number' and c.contract_number = p_args->>'contract_number')
        order by c.contract_id, i.contract_item_id limit 21
      ) q;
      sources := jsonb_build_array('analytics.v_contract_status', 'core.contract_items');
    else
      select coalesce(jsonb_agg(to_jsonb(q)), '[]') into rows from (
        select t.inventory_movement_id, t.occurred_at, t.issued_qty, t.material_id,
          t.material_name, m.unit, t.district_id, t.district_name_th, t.issue_reference,
          t.issue_type, t.replenishment_plan_id, t.replenishment_item_id, t.ad_hoc_issue_id,
          t.handling_unit_id, t.handling_unit_code, t.unit_type, t.receipt_lot_id,
          t.lot_code, t.acceptance_date, t.installment_no, t.purchase_order::text,
          t.contract_number, t.contract_item_id, t.line_item, t.source_row_number,
          t.vendor_name, t.vendor_aliases, t.from_location_id, t.to_location_id,
          lot.source_batch_id, b.metadata->>'data_class' as data_class,
          'issued_movement'::text as provenance_kind
        from analytics.v_issue_traceback t join core.materials m using(material_id)
        join core.receipt_lots lot using(receipt_lot_id)
        left join raw.import_batches b on b.batch_id = lot.source_batch_id
        where (v_actor_role <> 'district' or t.district_id = v_district) and (
          (p_args ? 'issue_reference' and (
            t.issue_reference = p_args->>'issue_reference'
            or exists (
              select 1 from core.replenishment_plans issue_plan
              where issue_plan.replenishment_plan_id = t.replenishment_plan_id
                and issue_plan.plan_number = p_args->>'issue_reference'
            )
          ))
          or (p_args ? 'handling_unit_code' and t.handling_unit_code = p_args->>'handling_unit_code')
          or (p_args ? 'purchase_order' and t.purchase_order = (p_args->>'purchase_order')::bigint)
          or (p_args ? 'material_id' and t.material_id = p_args->>'material_id'))
        order by t.occurred_at desc, t.inventory_movement_id limit 21
      ) q;
      sources := jsonb_build_array('analytics.v_issue_traceback');
    end if;
    truncated := jsonb_array_length(rows) > 20;
    select coalesce(jsonb_agg(value order by ordinal), '[]') into rows
      from jsonb_array_elements(rows) with ordinality e(value, ordinal) where ordinal <= 20;
    if jsonb_array_length(rows) = 0 then result_status := 'no_data'; end if;
    -- Preserve per-row source dates; these are never replaced with request time.
    select coalesce(jsonb_agg(jsonb_build_object(
      'snapshot_at', value->'snapshot_at', 'usage_as_of_date', value->'usage_as_of_date',
      'created_at', value->'created_at', 'updated_at', value->'updated_at',
      'acted_at', value->'acted_at', 'occurred_at', value->'occurred_at')), '[]')
      into as_of from jsonb_array_elements(rows);
    if exists(select 1 from jsonb_array_elements(rows) e
        where coalesce(e->>'snapshot_at', e->>'created_at', e->>'updated_at', e->>'occurred_at') is null)
      then warnings := warnings || jsonb_build_array('source_timestamp_missing'); end if;
    if tool_name = 'get_replenishment_recommendation' and exists(
        select 1 from jsonb_array_elements(rows) e where e->>'rule_version' is null)
      then warnings := warnings || jsonb_build_array('rule_version_missing'); end if;
  exception
    when insufficient_privilege then result_status := 'forbidden'; rows := '[]'; sources := '[]';
    when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range then
      result_status := 'invalid_input'; rows := '[]'; sources := '[]';
  end;
  insert into audit.vmi_chat_requests(request_id, actor_id, tool, tool_version, status, latency_ms)
    values(effective_request_id, actor, tool_name, 'v1', result_status,
      greatest(0, floor(extract(epoch from clock_timestamp() - started) * 1000))::integer);
  return jsonb_build_object('request_id', effective_request_id, 'tool', tool_name,
    'status', result_status, 'data', rows, 'data_as_of', as_of,
    'scope', jsonb_build_object('role', v_actor_role, 'district_id', v_district,
      'truncated', truncated),
    'sources', sources, 'warnings', warnings);
end;
$$;
revoke all on function public.vmi_chat_read(text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.vmi_chat_read(text,jsonb,uuid) to authenticated;
comment on function public.vmi_chat_read(text,jsonb,uuid) is
  'P01 VMI tools v1. Fixed projections and caller-bound permissions. No arbitrary SQL or business writes.';

-- Per-user admission before a paid LLM call.
create table if not exists audit.vmi_chat_admissions (
  admission_id bigint generated always as identity primary key,
  request_id uuid not null unique,
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists vmi_chat_admissions_actor_time
  on audit.vmi_chat_admissions(actor_id, created_at);
alter table audit.vmi_chat_admissions enable row level security;
revoke all on audit.vmi_chat_admissions from public, anon, authenticated;
create or replace trigger vmi_chat_admissions_append_only before update or delete
  on audit.vmi_chat_admissions for each row
  execute function audit.reject_append_only_mutation();

create or replace function public.vmi_chat_admit(p_request_id uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog
set statement_timeout = '2s'
set lock_timeout = '1s'
as $$
declare
  actor uuid := auth.uid();
  actor_role text;
  actor_district text;
begin
  if actor is null or p_request_id is null then
    raise sqlstate '28000' using message = 'Authentication required';
  end if;

  select role::text, district_id
    into actor_role, actor_district
    from public.user_profiles
    where user_id = actor and is_active;
  if actor_role is null then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('vmi-chat-admit:' || actor::text, 0));
  if (select count(*) from audit.vmi_chat_admissions
      where actor_id = actor
        and created_at > clock_timestamp() - interval '1 minute') >= 10 then
    return jsonb_build_object('status', 'unavailable',
      'warnings', jsonb_build_array('rate_limited'));
  end if;

  insert into audit.vmi_chat_admissions(request_id, actor_id)
    values(p_request_id, actor);
  return jsonb_build_object('status', 'ok', 'scope',
    jsonb_build_object('role', actor_role, 'district_id', actor_district));
end;
$$;

revoke all on function public.vmi_chat_admit(uuid) from public, anon, authenticated;
grant execute on function public.vmi_chat_admit(uuid) to authenticated;
comment on function public.vmi_chat_admit(uuid) is
  'P02 pre-inference admission. Caller-derived identity, 10 requests/minute, no prompt storage.';

-- Caller-scoped stock risk and delivery overview.
create or replace function public.vmi_chat_overview(p_tool text, p_args jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog set statement_timeout = '5s' set lock_timeout = '1s'
as $$
declare
  actor uuid := auth.uid(); actor_role text; actor_district text;
  district_filter text; material_filter text; result_rows jsonb; total integer;
begin
  if actor is null then raise sqlstate '28000' using message = 'Authentication required'; end if;
  select role::text, district_id into actor_role, actor_district
  from public.user_profiles where user_id = actor and is_active;
  if actor_role is null then return jsonb_build_object('status','forbidden'); end if;
  if p_tool is distinct from 'get_operations_overview' or p_request_id is null
    or p_args is null or jsonb_typeof(p_args) <> 'object' or octet_length(p_args::text) > 2000 then
    return jsonb_build_object('status','invalid_input');
  end if;
  if exists(select 1 from jsonb_each(p_args) e where e.key not in ('view','material_id','district_id')
    or jsonb_typeof(e.value) <> 'string' or length(e.value #>> '{}') not between 1 and 100)
    or coalesce(p_args->>'view','') not in ('risk','delivery') then
    return jsonb_build_object('status','invalid_input');
  end if;
  material_filter := p_args->>'material_id'; district_filter := p_args->>'district_id';
  if (material_filter is not null and material_filter !~ '^[A-Za-z0-9._/-]{1,100}$')
    or (district_filter is not null and district_filter !~ '^55(0[1-9]|1[0-8])$') then
    return jsonb_build_object('status','invalid_input');
  end if;
  if actor_role = 'district' then
    if actor_district is null or (district_filter is not null and district_filter <> actor_district) then
      return jsonb_build_object('status','forbidden');
    end if;
    district_filter := actor_district;
  end if;
  -- The admission must be caller-bound, recent and issued before a paid model call.
  if not exists(select 1 from audit.vmi_chat_admissions where request_id = p_request_id
    and actor_id = actor and created_at > clock_timestamp() - interval '2 minutes') then
    return jsonb_build_object('status','forbidden');
  end if;
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result_rows from (
    select h.material_id,h.material_name,m.unit,h.district_id,h.district_name_th,
      h.current_stock_qty,h.cmp_monthly,h.months_available,h.health_band,h.snapshot_at,
      h.usage_as_of_date,h.input_data_class,h.stock_source_status,
      p.plan_number,p.plan_status,p.item_status,p.suggested_qty,p.confirmed_qty,p.final_qty,
      p.priority_score,p.updated_at as plan_updated_at
    from analytics.v_stock_health h join core.materials m using(material_id)
    left join lateral (
      select q.plan_number,q.plan_status,q.item_status,q.suggested_qty,q.confirmed_qty,
        q.final_qty,q.priority_score,q.updated_at
      from analytics.v_replenishment_queue q
      where q.material_id=h.material_id and q.district_id=h.district_id
        and q.plan_status not in ('cancelled','completed')
        and q.item_status not in ('rejected','shipped','cancelled')
      order by q.created_at desc,q.version_no desc,q.replenishment_item_id limit 1
    ) p on p_args->>'view' = 'delivery'
    where (material_filter is null or h.material_id=material_filter)
      and (district_filter is null or h.district_id=district_filter)
      and not h.source_stock_missing and h.cmp_monthly > 0
      and (h.health_band in ('critical','watch')
        or (p_args->>'view'='delivery' and p.suggested_qty > 0))
    order by h.months_available asc nulls last,p.priority_score desc nulls last,
      h.district_id,h.material_id limit 21
  ) q;
  total := jsonb_array_length(result_rows);
  select coalesce(jsonb_agg(value order by ordinal),'[]'::jsonb) into result_rows
    from jsonb_array_elements(result_rows) with ordinality e(value,ordinal) where ordinal <= 20;
  return jsonb_build_object('request_id',p_request_id,'tool',p_tool,'view',p_args->>'view',
    'status',case when total=0 then 'no_data' else 'ok' end,'data',result_rows,
    'scope',jsonb_build_object('role',actor_role,'district_id',district_filter,'truncated',total>20),
    'sources',jsonb_build_array('analytics.v_stock_health','analytics.v_replenishment_queue'),
    'warnings',jsonb_build_array('recommendation_only','missing_stock_excluded'));
end;
$$;
revoke all on function public.vmi_chat_overview(text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.vmi_chat_overview(text,jsonb,uuid) to authenticated;

-- A reviewed snapshot, not automatic access to future tables or columns.
create table if not exists ops.chat_sources (
  source_id text primary key,
  relation regclass not null unique,
  description text not null,
  columns jsonb not null,
  access_mode text not null check (access_mode in ('admin','reporting','master','district','location'))
);
alter table ops.chat_sources enable row level security;
revoke all on ops.chat_sources from public, anon, authenticated;

insert into ops.chat_sources(source_id,relation,description,columns,access_mode)
select n.nspname||'.'||c.relname,c.oid,
  concat_ws(' ',obj_description(c.oid),replace(c.relname,'_',' '),
    case when c.relname ~ 'district' then 'เขต พื้นที่ รหัส ชื่อ นวลจันทร์'
      when c.relname ~ 'material|packaging' then 'พัสดุ วัสดุ สินค้า SKU หน่วย บรรจุภัณฑ์'
      when c.relname ~ 'stock|inventory|fifo|handling|receipt' then 'สต็อก คงเหลือ คลัง รับ จ่าย เคลื่อนไหว ประวัติ'
      when c.relname ~ 'contract|vendor|delivery' then 'สัญญา PO จัดซื้อ ผู้ขาย ส่งมอบ'
      when c.relname ~ 'usage|demand|forecast' then 'อัตราใช้ CMP พยากรณ์ รายเดือน ย้อนหลัง'
      when c.relname ~ 'replenishment|quantity|approval|adjustment' then 'แผนเติม แนะนำ ปริมาณ อนุมัติ ยืนยัน'
      when c.relname ~ 'transport|route|vehicle|driver' then 'ขนส่ง เส้นทาง รถ คนขับ เที่ยว ค่าขนส่ง'
      when c.relname ~ 'warehouse|location' then 'คลัง ที่ตั้ง สถานที่'
      else 'ข้อมูลระบบ นำเข้า คุณภาพ หลักฐาน' end),
  (select jsonb_object_agg(a.attname,format_type(a.atttypid,a.atttypmod))
   from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
   and a.attname !~* 'password|secret|token|api_key|authorization'),
  case when c.relname in ('districts','materials','warehouses','locations','transport_warehouses','sap_plant_district_map') then 'master'
    when n.nspname in ('core','analytics','ops') and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='district_id') then 'district'
    when n.nspname in ('core','analytics') and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='location_id') then 'location'
    when n.nspname in ('core','analytics') or c.relname in ('data_quality_rules','data_quality_issues') then 'reporting'
    else 'admin' end
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname in ('core','analytics','ops','raw','staging','reference_data')
    or (n.nspname='public' and c.relname in ('contracts','user_profiles'))
    or (n.nspname='audit' and c.relname='change_log')) and c.relkind in ('r','v','m')
  and c.relname not in ('chat_sources','one_time_worker_triggers','api_rate_limit_windows')
  -- seed once: a database that already has a reviewed snapshot keeps it
  and not exists (select 1 from ops.chat_sources);

-- Access checks run again for every read; model-selected scope is never authority.
create or replace function ops.chat_source_predicate(p_source text,p_role text,p_district text)
returns text language plpgsql stable set search_path=pg_catalog as $$
declare mode text;
begin
  select access_mode into mode from ops.chat_sources where source_id=p_source;
  if mode is null then return null; end if;
  if p_role='admin' or mode='master' then return 'true'; end if;
  if p_role in ('planner','viewer') and mode<>'admin' then return 'true'; end if;
  if mode='district' then
    if p_role='district' and p_district is not null then
      return format('t.district_id = %L',p_district);
    elsif p_role in ('academic','picker') then return 'true'; end if;
  end if;
  if mode='location' and p_role='district' and p_district is not null then
    return format('t.location_id in (select location_id from core.locations where district_id=%L or location_type=''WAREHOUSE'')',p_district);
  end if;
  if mode='location' and p_role in ('academic','picker') then return 'true'; end if;
  return null;
end $$;
revoke all on function ops.chat_source_predicate(text,text,text) from public,anon,authenticated;

create or replace function public.vmi_chat_database(p_tool text,p_args jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
set statement_timeout='5s' set lock_timeout='1s' as $$
declare
  actor_role text; actor_district text; src ops.chat_sources%rowtype;
  predicate text; projection text:=''; grouping text:=''; ordering text:=''; sql text;
  item jsonb; col text; op text; value text; typ text; agg text; output_name text;
  selected text[]:='{}'; output_columns text[]:='{}'; result jsonb; result_count integer;
  row_limit integer; row_offset integer; search_text text; search_columns text:='';
begin
  if auth.uid() is null then raise sqlstate '28000' using message='Authentication required'; end if;
  select role::text,district_id into actor_role,actor_district from public.user_profiles where user_id=auth.uid() and is_active;
  if actor_role is null or not exists(select 1 from audit.vmi_chat_admissions
      where request_id=p_request_id and actor_id=auth.uid() and created_at>clock_timestamp()-interval '2 minutes') then
    return jsonb_build_object('status','forbidden');
  end if;
  if p_args is null or jsonb_typeof(p_args)<>'object' or octet_length(p_args::text)>16000 then
    return jsonb_build_object('status','invalid_input');
  end if;
  if p_tool='discover_database' then
    select coalesce(jsonb_agg(jsonb_build_object('source_id',source_id,'description',description,'columns',columns) order by source_id),'[]') into result
    from ops.chat_sources where ops.chat_source_predicate(source_id,actor_role,actor_district) is not null;
    return jsonb_build_object('status','ok','tool',p_tool,'data',result,'scope',jsonb_build_object('role',actor_role,'district_id',actor_district));
  end if;
  if p_tool<>'query_database' or exists(select 1 from jsonb_object_keys(p_args) k where k not in
    ('source_id','columns','filters','group_by','metrics','order_column','order_direction','limit','offset','search')) then
    return jsonb_build_object('status','invalid_input');
  end if;
  select * into src from ops.chat_sources where source_id=p_args->>'source_id';
  predicate := ops.chat_source_predicate(src.source_id,actor_role,actor_district);
  if predicate is null then return jsonb_build_object('status','forbidden'); end if;
  row_limit:=coalesce((p_args->>'limit')::integer,20); row_offset:=coalesce((p_args->>'offset')::integer,0);
  if row_limit not between 1 and 50 or row_offset not between 0 and 10000 then raise invalid_parameter_value; end if;
  if jsonb_typeof(coalesce(p_args->'filters','[]'))<>'array' or jsonb_array_length(coalesce(p_args->'filters','[]'))>12
    or jsonb_typeof(coalesce(p_args->'metrics','[]'))<>'array' or jsonb_array_length(coalesce(p_args->'metrics','[]'))>6
    or jsonb_typeof(coalesce(p_args->'group_by','[]'))<>'array' or jsonb_array_length(coalesce(p_args->'group_by','[]'))>4
    or jsonb_typeof(coalesce(p_args->'columns','[]'))<>'array' or jsonb_array_length(coalesce(p_args->'columns','[]'))>16 then raise invalid_parameter_value; end if;
  for item in select * from jsonb_array_elements(coalesce(p_args->'filters','[]')) loop
    if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k where k not in ('column','operator','value')) then raise invalid_parameter_value; end if;
    col:=item->>'column'; op:=item->>'operator'; value:=item->>'value'; typ:=src.columns->>col;
    if typ is null or length(value)>1000 then raise invalid_parameter_value; end if;
    if op in ('is_null','not_null') then predicate:=predicate||format(' and t.%I is %s null',col,case when op='not_null' then 'not' else '' end);
    elsif value is null then raise invalid_parameter_value;
    elsif op='contains' then predicate:=predicate||format(' and strpos(lower(t.%I::text),lower(%L))>0',col,value);
    elsif op in ('eq','ne','gt','gte','lt','lte') then
      predicate:=predicate||format(' and t.%I %s %L::%s',col,case op when 'eq' then '=' when 'ne' then '<>' when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end,value,typ);
    else raise invalid_parameter_value; end if;
  end loop;
  search_text:=nullif(btrim(p_args->>'search'),'');
  if search_text is not null then
    if length(search_text)>200 then raise invalid_parameter_value; end if;
    select string_agg(format('coalesce(t.%I::text,'''')',key),',') into search_columns from jsonb_each_text(src.columns);
    predicate:=predicate||format(' and strpos(lower(concat_ws('' '',%s)),lower(%L))>0',search_columns,search_text);
  end if;
  if jsonb_array_length(coalesce(p_args->'metrics','[]'))>0 then
    for col in select jsonb_array_elements_text(coalesce(p_args->'group_by','[]')) loop
      if not src.columns ? col or col=any(selected) then raise invalid_parameter_value; end if;
      selected:=array_append(selected,col); projection:=concat_ws(', ',nullif(projection,''),format('t.%I',col));
      grouping:=concat_ws(', ',nullif(grouping,''),format('t.%I',col));
    end loop;
    output_columns:=selected;
    for item in select * from jsonb_array_elements(p_args->'metrics') loop
      if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k where k not in ('function','column')) then raise invalid_parameter_value; end if;
      col:=item->>'column'; agg:=item->>'function'; typ:=src.columns->>col;
      if agg not in ('count','sum','avg','min','max') or (col<>'*' and typ is null) or (col='*' and agg<>'count') then raise invalid_parameter_value; end if;
      if agg in ('sum','avg') and typ !~ '^(smallint|integer|bigint|numeric|real|double precision)' then raise invalid_parameter_value; end if;
      output_name:=agg||'_'||case when col='*' then 'rows' else col end;
      if output_name=any(output_columns) then raise invalid_parameter_value; end if;
      output_columns:=array_append(output_columns,output_name);
      projection:=concat_ws(', ',nullif(projection,''),format('%s(%s) as %I',agg,case when col='*' then '*' else format('t.%I',col) end,output_name));
    end loop;
  else
    if jsonb_array_length(coalesce(p_args->'group_by','[]'))>0 then raise invalid_parameter_value; end if;
    for col in select jsonb_array_elements_text(coalesce(p_args->'columns','[]')) loop
      if not src.columns ? col or col=any(selected) then raise invalid_parameter_value; end if;
      selected:=array_append(selected,col);
    end loop;
    if cardinality(selected)=0 then select array_agg(key) into selected from (select key from jsonb_object_keys(src.columns) key order by key limit 16) q; end if;
    select string_agg(format('t.%I',x),', ') into projection from unnest(selected) x;
    output_columns:=selected;
  end if;
  col:=nullif(p_args->>'order_column','');
  if col is not null then
    if not col=any(output_columns) or coalesce(p_args->>'order_direction','asc') not in ('asc','desc') then raise invalid_parameter_value; end if;
    ordering:=format(' order by %I %s nulls last',col,coalesce(p_args->>'order_direction','asc'));
  else ordering:=' order by 1'; end if;
  sql:=format('select coalesce(jsonb_agg(to_jsonb(q)),''[]'') from (select %s from %s t where %s%s%s limit %s offset %s) q',
    projection,src.relation,predicate,case when grouping<>'' then ' group by '||grouping else '' end,ordering,row_limit+1,row_offset);
  execute sql into result;
  result_count:=jsonb_array_length(result);
  select coalesce(jsonb_agg(e.value order by e.ord),'[]') into result from jsonb_array_elements(result) with ordinality e(value,ord) where e.ord<=row_limit;
  return jsonb_build_object('status',case when result_count=0 then 'no_data' else 'ok' end,'tool',p_tool,
    'source_id',src.source_id,'data',result,'sources',jsonb_build_array(src.source_id),
    'scope',jsonb_build_object('role',actor_role,'district_id',actor_district,'truncated',result_count>row_limit),
    'query',p_args,'aggregation',jsonb_array_length(coalesce(p_args->'metrics','[]'))>0,'observed_at',clock_timestamp());
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range or undefined_function or datatype_mismatch then
  return jsonb_build_object('status','invalid_input');
end $$;
revoke all on function public.vmi_chat_database(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.vmi_chat_database(text,jsonb,uuid) to authenticated;

-- Reviewed document knowledge, BGE-M3 (1024-dim) vectors.
create table if not exists rag.knowledge_chunks_bge_m3 (
  id uuid primary key default gen_random_uuid(),
  source_id text not null check (length(source_id) between 1 and 500),
  title text not null check (length(title) between 1 and 500),
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (length(content) between 1 and 8000),
  embedding extensions.vector(1024) not null,
  embedding_model text not null default 'baai/bge-m3'
    check (embedding_model = 'baai/bge-m3'),
  allowed_roles text[] not null default array['admin']::text[]
    check (cardinality(allowed_roles) > 0 and allowed_roles <@ array['admin','planner','district','viewer','academic','picker']::text[]),
  district_id text references core.districts(district_id),
  updated_at timestamptz not null default now(),
  unique(source_id, chunk_index)
);
comment on table rag.knowledge_chunks_bge_m3 is 'Reviewed document chunks; semantic retrieval only. Operational values must be queried live.';
alter table rag.knowledge_chunks_bge_m3 enable row level security;
revoke all on rag.knowledge_chunks_bge_m3 from public, anon, authenticated;
grant usage on schema rag to authenticated;
grant select on rag.knowledge_chunks_bge_m3 to authenticated;
grant all on rag.knowledge_chunks_bge_m3 to service_role;
drop policy if exists knowledge_read on rag.knowledge_chunks_bge_m3;
create policy knowledge_read on rag.knowledge_chunks_bge_m3 for select to authenticated using (
  exists (select 1 from public.user_profiles p where p.user_id = (select auth.uid()) and p.is_active
    and (p.role::text = 'admin' or (p.role::text = any(allowed_roles)
      and (knowledge_chunks_bge_m3.district_id is null or knowledge_chunks_bge_m3.district_id = p.district_id))))
);
create index if not exists knowledge_chunks_bge_m3_embedding_hnsw on rag.knowledge_chunks_bge_m3
  using hnsw (embedding extensions.vector_cosine_ops);

create or replace function public.vmi_chat_knowledge_bge_m3(p_embedding extensions.vector(1024), p_limit integer default 6)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog
set statement_timeout = '5s' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise sqlstate '28000' using message = 'Authentication required'; end if;
  if p_embedding is null or extensions.vector_dims(p_embedding) <> 1024
    or extensions.vector_norm(p_embedding) = 0 or p_limit is null or p_limit not between 1 and 12 then
    return jsonb_build_object('status','invalid_input','tool','search_knowledge');
  end if;
  select coalesce(jsonb_agg(to_jsonb(matches)), '[]'::jsonb) into result from (
    select id, source_id, title, content, updated_at,
      1 - (embedding operator(extensions.<=>) p_embedding) as similarity
    from rag.knowledge_chunks_bge_m3
    where embedding_model = 'baai/bge-m3'
      and 1 - (embedding operator(extensions.<=>) p_embedding) >= 0.5
    order by embedding operator(extensions.<=>) p_embedding limit p_limit
  ) matches;
  return jsonb_build_object('status',case when jsonb_array_length(result)>0 then 'ok' else 'no_data' end,
    'tool','search_knowledge','data',result,'observed_at',now(),
    'sources',(select coalesce(jsonb_agg(distinct x->>'source_id'),'[]'::jsonb) from jsonb_array_elements(result) x));
end $$;
revoke all on function public.vmi_chat_knowledge_bge_m3(extensions.vector,integer) from public,anon;
grant execute on function public.vmi_chat_knowledge_bge_m3(extensions.vector,integer) to authenticated;

insert into ops.schema_migrations(version,module,description,source_file)
values('202611100001','CHAT','Chat assistant: scoped reads, admission, overview, database catalog and BGE-M3 knowledge.',
  'supabase/migrations/202611100001_chat_assistant.sql')
on conflict (version) do nothing;
notify pgrst, 'reload schema';
commit;
