import test from 'node:test';
import assert from 'node:assert/strict';
import { embedText, providerErrorCode } from '../app/api/chat/embedding.mjs';
import { runAgent } from '../app/api/chat/harness.mjs';

const vector = Array(1024).fill(0); vector[0] = 2;
test('BGE-M3 uses the same OpenRouter encoding for documents and questions and normalizes 1024 dimensions', async () => {
  for (const taskType of ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY']) {
    const result = await embedText({ text: 'หลักการเติมวัสดุ', apiKey: 'sk-or-test', taskType, fetcher: async (url, init) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/embeddings');
      assert.equal(init.headers.Authorization, 'Bearer sk-or-test');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'baai/bge-m3'); assert.equal(body.input, 'หลักการเติมวัสดุ');
      assert.equal(body.encoding_format, 'float'); assert.equal(body.dimensions, undefined);
      assert.equal(body.taskType, undefined);
      return Response.json({ model: 'baai/bge-m3', data: [{ index: 0, embedding: vector }] });
    } });
    assert.equal(result[0], 1); assert.equal(result.length, 1024);
  }
});
test('malformed vectors and provider failures cannot become knowledge evidence', async () => {
  for (const values of [[], [1], Array(768).fill(1), Array(1024).fill(0), Array(1024).fill('1'), Array(1024).fill(1e308)]) {
    await assert.rejects(embedText({ text: 'test', apiKey: 'sk-or-test', fetcher: async () => Response.json({ model: 'baai/bge-m3', data: [{ index: 0, embedding: values }] }) }), /embedding_output_invalid/);
  }
  for (const [status, code] of [[402, 'provider_billing_required'], [429, 'provider_rate_limited'], [503, 'embedding_unavailable']]) {
    assert.equal(providerErrorCode(status), status === 503 ? 'provider_unavailable' : code);
    await assert.rejects(embedText({ text: 'test', apiKey: 'sk-or-test', fetcher: async () => new Response('', { status }) }), error => error.message === code);
  }
});
test('a Google key or a response from a different embedding model cannot enter the BGE corpus', async () => {
  await assert.rejects(embedText({ text: 'test', apiKey: 'AIza-google-key', fetcher: async () => assert.fail('must not call provider') }), /embedding_input_invalid/);
  await assert.rejects(embedText({ text: 'test', apiKey: 'sk-or-test', fetcher: async () =>
    Response.json({ model: 'other-model', data: [{ index: 0, embedding: vector }] }) }), /embedding_output_invalid/);
});
test('verified BGE-M3 provider names normalize into the same corpus', async () => {
  for (const model of ['BAAI/bge-m3', 'parasail-bge-m3']) {
    const result = await embedText({ text: 'test', apiKey: 'sk-or-test', fetcher: async () =>
      Response.json({ model, data: [{ index: 0, embedding: vector }] }) });
    assert.equal(result.length, 1024); assert.equal(result[0], 1);
  }
});
test('knowledge search runs through the existing harness and names the documents it read', async () => {
  for (const question of ['กฎเติมวัสดุ', 'ขอแหล่งข้อมูลกฎเติมวัสดุ']) {
    const calls = [{name:'search_knowledge',args:{query:'กฎเติมวัสดุ'}},{name:'finish',args:{}}];
    const result = await runAgent({message:question,temperature:0,generate:async()=>({candidates:[{content:{parts:[{functionCall:calls.shift()}]}}]}),
      read:async d=>({tool:d.name,status:'ok',data:[{content:'Trigger 3.5 เดือน',source_id:'rules.md'}]})});
    assert.equal(result.status,'ok'); assert.match(result.answer,/Trigger 3.5/);
    assert.match(result.answer,/ที่มา: rules\.md$/);
  }
});

 test('402 in-flight capacity is distinct from an exhausted account or key budget',async()=>{
 const {providerFailureCode}=await import('../app/api/chat/embedding.mjs');
 const body={error:{metadata:{limit_source:'openrouter_in_flight_budget'}}};
 assert.equal(await providerFailureCode(new Response(JSON.stringify(body),{status:402,headers:{'retry-after':'2'}})),'provider_capacity_budget');
 assert.equal(await providerFailureCode(new Response(JSON.stringify(body),{status:402})),'provider_billing_required');
 assert.equal(await providerFailureCode(new Response(JSON.stringify({error:{message:'insufficient credits'}}),{status:402})),'provider_billing_required');
 assert.equal(await providerFailureCode(new Response('upstream',{status:503})),'provider_http_503');
 });

 test('provider waits for a short in-flight Retry-After once and never retries billing',async()=>{
 const {fetchProvider}=await import('../app/api/chat/embedding.mjs');let requests=0;
 const blocked=()=>new Response(JSON.stringify({error:{metadata:{limit_source:'openrouter_in_flight_budget'}}}),{status:402,headers:{'retry-after':'1'}});
 const response=await fetchProvider('https://openrouter.ai/api/v1/chat/completions',{signal:new AbortController().signal},async()=>++requests===1?blocked():new Response('ok'));
 assert.equal(await response.text(),'ok');assert.equal(requests,2);
 requests=0;
 await assert.rejects(fetchProvider('https://openrouter.ai/api/v1/chat/completions',{},async()=>{requests++;return new Response('{}',{status:402});}),/provider_billing_required/);
 assert.equal(requests,1);
 await assert.rejects(fetchProvider('https://openrouter.ai/api/v1/chat/completions',{},async()=>new Response(JSON.stringify({error:{metadata:{limit_source:'openrouter_in_flight_budget'}}}),{status:402,headers:{'retry-after':'60'}})),error=>error.message==='provider_capacity_budget'&&error.cause.retry_after_seconds===60);
 });

