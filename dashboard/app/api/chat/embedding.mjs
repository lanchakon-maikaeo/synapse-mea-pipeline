// Documents and questions must use the same model and dimensions.
export const EMBEDDING_MODEL = 'baai/bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;

export function providerErrorCode(status, fallback = 'provider_unavailable') {
  return status === 402 ? 'provider_billing_required' : status === 429 ? 'provider_rate_limited' : fallback;
}

export async function embedText({ text, apiKey, taskType = 'RETRIEVAL_QUERY', signal, fetcher = fetch }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000 || !apiKey?.startsWith('sk-or-') ||
      !['RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT'].includes(taskType)) throw Error('embedding_input_invalid');
  const response = await fetcher('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, encoding_format: 'float' }),
    redirect: 'error', signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw Error(providerErrorCode(response.status, 'embedding_unavailable'));
  }
  const payload = await response.json();
  if (payload?.model !== EMBEDDING_MODEL || !Array.isArray(payload.data) || payload.data.length !== 1 ||
      payload.data[0]?.index !== 0) throw Error('embedding_output_invalid');
  const values = payload.data[0].embedding;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS ||
      values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw Error('embedding_output_invalid');
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || !norm) throw Error('embedding_output_invalid');
  return values.map(value => value / norm);
}
