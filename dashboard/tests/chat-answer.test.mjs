import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswer } from '../app/api/chat/answer.mjs';
import { runAgent } from '../app/api/chat/harness.mjs';
import { renderToolResult, sourceLine } from '../app/api/chat/tools.mjs';

const call = (name, args) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }] });
const row = { tool: 'query_database', source_id: 'core.districts', status: 'ok', data: [{ district_id: '5501', district_name_th: 'นวลจันทร์' }], observed_at: '2026-09-09T02:00:00Z' };
const base = { status: 'ok', stop_reason: 'complete', answer: 'รหัสเขต: 5501 · ชื่อเขต: นวลจันทร์', evidence: [row], trace: [] };
const draft = call('write_answer', { summary: 'เขต 5501 คือเขตนวลจันทร์', items: [], notes: [], evidence_ids: [1] });
const READ = 'ที่มา: core.districts · อ่านเมื่อ 9 ก.ย. 2569 09:00';
const approved = call('check_answer', { supported: true, answers_question: true, citations_valid: true });

test('production sequence discovers, reads, finishes, writes and independently checks an answer', async () => {
  const responses = [call('discover_database', { query: 'เขต 5501' }), call('query_database', {
    source_id: 'core.districts', columns: ['district_id', 'district_name_th'], filters: [], metrics: [], group_by: [],
    order_column: null, order_direction: 'asc', limit: 1, offset: 0, search: '5501',
  }), call('finish', {}), draft, approved];
  const requests = [];
  const generate = async body => { requests.push(structuredClone(body)); return responses.shift(); };
  const result = await runAgent({ message: 'เขต 5501 คือเขตไหน', temperature: 0, generate,
    read: async d => d.name === 'discover_database' ? { tool: d.name, status: 'ok', data: [{ source_id: 'core.districts' }] } : row });
  const answer = await composeAnswer({ result, question: 'เขต 5501 คือเขตไหน', generate });
  assert.equal(answer.answer_mode, 'synthesized');
  assert.equal(answer.answer, `เขต 5501 คือเขตนวลจันทร์\n\n${READ}`);
  assert.equal(requests.length, 5);
  const reviewerInput = JSON.parse(requests[4].contents[0].parts[0].text);
  assert.equal(reviewerInput.evidence.length, 1); // No catalog masquerading as facts.
  assert.equal(reviewerInput.draft.summary, 'เขต 5501 คือเขตนวลจันทร์');
  assert.deepEqual(answer.evidence, result.evidence);
});

test('invalid citations, extra output, unsupported facts and irrelevant answers fall back', async () => {
  for (const responses of [
    [{ candidates: [{ content: { parts: [] } }, ...draft.candidates] }],
    [call('write_answer', { summary: 'ผิด', items: [], notes: [], evidence_ids: [2] })],
    [call('write_answer', { summary: 'ผิด', items: [], notes: [], evidence_ids: [1, 1] })],
    [call('write_answer', { summary: 'ผิด', items: [], notes: [], evidence_ids: [1], sql: 'drop table' })],
    [call('write_answer', { summary: 'ผิด', items: [], notes: [], evidence_ids: [1] }), call('check_answer', { supported: false, answers_question: true, citations_valid: true })],
    [draft, call('check_answer', { supported: true, answers_question: false, citations_valid: true })],
    [draft, call('check_answer', { supported: true, answers_question: true, citations_valid: false })],
    [draft, call('check_answer', { supported: 'true', answers_question: true, citations_valid: true })],
  ]) {
    const answer = await composeAnswer({ result: base, question: 'เขตไหน', generate: async () => responses.shift() });
    assert.equal(answer.answer_mode, 'evidence'); assert.equal(answer.answer, base.answer);
  }
});

test('partial, denied, conversation, oversized context and provider failures preserve evidence', async () => {
  for (const result of [
    { ...base, stop_reason: 'step_limit', status: 'partial' },
    { ...base, evidence: [{ ...row, status: 'forbidden' }] },
    { ...base, evidence: [] },
    { ...base, evidence: [{ ...row, data: ['x'.repeat(40001)] }] },
  ]) {
    const r = await composeAnswer({ result, question: 'test', generate: () => assert.fail('must not call provider') });
    assert.equal(r.answer, result.answer); assert.equal(r.status, result.status);
  }
  for (const error of ['provider_rate_limited', 'model_call_limit', 'timeout']) {
    const r = await composeAnswer({ result: base, question: 'test', generate: async () => { throw Error(error); } });
    assert.equal(r.answer, base.answer); assert.equal(r.answer_validation, 'unavailable');
  }
  const abort = new AbortController(); abort.abort();
  const r = await composeAnswer({ result: base, question: 'test', signal: abort.signal, generate: () => assert.fail('cancelled') });
  assert.equal(r.answer_validation, 'deadline'); assert.equal(r.answer, base.answer);
});

