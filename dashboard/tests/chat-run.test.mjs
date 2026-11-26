import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../app/api/chat/run.mjs';
import { CONVERSATION_REPLIES } from '../app/api/chat/tools.mjs';

const config = { provider: 'typhoon', apiUrl: 'https://api.opentyphoon.ai/v1/chat/completions', apiKey: 'test-key-123',
  model: 'typhoon-v2.5-30b-a3b-instruct', temperature: 0, timeoutMs: 30000, embeddings: false };
const terms = { names: [], words: [] };

// Typhoon does not enforce tool_choice "required": a reply is a tool call or plain text.
function provider(...replies) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push(JSON.parse(init.body));
    const reply = replies.shift();
    if (typeof reply === 'string') return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: reply } }] });
    const [name, args] = reply;
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call_${requests.length}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] } }] });
  };
  return { requests, fetcher };
}
const districts = async (name, args) => args.p_tool === 'discover_database'
  ? { tool: 'discover_database', status: 'ok', data: [{ source_id: 'core.districts', description: 'districts เขต', columns: { district_id: 'text', district_name_th: 'text' } }] }
  : { tool: 'query_database', source_id: 'core.districts', status: 'ok', data: [{ district_id: '5507', district_name_th: 'บางนา' }] };
const query = { source_id: 'core.districts', columns: ['district_id', 'district_name_th'], filters: [{ column: 'district_id', operator: 'eq', value: '5507' }],
  group_by: [], metrics: [], order_column: null, order_direction: 'asc', limit: 5, offset: 0, search: null };

test('a text reply after the evidence is read still gets an answer written and checked from the evidence', async () => {
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'เขต 5507' }], ['rank_candidates', { indices: [0] }], ['query_database', query],
    'เขต 5507 คือเขตบางนา',
    ['write_answer', { answer: 'เขต 5507 คือเขตบางนา', evidence_ids: [1] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  );
  const { result } = await runChat({ message: 'เขต 5507 คือเขตอะไร', config, terms, fetcher, rpc: districts, signal: new AbortController().signal });
  assert.equal(requests.length, 6);
  assert.equal(result.stop_reason, 'complete');
  assert.equal(result.answer_mode, 'synthesized');
  assert.equal(result.answer, 'เขต 5507 คือเขตบางนา');
});

test('a text reply before anything is read is asked once more for a function call', async () => {
  const { requests, fetcher } = provider('สวัสดีครับ ยินดีให้บริการ', ['conversation', { intent: 'greeting' }]);
  const { result } = await runChat({ message: 'สวัสดีครับ', config, terms, fetcher, signal: new AbortController().signal,
    rpc: async () => { throw new Error('no database read expected'); } });
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /function/);
  assert.equal(result.answer, CONVERSATION_REPLIES.greeting);
});

test('a call whose arguments fail validation goes back to the model once with what failed', async () => {
  const { requests, fetcher } = provider(
    ['get_plan_status', { plan_id: 'KT01-W47-000214' }],
    ['unsupported', { reason: 'ระบบยังอนุมัติแผนไม่ได้' }],
  );
  const { result } = await runChat({ message: 'อนุมัติแผน KT01-W47-000214 ให้หน่อย', config, terms, fetcher, signal: new AbortController().signal,
    rpc: async () => { throw new Error('no database read expected'); } });
  assert.equal(requests.length, 2);
  const returned = requests[1].messages.at(-1);
  assert.equal(returned.role, 'tool');
  assert.match(returned.content, /get_plan_status/);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.answer, 'ระบบยังอนุมัติแผนไม่ได้');
});

