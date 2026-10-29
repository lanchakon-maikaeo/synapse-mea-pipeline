\set ON_ERROR_STOP on

-- M17 planner selection: the planner's picks replace the system proposal on an
-- open plan before districts confirm. Everything runs inside a rolled-back
-- transaction with isolated fixtures.

begin;

create temporary table m17ps_checks (
  check_name text primary key,
  passed boolean not null
);
create temporary table m17ps_state (
  ok_result jsonb,
  no_cmp_result jsonb,
  responded_result jsonb,
  viewer_result jsonb,
  locked_result jsonb,
  closed_plan_result jsonb
);
insert into m17ps_state default values;
grant select, insert, update on m17ps_checks, m17ps_state to authenticated;

insert into auth.users (id, raw_user_meta_data)
values
  ('17000000-0000-4000-8000-000000000001', '{"display_name":"M17 Planner"}'),
  ('17000000-0000-4000-8000-000000000002', '{"display_name":"M17 Viewer"}');

update public.user_profiles set role = 'planner', district_id = null
where user_id = '17000000-0000-4000-8000-000000000001';
update public.user_profiles set role = 'viewer', district_id = null
where user_id = '17000000-0000-4000-8000-000000000002';

insert into raw.import_batches (
  batch_id, source_system, source_file, source_sheet, source_checksum,
  row_count, status, imported_at, metadata
) values (
  '17000000-0000-4000-8000-000000000010', 'm17-contract-test',
  'm17-contract-test.csv', 'm17', repeat('e', 64), 4, 'succeeded', now(),
  '{"isolated":true}'::jsonb
);

insert into core.materials (
  material_id, sap_material_id, material_name, category, unit,
  weight_per_unit_kg, is_vmi, master_source, data_quality_status, source_batch_id
)
select id, id, 'M17 material ' || id, 'TEST', 'EA', 1, true,
  'material_master', 'valid', '17000000-0000-4000-8000-000000000010'
from unnest(array['M17-A', 'M17-B', 'M17-C', 'M17-D']) as id;

-- Stock + CMP so M17-C can be added for district 5503; M17-D has none.
insert into core.stock_snapshots (
  snapshot_id, material_id, location_id, quantity_on_hand, snapshot_at,
  source_batch_id, data_class, source_quality, created_at
) values (
  '17000000-0000-4000-8000-000000000401', 'M17-C', 'DIST-5503', 12,
  statement_timestamp() - interval '1 day',
  '17000000-0000-4000-8000-000000000010', 'test_fixture', 'source_derived',
  statement_timestamp() - interval '1 day'
);
insert into core.usage_rates (
  usage_rate_id, material_id, district_id, as_of_date, cmp_monthly,
  avg_ly, avg_12m, avg_6m, avg_4m, source_batch_id, data_class,
  source_quality, created_at, updated_at
) values (
  '17000000-0000-4000-8000-000000000411', 'M17-C', '5503', current_date - 1,
  10, 10, 10, 10, 10, '17000000-0000-4000-8000-000000000010', 'test_fixture',
  'source_derived', statement_timestamp() - interval '1 day',
  statement_timestamp() - interval '1 day'
);

insert into ops.replenishment_runs (
  replenishment_run_id, policy_version, snapshot_cutoff_at, status,
  candidate_count, initiated_by, finished_at
) values
  ('17000000-0000-4000-8000-000000000101', 'v1.0.0', now(), 'succeeded', 3,
   '17000000-0000-4000-8000-000000000001', now()),
  ('17000000-0000-4000-8000-000000000102', 'v1.0.0', now(), 'succeeded', 1,
   '17000000-0000-4000-8000-000000000001', now());

insert into core.replenishment_plans (
  replenishment_plan_id, replenishment_run_id, plan_number, week_start_date,
  version_no, origin_location_id, status, response_due_at, created_by
) values
  ('17000000-0000-4000-8000-000000000201', '17000000-0000-4000-8000-000000000101',
   'RP-M17-OPEN', date_trunc('week', current_date)::date + 70, 1, 'WH-KT',
   'pending_district_confirmation', now() + interval '1 day',
   '17000000-0000-4000-8000-000000000001'),
  ('17000000-0000-4000-8000-000000000202', '17000000-0000-4000-8000-000000000102',
   'RP-M17-CLOSED', date_trunc('week', current_date)::date + 77, 1, 'WH-KT',
   'pending_academic_approval', now() + interval '1 day',
   '17000000-0000-4000-8000-000000000001');

