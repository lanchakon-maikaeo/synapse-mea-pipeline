// Documents and questions must use the same model and dimensions.
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;

export function providerErrorCode(status, fallback = 'provider_unavailable') {
  return status === 402 ? 'provider_billing_required' : status === 429 ? 'provider_rate_limited' : fallback;
}

export async function embedText({ text, apiKey, taskType = 'RETRIEVAL_QUERY', signal, fetcher = fetch }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000 || !apiKey ||
      !['RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT'].includes(taskType)) throw Error('embedding_input_invalid');
  const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`, {
    method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `models/${EMBEDDING_MODEL}`, content: { parts: [{ text }] },
      taskType, outputDimensionality: EMBEDDING_DIMENSIONS }),
    redirect: 'error', signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw Error(providerErrorCode(response.status, 'embedding_unavailable'));
  }
  const values = (await response.json())?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS ||
      values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw Error('embedding_output_invalid');
  const norm = Math.hypot(...values);
  if (!norm) throw Error('embedding_output_invalid');
  return values.map(value => value / norm);
}
