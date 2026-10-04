import { setTimeout as delay } from 'node:timers/promises';
// Documents and questions must use the same model and dimensions.
export const EMBEDDING_MODEL = 'baai/bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;

export function providerErrorCode(status, fallback = 'provider_unavailable') {
  return status === 402 ? 'provider_billing_required' : status === 429 ? 'provider_rate_limited' : fallback;
}

// A 402 with an explicit in-flight budget and Retry-After is temporary.
// All other 402 responses need the account/key credit limit checked.
export async function providerFailureCode(response, fallback = `provider_http_${response.status}`) {
  if(response.status!==402){await response.body?.cancel().catch(()=>undefined);return providerErrorCode(response.status,fallback);}
  const payload=await response.json().catch(()=>null);
  const delay=Number(response.headers.get('retry-after'));
  return payload?.error?.metadata?.limit_source==='openrouter_in_flight_budget'&&Number.isFinite(delay)&&delay>0
    ?'provider_capacity_budget':'provider_billing_required';
}

// Only replay a request rejected before generation by the in-flight budget.
export async function fetchProvider(url, init, fetcher = fetch, fallback = '') {
  for(let attempt=0;attempt<2;attempt++) {
    const response=await fetcher(url,init);
    if(response.ok)return response;
    const code=await providerFailureCode(response,fallback||undefined);
    const seconds=Number(response.headers.get('retry-after'));
    if(code==='provider_capacity_budget'&&attempt===0&&Number.isInteger(seconds)&&seconds>0&&seconds<=10) {
      await delay(seconds*1000,undefined,{signal:init.signal});
      continue;
    }
    throw Error(code,{cause:code==='provider_capacity_budget'&&Number.isFinite(seconds)&&seconds>0?{retry_after_seconds:seconds}:undefined});
  }
  throw Error('provider_unavailable');
}

export async function embedText({ text, apiKey, taskType = 'RETRIEVAL_QUERY', signal, fetcher = fetch }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000 || !apiKey?.startsWith('sk-or-') ||
      !['RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT'].includes(taskType)) throw Error('embedding_input_invalid');
  const response = await fetchProvider('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, encoding_format: 'float' }),
    redirect: 'error', signal,
  },fetcher,'embedding_unavailable');
  const payload = await response.json();
  const invalidOutput = reason => new Error('embedding_output_invalid', { cause: {
    embedding_validation: reason,
    response_model: typeof payload?.model === 'string' && /^[a-zA-Z0-9/_.:-]{1,120}$/.test(payload.model) ? payload.model : 'unknown',
    vector_dimensions: Array.isArray(payload?.data?.[0]?.embedding) ? payload.data[0].embedding.length : null,
  } });
  // OpenRouter can return the provider's model name instead of its routing slug.
  if (!['baai/bge-m3', 'BAAI/bge-m3', 'parasail-bge-m3'].includes(payload?.model) || !Array.isArray(payload?.data) || payload.data.length !== 1 ||
      payload.data[0]?.index !== 0) throw invalidOutput('response_shape');
  const values = payload.data[0].embedding;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS ||
      values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw invalidOutput('vector_shape');
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || !norm) throw invalidOutput('vector_norm');
  return values.map(value => value / norm);
}
