\set ON_ERROR_STOP on

begin;

create temporary table functional_test_state (
  payload jsonb not null,
  publish_result jsonb,
  repeat_result jsonb,
  receipt_old_result jsonb,
  receipt_opening_result jsonb,
  reconcile_result jsonb,
  district_response_result jsonb,
  change_review_result jsonb,
  planner_approval_result jsonb,
  academic_approval_result jsonb,
  issue_result jsonb,
  return_result jsonb,
  ad_hoc_create_result jsonb,
  ad_hoc_approve_result jsonb,
  ad_hoc_issue_result jsonb,
  trace_result jsonb,
  excluded_forecast_result jsonb,
  excluded_route_result jsonb,
  cross_district_result jsonb,
  viewer_result jsonb,
  contract_item_id bigint,
  replenishment_run_id uuid,
  replenishment_plan_id uuid,
  replenishment_item_id uuid,
  change_request_id uuid,
  older_handling_unit_id uuid,
  opening_handling_unit_id uuid,
  weekly_issue_movement_id uuid,
  ad_hoc_issue_id uuid,
  suggested_qty numeric
);

create temporary table functional_checks (
  check_name text primary key,
  passed boolean not null
);

insert into auth.users (id, raw_user_meta_data)
values
  ('10000000-0000-4000-8000-000000000001', '{"display_name":"Local Admin"}'),
  ('10000000-0000-4000-8000-000000000002', '{"display_name":"Local Viewer"}'),
  ('10000000-0000-4000-8000-000000000003', '{"display_name":"Local District"}'),
  ('10000000-0000-4000-8000-000000000004', '{"display_name":"Local Planner"}'),
  ('10000000-0000-4000-8000-000000000005', '{"display_name":"Local Academic"}'),
  ('10000000-0000-4000-8000-000000000006', '{"display_name":"Local Picker"}');

update public.user_profiles
set role = 'admin', district_id = null
where user_id = '10000000-0000-4000-8000-000000000001';

update public.user_profiles
set role = 'district', district_id = '5501'
where user_id = '10000000-0000-4000-8000-000000000003';

update public.user_profiles
set role = 'planner', district_id = null
where user_id = '10000000-0000-4000-8000-000000000004';

update public.user_profiles
set role = 'academic', district_id = null
where user_id = '10000000-0000-4000-8000-000000000005';

update public.user_profiles
set role = 'picker', district_id = null
where user_id = '10000000-0000-4000-8000-000000000006';