test('a data question answered with a canned conversation reply goes back once to be searched', async () => {
  const { requests, fetcher } = provider(
    ['conversation', { intent: 'capabilities' }],
    ['discover_database', { query: 'รถ บรรทุก น้ำหนัก' }], ['rank_candidates', { indices: [0] }],
    ['query_database', { ...query, source_id: 'core.transport_vehicles', columns: ['vehicle_id', 'max_weight_kg'], filters: [],
      order_column: 'max_weight_kg', order_direction: 'desc', limit: 1 }],
    ['finish', {}],
    ['write_answer', { answer: 'รถ V-101 บรรทุกได้มากที่สุด 15000 กก.', evidence_ids: [1] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  );
  const vehicles = async (name, args) => args.p_tool === 'discover_database'
    ? { tool: 'discover_database', status: 'ok', data: [{ source_id: 'core.transport_vehicles', description: 'vehicles รถ', columns: { vehicle_id: 'text', max_weight_kg: 'numeric' } }] }
    : { tool: 'query_database', source_id: 'core.transport_vehicles', status: 'ok', data: [{ vehicle_id: 'V-101', max_weight_kg: 15000 }] };
  const { result } = await runChat({ message: 'รถคันไหนบรรทุกน้ำหนักได้มากที่สุด', config, terms, fetcher, rpc: vehicles, signal: new AbortController().signal });
  const returned = requests[1].messages.at(-1);
  assert.equal(returned.role, 'tool');
  assert.match(returned.content, /discover_database/);
  assert.equal(result.answer_mode, 'synthesized');
  assert.equal(result.answer, 'รถ V-101 บรรทุกได้มากที่สุด 15000 กก.');
});

test('a code that came from neither the question nor the data read goes back once to be looked up', async () => {
  const guessed = { material_id: '020300400512', scope: 'district', district_id: '5501' };
  const { requests, fetcher } = provider(
    ['get_stock_status', guessed],
    ['discover_database', { query: 'เขตบางนา' }], ['rank_candidates', { indices: [0] }],
    ['query_database', { ...query, filters: [{ column: 'district_name_th', operator: 'contains', value: 'บางนา' }] }],
    ['get_stock_status', { ...guessed, district_id: '5507' }],
    ['finish', {}],
    ['write_answer', { answer: 'เขตบางนามีสายอะลูมิเนียม 1250 เมตร', evidence_ids: [2] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  );
  const stockReads = [];
  const rpc = async (name, args) => {
    if (args.p_tool !== 'get_stock_status') return districts(name, args);
    stockReads.push(args.p_args.district_id);
    return { tool: 'get_stock_status', status: 'ok', data: [{ material_id: '020300400512', district_id: args.p_args.district_id, current_stock_qty: 1250 }] };
  };
  const { result } = await runChat({ message: 'สต็อกวัสดุ 020300400512 ของเขตบางนาเหลือเท่าไร', config, terms, fetcher, rpc, signal: new AbortController().signal });
  const returned = requests[1].messages.at(-1);
  assert.equal(returned.role, 'tool');
  assert.match(returned.content, /5501/);
  assert.deepEqual(stockReads, ['5507']);
  assert.match(result.answer, /^เขตบางนามีสายอะลูมิเนียม 1250 เมตร/);
});

test('a query rejected as invalid input tells the model which columns the source has', async () => {
  const items = { ...query, source_id: 'core.contract_items', columns: ['material_id', 'quantity'],
    filters: [{ column: 'purchase_order', operator: 'eq', value: '1300004521' }] };
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'PO 1300004521' }], ['rank_candidates', { indices: [0] }],
    ['query_database', items],
    ['unsupported', { reason: 'ไม่พบคอลัมน์ PO ในรายการสัญญา' }],
  );
  const rpc = async (name, args) => args.p_tool === 'discover_database'
    ? { tool: 'discover_database', status: 'ok', data: [{ source_id: 'core.contract_items', description: 'contract items สัญญา',
      columns: { contract_id: 'text', material_id: 'text', quantity: 'numeric' } }] }
    : { tool: 'query_database', status: 'invalid_input' };
  await runChat({ message: 'PO 1300004521 มีวัสดุอะไรบ้าง', config, terms, fetcher, rpc, signal: new AbortController().signal });
  const returned = JSON.parse(requests[3].messages.at(-1).content);
  assert.equal(returned.status, 'invalid_input');
  assert.deepEqual(returned.columns, ['contract_id', 'material_id', 'quantity']);
  assert.deepEqual(returned.problems.filter(p => p.includes('purchase_order')).length, 1, 'names the column the source does not have');
});

test('a writer that answers in text is asked once more to call write_answer', async () => {
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'เขต 5507' }], ['rank_candidates', { indices: [0] }], ['query_database', query], ['finish', {}],
    'เขต 5507 คือเขตบางนา',
    ['write_answer', { answer: 'เขต 5507 คือเขตบางนา', evidence_ids: [1] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  );
  const { result } = await runChat({ message: 'เขต 5507 คือเขตอะไร', config, terms, fetcher, rpc: districts, signal: new AbortController().signal });
  assert.equal(requests.length, 7);
  assert.match(requests[5].messages.at(-1).content, /write_answer/);
  assert.equal(result.answer_mode, 'synthesized');
  assert.equal(result.answer, 'เขต 5507 คือเขตบางนา');
});

