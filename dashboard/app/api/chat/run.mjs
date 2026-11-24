import { runAgent } from './harness.mjs';
import { retrieveDatabase } from './retrieval.mjs';
import { embedText, fetchProvider } from './embedding.mjs';
import { composeAnswer } from './answer.mjs';
import { openRouterRequest, openRouterResponse } from './openrouter.mjs';
import { createMasker } from './masking.mjs';

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
  try {
    const result = await runAgent({
      message, history, temperature: config.temperature, scope, signal,
      generate, hiddenTools: config.embeddings ? [] : ['search_knowledge'],
      read: async decision => decision.name === 'search_knowledge'
        ? rpc('vmi_chat_knowledge_bge_m3', {
          p_embedding: await embedText({ text: masker.mask(String(decision.args.query)), apiKey: config.apiKey, fetcher,
            signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) }),
          p_limit: topK,
        })
        : ['discover_database', 'query_database'].includes(decision.name)
        ? retrieveDatabase({ decision, question: message, generate, topK,
          rpc: query => rpc('vmi_chat_database', { p_tool: query.name, p_args: query.args, p_request_id: requestId }) })
        : rpc(decision.name === 'get_operations_overview' ? 'vmi_chat_overview' : 'vmi_chat_read', {
          p_tool: decision.name, p_args: decision.args, p_request_id: requestId,
        }),
    });
    // Reserve at most two extra calls for writing/review; same overall deadline.
    const answered = await composeAnswer({ result, question: message, history, signal, generate: body => generate(body, 14) });
    return { result: { ...answered, answer: masker.guard(answered.answer, [message, ...history.map(turn => turn.text), answered.evidence]) } };
  } finally {
    stats.counts = masker.counts();
  }
}
