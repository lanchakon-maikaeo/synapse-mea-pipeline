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
// Catalog descriptions come from one keyword set per category, so sources of a category read alike (ADR 0002).
const alike = 'พัสดุ วัสดุ สินค้า SKU หน่วย บรรจุภัณฑ์';
const twins = [
  { source_id: 'core.material_packaging', description: `material packaging ${alike}`,
    columns: { material_id: 'text', quantity_per_box: 'numeric', created_at: 'timestamp with time zone', source_row_id: 'text' } },
  { source_id: 'core.materials', description: `materials ${alike}`,
    columns: { material_id: 'text', material_name: 'text', unit: 'text', updated_at: 'timestamp with time zone', source_batch_id: 'uuid' } },
];
test('the source ranker sees each source\'s columns, so sources described alike can be told apart', async () => {
  let asked;
  await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'เต้ารับคู่มีขั้วสายดิน' } },
    question: 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร', topK: 1, rpc: async () => ({ status: 'ok', data: twins }),
    generate: async body => { asked = JSON.parse(body.contents[0].parts[0].text); return call('rank_candidates', { indices: [1] }); } });
  const seen = Object.fromEntries(asked.candidates.map(({ data }) => [data.source_id, JSON.stringify(data.columns ?? '')]));
  assert.match(seen['core.materials'], /material_name/);
  assert.match(seen['core.material_packaging'], /quantity_per_box/);
  assert.doesNotMatch(Object.values(seen).join(' '), /created_at|updated_at|source_row_id|source_batch_id/, 'audit and lineage columns tell no source apart');
});
test('a source with more columns than the ranker is shown still shows the columns that name things', async () => {
  // The catalog lists columns shortest name first; a cut by position would drop requester_name.
  const columns = Object.fromEntries([...Array.from({ length: 20 }, (_, i) => [`qty_${i}`, 'numeric']), ['requester_name', 'text'], ['district_note', 'text']]);
  let asked;
  await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'ผู้ขอเติม' } }, question: 'ใครเป็นผู้ขอเติม', topK: 1,
    rpc: async () => ({ status: 'ok', data: [{ source_id: 'analytics.v_replenishment_queue', description: 'แผนเติม', columns }] }),
    generate: async body => { asked = JSON.parse(body.contents[0].parts[0].text); return call('rank_candidates', { indices: [0] }); } });
  assert.match(JSON.stringify(asked.candidates[0].data.columns), /requester_name.*district_note|district_note.*requester_name/);
});
test('a catalog too large to rank with its columns is still ranked by name and description, not left in catalog order', async () => {
  const columns = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`descriptive_column_${i}_${'x'.repeat(24)}`, 'text']));
  const big = Array.from({ length: 120 }, (_, i) => ({ source_id: `core.table_${i}`, description: 'ตาราง', columns }));
  let asked;
  const r = await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'เต้ารับ' } }, question: 'เต้ารับ มีรหัสอะไร', topK: 1,
    rpc: async () => ({ status: 'ok', data: big }),
    generate: async body => {
      asked = JSON.parse(body.contents[0].parts[0].text);
      return call('rank_candidates', { indices: [asked.candidates.findIndex(({ data }) => data.source_id === 'core.table_7')] });
    } });
  assert.equal(r.retrieval.status, 'model_reranked');
  assert.deepEqual(r.data.map(x => x.source_id), ['core.table_7']);
  assert.ok(asked.candidates.every(({ data }) => data.columns === undefined));
});
// The production failure: the item's name says nothing to the catalog, and รหัส matches the districts' keyword set.
const registers = [
  { source_id: 'analytics.v_stock_health', description: 'สต็อก', columns: { material_name: 'text', district_name_th: 'text' } },
  { source_id: 'core.districts', description: 'เขต พื้นที่ รหัส ชื่อ นวลจันทร์', columns: { district_id: 'text', sap_plant_code: 'text', district_name_th: 'text' } },
  ...twins,
];
const item = 'เต้ารับคู่ แบบมีขั้วสายดินพร้อมกล่องยาง';
// vmi_chat_database: contains filters on one column, counted.
const database = probed => async ({ name, args }) => {
  if (name === 'discover_database') return { status: 'ok', data: registers };
  probed.push(args.source_id);
  const holds = args.source_id === 'core.materials' && args.filters.every(f => f.column === 'material_name' && f.operator === 'contains' && item.includes(f.value));
  return { status: 'ok', tool: name, source_id: args.source_id, data: [{ count_rows: holds ? 1 : 0 }], aggregation: true };
};
test('a register with a row matching every word of the search goes first to the ranker, with the column that matched', async () => {
  const probed = [];
  let asked;
  const r = await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'เต้ารับคู่มีขั้วสายดิน' } },
    question: 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร', topK: 2, rpc: database(probed),
    // Typhoon's ranker, shown many alike candidates, keeps the first ones.
    generate: async body => { asked = JSON.parse(body.contents[0].parts[0].text); return call('rank_candidates', { indices: [0, 1] }); } });
  assert.deepEqual(probed.sort(), ['core.districts', 'core.materials'], 'only registers: sources whose name column is named after them');
  assert.deepEqual(asked.candidates.map(({ data }) => data.source_id).slice(0, 2), ['core.materials', 'core.districts']);
  assert.equal(asked.candidates[0].data.search_found_in, 'material_name');
  assert.deepEqual(r.data.map(x => [x.source_id, x.search_found_in]), [['core.materials', 'material_name'], ['core.districts', undefined]]);
});
test('a register holding the searched name is discovered even when the ranker passes it over', async () => {
  const r = await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'เต้ารับคู่มีขั้วสายดิน' } },
    question: 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร', topK: 2, rpc: database([]),
    generate: async body => {
      const { candidates } = JSON.parse(body.contents[0].parts[0].text);
      return call('rank_candidates', { indices: ['core.districts', 'analytics.v_stock_health'].map(id => candidates.findIndex(c => c.data.source_id === id)) });
    } });
  assert.deepEqual(r.data.map(x => x.source_id), ['core.districts', 'core.materials']);
});
test('a name lookup that fails or is not allowed leaves discovery as the ranker made it', async () => {
  for (const probe of [async () => { throw Error('timeout'); }, async () => ({ status: 'forbidden' }), async () => ({ status: 'invalid_input' })]) {
    const r = await retrieveDatabase({ decision: { name: 'discover_database', args: { query: 'เต้ารับคู่มีขั้วสายดิน' } },
      question: 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร', topK: 1, rpc: async decision => decision.name === 'discover_database' ? { status: 'ok', data: registers } : probe(),
      generate: pick('core.material_packaging') });
    assert.deepEqual(r.data.map(x => [x.source_id, x.search_found_in]), [['core.material_packaging', undefined]]);
  }
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
  assert.equal(answer, '• จำนวน: 0 · หน่วย: ไม่ทราบ\nแสดงแค่บางรายการ ถ้าต้องการดูเพิ่ม ระบุเงื่อนไขให้แคบลงหรือขอหน้าถัดไป');
});
