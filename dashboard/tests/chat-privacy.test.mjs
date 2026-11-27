import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../app/api/chat/run.mjs';

const config = { provider: 'typhoon', apiUrl: 'https://api.opentyphoon.ai/v1/chat/completions', apiKey: 'test-key-123',
  model: 'typhoon-v2.5-30b-a3b-instruct', temperature: 0, timeoutMs: 30000, embeddings: false };
const terms = { names: [], words: [] };

// A fake provider that records every request and answers with the tool call `reply` builds from it.
function provider(...replies) {
  const requests = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const [name, args] = replies.shift()(body);
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call_${requests.length}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 10 } });
  };
  return { requests, fetcher };
}
const lastUser = body => body.messages.filter(m => m.role === 'user').at(-1).content;

test('a phone number in the question never reaches the provider but the answer shows it', async () => {
  const { requests, fetcher } = provider(body => {
    const label = lastUser(body).match(/\[เบอร์โทร-\d+\]/)?.[0];
    return ['unsupported', { reason: `ระบบโทรหา ${label} แทนผู้ใช้ไม่ได้` }];
  });
  const run = await runChat({ message: 'ช่วยโทรหา 081-234-5678 ให้หน่อย', config, terms, fetcher,
    rpc: async () => { throw new Error('no database read expected'); }, signal: new AbortController().signal });
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(requests), /081-234-5678|0812345678/);
  assert.match(lastUser(requests[0]), /\[เบอร์โทร-1\]/);
  assert.equal(run.result.answer, 'ระบบโทรหา 081-234-5678 แทนผู้ใช้ไม่ได้');
});

// discover -> rank sources -> query -> finish -> write -> check, with people in the rows.
const queue = 'analytics.v_replenishment_queue';
const row = { plan_number: 'KT01-W45-021169', requester_name: 'วิภา ทองดี', district_note: 'โทรหาวิภา 089-111-2222 แล้ว',
  reviewed_by: '0b6f7a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' };
const labelIn = (body, word) => JSON.stringify(body).match(new RegExp(`\\[${word}-\\d+\\]`))?.[0];
function database(reads) {
  return async (name, args) => {
    reads.push(structuredClone(args));
    if (args.p_tool === 'discover_database') return { tool: 'discover_database', status: 'ok',
      data: [{ source_id: queue, description: 'คิวแผนเติม', columns: { plan_number: 'text', requester_name: 'text', district_note: 'text' } }] };
    return { tool: 'query_database', source_id: queue, status: 'ok', data: [row], observed_at: '2026-11-22T03:00:00Z' };
  };
}
const flow = writer => provider(
  () => ['discover_database', { query: 'คำขอเติมของผู้ขอ' }],
  () => ['rank_candidates', { indices: [0] }],
  body => ['query_database', { source_id: queue, columns: ['plan_number', 'requester_name', 'district_note'],
    filters: [{ column: 'requester_name', operator: 'eq', value: labelIn(body, 'ชื่อ') }], group_by: [], metrics: [],
    order_column: null, order_direction: 'asc', limit: 5, offset: 0, search: null }],
  () => ['finish', {}],
  writer,
  () => ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
);
const ask = (fetcher, reads) => runChat({ message: 'วิภา ทองดี ขอเติมในแผนไหน', config, terms: { names: ['วิภา ทองดี'], words: [] },
  fetcher, rpc: database(reads), signal: new AbortController().signal });

test('people in the rows never reach the provider; the database gets real values and the answer shows them', async () => {
  const reads = [];
  const { requests, fetcher } = flow(body => ['write_answer', { summary: `${labelIn(body, 'ชื่อ')} ขอเติมในแผน KT01-W45-021169 ติดต่อ ${labelIn(body, 'เบอร์โทร')}`, items: [], notes: [], evidence_ids: [1] }]);
  const { result } = await ask(fetcher, reads);
  assert.equal(requests.length, 6);
  assert.doesNotMatch(JSON.stringify(requests), /วิภา|089-111-2222|0891112222|0b6f7a5e|reviewed_by/);
  assert.equal(reads[1].p_args.filters[0].value, 'วิภา ทองดี');
  assert.equal(result.answer_mode, 'synthesized');
  assert.equal(result.answer, 'วิภา ทองดี ขอเติมในแผน KT01-W45-021169 ติดต่อ 089-111-2222\n\nที่มา: analytics.v_replenishment_queue · อ่านเมื่อ 22 พ.ย. 2569 10:00');
});

test('an answer that cites a label this run never issued falls back to the evidence answer', async () => {
  const { fetcher } = flow(() => ['write_answer', { summary: '[ชื่อ-7] ขอเติมในแผน KT01-W45-021169', items: [], notes: [], evidence_ids: [1] }]);
  const { result } = await ask(fetcher, []);
  assert.equal(result.answer_mode, 'evidence');
  assert.equal(result.answer_validation, 'unknown_label');
  assert.match(result.answer, /ผู้ขอเติม: วิภา ทองดี/);
});

test('a contact number in the answer that is not in the evidence or the question is hidden', async () => {
  const { fetcher } = flow(() => ['write_answer', { summary: 'ติดต่อผู้ขอที่ 081-999-0000 หรือ 089-111-2222', items: [], notes: [], evidence_ids: [1] }]);
  const { result } = await ask(fetcher, []);
  assert.equal(result.answer, 'ติดต่อผู้ขอที่ [ปิดไว้] หรือ 089-111-2222\n\nที่มา: analytics.v_replenishment_queue · อ่านเมื่อ 22 พ.ย. 2569 10:00');
});

test('a document search query is masked before it is sent for embedding', async () => {
  const embedded = [];
  const { fetcher: chat } = provider(
    body => ['search_knowledge', { query: `ขั้นตอนเบิกของ ${labelIn(body, 'ชื่อ')}` }],
    () => ['unsupported', { reason: 'ยังไม่มีเอกสาร' }],
  );
  const fetcher = async (url, init) => {
    if (!String(url).endsWith('/embeddings')) return chat(url, init);
    embedded.push(JSON.parse(init.body).input);
    return Response.json({ model: 'baai/bge-m3', data: [{ index: 0, embedding: Array.from({ length: 1024 }, (_, i) => i + 1) }] });
  };
  await runChat({ message: 'คุณสมศรี ใจดี ต้องเบิกยังไง', terms, fetcher, signal: new AbortController().signal,
    config: { ...config, provider: 'openrouter', apiKey: 'sk-or-test-key', embeddings: true, documents: true },
    rpc: async () => ({ tool: 'search_knowledge', status: 'ok', data: [{ content: 'ขั้นตอนเบิก', source_id: 'doc-1' }] }) });
  assert.deepEqual(embedded, ['ขั้นตอนเบิกของ [ชื่อ-1]']);
});