with fixture_batch as (
  insert into raw.import_batches (
    source_system,
    source_file,
    source_sheet,
    source_checksum,
    row_count,
    status,
    imported_at,
    metadata
  )
  values (
    'local-contract-test',
    'local-production-workflow.csv',
    'contract',
    repeat('a', 64),
    1,
    'succeeded',
    now(),
    '{"isolated":true}'::jsonb
  )
  returning batch_id
), fixture_source as (
  insert into raw.source_rows (
    batch_id,
    source_entity,
    source_sheet,
    source_row_number,
    row_hash,
    payload
  )
  select
    batch_id,
    'contract_item',
    'contract',
    1,
    repeat('b', 64),
    '{"material_id":"LOCAL-VMI-001"}'::jsonb
  from fixture_batch
  returning source_row_id, batch_id
), fixture_material as (
  insert into core.materials (
    material_id,
    sap_material_id,
    material_name,
    category,
    unit,
    is_vmi,
    master_source,
    data_quality_status,
    source_batch_id
  )
  select
    'LOCAL-VMI-001',
    'LOCAL-VMI-001',
    'Local production workflow material',
    'TEST',
    'EA',
    true,
    'material_master',
    'valid',
    batch_id
  from fixture_source
  returning material_id, source_batch_id
), fixture_vendor as (
  insert into core.vendors (vendor_name, normalized_name)
  values ('Local Traceable Vendor', 'local traceable vendor')
  returning vendor_id
), fixture_contract as (
  insert into core.contracts (
    contract_key,
    purchase_order,
    contract_number,
    procurement_code,
    vendor_id,
    start_date,
    record_date,
    document_date,
    end_date,
    source_item_count,
    source_batch_id
  )
  select
    'LOCAL-CONTRACT-001',
    4500000001,
    'MEA-LOCAL-001',
    'LOCAL',
    vendor_id,
    current_date - 30,
    current_date - 30,
    current_date - 30,
    current_date + 365,
    1,
    source_batch_id
  from fixture_vendor
  cross join fixture_material
  returning contract_id, source_batch_id
), fixture_item as (
  insert into core.contract_items (
    contract_id,
    material_id,
    source_row_id,
    source_row_number,
    line_item,
    item_description,
    unit,
    quantity,
    delivery_date,
    acceptance_date,
    validation_status,
    source_batch_id
  )
  select
    contract_id,
    'LOCAL-VMI-001',
    source_row_id,
    1,
    10,
    'Local production workflow material',
    'EA',
    3000,
    current_date - 10,
    current_date - 9,
    'valid',
    fixture_contract.source_batch_id
  from fixture_contract
  cross join fixture_source
  returning contract_item_id
)
insert into functional_test_state (payload, contract_item_id)
select
  jsonb_build_object(
    'material_id', 'LOCAL-VMI-001',
    'district_id', '5501',
    'source_note', 'isolated production workflow contract',
    'snapshot_at', now(),
    'current_stock', 10,
    'run_replenishment', true,
    'history', (
      select jsonb_agg(
        jsonb_build_object(
          'period',
          to_char(
            date_trunc('month', current_date) - make_interval(months => 13 - month_index),
            'YYYY-MM'
          ),
          'demand_quantity',
          100 + (month_index % 3),
          'stockout_days',
          0,
          'lead_time_days',
          7
        )
        order by month_index
      )
      from generate_series(0, 13) month_index
    )
  ),
  contract_item_id
from fixture_item;

grant select, update on functional_test_state to authenticated;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update functional_test_state
set publish_result = public.m10_input_dispatch(
      'POST',
      '/v1/data-inputs/vmi',
      '{}'::jsonb,
      payload,
      'local-production-publish'
    ),
    repeat_result = public.m10_input_dispatch(
      'POST',
      '/v1/data-inputs/vmi',
      '{}'::jsonb,
      payload,
      'local-production-repeat'
    );

reset role;