test('server preserves truncation and warnings even if the writer omits them', async () => {
  const responses = [draft, approved];
  const result = { ...base, evidence: [
    { tool: 'discover_database', status: 'ok', data: [], retrieval: { stage: 'sources', status: 'fallback_original_order' } },
    { ...row, scope: { truncated: true }, warnings: ['ข้อมูลยังไม่ครบ'] },
  ] };
  const r = await composeAnswer({ result, question: 'test', generate: async () => responses.shift() });
  assert.match(r.answer, /ยังไม่ใช่ทั้งหมด/); assert.match(r.answer, /ข้อมูลยังไม่ครบ/);
  assert.doesNotMatch(r.answer, /จัดอันดับแหล่งข้อมูลไม่สำเร็จ/);
});


test('the writer answers in fields: the answer, one line per item, its limits, then where the facts came from', async () => {
  const responses = [call('write_answer', { summary: 'มี 2 เขต', items: ['• รหัสเขต: 5501 · ชื่อเขต: นวลจันทร์', 'รหัสเขต: 5502 · ชื่อเขต: บางเขน'],
    notes: ['ข้อมูลชื่อเขตอาจไม่ครบ'], evidence_ids: [1] }), approved];
  const answer = await composeAnswer({ result: base, question: 'มีเขตอะไรบ้าง', generate: async () => responses.shift() });
  assert.equal(answer.answer, ['มี 2 เขต', '• รหัสเขต: 5501 · ชื่อเขต: นวลจันทร์\n• รหัสเขต: 5502 · ชื่อเขต: บางเขน',
    'ข้อมูลชื่อเขตอาจไม่ครบ', READ].join('\n\n'));
  for (const bad of [{ items: 'รายการ' }, { notes: [1] }, { summary: ' ' }]) {
    const writes = [call('write_answer', { summary: 'มี 2 เขต', items: [], notes: [], evidence_ids: [1], ...bad }), approved];
    assert.equal((await composeAnswer({ result: base, question: 'มีเขตอะไรบ้าง', generate: async () => writes.shift() })).answer_validation, 'invalid_draft');
  }
});

test('every answer ends with where its facts came from: the snapshot date when there is one, else when it was read', async () => {
  assert.equal(sourceLine([row]), READ);
  assert.equal(sourceLine([{ tool: 'get_stock_status', status: 'ok', sources: ['analytics.v_stock_health'], data_as_of: '2026-11-20T03:00:00Z' }, row]),
    'ที่มา: analytics.v_stock_health, core.districts · ข้อมูล ณ 20 พ.ย. 2569 10:00');
  assert.equal(sourceLine([{ ...row, status: 'invalid_input' }, { tool: 'discover_database', status: 'ok', source_id: 'core.districts' }]), undefined);
  assert.doesNotMatch(renderToolResult(row, true), /core.districts/);
});

test('the writer is given the Thai names of the columns and codes it read', async () => {
  const requests = [];
  const evidence = [{ ...row, data: [{ plan_status: 'pending_district_confirmation', requester_name: null }] }];
  await composeAnswer({ result: { ...base, evidence }, question: 'แผนนี้สถานะอะไร', generate: async body => { requests.push(body); return draft; } });
  const input = JSON.parse(requests[0].contents[0].parts[0].text);
  assert.deepEqual(input.labels, { columns: { plan_status: 'สถานะแผน', requester_name: 'ผู้ขอเติม' }, values: { pending_district_confirmation: 'รอเขตยืนยัน' } });
  assert.match(requests[0].systemInstruction.parts[1].text, /ไม่ใช้ครับหรือค่ะ/);
});

test('the writer runs at the configured temperature and the reviewer stays at 0', async () => {
  const requests = [], responses = [draft, approved];
  await composeAnswer({ result: base, question: 'เขต 5501 คือเขตไหน', temperature: 0.4, generate: async body => { requests.push(body); return responses.shift(); } });
  assert.deepEqual(requests.map(body => body.generationConfig.temperature), [0.4, 0]);
});

test('a notice the writer already gave is not repeated: stale stock is said once', async () => {
  const { annotateStockFreshness } = await import('../app/api/chat/tools.mjs');
  const stale = annotateStockFreshness({ ...row, tool: 'get_stock_status', data: [{ current_stock_qty: 420, snapshot_at: '2026-11-20T03:00:00Z' }] }, new Date('2026-11-26T03:00:00Z'));
  const [warning] = stale.warnings;
  for (const note of [warning, 'สต็อกปัจจุบันยังยืนยันไม่ได้ เพราะข้อมูลเป็นยอด ณ 20 พ.ย.']) {
    const responses = [call('write_answer', { summary: 'เหลือ 420 เครื่อง ณ 20 พ.ย.', items: [], notes: [note], evidence_ids: [1] }), approved];
    const answer = await composeAnswer({ result: { ...base, evidence: [stale] }, question: 'มิเตอร์เหลือเท่าไร', generate: async () => responses.shift() });
    assert.equal(answer.answer.split(warning).length - 1, note === warning ? 1 : 0);
    assert.match(answer.answer, /ยืนยันไม่ได้|ไม่เป็นปัจจุบัน/);
  }
  const responses = [call('write_answer', { summary: 'เหลือ 420 เครื่อง', items: [], notes: [], evidence_ids: [1] }), approved];
  const silent = await composeAnswer({ result: { ...base, evidence: [stale] }, question: 'มิเตอร์เหลือเท่าไร', generate: async () => responses.shift() });
  assert.equal(silent.answer.split(warning).length - 1, 1, 'a writer that leaves it out still gets the warning from the server');
});
