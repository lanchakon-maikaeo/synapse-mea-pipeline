-- Explicit retirement script; guarded to the selected disposable Test project.
begin;
do $$
begin
  if not exists (
    select 1 from ops.environment_registry
    where environment_name='test' and project_ref='vtwtfgocokuktxfumjuz'
  ) then
    raise exception 'P01 cleanup requires test project vtwtfgocokuktxfumjuz';
  end if;
end $$;
alter table core.inventory_movements disable trigger inventory_movements_append_only;
delete from core.inventory_movements
where inventory_movement_id='00000000-0000-4000-8900-000000005501'
  and metadata->>'dataset_version'='vmi-chat-test-v1';
alter table core.inventory_movements enable trigger inventory_movements_append_only;
delete from core.handling_units where handling_unit_id='00000000-0000-4000-8800-000000005501';
delete from core.receipt_lots where receipt_lot_id='00000000-0000-4000-8700-000000005501';
delete from ops.quantity_recommendations
where recommendation_id in ('00000000-0000-4000-8500-000000005501',
  '00000000-0000-4000-8500-000000005502');
alter table ops.plan_approvals disable trigger plan_approvals_append_only;
delete from ops.plan_approvals
where plan_approval_id in ('00000000-0000-4000-8600-000000005501',
  '00000000-0000-4000-8600-000000005502','00000000-0000-4000-8600-000000009999');
alter table ops.plan_approvals enable trigger plan_approvals_append_only;
alter table ops.replenishment_run_inputs disable trigger replenishment_run_inputs_append_only;
delete from ops.replenishment_run_inputs
where replenishment_item_id in ('00000000-0000-4000-8400-000000005501',
  '00000000-0000-4000-8400-000000005502','00000000-0000-4000-8400-000000009999');
alter table ops.replenishment_run_inputs enable trigger replenishment_run_inputs_append_only;
delete from core.replenishment_items
where replenishment_item_id in ('00000000-0000-4000-8400-000000005501',
  '00000000-0000-4000-8400-000000005502','00000000-0000-4000-8400-000000009999');
delete from core.replenishment_plans
where replenishment_plan_id in ('00000000-0000-4000-8000-000000005501',
  '00000000-0000-4000-8000-000000005502','00000000-0000-4000-8000-000000009999');
delete from ops.replenishment_runs
where replenishment_run_id in ('00000000-0000-4000-8300-000000005501',
  '00000000-0000-4000-8300-000000005502','00000000-0000-4000-8300-000000009999');
delete from core.contract_item_versions where source_batch_id='00000000-0000-4000-8000-00000000b001';
delete from core.contract_items where source_batch_id='00000000-0000-4000-8000-00000000b001';
delete from core.contracts where source_batch_id='00000000-0000-4000-8000-00000000b001';
delete from core.vendors where normalized_name='test vmi supplier'
  and not exists(select 1 from core.contracts where vendor_id=core.vendors.vendor_id);
delete from core.packaging_profiles where source_batch_id='00000000-0000-4000-8000-00000000b001';
delete from core.stock_snapshots where source_batch_id='00000000-0000-4000-8000-00000000b001';
delete from core.usage_rates where source_batch_id='00000000-0000-4000-8000-00000000b001';
delete from core.materials where source_batch_id='00000000-0000-4000-8000-00000000b001';
delete from raw.source_rows where batch_id='00000000-0000-4000-8000-00000000b001';
delete from raw.import_batches where batch_id='00000000-0000-4000-8000-00000000b001';
commit;