update functional_test_state state
set replenishment_run_id =
      (state.publish_result #>> '{body,replenishment_run_id}')::uuid,
    replenishment_plan_id = plan.replenishment_plan_id,
    replenishment_item_id = item.replenishment_item_id,
    suggested_qty = item.suggested_qty
from core.replenishment_plans plan
join core.replenishment_items item using (replenishment_plan_id)
where plan.replenishment_run_id =
      (state.publish_result #>> '{body,replenishment_run_id}')::uuid;

insert into functional_checks (check_name, passed)
select 'admin_publish_status',
       coalesce((publish_result ->> 'status')::integer = 201, false)
from functional_test_state
union all
select 'repeat_is_idempotent',
       coalesce(
         (repeat_result ->> 'status')::integer = 201
         and (repeat_result #>> '{body,idempotent}')::boolean,
         false
       )
from functional_test_state
union all
select 'raw_lineage_rows',
       (
         select count(*) = 15
         from raw.source_rows
         where batch_id = (
           select (publish_result #>> '{body,batch_id}')::uuid
           from functional_test_state
         )
       )
union all
select 'cmp_business_rule',
       (
         select cmp_monthly = round(
           (
             coalesce(avg_ly, 0)
             + coalesce(avg_12m, 0)
             + coalesce(avg_6m, 0)
             + coalesce(avg_4m, 0)
           ) / 4,
           0
         )
         from core.usage_rates
         where usage_rate_id = (
           select (publish_result #>> '{body,usage_rate_id}')::uuid
           from functional_test_state
         )
       )
union all
select 'weekly_plan_created',
       coalesce(
         (
           select replenishment_plan_id is not null
             and replenishment_item_id is not null
           from functional_test_state
         ),
         false
       );

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update functional_test_state state
set receipt_old_result = public.m09_dispatch(
      'POST',
      '/v1/inventory/receipts',
      '{}'::jsonb,
      jsonb_build_object(
        'contract_item_id', state.contract_item_id,
        'location_id', 'WH-KT',
        'acceptance_date', current_date - 10,
        'quantity', 1000,
        'handling_unit_code', 'LOCAL-HU-OLD-SEALED',
        'unit_type', 'FULL_PALLET',
        'opening_status', 'SEALED',
        'installment_no', '1',
        'source_reference', 'local acceptance document old'
      ),
      'local-receipt-old'
    ),
    receipt_opening_result = public.m09_dispatch(
      'POST',
      '/v1/inventory/receipts',
      '{}'::jsonb,
      jsonb_build_object(
        'contract_item_id', state.contract_item_id,
        'location_id', 'WH-KT',
        'acceptance_date', current_date - 5,
        'quantity', 1200,
        'handling_unit_code', 'LOCAL-HU-NEW-OPENING',
        'unit_type', 'FULL_PALLET',
        'opening_status', 'OPENING_UNKNOWN',
        'installment_no', '2',
        'source_reference', 'local opening balance evidence'
      ),
      'local-receipt-opening'
    );

reset role;

update functional_test_state
set older_handling_unit_id =
      (receipt_old_result #>> '{body,handling_unit_id}')::uuid,
    opening_handling_unit_id =
      (receipt_opening_result #>> '{body,handling_unit_id}')::uuid;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000006',
  true
);
set local role authenticated;

update functional_test_state state
set reconcile_result = public.m09_dispatch(
  'POST',
  '/v1/inventory/handling-units/'
    || state.opening_handling_unit_id
    || '/reconcile',
  '{}'::jsonb,
  '{"resolved_status":"OPEN","reason":"counted and linked to acceptance evidence"}'::jsonb,
  'local-opening-reconcile'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;

update functional_test_state state
set district_response_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/items/' || state.replenishment_item_id || '/respond',
  '{}'::jsonb,
  jsonb_build_object(
    'decision', 'change',
    'confirmed_qty', 950,
    'reason', 'documented field programme requires special quantity',
    'requester_name', 'District 5501 requester'
  ),
  'local-district-response'
);

reset role;

update functional_test_state state
set change_request_id = request.change_request_id
from ops.district_change_requests request
where request.replenishment_item_id = state.replenishment_item_id
  and request.status = 'pending_review';

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000004',
  true
);
set local role authenticated;

update functional_test_state state
set change_review_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/change-requests/'
    || state.change_request_id
    || '/review',
  '{}'::jsonb,
  '{"decision":"approved","review_note":"evidence verified; forward to Academic"}'::jsonb,
  'local-change-review'
);

update functional_test_state state
set planner_approval_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/'
    || state.replenishment_plan_id
    || '/approve',
  '{}'::jsonb,
  '{}'::jsonb,
  'local-planner-approval'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000005',
  true
);
set local role authenticated;

update functional_test_state state
set academic_approval_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/'
    || state.replenishment_plan_id
    || '/approve',
  '{}'::jsonb,
  '{"note":"Academic special approval"}'::jsonb,
  'local-academic-approval'
);

reset role;

insert into functional_checks (check_name, passed)
select 'receipts_created',
       coalesce(
         (receipt_old_result ->> 'status')::integer = 201
         and (receipt_opening_result ->> 'status')::integer = 201,
         false
       )
from functional_test_state
union all
select 'opening_unknown_reconciled',
       coalesce(
         (reconcile_result ->> 'status')::integer = 200
         and reconcile_result #>> '{body,opening_status}' = 'OPEN',
         false
       )
from functional_test_state
union all
select 'abnormal_request_detected',
       coalesce(
         (district_response_result ->> 'status')::integer = 200
         and (
           select special_approval_required
           from ops.district_change_requests
           where change_request_id = state.change_request_id
         ),
         false
       )
from functional_test_state state
union all
select 'planner_stage_completed',
       coalesce(
         (planner_approval_result ->> 'status')::integer = 200
         and planner_approval_result #>> '{body,status}'
           = 'pending_academic_approval',
         false
       )
from functional_test_state state
union all
select 'academic_lock_completed',
       coalesce(
         (academic_approval_result ->> 'status')::integer = 200
         and (
           select status = 'locked'
           from core.replenishment_plans
           where replenishment_plan_id = state.replenishment_plan_id
         ),
         false
       )
from functional_test_state state
union all
select 'open_handling_unit_first',
       coalesce(
         (
           select a.handling_unit_id = state.opening_handling_unit_id
           from ops.fifo_allocations a
           where a.replenishment_item_id = state.replenishment_item_id
           order by a.allocation_sequence
           limit 1
         ),
         false
       )
from functional_test_state state
union all
select 'special_approval_audited',
       (
         select count(*) = 2
         from ops.plan_approvals a
         join functional_test_state state
           on state.replenishment_plan_id = a.replenishment_plan_id
         where a.approval_stage in ('academic', 'lock')
       );

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000006',
  true
);
set local role authenticated;

update functional_test_state state
set issue_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/'
    || state.replenishment_plan_id
    || '/issue',
  '{}'::jsonb,
  '{}'::jsonb,
  'local-plan-issue'
);

