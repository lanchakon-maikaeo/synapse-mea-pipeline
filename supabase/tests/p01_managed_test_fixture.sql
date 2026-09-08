-- Versioned, idempotent P01 fixture for test-synapse-mea only.
begin;
do $$
begin
  if not exists (
    select 1 from ops.environment_registry
    where environment_name='test' and project_ref='vtwtfgocokuktxfumjuz'
  ) then
    raise exception 'P01 fixture requires test project vtwtfgocokuktxfumjuz';
  end if;
  if not exists (
    select 1 from core.materials
    where material_id='471050004000' and is_vmi and unit is not null
  ) or not exists (
    select 1 from core.materials
    where material_id='471050005000' and is_vmi and unit is not null
  ) then
    raise exception 'P01 fixture requires the existing governed VMI materials';
  end if;
end $$;

insert into raw.import_batches (
  batch_id, source_system, source_file, source_sheet, source_checksum,
  row_count, status, imported_at, connector_name, source_entity,
  started_at, finished_at, metadata
) values (
  '00000000-0000-4000-8000-00000000b001',
  'p01_vmi_chat_test', 'MEA_VMI_Dummy_Klongtoey.xlsx', 'P01-vmi-chat-test-v1',
  'c81b39b1aded306716da5808cff6c7fbeb479c46e06f4bba29f360be5cac6db9',
  2, 'succeeded', '2026-09-08T00:00:00Z', 'p01-managed-test',
  'vmi_chat_test_fixture', '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z',
  '{"data_class":"test_fixture","dataset_version":"vmi-chat-test-v1",
    "not_actual_sap":true,"workbook_sha256":
    "c81b39b1aded306716da5808cff6c7fbeb479c46e06f4bba29f360be5cac6db9"}'
) on conflict (source_checksum, source_sheet) do update
set status='succeeded', metadata=excluded.metadata, updated_at=now();

insert into raw.source_rows (
  batch_id, source_entity, source_sheet, source_row_number, row_hash, payload
) values
  ('00000000-0000-4000-8000-00000000b001','p01_contract','P01-vmi-chat-test-v1',1,
   repeat('a',64),'{"contract_number":"POC-CNT-001","purchase_order":"990000000000000001"}'),
  ('00000000-0000-4000-8000-00000000b001','p01_contract','P01-vmi-chat-test-v1',2,
   repeat('b',64),'{"contract_number":"POC-CNT-TRACE-001","purchase_order":"990000000000000002"}')
on conflict (batch_id,source_entity,source_row_number) do update
set row_hash=excluded.row_hash,payload=excluded.payload;

