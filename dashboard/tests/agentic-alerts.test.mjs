import test from 'node:test';
import assert from 'node:assert/strict';
import { districtRisk, warehouseSupply, nextUrgentAlert } from '../app/agentic-alerts.mjs';

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
  calls++; if(calls===1)return tool('read_evidence',{sources:['policy']});
  if(calls===2||calls===4)return tool('recommend',{summary:'จะหมดวันนี้',actions:['ส่งทันที'],evidence_ids:['alert','policy'],uncertainties:[]});
  return tool('check_recommendation',{supported:false,reason:'stale_current_claim',explanation:'Uses historical stock as current'});
 },now),/unsupported_stale_current_claim/);
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
test('failed analysis yields its next slot to an untouched alert',async()=>{
 const sample={...context,stock:[...context.stock,{...context.stock[0],district_id:'5502'}]};let saved;const attempted=[];
 const rpc=async(name,args)=>name==='agentic_alert_claim'?true:name==='agentic_alert_context'?sample:name==='agentic_alert_save'?(saved=args.p_alerts,{saved:saved.length}):null;
 const fetcher=async(_,init)=>{attempted.push(JSON.parse(JSON.parse(init.body).messages[1].content).alert.key);return new Response('',{status:503});};
 for(let run=0;run<2;run++){await runAlertWorker({rpc,env:{LLM_API_KEY:'sk-or-test'},now:new Date(now.getTime()+run*900000),signal:new AbortController().signal,maxAnalyses:1,fetcher});sample.existing=saved.map(x=>({...x,status:'open'}));}
 assert.equal(new Set(attempted).size,2);
});