test('a query rejected as invalid input names the rules it broke', async () => {
  const heaviest = { ...query, source_id: 'core.transport_vehicles', columns: ['vehicle_id', 'max_weight_kg'],
    filters: [{ column: 'max_weight_kg', operator: 'gt', value: null }], metrics: [{ function: 'max', column: 'max_weight_kg' }],
    order_column: 'max_weight_kg', order_direction: 'desc' };
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'รถ บรรทุก น้ำหนัก' }], ['rank_candidates', { indices: [0] }],
    ['query_database', heaviest],
    ['unsupported', { reason: 'ยังหารถไม่ได้' }],
  );
  const rpc = async (name, args) => args.p_tool === 'discover_database'
    ? { tool: 'discover_database', status: 'ok', data: [{ source_id: 'core.transport_vehicles', description: 'vehicles รถ',
      columns: { vehicle_id: 'text', max_weight_kg: 'numeric' } }] }
    : { tool: 'query_database', status: 'invalid_input' };
  await runChat({ message: 'รถคันไหนบรรทุกน้ำหนักได้มากที่สุด', config, terms, fetcher, rpc, signal: new AbortController().signal });
  const { problems } = JSON.parse(requests[3].messages.at(-1).content);
  assert.equal(problems.length, 3);
  assert.ok(problems.some(p => p.includes('max_weight_kg gt') && p.includes('value')), 'a comparison needs a value');
  assert.ok(problems.some(p => p.includes('metrics') && p.includes('columns')), 'metrics return no plain columns');
  assert.ok(problems.some(p => p.includes('order_column max_weight_kg') && p.includes('max_max_weight_kg')), 'order by a returned column');
});

test('a call repeated with the same arguments goes back once instead of ending the run', async () => {
  const byName = { ...query, source_id: 'analytics.v_replenishment_queue', columns: [],
    filters: [{ column: 'material_name', operator: 'eq', value: 'ลูกถ้วยแขวน 030500100077' }], metrics: [{ function: 'sum', column: 'final_qty' }] };
  const byCode = { ...byName, filters: [{ column: 'material_id', operator: 'eq', value: '030500100077' }] };
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'ลูกถ้วยแขวน 030500100077' }], ['rank_candidates', { indices: [0] }],
    ['query_database', byName], ['query_database', byName], ['query_database', byCode], ['finish', {}],
    ['write_answer', { answer: 'ยอด final_qty รวม 4600', evidence_ids: [2] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  );
  const filtered = [];
  const rpc = async (name, args) => {
    if (args.p_tool === 'discover_database') return { tool: 'discover_database', status: 'ok', data: [{ source_id: 'analytics.v_replenishment_queue',
      description: 'คิวแผนเติม', columns: { material_id: 'text', material_name: 'text', final_qty: 'numeric' } }] };
    const column = args.p_args.filters[0].column;
    filtered.push(column);
    return { tool: 'query_database', source_id: 'analytics.v_replenishment_queue', status: 'ok', aggregation: true,
      data: [{ sum_final_qty: column === 'material_id' ? 4600 : null }] };
  };
  const { result } = await runChat({ message: 'ยอด final_qty รวมของลูกถ้วยแขวน 030500100077 ในคิวแผนเติมทุกเขตเป็นเท่าไร',
    config, terms, fetcher, rpc, signal: new AbortController().signal });
  assert.match(requests[4].messages.at(-1).content, /repeated_call/);
  assert.deepEqual(filtered, ['material_name', 'material_id']);
  assert.equal(result.stop_reason, 'complete');
  assert.match(result.answer, /^ยอด final_qty รวม 4600/);
});

