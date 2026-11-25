import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveSources, rerank, retrieveDatabase } from '../app/api/chat/retrieval.mjs';
import { validateDecision, renderToolResult } from '../app/api/chat/tools.mjs';
import { runAgent } from '../app/api/chat/harness.mjs';
const call = (name, args) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }] });
const sources = [
  { source_id: 'core.contracts', description: 'สัญญา PO', columns: { contract_id: 'bigint' } },
  { source_id: 'core.districts', description: 'เขต ชื่อ รหัส นวลจันทร์', columns: { district_id: 'text', district_name_th: 'text' } },
];
const plan = { source_id: 'core.districts', columns: ['district_id', 'district_name_th'], filters: [{ column: 'district_id', operator: 'eq', value: '5501' }], group_by: [], metrics: [], order_column: null, order_direction: 'asc', limit: 10, offset: 0, search: null };
test('Thai discovery retrieves a relevant source, then model reranks before top-k', async () => {
  assert.equal(retrieveSources('เขต 5501 คือเขตไหน', sources, 1)[0].source_id, 'core.districts');
  assert.equal(retrieveSources('คำที่ไม่อยู่ในแคตตาล็อก', sources, 1).length, 2);
  const r = await rerank({ search: 'เขต' }, sources, 1, async () => call('rank_candidates', { indices: [1] }));
  assert.deepEqual(r.selected, [sources[1]]); assert.equal(r.status, 'model_reranked');
  for (const indices of [[0, 0], [9], [-1], ['1']]) await assert.rejects(rerank({ search: 'q' }, sources, 2, async () => call('rank_candidates', { indices })), /rerank_output_invalid/);
});
test('reranking does not manufacture records and never changes whole-set aggregates', async () => {
  const envelope = { status: 'ok', data: [{ count_rows: 2000 }], aggregation: true };
  let calls = 0;
  const r = await retrieveDatabase({ decision: { name: 'query_database', args: { search: 'PVC' } }, question: 'count', rpc: async () => envelope, generate: async () => { calls++; } });
  assert.deepEqual(r, envelope); assert.equal(calls, 0);
  const ordered = await retrieveDatabase({ decision: { name: 'query_database', args: { search: 'PVC', order_column: 'weight_per_unit_kg' } }, question: 'heaviest PVC',
    rpc: async () => ({ ...envelope, aggregation: false }), generate: async () => { calls++; } });
  assert.equal(ordered.aggregation, false); assert.equal(calls, 0);
  // ADR 0002: the database ranks searched rows by how near they are; no model call reorders them.
  const searched = { status: 'ok', data: [{ district_id: '5502' }, { district_id: '5501' }], scope: { truncated: false } };
  const ranked = await retrieveDatabase({ decision: { name: 'query_database', args: { search: 'เขต', limit: 2 } }, question: 'เขต', topK: 1,
    rpc: async () => searched, generate: async () => { calls++; return call('rank_candidates', { indices: [1] }); } });
  assert.deepEqual(ranked, searched); assert.equal(calls, 0);
});
test('query compiler input rejects identifiers, arbitrary SQL and malformed nested values', () => {
  assert.deepEqual(validateDecision({ name: 'query_database', args: plan }).args, plan);
  for (const args of [{ ...plan, sql: 'select 1' }, { ...plan, columns: ['x;drop table x'] }, { ...plan, limit: 1000 },
    { ...plan, metrics: [{ function: 'pg_sleep', column: '*' }] }, { ...plan, filters: [{ column: 'district_id', operator: 'eq', value: {} }] }]) {
    assert.throws(() => validateDecision({ name: 'query_database', args }));
  }
});
test('optional ranking failure preserves authorized candidates; RPC denial is never bypassed', async () => {
  for (const generate of [async () => { throw Error('quota'); }, async () => call('rank_candidates', { indices: [] })]) {
    const r = await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'เขต' } }, question: 'เขต', topK: 1,
      rpc: async () => ({ status: 'ok', data: sources }), generate });
    assert.deepEqual(r.data.map(x => x.source_id), ['core.districts']);
    assert.equal(r.retrieval.status, 'fallback_original_order');
  }
  const denied = { status: 'forbidden', data: [] };
  assert.deepEqual(await retrieveDatabase({ decision: {}, rpc: async () => denied, generate: () => assert.fail('denied') }), denied);
  await assert.rejects(retrieveDatabase({ decision: {}, rpc: async () => { throw Error('unauthorized'); } }), /unauthorized/);
});
const catalog = [
  { source_id: 'core.inventory_movements', description: 'รับเข้า จ่ายออก โอนย้าย', columns: { movement_id: 'bigint' } },
  { source_id: 'core.materials', description: 'materials พัสดุ วัสดุ สินค้า SKU หน่วย', columns: { material_code: 'text', material_name: 'text' } },
];
const pick = id => async body => {
  const { candidates } = JSON.parse(body.contents[0].parts[0].text);
  return call('rank_candidates', { indices: [candidates.findIndex(c => c.data.source_id === id)] });
};
test('the user naming วัสดุ reaches the materials source even when the discover query is only an item name', async () => {
  const r = await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'หม้อแปลงจำหน่ายคอนเวนชันนัล' } },
    question: 'หม้อแปลงจำหน่ายคอนเวนชันนัล มีรหัสวัสดุอะไร', topK: 1, rpc: async () => ({ status: 'ok', data: catalog }),
    generate: async () => { throw Error('quota'); } });
  assert.deepEqual(r.data.map(x => x.source_id), ['core.materials']);
});
test('parts of a Thai item name do not narrow discovery to unrelated sources', async () => {
  // "เต้ารับ" split as "เต้า|รับ" would match "รับเข้า", keep 30 candidates and cut core.materials before ranking.
  const wide = [...catalog, ...Array.from({ length: 30 }, (_, i) => ({ source_id: `analytics.view_${i}`, description: 'ภาพรวม', columns: {} }))];
  const r = await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'เต้ารับคู่มีขั้วสายดิน' } },
    question: 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร', topK: 1, rpc: async () => ({ status: 'ok', data: wide }), generate: pick('core.materials') });
  assert.deepEqual(r.data.map(x => x.source_id), ['core.materials']);
  assert.equal(r.retrieval.candidate_count, wide.length);
});
test('a word few sources share (รหัส) does not cut the rest of the catalog alphabetically before ranking', async () => {
  const wide = [...catalog, { source_id: 'core.districts', description: 'เขต พื้นที่ รหัส ชื่อ', columns: {} },
    ...Array.from({ length: 30 }, (_, i) => ({ source_id: `analytics.view_${i}`, description: 'ภาพรวม', columns: {} }))];
  const r = await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'เต้ารับคู่มีขั้วสายดิน' } },
    question: 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร', topK: 1, rpc: async () => ({ status: 'ok', data: wide }), generate: pick('core.materials') });
  assert.deepEqual(r.data.map(x => x.source_id), ['core.materials']);
  assert.equal(r.retrieval.candidate_count, wide.length);
});
test('the source ranker sees what the user asked, not only the search the model wrote', async () => {
  let asked;
  await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'มิเตอร์ไฟฟ้า 1 เฟส' } },
    question: 'สต็อกมิเตอร์ไฟฟ้า 1 เฟสที่เขตบางกะปิตอนนี้เหลือเท่าไร', topK: 1, rpc: async () => ({ status: 'ok', data: catalog }),
    generate: async body => { asked = JSON.parse(body.contents[0].parts[0].text); return call('rank_candidates', { indices: [0] }); } });
  assert.equal(asked.search, 'มิเตอร์ไฟฟ้า 1 เฟส');
  assert.equal(asked.question, 'สต็อกมิเตอร์ไฟฟ้า 1 เฟสที่เขตบางกะปิตอนนี้เหลือเท่าไร');
});
test('discovery is not an answer: harness must execute the discovered source', async () => {
  const responses = [call('discover_database', { query: 'เขต 5501' }), call('query_database', plan), call('finish', {})];
  const r = await runAgent({ message: 'เขต 5501 คือเขตไหน', temperature: 0, scope: { role: 'admin' },
    generate: async () => responses.shift(),
    read: async d => d.name === 'discover_database' ? { status: 'ok', tool: d.name, data: sources } :
      { status: 'ok', tool: d.name, source_id: plan.source_id, data: [{ district_id: '5501', district_name_th: 'นวลจันทร์' }] } });
  assert.match(r.answer, /ชื่อเขต: นวลจันทร์/); assert.equal(r.stop_reason, 'complete'); assert.equal(r.trace.length, 2);
  await assert.rejects(runAgent({ message: 'q', generate: async () => call('query_database', plan), read: async () => { throw Error('must not read'); } }), /source_not_discovered/);
});
test('generic evidence distinguishes unknown and zero and labels truncation', () => {
  const answer = renderToolResult({ status: 'ok', tool: 'query_database', source_id: 'core.materials', data: [{ quantity: 0, unit: null }], scope: { truncated: true } });
  assert.match(answer, /quantity: 0/); assert.match(answer, /หน่วย: ไม่ทราบ/); assert.match(answer, /ยังไม่ใช่ข้อมูลทั้งหมด/);
});
