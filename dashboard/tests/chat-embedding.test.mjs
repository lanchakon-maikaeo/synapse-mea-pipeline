import test from 'node:test';
import assert from 'node:assert/strict';
import { embedText, providerErrorCode } from '../app/api/chat/embedding.mjs';
import { runAgent } from '../app/api/chat/harness.mjs';

const vector = Array(768).fill(0); vector[0] = 2;
test('embedding request uses the document/query task, fixed dimensions and normalizes vectors', async () => {
  for (const taskType of ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY']) {
    const result = await embedText({ text: 'หลักการเติมวัสดุ', apiKey: 'test', taskType, fetcher: async (url, init) => {
      assert.match(url, /gemini-embedding-001:embedContent$/);
      const body = JSON.parse(init.body);
      assert.equal(body.taskType, taskType); assert.equal(body.outputDimensionality, 768);
      return Response.json({ embedding: { values: vector } });
    } });
    assert.equal(result[0], 1); assert.equal(result.length, 768);
  }
});
test('malformed vectors and provider failures cannot become knowledge evidence', async () => {
  for (const values of [[], [1], Array(768).fill(0), Array(768).fill('1')]) {
    await assert.rejects(embedText({ text: 'test', apiKey: 'test', fetcher: async () => Response.json({ embedding: { values } }) }), /embedding_output_invalid/);
  }
  for (const [status, code] of [[402, 'provider_billing_required'], [429, 'provider_rate_limited'], [503, 'embedding_unavailable']]) {
    assert.equal(providerErrorCode(status), status === 503 ? 'provider_unavailable' : code);
    await assert.rejects(embedText({ text: 'test', apiKey: 'test', fetcher: async () => new Response('', { status }) }), error => error.message === code);
  }
});
test('knowledge search runs through the existing harness and hides sources by default', async () => {
  for (const question of ['กฎเติมวัสดุ', 'ขอแหล่งข้อมูลกฎเติมวัสดุ']) {
    const calls = [{name:'search_knowledge',args:{query:'กฎเติมวัสดุ'}},{name:'finish',args:{}}];
    const result = await runAgent({message:question,temperature:0,generate:async()=>({candidates:[{content:{parts:[{functionCall:calls.shift()}]}}]}),
      read:async d=>({tool:d.name,status:'ok',data:[{content:'Trigger 3.5 เดือน',source_id:'rules.md'}]})});
    assert.equal(result.status,'ok'); assert.match(result.answer,/Trigger 3.5/);
    assert.equal(result.answer.includes('rules.md'),question.includes('แหล่งข้อมูล'));
  }
});
