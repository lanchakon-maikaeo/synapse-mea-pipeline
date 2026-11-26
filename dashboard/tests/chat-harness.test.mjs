import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, MAX_READS } from '../app/api/chat/harness.mjs';
import { CHAT_TOOLS } from '../app/api/chat/tools.mjs';
const call = (name, args = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'opaque-signature' }] } }] });
const overview = call('get_operations_overview', { view: 'risk', material_id: null, district_id: null });
const stock = (id) => call('get_stock_status', { material_id: id, scope: 'warehouse', district_id: null });
const result = (d) => ({ tool: d.name, status: 'ok', data: [{ material_id: 'SKU-1', district_id: '5501', current_stock_qty: 1, months_available: 0.2 }], scope: { role: 'admin' } });
function scenario(responses, read = async (d) => result(d), message = 'คลังไหนใกล้หมด แล้วตรวจคลังต้นทาง') {
  const requests = []; const reads = [];
  return { requests, reads, run: () => runAgent({ message, temperature: 0, scope: { role: 'admin' },
    generate: async (body) => { requests.push(structuredClone(body)); const item = responses.shift(); if (item instanceof Error) throw item; return item; },
    read: async (d) => { reads.push(d); return read(d); } }) };
}
test('multi-step harness returns evidence, preserves signature and only completes after finish', async () => {
  const s = scenario([overview, stock('SKU-1'), call('finish')]); const r = await s.run();
  assert.equal(r.stop_reason, 'complete'); assert.equal(r.trace.length, 2); assert.equal(s.reads.length, 2);
  assert.equal(s.requests[1].contents.at(-2).parts[0].thoughtSignature, 'opaque-signature');
  assert.equal(s.requests[1].contents.at(-1).parts[0].functionResponse.name, 'get_operations_overview');
});
test('cannot finish without evidence or execute arbitrary tools', async () => {
  await assert.rejects(scenario([call('finish')]).run, /finish_without_evidence/);
  const s = scenario([call('execute_sql', { sql: 'delete from stock' })]);
  await assert.rejects(s.run, /provider_output_invalid/); assert.equal(s.reads.length, 0);
});
test('query tools are offered only after discovery and source IDs are bounded to its result', async () => {
  const query = { source_id: 'public.districts', columns: ['district_id', 'district_name'], filters: [],
    group_by: [], metrics: [], order_column: null, order_direction: 'asc', limit: 1, offset: 0, search: '5501' };
  const s = scenario([call('discover_database', { query: 'เขต 5501' }), call('query_database', query), call('finish')],
    async d => d.name === 'discover_database'
      ? { tool: d.name, status: 'ok', data: [{ source_id: 'public.districts' }] }
      : { tool: d.name, status: 'ok', data: [{ district_id: '5501', district_name: 'บางเขน' }] });
  const r = await s.run();
  const tools = index => s.requests[index].tools[0].functionDeclarations;
  assert.ok(!tools(0).some(fn => ['query_database', 'finish'].includes(fn.name)));
  assert.deepEqual(tools(1).find(fn => fn.name === 'query_database').parametersJsonSchema.properties.source_id.enum, ['public.districts']);
  assert.ok(!tools(1).some(fn => fn.name === 'finish'));
  assert.ok(tools(2).some(fn => fn.name === 'finish'));
  assert.equal(r.stop_reason, 'complete');
});
test('conversation replies require no business reads and cannot carry invented facts', async () => {
  for (const intent of ['greeting', 'thanks', 'goodbye', 'capabilities']) {
    const s = scenario([call('conversation', { intent })], undefined, 'สวัสดีครับ ช่วยอะไรได้บ้าง');
    const r = await s.run();
    assert.equal(r.status, 'ok'); assert.equal(r.stop_reason, 'complete');
    assert.ok(r.answer.length > 0); assert.equal(s.reads.length, 0);
  }
  await assert.rejects(scenario([call('conversation', { intent: 'stock', answer: '999' })]).run, /provider_output_invalid/);
  await assert.rejects(scenario([call('conversation', { intent: 'stock' })]).run, /provider_output_invalid/);
});
test('duplicate calls stop instead of repeatedly spending money or querying', async () => {
  // The first repeats go back to the model; once its corrections are spent the run stops.
  const s = scenario([overview, overview, overview, overview]); const r = await s.run();
  assert.equal(r.stop_reason, 'repeated_tool'); assert.equal(r.status, 'partial'); assert.equal(s.reads.length, 1);
});
test('hard read budget applies even when the model ignores instructions', async () => {
  const skus = Array.from({ length: MAX_READS + 1 }, (_, i) => `SKU-${i}`);
  const s = scenario(skus.map(stock), undefined, `ตรวจสต็อก ${skus.join(' ')}`); const r = await s.run();
  assert.equal(r.stop_reason, 'step_limit'); assert.equal(s.reads.length, MAX_READS); assert.equal(s.requests.length, MAX_READS + 1);
});
test('provider or tool failures after evidence are marked partial', async () => {
  const s = scenario([overview, new Error('quota')]); const r = await s.run();
  assert.equal(r.status, 'partial'); assert.equal(r.stop_reason, 'provider_error'); assert.match(r.answer, /บางส่วน/);
  let count = 0;
  const t = scenario([overview, stock('A')], async (d) => { if (count++) throw Error('timeout'); return result(d); });
  assert.equal((await t.run()).stop_reason, 'tool_error');
});
test('revoked identity and denied tool result stop execution', async () => {
  const s = scenario([overview], async () => { throw Error('unauthorized'); });
  await assert.rejects(s.run, /unauthorized/);
  const t = scenario([overview, stock('A')], async () => ({ status: 'forbidden', data: [] }));
  assert.equal((await t.run()).stop_reason, 'forbidden'); assert.equal(t.requests.length, 1);
});
test('cancellation prevents all model/tool calls', async () => {
  const c = new AbortController(); c.abort(); let calls = 0;
  await assert.rejects(runAgent({ message: 'test', signal: c.signal, generate: async () => { calls++; }, read: async () => {} }));
  assert.equal(calls, 0);
});
test('tool context cannot grow past budget', async () => {
  const s = scenario([overview], async (d) => ({ ...result(d), data: [{ material_name: 'x'.repeat(40001) }] }));
  assert.equal((await s.run()).stop_reason, 'context_limit'); assert.equal(s.requests.length, 1);
});
const materials = { tool: 'discover_database', status: 'ok', data: [{ source_id: 'core.materials', columns: { material_id: 'text', material_name: 'text' } }] };
const find = (search, columns = ['material_id']) => call('query_database', { source_id: 'core.materials', columns, filters: [], group_by: [], metrics: [],
  order_column: null, order_direction: 'asc', limit: 5, offset: 0, search });