reset role;

update functional_test_state state
set weekly_issue_movement_id = (
  select movement.inventory_movement_id
  from core.inventory_movements movement
  where movement.replenishment_item_id = state.replenishment_item_id
    and movement.movement_type = 'ISSUE'
  order by movement.occurred_at, movement.inventory_movement_id
  limit 1
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000006',
  true
);
set local role authenticated;

update functional_test_state state
set return_result = public.m09_dispatch(
  'POST',
  '/v1/inventory/returns',
  '{}'::jsonb,
  jsonb_build_object(
    'source_issue_movement_id', state.weekly_issue_movement_id,
    'quantity', 10,
    'damaged', true,
    'reason', 'physical inspection failed during district handover'
  ),
  'local-damaged-return'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;

update functional_test_state
set ad_hoc_create_result = public.m09_dispatch(
      'POST',
      '/v1/ad-hoc/issues',
      '{}'::jsonb,
      '{
        "material_id":"LOCAL-VMI-001",
        "district_id":"5501",
        "requested_qty":50,
        "reason":"emergency field replacement",
        "requester_name":"District 5501 emergency desk",
        "idempotency_key":"local-ad-hoc-001"
      }'::jsonb,
      'local-ad-hoc-create'
    ),
    cross_district_result = public.m09_dispatch(
      'POST',
      '/v1/ad-hoc/issues',
      '{}'::jsonb,
      '{
        "material_id":"LOCAL-VMI-001",
        "district_id":"5502",
        "requested_qty":10,
        "reason":"cross district denial",
        "requester_name":"District 5501"
      }'::jsonb,
      'local-cross-district'
    );

reset role;

update functional_test_state
set ad_hoc_issue_id =
      (ad_hoc_create_result #>> '{body,ad_hoc_issue_id}')::uuid;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000004',
  true
);
set local role authenticated;

update functional_test_state state
set ad_hoc_approve_result = public.m09_dispatch(
  'POST',
  '/v1/ad-hoc/issues/' || state.ad_hoc_issue_id || '/approve',
  '{}'::jsonb,
  '{"note":"emergency evidence verified"}'::jsonb,
  'local-ad-hoc-approve'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000006',
  true
);
set local role authenticated;

update functional_test_state state
set ad_hoc_issue_result = public.m09_dispatch(
  'POST',
  '/v1/ad-hoc/issues/' || state.ad_hoc_issue_id || '/issue',
  '{}'::jsonb,
  '{}'::jsonb,
  'local-ad-hoc-issue'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000003',
  true
);
set local role authenticated;

update functional_test_state
set trace_result = public.m09_dispatch(
  'GET',
  '/v1/traceability',
  '{"search":"LOCAL-VMI-001"}'::jsonb,
  '{}'::jsonb,
  'local-trace'
);

reset role;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update functional_test_state
set excluded_forecast_result = public.m09_dispatch(
      'POST',
      '/v1/forecasts/runs',
      '{}'::jsonb,
      '{}'::jsonb,
      'local-forecast-excluded'
    ),
    excluded_route_result = public.m09_dispatch(
      'POST',
      '/v1/routes/jobs',
      '{}'::jsonb,
      '{}'::jsonb,
      'local-route-excluded'
    );

