import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, MAX_READS } from '../app/api/chat/harness.mjs';
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
  assert.doesNotMatch(r.answer, /ข้อมูลที่ใช้ค้นหาไม่ครบ/);
  const only = scenario([call('discover_database', { query: 'วัสดุ' }), find('y', ['material_colour']), find('z', ['material_colour'])],
    rejecting([]), 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร');
  assert.equal((await only.run()).answer.split('ข้อมูลที่ใช้ค้นหาไม่ครบ').length - 1, 1, 'nothing else was read: say it once');
});
