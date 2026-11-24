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
