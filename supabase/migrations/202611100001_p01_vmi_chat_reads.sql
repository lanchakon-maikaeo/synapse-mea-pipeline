-- Ported from dev (20260908101212..20261004024530 became 202611100001..008).
-- A database that already ran the dev files must register the new versions
-- instead of applying them; see the porting PR for the SQL.
-- P01: exact, bounded VMI reads. Existing dashboard RPCs are unchanged.
begin;

create table audit.vmi_chat_requests (
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
create index vmi_chat_requests_actor_time on audit.vmi_chat_requests(actor_id, created_at);
alter table audit.vmi_chat_requests enable row level security;
revoke all on audit.vmi_chat_requests from public, anon, authenticated;
create trigger vmi_chat_requests_append_only before update or delete
  on audit.vmi_chat_requests for each row execute function audit.reject_append_only_mutation();

create function public.vmi_chat_read(
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
      sources := jsonb_build_array('analytics.v_quantity_recommendations');
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
          (p_args ? 'issue_reference' and t.issue_reference = p_args->>'issue_reference')
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

insert into ops.schema_migrations(version,module,description,source_file)
values('202611100001','P01','Bounded VMI chat reads with caller-derived append-only audit.',
  'supabase/migrations/202611100001_p01_vmi_chat_reads.sql');
notify pgrst, 'reload schema';
commit;
