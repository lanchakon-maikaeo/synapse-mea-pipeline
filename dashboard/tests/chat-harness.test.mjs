import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, MAX_READS } from '../app/api/chat/harness.mjs';
const call = (name, args = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'opaque-signature' }] } }] });
const overview = call('get_operations_overview', { view: 'risk', material_id: null, district_id: null });
const stock = (id) => call('get_stock_status', { material_id: id, scope: 'warehouse', district_id: null });
const result = (d) => ({ tool: d.name, status: 'ok', data: [{ material_id: 'SKU-1', district_id: '5501', current_stock_qty: 1, months_available: 0.2 }], scope: { role: 'admin' } });
function scenario(responses, read = async (d) => result(d)) {
  const requests = []; const reads = [];
  return { requests, reads, run: () => runAgent({ message: 'คลังไหนใกล้หมด แล้วตรวจคลังต้นทาง', temperature: 0, scope: { role: 'admin' },
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
test('duplicate calls stop instead of repeatedly spending money or querying', async () => {
  const s = scenario([overview, overview]); const r = await s.run();
  assert.equal(r.stop_reason, 'repeated_tool'); assert.equal(r.status, 'partial'); assert.equal(s.reads.length, 1);
});
test('hard read budget applies even when the model ignores instructions', async () => {
  const s = scenario([stock('A'), stock('B'), stock('C'), stock('D')]); const r = await s.run();
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
