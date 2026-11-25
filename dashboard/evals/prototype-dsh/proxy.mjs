// PROTOTYPE, wipe me: throwaway trial of DeepSeek Harness (dsh), never production.
// The only process that holds the Typhoon key (start-proxy.sh reads it hidden). dsh talks to this
// OpenAI-compatible endpoint with a random local token; every request is masked with the chat
// route's masker (ADR 0001), one masker per trial run (/run/<id>/v1/...), and labels in the
// reply are restored before dsh sees it. Upstream is always non-streaming; a streaming request
// gets the whole reply back as one SSE chunk.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createMasker } from '../../app/api/chat/masking.mjs';
import { fixtureDatabase } from '../fixture.mjs';

const KEY = process.env.LLM_API_KEY;
delete process.env.LLM_API_KEY;
if (!KEY) { console.error('no key'); process.exit(2); }
const PORT = Number(process.env.TRIAL_PROXY_PORT ?? 18787);
const TOKEN = randomBytes(24).toString('hex');
writeFileSync(process.env.TRIAL_PROXY_TOKEN_FILE ?? '/private/tmp/dsh-trial/proxy.token', TOKEN, { mode: 0o600 });
const UPSTREAM = 'https://api.opentyphoon.ai/v1/chat/completions';
const MODEL = 'typhoon-v2.5-30b-a3b-instruct';
const { terms } = fixtureDatabase({});
const runs = new Map();
const run = id => {
  if (!runs.has(id)) runs.set(id, { masker: createMasker(terms), sent: [], statuses: [], calls: 0, tokens: 0 });
  return runs.get(id);
};

const maskJsonText = (masker, text) => {
  try { const value = JSON.parse(text); if (value && typeof value === 'object') return JSON.stringify(masker.mask(value)); } catch { /* plain text */ }
  return masker.mask(text);
};
function maskMessage(masker, m) {
  const out = { ...m };
  const maskText = text => m.role === 'tool' ? maskJsonText(masker, text) : masker.mask(text);
  if (typeof m.content === 'string') out.content = maskText(m.content);
  else if (Array.isArray(m.content)) out.content = m.content.map(p => p?.type === 'text' ? { ...p, text: maskText(p.text) } : p);
  if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls.map(c => ({ ...c, function: { ...c.function, arguments: maskJsonText(masker, c.function?.arguments ?? '') } }));
  return out;
}

const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

async function complete(req, res, r) {
  const body = {
    model: MODEL, messages: req.messages.map(m => maskMessage(r.masker, m)), temperature: req.temperature ?? 0,
    max_tokens: Math.min(req.max_tokens ?? req.max_completion_tokens ?? 4096, 4096),
    ...(req.tools?.length ? { tools: req.tools, tool_choice: req.tool_choice ?? 'auto' } : {}),
  };
  r.sent.push(JSON.stringify(body));
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    r.statuses.push(`fetch_failed:${error.cause?.code ?? error.name}`);
    return reply(res, 502, { error: { message: 'upstream_fetch_failed' } });
  }
  r.calls++;
  r.statuses.push(upstream.status);
  const text = await upstream.text();
  if (!upstream.ok) { res.writeHead(upstream.status, { 'content-type': 'application/json' }); return res.end(text); }
  const json = JSON.parse(text);
  r.tokens += json.usage?.total_tokens ?? 0;
  let message;
  try { message = r.masker.restore(json.choices?.[0]?.message ?? {}); } catch {
    r.statuses.push('unknown_label');
    return reply(res, 502, { error: { message: 'unknown_label' } });
  }
  const finish = json.choices?.[0]?.finish_reason ?? 'stop';
  const base = { id: json.id ?? 'trial', created: json.created ?? Math.floor(Date.now() / 1000), model: req.model };
  if (!req.stream) return reply(res, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage: json.usage });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices, ...extra })}\n\n`);
  chunk([{ index: 0, delta: { role: 'assistant', content: message.content ?? '',
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((c, index) => ({ index, id: c.id, type: 'function', function: c.function })) } : {}) },
  finish_reason: null }]);
  chunk([{ index: 0, delta: {}, finish_reason: finish }]);
  if (req.stream_options?.include_usage) chunk([], { usage: json.usage });
  res.end('data: [DONE]\n\n');
}

createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(res, 401, { error: { message: 'unauthorized' } });
  const url = new URL(req.url, 'http://localhost');
  const trial = url.pathname.match(/^\/_trial\/([\w-]+)$/);
  if (trial && req.method === 'GET') {
    const r = runs.get(trial[1]);
    runs.delete(trial[1]);
    return reply(res, 200, r ? { sent: r.sent, statuses: r.statuses, calls: r.calls, tokens: r.tokens, counts: r.masker.counts() } : { sent: [], statuses: [], calls: 0, tokens: 0 });
  }
  const route = url.pathname.match(/^\/run\/([\w-]+)\/v1\/(models|chat\/completions)$/);
  if (!route) return reply(res, 404, { error: { message: 'not_found' } });
  if (route[2] === 'models') return reply(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
  let raw = '';
  for await (const part of req) raw += part;
  try { await complete(JSON.parse(raw), res, run(route[1])); } catch (error) { reply(res, 500, { error: { message: String(error?.message ?? error) } }); }
}).listen(PORT, '127.0.0.1', () => console.log(`trial proxy on 127.0.0.1:${PORT}; key held in memory; token written`));
