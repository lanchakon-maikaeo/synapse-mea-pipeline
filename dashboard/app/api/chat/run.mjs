import { runAgent } from './harness.mjs';
import { retrieveDatabase } from './retrieval.mjs';
import { embedText, embedTexts, fetchProvider } from './embedding.mjs';
import { asked } from './tools.mjs';
import { sapTerms } from './sap-terms.mjs';
import { composeAnswer } from './answer.mjs';
import { openRouterRequest, openRouterResponse } from './openrouter.mjs';
import { createMasker } from './masking.mjs';

// An ordered row read (no group_by or metrics) under this limit is read this wide, then cut back to the model's limit
// plus the rows that tie with its last row, like SQL's WITH TIES: "the most" then names every row that shares it.
const TIES_LIMIT = 20;
const tied = ({ order_column, group_by, metrics, limit }) => Boolean(order_column) && !group_by?.length && !metrics?.length && limit < TIES_LIMIT;
function withTies(envelope, { order_column: column, limit }) {
  if (envelope?.status !== 'ok' || !Array.isArray(envelope.data)) return envelope;
  const rows = envelope.data;
  const last = rows[limit - 1]?.[column];
  let kept = Math.min(limit, rows.length);
  while (last !== undefined && last !== null && kept < rows.length && String(rows[kept]?.[column]) === String(last)) kept++;
  return { ...envelope, data: rows.slice(0, kept), scope: { ...envelope.scope, truncated: kept < rows.length || Boolean(envelope.scope?.truncated) },
    ...(envelope.query && { query: { ...envelope.query, limit } }) };
}

// One chat question is one AI run. rpc reads Supabase as the signed-in user; every provider
// call goes through this run's masker. stats is filled even when the run throws.
export async function runChat({ message, history = /** @type {{ role: string, text: string }[]} */ ([]), scope, requestId, config, topK = 6, terms, rpc, signal,
  fetcher = fetch, stats = /** @type {{ modelCalls: number, totalTokens: number, counts?: Record<string, number> }} */ ({ modelCalls: 0, totalTokens: 0 }) }) {
  const masker = createMasker(terms);
  const generate = async (body, limit = 12) => {
    if (stats.modelCalls >= limit) throw new Error('model_call_limit');
    const response = await fetchProvider(config.apiUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(openRouterRequest(masker.maskBody(body), config.model)), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    }, async (input, init) => {
      if (stats.modelCalls >= limit) throw new Error('model_call_limit');
      stats.modelCalls++; return fetcher(input, init);
    });
    const payload = masker.restore(openRouterResponse(await response.json()));
    const tokens = payload?.usageMetadata?.totalTokenCount;
    if (Number.isSafeInteger(tokens) && tokens >= 0) stats.totalTokens += tokens;
    return payload;
  };
  // BGE-M3 on Cloudflare for any provider, else OpenRouter's; the text is masked like every other provider call.
  const embed = config.cloudflare || config.embeddings ? async text => {
    const options = { fetcher, signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) };
    return config.cloudflare ? (await embedTexts({ texts: [masker.mask(text)], ...config.cloudflare, ...options }))[0]
      : embedText({ text: masker.mask(text), apiKey: config.apiKey, ...options });
  } : undefined;
  const materialSources = new Set();
  // ADR 0002, RRF: a search with no exact hit in a source of materials asks once more with what the text means and its
  // SAP terms; the database fuses the text and meaning ranks. A failed embedding or second read keeps the first result.
  const database = async query => {
    const args = { p_tool: query.name, p_args: query.args, p_request_id: requestId };
    const first = query.name === 'query_database' && tied(query.args ?? {})
      ? withTies(await rpc('vmi_chat_database', { ...args, p_args: { ...query.args, limit: TIES_LIMIT } }), query.args)
      : await rpc('vmi_chat_database', args);
    if (query.name === 'discover_database' && Array.isArray(first?.data)) first.data
      .filter(source => source && Object.hasOwn(source.columns ?? {}, 'material_id')).forEach(source => materialSources.add(source.source_id));
    const text = query.name === 'query_database' && first?.status === 'no_data' && !query.args?.metrics?.length &&
      materialSources.has(query.args?.source_id) && asked(query.args);
    if (!text) return first;
    // Most material names are SAP English ("TRANS 3P4W ... 250KVA"); Thai words also go as SAP terms (near_text), which
    // the database counts in each name, and they join the text that is embedded.
    const terms = sapTerms(text);
    if (!embed && !terms) return first;
    const vector = embed && await embed(terms ? `${text} ${terms.replaceAll('|', ' ')}` : text).catch(() => undefined);
    if (!vector && !terms) return first;
    const second = await rpc('vmi_chat_database', { ...args, p_args: terms ? { ...query.args, near_text: terms } : query.args,
      ...(vector && { p_embedding: `[${vector.join(',')}]` }) }).catch(() => undefined);
    // The model sees the query it wrote, not the terms added for it.
    return second?.status === 'no_data' ? { ...second, ...(first.query !== undefined && { query: first.query }) } : first;
  };
  try {
    const result = await runAgent({
      message, history, temperature: config.temperature, scope, signal,
      generate, hiddenTools: embed && config.documents ? [] : ['search_knowledge'],
      read: async decision => decision.name === 'search_knowledge'
        ? rpc('vmi_chat_knowledge_bge_m3', {
          p_embedding: `[${(await embed(String(decision.args.query))).join(',')}]`,
          // The text list reads our own database, so the query goes as asked.
          p_limit: topK, p_query: String(decision.args.query),
        })
        : ['discover_database', 'query_database'].includes(decision.name)
        ? retrieveDatabase({ decision, question: message, generate, topK, rpc: database })
        : rpc(decision.name === 'get_operations_overview' ? 'vmi_chat_overview' : 'vmi_chat_read', {
          p_tool: decision.name, p_args: decision.args, p_request_id: requestId,
        }),
    });
    // Reserve at most four extra calls: writing and review, each asked once more after a text reply; same overall deadline.
    const answered = await composeAnswer({ result, question: message, history, signal, temperature: config.temperature, generate: body => generate(body, 16) });
    return { result: { ...answered, answer: masker.guard(answered.answer, [message, ...history.map(turn => turn.text), answered.evidence]) } };
  } finally {
    stats.counts = masker.counts();
  }
}