// ADR 0002: a text search with no exact hit returns รายการใกล้เคียง, which must never read as the answer itself.
const nearQuery = { ...query, source_id: 'core.materials', columns: ['material_id', 'material_name'],
  filters: [{ column: 'material_name', operator: 'contains', value: 'หม้อแปลงไฟฟ้า 3 เฟส 250kVA' }] };
const nearRpc = async (name, args) => args.p_tool === 'discover_database'
  ? { tool: 'discover_database', status: 'ok', data: [{ source_id: 'core.materials', description: 'ทะเบียนวัสดุ', columns: { material_id: 'text', material_name: 'text' } }] }
  : { tool: 'query_database', source_id: 'core.materials', status: 'no_data', data: [],
    near_matches: [{ material_id: '010101000250', material_name: 'หม้อแปลงไฟฟ้า 3 เฟส 22kV 250kVA', match_score: 0.87 }] };

test('near matches shown from the evidence are labelled as near, not as the item asked for', async () => {
  const { fetcher } = provider(
    ['discover_database', { query: 'หม้อแปลง 250kVA' }], ['rank_candidates', { indices: [0] }], ['query_database', nearQuery], ['finish', {}],
    ['write_answer', { answer: 'หม้อแปลงไฟฟ้า 3 เฟส 250kVA คือ SKU 010101000250', evidence_ids: [1] }],
    ['check_answer', { supported: false, answers_question: true, citations_valid: true }],
  );
  const { result } = await runChat({ message: 'หม้อแปลงไฟฟ้า 3 เฟส 250kVA รหัสอะไร', config, terms, fetcher, rpc: nearRpc, signal: new AbortController().signal });
  assert.equal(result.answer_mode, 'evidence');
  assert.match(result.answer, /ไม่พบรายการที่ตรงทุกคำ/);
  assert.match(result.answer, /รายการใกล้เคียง[\s\S]*010101000250[\s\S]*22kV 250kVA/);
});

test('a written answer from near matches carries the server notice that they are near matches', async () => {
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'หม้อแปลง 250kVA' }], ['rank_candidates', { indices: [0] }], ['query_database', nearQuery], ['finish', {}],
    ['write_answer', { answer: 'ไม่พบชื่อนี้ตรงตัว ใกล้เคียงที่สุดคือ หม้อแปลงไฟฟ้า 3 เฟส 22kV 250kVA (SKU 010101000250)', evidence_ids: [1] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  );
  const { result } = await runChat({ message: 'หม้อแปลงไฟฟ้า 3 เฟส 250kVA รหัสอะไร', config, terms, fetcher, rpc: nearRpc, signal: new AbortController().signal });
  assert.equal(result.answer_mode, 'synthesized');
  assert.match(result.answer, /รายการใกล้เคียง ไม่ใช่รายการที่ตรงทุกคำ/);
  assert.match(JSON.stringify(requests[4]), /near_matches/);
});

test('a Thai search term reaches the database as words so their order does not matter', async () => {
  const searched = [];
  const { fetcher } = provider(
    ['discover_database', { query: 'หม้อแปลง 250kVA' }], ['rank_candidates', { indices: [0] }],
    ['query_database', { ...nearQuery, filters: [], search: 'หม้อแปลงไฟฟ้า250kVA - 3 เฟส' }], ['finish', {}],
    ['write_answer', { answer: 'ไม่พบรายการตรงตัว', evidence_ids: [1] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  );
  const rpc = async (name, args) => { if (args.p_tool === 'query_database') searched.push(args.p_args.search); return nearRpc(name, args); };
  await runChat({ message: 'หม้อแปลงไฟฟ้า 250kVA 3 เฟส', config, terms, fetcher, rpc, signal: new AbortController().signal });
  assert.deepEqual(searched.filter(Boolean), ['หม้อแปลง ไฟฟ้า 250 kVA 3 เฟส'], 'discovery\'s name lookup filters, it does not search');
});

// Catalog descriptions come from one keyword set per category, so the ranker can pick a source that lacks a column.
const alike = 'พัสดุ วัสดุ สินค้า SKU หน่วย บรรจุภัณฑ์';
const twins = [
  { source_id: 'core.material_packaging', description: `material packaging ${alike}`, columns: { material_id: 'text', quantity_per_box: 'numeric' } },
  { source_id: 'core.materials', description: `materials ${alike}`, columns: { material_id: 'text', material_name: 'text' } },
];
async function rejectedColumns(columns) {
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'เต้ารับคู่มีขั้วสายดิน' }], ['rank_candidates', { indices: [0, 1] }],
    ['query_database', { ...query, source_id: 'core.material_packaging', columns, filters: [] }],
    ['unsupported', { reason: 'ยังหาไม่ได้' }],
  );
  const rpc = async (name, args) => args.p_tool === 'discover_database'
    ? { tool: 'discover_database', status: 'ok', data: twins } : { tool: 'query_database', status: 'invalid_input' };
  await runChat({ message: 'เต้ารับคู่มีขั้วสายดิน มีรหัสอะไร', config, terms, fetcher, rpc, signal: new AbortController().signal });
  return JSON.parse(requests[3].messages.at(-1).content).problems;
}