insert into core.replenishment_items (
  replenishment_item_id, replenishment_plan_id, material_id, district_id,
  current_stock_qty, cmp_monthly, months_available, min_fill_qty, max_fill_qty,
  suggested_qty, requested_qty, final_qty, projected_months_after,
  source_stock_missing, priority_score, priority_band, status
) values
  ('17000000-0000-4000-8000-000000000301', '17000000-0000-4000-8000-000000000201',
   'M17-A', '5501', 20, 20, 1, 60, 100, 100, 100, 100, 6, false, 8, 'critical', 'pending'),
  ('17000000-0000-4000-8000-000000000302', '17000000-0000-4000-8000-000000000201',
   'M17-B', '5501', 10, 10, 1, 30, 50, 50, 50, 50, 6, false, 8, 'critical', 'pending'),
  ('17000000-0000-4000-8000-000000000303', '17000000-0000-4000-8000-000000000201',
   'M17-A', '5502', 20, 20, 1, 60, 100, 100, 100, 100, 6, false, 8, 'critical',
   'district_confirmed'),
  ('17000000-0000-4000-8000-000000000304', '17000000-0000-4000-8000-000000000202',
   'M17-A', '5501', 20, 20, 1, 60, 100, 100, 100, 100, 6, false, 8, 'critical',
   'district_confirmed');

update ops.environment_controls
set operational_writes_enabled = true, updated_at = now()
where singleton;

-- Planner sends: keep A@5501 at 80, add C@5503 = 20, drop B@5501.
select set_config('request.jwt.claim.sub', '17000000-0000-4000-8000-000000000001', true);
set local role authenticated;

update m17ps_state set ok_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/17000000-0000-4000-8000-000000000201/planner-selection',
  '{}'::jsonb,
  '{
    "lines": [
      {"replenishment_item_id": "17000000-0000-4000-8000-000000000301",
       "district_id": "5501", "material_id": "M17-A", "quantity": 80,
       "source": "system", "reason": ""},
      {"replenishment_item_id": null, "district_id": "5503",
       "material_id": "M17-C", "quantity": 20, "source": "added",
       "reason": "งานโครงการของเขต"}
    ],
    "dropped": [
      {"replenishment_item_id": "17000000-0000-4000-8000-000000000302",
       "reason": "เขตแจ้งว่ายังมีพอ"}
    ]
  }'::jsonb,
  'm17-ok'
);

update m17ps_state set no_cmp_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/17000000-0000-4000-8000-000000000201/planner-selection',
  '{}'::jsonb,
  '{"lines": [{"replenishment_item_id": null, "district_id": "5503",
     "material_id": "M17-D", "quantity": 5, "reason": "ทดสอบ"}], "dropped": []}'::jsonb,
  'm17-no-cmp'
);

update m17ps_state set responded_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/17000000-0000-4000-8000-000000000201/planner-selection',
  '{}'::jsonb,
  '{"lines": [{"replenishment_item_id": "17000000-0000-4000-8000-000000000303",
     "district_id": "5502", "material_id": "M17-A", "quantity": 5}], "dropped": []}'::jsonb,
  'm17-responded'
);

update m17ps_state set closed_plan_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/17000000-0000-4000-8000-000000000202/planner-selection',
  '{}'::jsonb,
  '{"lines": [{"replenishment_item_id": "17000000-0000-4000-8000-000000000304",
     "district_id": "5501", "material_id": "M17-A", "quantity": 5}], "dropped": []}'::jsonb,
  'm17-closed'
);

reset role;
select set_config('request.jwt.claim.sub', '17000000-0000-4000-8000-000000000002', true);
set local role authenticated;
update m17ps_state set viewer_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/17000000-0000-4000-8000-000000000201/planner-selection',
  '{}'::jsonb,
  '{"lines": [], "dropped": []}'::jsonb,
  'm17-viewer'
);
reset role;

-- District confirming the planner's quantity is a confirmation, not a change.
select set_config('request.jwt.claim.sub', '17000000-0000-4000-8000-000000000001', true);
select core.respond_replenishment_item(
  '17000000-0000-4000-8000-000000000301', 'confirm', 80, 'เขตยืนยันตามแผน', 'M17 District'
);
insert into m17ps_checks
select 'district confirm at planner qty is not a change',
  status = 'district_confirmed' and final_qty = 80
