import test from 'node:test';
import assert from 'node:assert/strict';
import { embedMaterialNames } from '../app/api/material-embeddings.mjs';

const unit = axis => { const values = Array(1024).fill(0); values[axis] = 1; return values; };
const names = count => Array.from({ length: count }, (_, i) => ({ material_id: `M${i}`, material_name: `วัสดุ ${i}` }));

test('the daily job embeds queued material names 100 per call and saves them in small batches until the queue is empty', async () => {
  const queues = [names(100), names(30), []], embedded = [], saved = [];
  const result = await embedMaterialNames({ signal: new AbortController().signal,
    embed: async texts => { embedded.push(texts.length); return texts.map((_, i) => unit(i % 1024)); },
    rpc: async (name, body) => {
      if (name === 'material_embedding_queue') { assert.deepEqual(body, { p_limit: 100 }); return queues.shift(); }
      assert.equal(name, 'material_embedding_save');
      assert.ok(body.p_rows.length <= 25);
      for (const row of body.p_rows) assert.equal(JSON.parse(row.embedding).length, 1024);
      saved.push(...body.p_rows.map(row => row.material_id));
      return body.p_rows.length;
    } });
  assert.deepEqual(embedded, [100, 30]);
  assert.equal(saved.length, 130);
  assert.deepEqual(result, { status: 'done', embedded: 130, saved: 130 });
});

test('the job stops at its batch limit or deadline and says the queue is not empty yet', async () => {
  const result = await embedMaterialNames({ signal: new AbortController().signal, batches: 2,
    embed: async texts => texts.map(() => unit(0)), rpc: async (name, body) => name === 'material_embedding_queue' ? names(100) : body.p_rows.length });
  assert.deepEqual(result, { status: 'partial', embedded: 200, saved: 200 });
  const stopped = await embedMaterialNames({ signal: AbortSignal.abort(), embed: async () => assert.fail('no call after the deadline'),
    rpc: async () => assert.fail('no call after the deadline') });
  assert.deepEqual(stopped, { status: 'partial', embedded: 0, saved: 0 });
});

// Production 27 Nov: each run embedded 900-1,500 names, then the 90-second deadline aborted a Cloudflare call
// mid-batch and the run answered 503 (embedding_unavailable, then embedding_output_invalid) for work it had saved.
test('no batch starts once the time budget is spent, and a deadline that lands mid-batch still reports what was saved', async () => {
  const clock = [0, 0, 30_000, 61_000]; // start, then the check before each batch
  const rpc = async (name, body) => name === 'material_embedding_queue' ? names(100) : body.p_rows.length;
  const budgeted = await embedMaterialNames({ signal: new AbortController().signal, budgetMs: 60_000, now: () => clock.shift(),
    embed: async texts => texts.map(() => unit(0)), rpc });
  assert.deepEqual(budgeted, { status: 'partial', embedded: 200, saved: 200 });
  const deadline = new AbortController();
  let calls = 0;
  const cut = await embedMaterialNames({ signal: deadline.signal, rpc, embed: async texts => {
    if (++calls === 2) { deadline.abort(new DOMException('signal timed out', 'TimeoutError')); throw deadline.signal.reason; }
    return texts.map(() => unit(0));
  } });
  assert.deepEqual(cut, { status: 'partial', embedded: 100, saved: 100 });
});
