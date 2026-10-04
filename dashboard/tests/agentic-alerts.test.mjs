import test from 'node:test';
import assert from 'node:assert/strict';
import { districtRisk, warehouseSupply } from '../app/agentic-alerts.mjs';

test('missing/fixture stock never becomes a stockout; real zero retains replenishment risk', () => {
  const row = { material_id: 'A', district_id: '5501', current_stock_qty: 0, cmp_monthly: 10,
    source_stock_missing: false, fixture_backed: false, input_data_class: 'actual' };
  row.snapshot_at = new Date().toISOString();
  row.usage_as_of_date = row.snapshot_at.slice(0,10);
  const policy = { months_trigger: 3.5, min_months: 4, stock_max_age_hours: 26 };
  assert.equal(districtRisk({ ...row, source_stock_missing: true }, policy).kind, 'data_quality');
  assert.equal(districtRisk({ ...row, fixture_backed: true }, policy).kind, 'data_quality');
  assert.equal(districtRisk({ ...row, cmp_monthly: null }, policy).months_available, null);
  assert.equal(districtRisk(row, policy).target_gap_qty, 40);
  assert.equal(districtRisk({ ...row, current_stock_qty: 35 }, policy).kind, 'covered');
  assert.equal(districtRisk({ ...row, cmp_monthly: 0 }, policy).kind, 'check_usage');
  assert.equal(districtRisk({ ...row, snapshot_at: '2026-07-21T00:00:00Z' }, policy,
    new Date('2026-10-04T00:00:00Z')).kind, 'data_quality');
});

test('warehouse reservations stay within material/location; corrupt and duplicate evidence fails safely', () => {
  const units = [
    { handling_unit_id: '1', material_id: 'A', location_id: 'W', eligible: true, available_qty: 100, reserved_qty: 40 },
    { handling_unit_id: '2', material_id: 'A', location_id: 'OTHER', eligible: true, available_qty: 1000, reserved_qty: 0 },
    { handling_unit_id: '3', material_id: 'A', location_id: 'W', eligible: false, available_qty: 500, reserved_qty: 0 },
  ];
  const input = { material_id: 'A', location_id: 'W', units, required_qty: 80, inventory_complete: true };
  assert.equal(warehouseSupply(input).shortfall_qty, 20);
  assert.equal(warehouseSupply({ ...input, units: [{ ...units[0], reserved_qty: 101 }] }).shortfall_qty, null);
  assert.throws(() => warehouseSupply({ ...input, units: [units[0], units[0]] }), /evidence/);
  assert.equal(warehouseSupply({ ...input, inventory_complete: false }).shortfall_qty, null);
});

import { buildCandidates, analyzeAlert, runAlertWorker } from '../app/api/agentic-alert-worker.mjs';
const now = new Date('2026-10-04T00:30:00Z');
const policy = { months_trigger: 3.5, min_months: 4, stock_max_age_hours: 26 };
const context = {
 policy, existing: [], units: [], warehouse: [], queue: [],
 stock: [{material_id:'A',district_id:'5501',current_stock_qty:0,cmp_monthly:10,
  snapshot_at:'2026-07-21T00:00:00Z',usage_as_of_date:'2026-07-21',source_stock_missing:false,fixture_backed:false,input_data_class:'actual'}],
};
test('worker records supported verification tasks during provider outage and preserves acknowledged analysis', async () => {
 let saved;
 const calls=[];
 const rpc=async(name,args)=>{calls.push(name);if(name==='agentic_alert_claim')return true;
  if(name==='agentic_alert_context')return context;
  if(name==='agentic_alert_save'){saved=args;return {saved:args.p_alerts.length};}};
 const result=await runAlertWorker({rpc,env:{LLM_API_KEY:'sk-or-test'},now,signal:new AbortController().signal,
  fetcher:async()=>new Response('',{status:503})});
 assert.equal(result.status,'succeeded');
 assert.equal(saved.p_alerts[0].details.analysis_status,'evidence_only');
 assert.equal(saved.p_alerts[0].details.evidence.stale,true);
 assert.ok(!calls.includes('agentic_alert_fail'));
 const original=saved.p_alerts[0];
 const existing={key:original.key,status:'acknowledged',details:{...original.details,analysis_status:'analyzed',analysis:{summary:'ตรวจสอบข้อมูล'}}};
 const rebuilt=buildCandidates({...context,existing:[existing]},now);
 assert.equal(rebuilt[0].details.analysis_status,'analyzed');
 assert.equal(rebuilt[0].key,original.key);
});
test('agent cannot cite unread sources or publish a reviewer-rejected recommendation', async () => {
 const alert=buildCandidates(context,now)[0];
 const related={policy};
 const tool=(name,args)=>({candidates:[{content:{parts:[{functionCall:{id:'call-1',name,args}}]}}]});
 let calls=0;
 await assert.rejects(analyzeAlert(alert,related,async()=>tool('recommend',{
  summary:'ตรวจสอบข้อมูล',actions:['ตรวจสต็อก'],evidence_ids:['policy'],uncertainties:[]}),now),/invalid_recommendation/);
 await assert.rejects(analyzeAlert(alert,related,async()=>{
  calls++; if(calls===1)return tool('read_evidence',{source:'policy'});
  if(calls===2)return tool('recommend',{summary:'จะหมดวันนี้',actions:['ส่งทันที'],evidence_ids:['alert','policy'],uncertainties:[]});
  return tool('check_recommendation',{supported:false});
 },now),/unsupported_recommendation/);
});
test('warehouse covered demand does not create a missing-stock alert; busy worker does not read or write', async()=>{
 const sample={...context,stock:[],warehouse:[{material_id:'A',location_id:'W',quantity_on_hand:100,snapshot_at:now.toISOString(),data_class:'actual'}],
  units:[{handling_unit_id:'U',material_id:'A',location_id:'W',available_qty:100,reserved_qty:0,eligible:true}],
  queue:[{replenishment_item_id:'I',replenishment_plan_id:'P',material_id:'A',origin_location_id:'W',input_data_class:'actual',
   plan_status:'draft',item_status:'draft',suggested_qty:80,allocated_qty:0}]};
 assert.equal(buildCandidates(sample,now).length,0);
 let count=0;
 const result=await runAlertWorker({rpc:async()=>{count++;return false;},signal:new AbortController().signal});
 assert.equal(result.status,'busy');assert.equal(count,1);
});