const rejecting = rows => async d => d.name === 'discover_database' ? materials
  : d.args.columns.includes('material_colour') ? { tool: 'query_database', status: 'invalid_input' }
  : { tool: 'query_database', status: rows.length ? 'ok' : 'no_data', source_id: 'core.materials', data: rows };
test('queries the database rejects before running do not use up the read budget', async () => {
  const rejected = ['a', 'b', 'c'].map(x => find(x, ['material_colour']));
  const s = scenario([call('discover_database', { query: 'วัสดุ' }), ...rejected, find('d'), find('e'), find('f')],
    rejecting([{ material_id: '1' }]), 'วัสดุ d e f มีรหัสอะไร');
  await s.run();
  assert.equal(s.reads.length, 7, 'three rejected queries and four reads that returned data');
  assert.equal(s.requests.length, MAX_READS + 1, 'no extra model calls');
});
test('the answer a stopped run falls back to says each finding once and leaves out queries the database rejected', async () => {
  const s = scenario([call('discover_database', { query: 'วัสดุ' }), find('x'), find('y', ['material_colour']), find('z', ['material_colour']), find('w')],
    rejecting([]), 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร');
  const r = await s.run();
  assert.equal(r.status, 'partial');
  assert.equal(r.answer.split('ไม่พบข้อมูลที่ตรงกับรหัสและขอบเขตที่ระบุ').length - 1, 1);
  assert.doesNotMatch(r.answer, /ค้นข้อมูลไม่สำเร็จ/);
  const only = scenario([call('discover_database', { query: 'วัสดุ' }), find('y', ['material_colour']), find('z', ['material_colour'])],
    rejecting([]), 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร');
  const answer = (await only.run()).answer;
  assert.equal(answer.split('ค้นข้อมูลไม่สำเร็จ').length - 1, 1, 'nothing else was read: say it once');
  // The user gave no code and nothing was verified: the rejected query was the model's.
  assert.doesNotMatch(answer, /ตรวจรหัส|ตรวจสอบได้บางส่วน/);
  assert.match(answer, /ลองระบุ SKU หรือชื่อเต็ม/);
});

// heldout who-requested: Typhoon guessed material_id contains "TFR" (or "T") for หม้อแปลง, read no_data and answered "not found".
const queue = (filters) => call('query_database', { source_id: 'analytics.v_replenishment_queue', columns: ['requester_name'], filters,
  group_by: [], metrics: [], order_column: null, order_direction: 'asc', limit: 10, offset: 0, search: null });
const replenishment = async d => d.name === 'discover_database'
  ? { tool: d.name, status: 'ok', data: [{ source_id: 'analytics.v_replenishment_queue', columns: { requester_name: 'text', plan_number: 'text', material_id: 'text', material_name: 'text' } }] }
  : { tool: d.name, status: 'ok', source_id: 'analytics.v_replenishment_queue', data: [{ requester_name: 'ผู้ขอ', plan_number: 'KT01-W47-000214', material_id: '020520508980' }] };
const rejectedFor = s => s.requests.at(-1).contents.flatMap(c => c.parts ?? [])
  .map(p => p.functionResponse?.response).filter(x => x?.status === 'rejected').map(x => x.reason);
test('a piece of a code the model made up goes back to it, and the name is searched instead', async () => {
  const s = scenario([call('discover_database', { query: 'ผู้ขอเติมหม้อแปลง' }),
    queue([{ column: 'material_id', operator: 'contains', value: 'TFR' }]),
    queue([{ column: 'material_id', operator: 'contains', value: 'T' }]),
    queue([{ column: 'material_name', operator: 'contains', value: 'หม้อแปลง' }]), call('finish')],
  replenishment, 'ใครเป็นผู้ขอเติมหม้อแปลงของเขตบางนา');
  await s.run();
  assert.deepEqual(rejectedFor(s), ['unsourced_code', 'unsourced_code']);
  assert.deepEqual(s.reads.map(d => d.args.filters?.[0]?.value ?? d.name), ['discover_database', 'หม้อแปลง']);
  assert.match(JSON.stringify(s.requests[2].contents.at(-1)), /ส่วนของรหัส[\s\S]*ชื่อ/);
});
test('a piece of a code the user wrote, or one with digits from data already read, is queried', async () => {
  const s = scenario([call('discover_database', { query: 'แผนเติม' }),
    queue([{ column: 'plan_number', operator: 'contains', value: 'KT01' }]),
    queue([{ column: 'material_id', operator: 'contains', value: '0205205' }]), call('finish')],
  replenishment, 'แผนเติมที่ขึ้นต้นด้วย KT01 มีใครขอบ้าง');
  await s.run();
  assert.deepEqual(rejectedFor(s), []);
  assert.equal(s.reads.length, 3);
});

// heldout contact-from-evidence: the phone is written in district_note; Typhoon asked for requester_phone, or never read the notes.
test('a column no source has points to the notes, where facts without a column of their own are written', async () => {
  const s = scenario([call('discover_database', { query: 'แผน KT01-W47-000214' }),
    call('query_database', { source_id: 'analytics.v_replenishment_queue', columns: ['requester_name', 'request_reason'],
      filters: [{ column: 'plan_number', operator: 'eq', value: 'KT01-W47-000214' }], group_by: [], metrics: [],
      order_column: null, order_direction: 'asc', limit: 10, offset: 0, search: null }), call('finish')],
  async d => d.name === 'discover_database'
    ? { tool: d.name, status: 'ok', data: [{ source_id: 'analytics.v_replenishment_queue',
      columns: { requester_name: 'text', plan_number: 'text', district_note: 'text', planner_note: 'text' } }] }
    : { tool: d.name, status: 'invalid_input' }, 'เหตุผลที่ขอเติมในแผน KT01-W47-000214 คืออะไร');
  await s.run().catch(() => {});
  assert.match(JSON.stringify(s.requests[2].contents.at(-1)), /request_reason[^"]*district_note, planner_note/);
});
test('the query tool tells the model that facts without a column of their own are written in the notes', () => {
  assert.match(CHAT_TOOLS.find(fn => fn.name === 'query_database').description, /_note/);
});
const planQueue = { requester_name: 'text', plan_number: 'text', district_note: 'text', planner_note: 'text' };
const plans = async d => d.name === 'discover_database'
  ? { tool: d.name, status: 'ok', data: [{ source_id: 'analytics.v_replenishment_queue', columns: planQueue }] }
  : { tool: d.name, status: 'ok', source_id: 'analytics.v_replenishment_queue', data: [{ requester_name: 'ผู้ขอ', plan_number: 'KT01-W47-000214' }] };
const planRows = columns => call('query_database', { source_id: 'analytics.v_replenishment_queue', columns,
  filters: [{ column: 'plan_number', operator: 'eq', value: 'KT01-W47-000214' }], group_by: [], metrics: [],
  order_column: null, order_direction: 'asc', limit: 10, offset: 0, search: null });
test('a question for a contact goes back once to read the notes when the source has no contact column', async () => {
  const s = scenario([call('discover_database', { query: 'แผน KT01-W47-000214' }), planRows(['requester_name']),
    planRows(['requester_name', 'district_note', 'planner_note']), call('finish')], plans, 'เบอร์ติดต่อผู้ขอเติมในแผน KT01-W47-000214 คืออะไร');
  await s.run();
  assert.deepEqual(rejectedFor(s), ['notes_not_read']);
  assert.match(JSON.stringify(s.requests[2].contents.at(-1)), /district_note, planner_note/);
  assert.deepEqual(s.reads.at(-1).args.columns, ['requester_name', 'district_note', 'planner_note']);
});
test('a question that does not ask for a contact, or a model that keeps leaving the notes out, is not held back', async () => {
  const who = scenario([call('discover_database', { query: 'แผน KT01-W47-000214' }), planRows(['requester_name']), call('finish')],
    plans, 'ใครเป็นผู้ขอเติมในแผน KT01-W47-000214');
  await who.run();
  assert.deepEqual(rejectedFor(who), []);
  const twice = scenario([call('discover_database', { query: 'แผน KT01-W47-000214' }), planRows(['requester_name']),
    planRows(['requester_name', 'plan_number']), call('finish')], plans, 'เบอร์ติดต่อผู้ขอเติมในแผน KT01-W47-000214 คืออะไร');
  await twice.run();
  assert.deepEqual(rejectedFor(twice), ['notes_not_read'], 'asked once, then the query runs');
  assert.equal(twice.reads.length, 2);
});
