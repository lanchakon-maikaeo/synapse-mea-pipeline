import test from 'node:test';
import assert from 'node:assert/strict';
import { runAlertWorker } from '../app/api/agentic-alert-worker.mjs';

const now = new Date('2026-11-22T03:00:00Z');
const env = { LLM_PROVIDER: 'typhoon', LLM_API_KEY: 'test-key-123' };
// One workflow alert: a plan waiting for the district, whose queue row names the requester.
const context = { policy: { months_trigger: 3.5, min_months: 4, stock_max_age_hours: 26 }, existing: [], units: [], warehouse: [], stock: [],
  queue: [{ replenishment_plan_id: 'p1', plan_number: 'KT01-W45-021169', plan_status: 'pending_district_confirmation',
    replenishment_item_id: 'i1', item_status: 'pending', material_id: '015800100148', material_name: 'SURGE ARRESTER', district_id: '5501',
    district_name_th: 'นวลจันทร์', requested_qty: 10, final_qty: 10, allocated_qty: 0, priority_score: 5, priority_band: 'high',
    input_data_class: 'actual', origin_location_id: null, updated_at: '2026-11-21T03:00:00Z',
    requester_name: 'วิภา ทองดี', district_note: 'โทรหาวิภา 089-111-2222 แล้ว' }] };

function database({ terms = { names: ['วิภา ทองดี'], words: [] } } = {}) {
  const calls = {};
  const rpc = async (name, args) => {
    (calls[name] ??= []).push(args);
    if (name === 'agentic_alert_claim') return true;
    if (name === 'agentic_alert_context') return context;
    if (name === 'ai_privacy_terms') { if (terms instanceof Error) throw terms; return terms; }
    if (name === 'agentic_alert_save') return { saved: args.p_alerts.length };
    return null;
  };
  return { rpc, calls };
}
function provider(...replies) {
  const requests = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const reply = replies.shift()(JSON.stringify(body));
    // Typhoon may answer in plain text even when one function is required.
    if (typeof reply === 'string') return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: reply } }] });
    const [name, args] = reply;
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call_${requests.length}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 10 } });
  };
  return { requests, fetcher };
}
const label = (sent, word) => sent.match(new RegExp(`\\[${word}-\\d+\\]`))?.[0];
const read = () => ['read_evidence', { sources: ['queue'] }];
const recommend = sent => ['recommend', { summary: `${label(sent, 'ชื่อ')} ยังไม่ยืนยันแผน KT01-W45-021169`,
  actions: [`ติดต่อ ${label(sent, 'ชื่อ')} ที่ ${label(sent, 'เบอร์โทร')}`], evidence_ids: ['alert', 'queue'], uncertainties: [] }];
const verdict = (supported, phrase = '') => () => ['check_recommendation', { explanation: 'ตรวจแล้ว', unsupported_phrase: phrase,
  reason: supported ? 'supported' : 'invented_date', supported }];
const run = (rpc, fetcher) => runAlertWorker({ rpc, env, now, fetcher, signal: new AbortController().signal });

test('people in alert evidence never reach the provider; the saved analysis shows real values and counts are kept', async () => {
  const { rpc, calls } = database();
  const { requests, fetcher } = provider(read, recommend, verdict(true));
  const result = await run(rpc, fetcher);
  assert.equal(result.analyzed, 1);
  assert.doesNotMatch(JSON.stringify(requests), /วิภา|089-111-2222|0891112222/);
  const analysis = calls.agentic_alert_save[0].p_alerts[0].details.analysis;
  assert.equal(analysis.summary, 'วิภา ทองดี ยังไม่ยืนยันแผน KT01-W45-021169');
  assert.deepEqual(analysis.actions, ['ติดต่อ วิภา ทองดี ที่ 089-111-2222']);
  assert.deepEqual(calls.ai_record_mask_counts, [{ p_task: 'alerts', p_counts: { name: 2, phone: 1 } }]);
});

test('a rejected draft is logged with this run\'s labels, never the values', async (t) => {
  const logged = [];
  t.mock.method(console, 'warn', line => logged.push(line));
  const { rpc } = database();
  const { fetcher } = provider(read, recommend, sent => verdict(false, `ติดต่อ ${label(sent, 'ชื่อ')}`)(), sent => verdict(false, `ติดต่อ ${label(sent, 'ชื่อ')}`)());
  const result = await run(rpc, fetcher);
  assert.deepEqual(result.errors, { unsupported_invented_date: 1 });
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], /วิภา|089-111-2222/);
  assert.match(JSON.parse(logged[0]).actions[0], /^ติดต่อ \[ชื่อ-\d+\] ที่ \[เบอร์โทร-\d+\]$/);
  assert.match(JSON.parse(logged[0]).phrase, /^ติดต่อ \[ชื่อ-\d+\]$/);
});

test('a draft citing a label this run never issued is rejected as unknown_label', async () => {
  const { rpc, calls } = database();
  const { fetcher } = provider(read, () => ['recommend', { summary: '[ชื่อ-9] ยังไม่ยืนยันแผน', actions: ['ติดต่อผู้ขอ'],
    evidence_ids: ['alert', 'queue'], uncertainties: [] }]);
  const result = await run(rpc, fetcher);
  assert.deepEqual(result.errors, { unknown_label: 1 });
  assert.equal(calls.agentic_alert_save[0].p_alerts[0].details.analysis_status, 'evidence_only');
});

test('without the masking terms no alert goes to a provider, and every alert is still saved', async () => {
  const { rpc, calls } = database({ terms: new Error('rpc down') });
  const { requests, fetcher } = provider();
  const result = await run(rpc, fetcher);
  assert.equal(requests.length, 0);
  assert.deepEqual(result.errors, { privacy_terms_unavailable: 1 });
  assert.equal(calls.agentic_alert_save[0].p_alerts[0].details.analysis_status, 'evidence_only');
});

test('an analysis answered in text is asked once more for the function', async () => {
  const { rpc } = database();
  const { requests, fetcher } = provider(read, () => 'ควรติดต่อเขตเพื่อยืนยันแผน', recommend, verdict(true));
  const result = await run(rpc, fetcher);
  assert.equal(requests.length, 4);
  assert.match(requests[2].messages.at(-1).content, /recommend/);
  assert.equal(result.analyzed, 1);
});