test('a column the queried source lacks points to the discovered source that has it, or to discovering again', async () => {
  const named = await rejectedColumns(['material_id', 'material_name']);
  assert.ok(named.some(p => p.includes('material_name') && p.includes('core.materials')), 'names the source that has material_name');
  const nowhere = await rejectedColumns(['material_id', 'material_colour']);
  assert.ok(nowhere.some(p => p.includes('material_colour') && p.includes('discover_database')), 'no discovered source has it: search the catalog again');
});

async function noRows(filters, columns = { vehicle_id: 'text', max_weight_kg: 'numeric', vehicle_type: 'text' }) {
  const asked = { ...query, source_id: 'core.transport_vehicles', columns: Object.keys(columns).slice(0, 2), filters,
    order_column: 'max_weight_kg', order_direction: 'desc' };
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'รถ บรรทุก' }], ['rank_candidates', { indices: [0] }],
    ['query_database', asked], ['unsupported', { reason: 'ยังหารถไม่ได้' }],
  );
  const rpc = async (name, args) => args.p_tool === 'discover_database'
    ? { tool: 'discover_database', status: 'ok', data: [{ source_id: 'core.transport_vehicles', description: 'vehicles รถ', columns }] }
    : { tool: 'query_database', status: 'no_data', source_id: 'core.transport_vehicles', data: [] };
  await runChat({ message: 'รถคันไหนบรรทุกน้ำหนักได้มากที่สุด', config, terms, fetcher, rpc, signal: new AbortController().signal });
  return JSON.parse(requests[3].messages.at(-1).content);
}

test('no rows under a filter the question did not ask for names the filter that removed them', async () => {
  const empty = await noRows([{ column: 'max_weight_kg', operator: 'is_null', value: null }]);
  assert.equal(empty.status, 'no_data');
  assert.ok(empty.hints.some(h => h.includes('max_weight_kg') && h.includes('is_null')));
  const named = await noRows([{ column: 'vehicle_type', operator: 'eq', value: '10 ล้อ' }]);
  assert.ok(named.hints.some(h => h.includes('vehicle_type') && /search|contains/.test(h)), 'eq must match every character; part of a name needs search or contains');
});

test('a run that recovered from a rejected query still gets its answer written and checked from what it read', async () => {
  const { requests, fetcher } = provider(
    ['discover_database', { query: 'เขต 5507' }], ['rank_candidates', { indices: [0] }],
    ['query_database', { ...query, columns: ['district_id', 'district_colour'] }], ['query_database', query], ['finish', {}],
    ['write_answer', { answer: 'เขต 5507 คือเขตบางนา', evidence_ids: [1] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  );
  const rpc = async (name, args) => args.p_tool === 'query_database' && args.p_args.columns.includes('district_colour')
    ? { tool: 'query_database', status: 'invalid_input' } : districts(name, args);
  const { result } = await runChat({ message: 'เขต 5507 คือเขตอะไร', config, terms, fetcher, rpc, signal: new AbortController().signal });
  assert.equal(result.answer_mode, 'synthesized');
  assert.equal(result.answer, 'เขต 5507 คือเขตบางนา');
  const written = JSON.parse(requests[5].messages.find(m => m.role === 'user').content);
  assert.deepEqual(written.evidence.map(e => e.data.status), ['ok'], 'the writer sees what was read, not the rejected query');
});