insert into core.stock_snapshots (
  snapshot_id,material_id,location_id,quantity_on_hand,snapshot_at,
  source_batch_id,data_class,source_quality
) values
 ('00000000-0000-4000-8100-000000000001','471050004000','WH-KT',17650,'2026-07-08T00:00:00+07',
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture'),
 ('00000000-0000-4000-8100-000000000002','471050004000','DIST-5501',62,'2026-07-08T00:00:00+07',
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture'),
 ('00000000-0000-4000-8100-000000000003','471050004000','DIST-5502',63,'2026-07-08T00:00:00+07',
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture'),
 ('00000000-0000-4000-8100-000000000004','471050005000','DIST-5508',55,'2026-07-08T00:00:00+07',
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture'),
 ('00000000-0000-4000-8100-000000000005','471050005000','DIST-5514',0,'2026-07-08T00:00:00+07',
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture')
on conflict (material_id,location_id,snapshot_at) do update set
 quantity_on_hand=excluded.quantity_on_hand,source_batch_id=excluded.source_batch_id,
 data_class='test_fixture',source_quality='test_fixture';

insert into core.usage_rates (
  usage_rate_id,material_id,district_id,as_of_date,cmp_monthly,
  avg_ly,avg_12m,avg_6m,avg_4m,source_batch_id,data_class,source_quality
) values
 ('00000000-0000-4000-8200-000000000001','471050004000','5501','2026-07-08',48,43.2,45.12,48,50.88,
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture'),
 ('00000000-0000-4000-8200-000000000002','471050004000','5502','2026-07-08',30,27,28.2,30,31.8,
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture'),
 ('00000000-0000-4000-8200-000000000003','471050005000','5508','2026-07-08',0,0,0,0,0,
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture'),
 ('00000000-0000-4000-8200-000000000004','471050005000','5514','2026-07-08',0,0,0,0,0,
  '00000000-0000-4000-8000-00000000b001','test_fixture','test_fixture')
on conflict (material_id,district_id,as_of_date) do update set
 cmp_monthly=excluded.cmp_monthly,avg_ly=excluded.avg_ly,avg_12m=excluded.avg_12m,
 avg_6m=excluded.avg_6m,avg_4m=excluded.avg_4m,source_batch_id=excluded.source_batch_id,
 data_class='test_fixture',source_quality='test_fixture',updated_at=now();

insert into ops.replenishment_runs (
  replenishment_run_id,policy_version,snapshot_cutoff_at,usage_cutoff_date,
  status,candidate_count,started_at,finished_at
) values
 ('00000000-0000-4000-8300-000000005501','v1.0.0','2026-07-08T00:00:00+07','2026-07-08','succeeded',1,now(),now()),
 ('00000000-0000-4000-8300-000000005502','v1.0.0','2026-07-08T00:00:00+07','2026-07-08','succeeded',1,now(),now()),
 ('00000000-0000-4000-8300-000000009999','v1.0.0','2026-07-08T00:00:00+07','2026-07-08','succeeded',1,now(),now())
on conflict (replenishment_run_id) do nothing;

insert into core.replenishment_plans (
  replenishment_plan_id,replenishment_run_id,origin_location_id,status,
  plan_number,week_start_date,version_no,response_due_at,
  planner_approved_at,academic_approved_at,locked_at
) values
 ('00000000-0000-4000-8000-000000005501','00000000-0000-4000-8300-000000005501','WH-KT',
  'pending_planner_approval','POC-PLAN-5501','2026-07-06',1,'2026-07-09T17:00:00+07',null,null,null),
 ('00000000-0000-4000-8000-000000005502','00000000-0000-4000-8300-000000005502','WH-KT',
  'pending_academic_approval','POC-PLAN-5502','2026-07-13',1,'2026-07-16T17:00:00+07',now(),null,null),
 ('00000000-0000-4000-8000-000000009999','00000000-0000-4000-8300-000000009999','WH-KT',
  'locked','POC-ISSUE-5501-001','2026-07-20',1,'2026-07-23T17:00:00+07',now(),now(),now())
on conflict (replenishment_plan_id) do nothing;

insert into core.replenishment_items (
  replenishment_item_id,replenishment_plan_id,material_id,district_id,
  source_stock_snapshot_id,source_usage_rate_id,current_stock_qty,cmp_monthly,
  months_available,min_fill_qty,max_fill_qty,suggested_qty,priority_score,
  priority_band,status,requested_qty,final_qty,district_decision
) values
 ('00000000-0000-4000-8400-000000005501','00000000-0000-4000-8000-000000005501',
  '471050004000','5501','00000000-0000-4000-8100-000000000002',
  '00000000-0000-4000-8200-000000000001',62,48,1.3,192,288,200,9,'critical',
  'district_confirmed',200,200,'confirm'),
 ('00000000-0000-4000-8400-000000005502','00000000-0000-4000-8000-000000005502',
  '471050004000','5502','00000000-0000-4000-8100-000000000003',
  '00000000-0000-4000-8200-000000000002',63,30,2.1,120,180,100,8,'high',
  'planner_approved',100,100,'confirm'),
 ('00000000-0000-4000-8400-000000009999','00000000-0000-4000-8000-000000009999',
  '471050004000','5501','00000000-0000-4000-8100-000000000002',
  '00000000-0000-4000-8200-000000000001',62,48,1.3,192,288,200,9,'critical',
  'locked',200,200,'confirm')
on conflict (replenishment_item_id) do nothing;

insert into ops.quantity_recommendations (
  recommendation_id,replenishment_item_id,recommendation_version,method,
  recommended_qty,evidence,source_freshness_status,created_at
) values
 ('00000000-0000-4000-8500-000000005501','00000000-0000-4000-8400-000000005501',1,
  'BUSINESS_RULE_V1',200,'{"policy_version":"v1.0.0"}','test_fixture','2026-07-08T00:00:00Z'),
 ('00000000-0000-4000-8500-000000005502','00000000-0000-4000-8400-000000005502',1,
  'BUSINESS_RULE_V1',100,'{"policy_version":"v1.0.0"}','test_fixture','2026-07-08T00:00:00Z')
on conflict (recommendation_id) do nothing;

insert into ops.plan_approvals (
  plan_approval_id,replenishment_plan_id,replenishment_item_id,district_id,
  approval_stage,decision,note,actor_role,acted_at
) values
 ('00000000-0000-4000-8600-000000005501','00000000-0000-4000-8000-000000005501',
  '00000000-0000-4000-8400-000000005501','5501','district_response','confirmed',
  'TEST fixture district confirmation','district','2026-07-08T01:00:00Z'),
 ('00000000-0000-4000-8600-000000005502','00000000-0000-4000-8000-000000005502',
  '00000000-0000-4000-8400-000000005502','5502','planner','approved',
  'TEST fixture planner approval','planner','2026-07-08T02:00:00Z'),
 ('00000000-0000-4000-8600-000000009999','00000000-0000-4000-8000-000000009999',
  '00000000-0000-4000-8400-000000009999','5501','lock','created',
  'TEST fixture locked plan','academic','2026-07-08T03:00:00Z')
on conflict (plan_approval_id) do nothing;

insert into core.vendors(vendor_name,normalized_name)
values('TEST VMI SUPPLIER','test vmi supplier')
on conflict (normalized_name) do nothing;
insert into core.contracts (
  contract_key,purchase_order,contract_number,procurement_code,vendor_id,
  start_date,record_date,document_date,end_date,source_item_count,source_batch_id
) values
 ('POC-CONTRACT-001',990000000000000001,'POC-CNT-001','TEST',
  (select vendor_id from core.vendors where normalized_name='test vmi supplier'),
  '2026-01-01','2026-01-01','2026-01-01','2026-12-31',1,
  '00000000-0000-4000-8000-00000000b001'),
 ('POC-CONTRACT-TRACE-001',990000000000000002,'POC-CNT-TRACE-001','TEST',
  (select vendor_id from core.vendors where normalized_name='test vmi supplier'),
  '2026-01-01','2026-01-01','2026-01-01','2026-12-31',1,
  '00000000-0000-4000-8000-00000000b001')
on conflict (purchase_order) do nothing;
insert into core.contract_items (
  contract_id,material_id,source_row_id,source_row_number,line_item,item_description,
  unit,quantity,delivery_date,acceptance_date,validation_status,source_batch_id
) select c.contract_id,'471050004000',r.source_row_id,r.source_row_number,10,
  'TEST PVC CONDUIT',(select unit from core.materials where material_id='471050004000'),
  100,'2026-07-01','2026-07-02','valid',
  '00000000-0000-4000-8000-00000000b001'
from core.contracts c join raw.source_rows r
  on r.batch_id='00000000-0000-4000-8000-00000000b001'
 and r.source_entity='p01_contract'
 and r.source_row_number=case when c.purchase_order=990000000000000001 then 1 else 2 end
where c.purchase_order in (990000000000000001,990000000000000002)
on conflict (source_batch_id,source_row_number) do nothing;

insert into core.receipt_lots (
  receipt_lot_id,lot_code,contract_item_id,warehouse_id,acceptance_date,
  installment_no,received_qty,remaining_qty,traceability_status,source_batch_id,
  source_reference,source_quality
) values (
 '00000000-0000-4000-8700-000000005501','POC-LOT-5501-001',
 (select i.contract_item_id from core.contract_items i join core.contracts c using(contract_id)
  where c.purchase_order=990000000000000002), 'WH-KT','2026-07-02','1',100,90,
 'complete','00000000-0000-4000-8000-00000000b001',
 'TEST_FIXTURE:vmi-chat-test-v1','source_derived'
) on conflict (receipt_lot_id) do nothing;
insert into core.handling_units (
  handling_unit_id,handling_unit_code,receipt_lot_id,material_id,location_id,
  unit_type,opening_status,received_qty,available_qty,reserved_qty,opened_at,
  source_reference,physical_location
) values (
 '00000000-0000-4000-8800-000000005501','POC-HU-5501-001',
 '00000000-0000-4000-8700-000000005501','471050004000','WH-KT',
 'LOOSE','OPEN',100,90,0,'2026-07-08T03:00:00Z',
 'TEST_FIXTURE:vmi-chat-test-v1','TEST-ZONE'
) on conflict (handling_unit_id) do nothing;
insert into core.inventory_movements (
  inventory_movement_id,movement_type,material_id,handling_unit_id,
  from_location_id,to_location_id,quantity,replenishment_item_id,
  idempotency_key,reason,occurred_at,metadata
) values (
 '00000000-0000-4000-8900-000000005501','ISSUE','471050004000',
 '00000000-0000-4000-8800-000000005501','WH-KT','DIST-5501',10,
 '00000000-0000-4000-8400-000000009999','P01-VMI-CHAT-ISSUE-5501-001',
 'TEST fixture issue','2026-07-08T04:00:00Z',
 '{"data_class":"test_fixture","dataset_version":"vmi-chat-test-v1"}'
) on conflict (inventory_movement_id) do nothing;
commit;