test('assistant surfaces new critical events, keeps dismissal and ignores normal or acknowledged alerts',()=>{
 const a={alert_id:'A',status:'open',severity:'critical',details:{fingerprint:'1'}};const seen=new Set(['A:1']);
 assert.equal(nextUrgentAlert([a],seen),null);
 assert.equal(nextUrgentAlert([{...a,details:{fingerprint:'2'}}],seen)?.alert_id,'A');
 assert.equal(nextUrgentAlert([{...a,severity:'warning'},{...a,status:'acknowledged'}],new Set()),null);
 assert.equal(nextUrgentAlert([a,{...a,alert_id:'B'}],seen)?.alert_id,'B');
});
test('agent reads a bounded evidence batch before publishing reviewed advice',async()=>{
 const alert=buildCandidates(context,now)[0];let calls=0;
 const tool=(name,args)=>({candidates:[{content:{parts:[{functionCall:{id:`call-${calls}`,name,args}}]}}]});
 const result=await analyzeAlert(alert,{policy,warehouse:{rows:[],truncated:false}},async body=>{
  calls++;const names=body.tools[0].functionDeclarations.map(x=>x.name);
  if(calls===1){assert.deepEqual(names,['read_evidence']);return tool('read_evidence',{sources:['policy','warehouse']});}
  if(calls===2){assert.deepEqual(names,['recommend']);return tool('recommend',{summary:'ตรวจข้อมูลสต็อกให้เป็นปัจจุบัน',actions:['ตรวจยอดและรายการจอง'],evidence_ids:['policy','warehouse','alert'],uncertainties:['ยังไม่ทราบเวลาของเข้า']});}
  return tool('check_recommendation',{supported:true,reason:'supported',explanation:''});
 },now);
 assert.equal(result.details.analysis_status,'analyzed');assert.equal(calls,3);
 await assert.rejects(analyzeAlert(alert,{policy},async()=>tool('read_evidence',{sources:['policy','policy']}),now),/invalid_evidence_source/);
});

 test('stale current-stock drafts get one repair and a fresh independent review',async()=>{
 const alert=buildCandidates(context,now)[0];let calls=0;
 const tool=(name,args)=>({candidates:[{content:{role:'model',parts:[{functionCall:{id:`call-${calls}`,name,args}}]}}]});
 const result=await analyzeAlert(alert,{policy},async body=>{
  calls++;
  if(calls===1)return tool('read_evidence',{sources:['policy']});
  if(calls===2)return tool('recommend',{summary:'สต็อกใกล้หมดวันนี้',actions:['ส่งวันนี้'],evidence_ids:['alert'],uncertainties:[]});
  if(calls===3)return tool('check_recommendation',{supported:false,reason:'stale_current_claim',explanation:'Uses historical stock as current'});
  if(calls===4){assert.equal(body.contents.at(-1).parts[0].functionResponse.response.status,'rejected');return tool('recommend',{summary:'ข้อมูลเก่า ยังยืนยันสต็อกปัจจุบันไม่ได้',actions:['อัปเดตสต็อกก่อนจัดลำดับส่ง'],evidence_ids:['alert'],uncertainties:['ยังจัดลำดับส่งวันนี้ไม่ได้']});}
  assert.match(body.contents[0].parts[0].text,/2026-10-04/);
  return tool('check_recommendation',{supported:true,reason:'supported',explanation:''});
 },now);
 assert.equal(result.details.analysis_status,'analyzed');assert.equal(calls,5);
 assert.match(result.details.analysis.summary,/ข้อมูลเก่า/);
 });

 test('review of a current workflow cites its own facts, not unused historical stock',async()=>{
 const alert={key:'workflow',details:{evidence:{plan_status:'pending_district_confirmation',item_count:6}}};let calls=0;
 const related={queue:{rows:[{plan_status:'pending_district_confirmation'}]},stock:{rows:[{snapshot_at:'2026-07-21',current_stock_qty:0}]}};
 const tool=(name,args)=>({candidates:[{content:{role:'model',parts:[{functionCall:{id:`call-${calls}`,name,args}}]}}]});
 const result=await analyzeAlert(alert,related,async body=>{
  calls++;
  if(calls===1)return tool('read_evidence',{sources:['stock','queue']});
  if(calls===2)return tool('recommend',{summary:'แผนรอการยืนยันจากเขต 6 รายการ',actions:['ตรวจสถานะแผนและข้อมูลก่อนยืนยัน'],evidence_ids:['alert','queue'],uncertainties:['ยังไม่ยืนยันสต็อกปัจจุบัน']});
  const input=JSON.parse(body.contents[0].parts[0].text);
  assert.deepEqual(Object.keys(input.evidence),['alert','queue']);
  assert.equal(input.evidence.alert.item_count,6);
  return tool('check_recommendation',{supported:true,reason:'supported',explanation:'Workflow facts match the cited active records'});
 },now);
 assert.equal(result.details.analysis_status,'analyzed');
 });
 test('a billing refusal stops further model calls while every alert is still saved',async()=>{
 const sample={...context,stock:[...context.stock,{...context.stock[0],district_id:'5502'}]};let requests=0;let saved;
 const rpc=async(name,args)=>name==='agentic_alert_claim'?true:name==='agentic_alert_context'?sample:name==='agentic_alert_save'?(saved=args.p_alerts,{saved:saved.length}):null;
 const result=await runAlertWorker({rpc,env:{LLM_API_KEY:'sk-or-test'},now,signal:new AbortController().signal,fetcher:async()=>{requests++;return new Response(JSON.stringify({error:{message:'insufficient credits'}}),{status:402});}});
 assert.equal(requests,1);assert.equal(saved.length,2);assert.equal(result.errors.provider_billing_required,1);
 assert.ok(saved.every(x=>x.details.analysis_status==='evidence_only'));
 });

 test('an in-flight capacity hold stops a run without skipping its alert persistence',async()=>{
 const sample={...context,stock:[...context.stock,{...context.stock[0],district_id:'5502'}]};let requests=0;let saved;
 const rpc=async(name,args)=>name==='agentic_alert_claim'?true:name==='agentic_alert_context'?sample:name==='agentic_alert_save'?(saved=args.p_alerts,{saved:saved.length}):null;
 const result=await runAlertWorker({rpc,env:{LLM_API_KEY:'sk-or-test'},now,signal:new AbortController().signal,fetcher:async()=>{requests++;return new Response(JSON.stringify({error:{metadata:{limit_source:'openrouter_in_flight_budget'}}}),{status:402,headers:{'retry-after':'60'}});}});
 assert.equal(requests,1);assert.equal(saved.length,2);assert.equal(result.retry_after_seconds,60);
 assert.equal(result.errors.provider_capacity_budget,1);
 });
 test('workflow reads cannot mix another plan, material or origin into their evidence',async()=>{
 const item={replenishment_plan_id:'P',replenishment_item_id:'I',district_id:'5501',material_id:'A',origin_location_id:'W',plan_status:'pending_district_confirmation',item_status:'draft',input_data_class:'actual',suggested_qty:0,allocated_qty:0};
 const sample={...context,queue:[item,{...item,replenishment_plan_id:'OTHER',material_id:'B',origin_location_id:'OTHER'}],warehouse:[{material_id:'A',location_id:'W'},{material_id:'B',location_id:'W'},{material_id:'A',location_id:'OTHER'}],stock:[...context.stock,{...context.stock[0],material_id:'B'}]};let reads;let saved;
 const rpc=async(name,args)=>name==='agentic_alert_claim'?true:name==='agentic_alert_context'?sample:name==='agentic_alert_save'?(saved=args.p_alerts,{saved:saved.length}):null;
 const fetcher=async(_,init)=>{
  const body=JSON.parse(init.body);const name=body.tools[0].function.name;const initial=JSON.parse(body.messages[1].content);
  if(initial.alert&&!initial.alert.key.includes('proactive:workflow:P:'))return new Response('{}',{status:503});
  let args;
  if(name==='read_evidence')args={sources:['queue','stock','warehouse']};
  else if(name==='recommend'){reads=JSON.parse(body.messages.at(-1).content);args={summary:'ตรวจสถานะแผน P',actions:['ตรวจข้อมูลก่อนยืนยัน'],evidence_ids:['alert','queue'],uncertainties:[]};}
  else args={supported:true,reason:'supported',explanation:''};
  return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:`id-${name}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}));
 };
 await runAlertWorker({rpc,env:{LLM_API_KEY:'sk-or-test'},now,signal:new AbortController().signal,maxAnalyses:6,fetcher});
 assert.deepEqual(reads.queue.rows.map(x=>x.replenishment_plan_id),['P']);
 assert.deepEqual(reads.stock.rows.map(x=>x.material_id),['A']);
 assert.deepEqual(reads.warehouse.rows.map(x=>[x.location_id,x.material_id]),[['W','A']]);
 assert.equal(saved.find(x=>x.key.includes('proactive:workflow:P:')).details.analysis_status,'analyzed');
 });

 test('with LLM_PROVIDER=typhoon the worker calls Typhoon with its model and key, and a 429 keeps evidence-only alerts',async()=>{
 let saved;const seen=[];
 const rpc=async(name,args)=>name==='agentic_alert_claim'?true:name==='agentic_alert_context'?context:name==='agentic_alert_save'?(saved=args.p_alerts,{saved:saved.length}):null;
 const result=await runAlertWorker({rpc,env:{LLM_PROVIDER:'typhoon',LLM_API_KEY:'typhoon-test-key-0123456789'},now,signal:new AbortController().signal,
  fetcher:async(url,init)=>{seen.push({url,model:JSON.parse(init.body).model,auth:init.headers.Authorization});return new Response('{}',{status:429});}});
 assert.deepEqual(seen,[{url:'https://api.opentyphoon.ai/v1/chat/completions',model:'typhoon-v2.5-30b-a3b-instruct',auth:'Bearer typhoon-test-key-0123456789'}]);
 assert.equal(result.errors.provider_rate_limited,1);assert.ok(saved.every(x=>x.details.analysis_status==='evidence_only'));
 });