reset role;

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

update functional_test_state
set viewer_result = public.m10_input_dispatch(
  'POST',
  '/v1/data-inputs/vmi',
  '{}'::jsonb,
  payload,
  'local-viewer-denial'
);

reset role;

insert into functional_checks (check_name, passed)
select 'weekly_issue_completed',
       coalesce(
         (issue_result ->> 'status')::integer = 200
         and (
           select status = 'completed'
           from core.replenishment_plans
           where replenishment_plan_id = state.replenishment_plan_id
         ),
         false
       )
from functional_test_state state
union all
select 'damaged_return_quarantined',
       coalesce(
         (return_result ->> 'status')::integer = 201
         and (
           select count(*) = 1
           from core.inventory_movements movement
           where movement.source_movement_id =
                 (return_result #>> '{body,inventory_movement_id}')::uuid
             and movement.movement_type = 'QUARANTINE'
         )
         and (
           select opening_status = 'QUARANTINED'
           from core.handling_units unit
           join core.inventory_movements movement using (handling_unit_id)
           where movement.inventory_movement_id =
                 (return_result #>> '{body,inventory_movement_id}')::uuid
         ),
         false
       )
from functional_test_state
union all
select 'ad_hoc_separate_issue_completed',
       coalesce(
         (ad_hoc_create_result ->> 'status')::integer = 201
         and (ad_hoc_approve_result ->> 'status')::integer = 200
         and (ad_hoc_issue_result ->> 'status')::integer = 200
         and (
           select status = 'issued'
           from ops.ad_hoc_issues
           where ad_hoc_issue_id = state.ad_hoc_issue_id
         ),
         false
       )
from functional_test_state state
union all
select 'traceback_has_weekly_and_ad_hoc',
       coalesce(
         (trace_result ->> 'status')::integer = 200
         and jsonb_array_length(trace_result -> 'body') >= 2
         and exists (
           select 1
           from jsonb_array_elements(trace_result -> 'body') row
           where row ->> 'issue_type' = 'WEEKLY_PLAN'
         )
         and exists (
           select 1
           from jsonb_array_elements(trace_result -> 'body') row
           where row ->> 'issue_type' = 'AD_HOC'
         )
         and not exists (
           select 1
           from jsonb_array_elements(trace_result -> 'body') row
           where coalesce(row ->> 'vendor_name', '') !~ '^SUP-[0-9]{6}$'
         ),
         false
       )
from functional_test_state
union all
select 'cross_district_request_blocked',
       coalesce(
         (cross_district_result ->> 'status')::integer = 403
         and cross_district_result #>> '{body,error,code}' = 'forbidden',
         false
       )
from functional_test_state
union all
select 'excluded_modules_fail_closed',
       coalesce(
         (excluded_forecast_result ->> 'status')::integer = 410
         and (excluded_route_result ->> 'status')::integer = 410
         and excluded_forecast_result #>> '{body,error,code}' = 'scope_excluded'
         and excluded_route_result #>> '{body,error,code}' = 'scope_excluded',
         false
       )
from functional_test_state
union all
select 'viewer_publish_forbidden',
       coalesce(
         (viewer_result ->> 'status')::integer = 403
         and viewer_result #>> '{body,error,code}' = 'forbidden',
         false
       )
from functional_test_state;

do $$
begin
  begin
    update core.inventory_movements
    set reason = 'forbidden mutation'
    where inventory_movement_id = (
      select inventory_movement_id
      from core.inventory_movements
      order by created_at
      limit 1
    );
    insert into functional_checks
    values ('inventory_movements_append_only_runtime', false);
  exception
    when raise_exception then
      insert into functional_checks
      values ('inventory_movements_append_only_runtime', true);
  end;
end
$$;

table functional_checks;

do $$
begin
  if exists(select 1 from functional_checks where not passed) then
    raise exception 'local production workflow contract failed: %',
      (
        select string_agg(check_name, ', ' order by check_name)
        from functional_checks
        where not passed
      );
  end if;
end
$$;

\ir p01_vmi_chat_verify.sql

rollback;