from core.replenishment_items
where replenishment_item_id = '17000000-0000-4000-8000-000000000301';

update ops.environment_controls set operational_writes_enabled = false where singleton;
select set_config('request.jwt.claim.sub', '17000000-0000-4000-8000-000000000001', true);
set local role authenticated;
update m17ps_state set locked_result = public.m09_dispatch(
  'POST',
  '/v1/replenishment/plans/17000000-0000-4000-8000-000000000201/planner-selection',
  '{}'::jsonb,
  '{"lines": [], "dropped": []}'::jsonb,
  'm17-locked'
);
reset role;

insert into m17ps_checks
select 'selection accepted', (ok_result ->> 'status')::int = 200
  and (ok_result #>> '{body,kept}')::int = 1
  and (ok_result #>> '{body,added}')::int = 1
  and (ok_result #>> '{body,dropped}')::int = 1
  and (ok_result #>> '{body,quantity_changed}')::int = 1
from m17ps_state;

insert into m17ps_checks
select 'kept line uses planner qty and remembers system qty',
  planner_qty = 80 and requested_qty = 80 and final_qty = 80
  and suggested_qty = 100
  and projected_months_after = 5 and planner_source = 'system'
  and planner_selected_by = '17000000-0000-4000-8000-000000000001'
from core.replenishment_items
where replenishment_item_id = '17000000-0000-4000-8000-000000000301';

insert into m17ps_checks
select 'unpicked proposal cancelled with reason',
  status = 'cancelled' and suggested_qty = 50 and planner_qty is null
  and district_note like 'Planner ไม่ส่ง: เขตแจ้งว่ายังมีพอ'
from core.replenishment_items
where replenishment_item_id = '17000000-0000-4000-8000-000000000302';

insert into m17ps_checks
select 'added line inserted from stock health',
  count(*) = 1
  and bool_and(planner_qty = 20 and suggested_qty = 0 and planner_source = 'added'
    and planner_note = 'งานโครงการของเขต' and status = 'pending'
    and cmp_monthly = 10 and current_stock_qty = 12
    and final_qty = 20)
from core.replenishment_items
where replenishment_plan_id = '17000000-0000-4000-8000-000000000201'
  and material_id = 'M17-C' and district_id = '5503';

insert into m17ps_checks
select 'quantity change is audited', count(*) = 1
from ops.replenishment_adjustments
where replenishment_item_id = '17000000-0000-4000-8000-000000000301'
  and previous_qty = 100 and new_qty = 80;

insert into m17ps_checks
select 'district-responded line untouched',
  status = 'district_confirmed' and suggested_qty = 100
from core.replenishment_items
where replenishment_item_id = '17000000-0000-4000-8000-000000000303';

insert into m17ps_checks
select 'plan stays open for districts', status = 'pending_district_confirmation'
from core.replenishment_plans
where replenishment_plan_id = '17000000-0000-4000-8000-000000000201';

insert into m17ps_checks
select 'queue view exposes planner columns', count(*) = 1
from analytics.v_replenishment_queue
where replenishment_item_id = '17000000-0000-4000-8000-000000000301'
  and planner_qty = 80 and suggested_qty = 100 and planner_source = 'system';

insert into m17ps_checks
select 'material without CMP rejected', (no_cmp_result ->> 'status')::int = 400
  and no_cmp_result::text like '%CMP%'
from m17ps_state;

insert into m17ps_checks
select 'responded line rejected', (responded_result ->> 'status')::int = 400
from m17ps_state;

insert into m17ps_checks
select 'plan past district review rejected', (closed_plan_result ->> 'status')::int = 400
from m17ps_state;

insert into m17ps_checks
select 'viewer forbidden', (viewer_result ->> 'status')::int = 403
from m17ps_state;

insert into m17ps_checks
select 'write lock honoured', (locked_result ->> 'status')::int = 423
from m17ps_state;

do $$
declare
  v_failed text;
begin
  select string_agg(check_name, ', ') into v_failed
  from m17ps_checks where not passed;
  if v_failed is not null then
    raise exception 'M17 planner selection checks failed: %', v_failed;
  end if;
  if (select count(*) from m17ps_checks) <> 14 then
    raise exception 'M17 planner selection: expected 14 checks';
  end if;
end
$$;

select check_name, passed from m17ps_checks order by check_name;

rollback;