// ADR 0002, RRF: Cloudflare Workers AI runs BGE-M3 for material names and search text, at most 100 texts per call.
test('Cloudflare BGE-M3 embeds a batch of texts in order and normalizes each 1024-dimension vector', async () => {
  const { embedTexts } = await import('../app/api/chat/embedding.mjs');
  const other = Array(1024).fill(0); other[1] = 3;
  const account = '0123456789abcdef0123456789abcdef';
  const result = await embedTexts({ texts: ['หม้อแปลงไฟฟ้า', 'สายเคเบิล'], accountId: account, apiToken: 'cf-test-token-1234567890', fetcher: async (url, init) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/baai/bge-m3`);
    assert.equal(init.headers.Authorization, 'Bearer cf-test-token-1234567890');
    assert.deepEqual(JSON.parse(init.body), { text: ['หม้อแปลงไฟฟ้า', 'สายเคเบิล'] });
    return Response.json({ success: true, result: { shape: [2, 1024], data: [vector, other] } });
  } });
  assert.equal(result.length, 2); assert.equal(result[0][0], 1); assert.equal(result[1][1], 1); assert.equal(result[1].length, 1024);
});
test('a Cloudflare reply with the wrong count or shape, or a bad account, never becomes an embedding', async () => {
  const { embedTexts } = await import('../app/api/chat/embedding.mjs');
  const call = (reply, extra = {}) => embedTexts({ texts: ['a', 'b'], accountId: '0123456789abcdef0123456789abcdef', apiToken: 'cf-test-token-1234567890',
    fetcher: async () => Response.json(reply), ...extra });
  for (const reply of [{ success: true, result: { data: [vector] } }, { success: false, result: { data: [vector, vector] } },
    { success: true, result: { data: [vector, Array(768).fill(1)] } }, { success: true, result: { response: [{ id: 0, score: 0.9 }] } }]) {
    await assert.rejects(call(reply), /embedding_output_invalid/);
  }
  await assert.rejects(call({}, { accountId: 'not-an-account', fetcher: async () => assert.fail('must not call provider') }), /embedding_input_invalid/);
  await assert.rejects(call({}, { texts: Array(101).fill('a'), fetcher: async () => assert.fail('must not call provider') }), /embedding_input_invalid/);
  await assert.rejects(call({}, { fetcher: async () => new Response('', { status: 429 }) }), /provider_rate_limited/);
  // The status says what to fix: 401/403 is the token's Workers AI permission, 404 the account.
  for (const status of [400, 401, 403, 404, 500]) {
    await assert.rejects(call({}, { fetcher: async () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status }) }),
      error => error.message === `provider_http_${status}`);
  }
});
test('Cloudflare vectors under result.response are read the same as under result.data', async () => {
  const { embedTexts } = await import('../app/api/chat/embedding.mjs');
  const result = await embedTexts({ texts: ['a'], accountId: '0123456789abcdef0123456789abcdef', apiToken: 'cf-test-token-1234567890',
    fetcher: async () => Response.json({ success: true, result: { shape: [1, 1024], response: [vector], pooling: 'cls' } }) });
  assert.equal(result.length, 1); assert.equal(result[0][0], 1);
});
