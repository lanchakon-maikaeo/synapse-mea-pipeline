import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAnswer } from '../app/api/chat/answer.mjs';
import { runAgent } from '../app/api/chat/harness.mjs';

const call = (name, args) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }] });
const row = { tool: 'query_database', source_id: 'core.districts', status: 'ok', data: [{ district_id: '5501', district_name_th: 'นวลจันทร์' }], observed_at: '2026-09-09T02:00:00Z' };
const base = { status: 'ok', stop_reason: 'complete', answer: 'รหัสเขต: 5501 · ชื่อเขต: นวลจันทร์', evidence: [row], trace: [] };
const draft = call('write_answer', { answer: 'เขต 5501 คือเขตนวลจันทร์ค่ะ', evidence_ids: [1] });
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
  assert.match(answer.answer, /^เขต 5501 คือเขตนวลจันทร์ค่ะ/);
  assert.match(answer.answer, /core.districts/);
  assert.match(answer.answer, /เวลาอ่าน ไม่ใช่วันปรับปรุง/);
  assert.equal(requests.length, 5);
  const reviewerInput = JSON.parse(requests[4].contents[0].parts[0].text);
  assert.equal(reviewerInput.evidence.length, 1); // No catalog masquerading as facts.
  assert.equal(reviewerInput.draft.answer, 'เขต 5501 คือเขตนวลจันทร์ค่ะ');
  assert.deepEqual(answer.evidence, result.evidence);
});

test('invalid citations, extra output, unsupported facts and irrelevant answers fall back', async () => {
  for (const responses of [
    [{ candidates: [{ content: { parts: [] } }, ...draft.candidates] }],
    [call('write_answer', { answer: 'ผิด', evidence_ids: [2] })],
    [call('write_answer', { answer: 'ผิด', evidence_ids: [1, 1] })],
    [call('write_answer', { answer: 'ผิด', evidence_ids: [1], sql: 'drop table' })],
    [call('write_answer', { answer: 'ผิด', evidence_ids: [1] }), call('check_answer', { supported: false, answers_question: true, citations_valid: true })],
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
  assert.match(r.answer, /ไม่ใช่ข้อมูลทั้งหมด/); assert.match(r.answer, /ข้อมูลยังไม่ครบ/);
  assert.match(r.answer, /จัดอันดับแหล่งข้อมูลไม่สำเร็จ/);
});
