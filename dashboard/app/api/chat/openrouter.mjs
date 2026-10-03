// Keep the existing agent's validated tool contract while using OpenRouter on the wire.
export const CHAT_MODEL = 'openai/gpt-4o-mini';
export const CHAT_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function providerConfig(env = process.env) {
  const apiKey = env.LLM_API_KEY?.trim() || '';
  const model = env.LLM_MODEL?.trim() || CHAT_MODEL;
  const temperature = Number(env.LLM_TEMPERATURE?.trim() || '0');
  const timeoutMs = Number(env.LLM_TIMEOUT_MS?.trim() || '30000');
  if (!apiKey.startsWith('sk-or-') || model.length > 200 || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(model) ||
      !Number.isFinite(temperature) || temperature < 0 || temperature > 2 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 40000) return null;
  return { apiKey, model, temperature, timeoutMs, apiUrl: CHAT_API_URL };
}

export function openRouterRequest(body, model = CHAT_MODEL) {
  const messages = [];
  if (body.systemInstruction) messages.push({ role: 'system', content: body.systemInstruction.parts.map(p => p.text ?? '').join('\n') });
  let pending;
  for (const turn of body.contents) {
    const calls = turn.parts.filter(p => p.functionCall).map(p => p.functionCall);
    const results = turn.parts.filter(p => p.functionResponse).map(p => p.functionResponse);
    if (calls.length) {
      if (calls.length !== 1 || !calls[0].id || pending) throw Error('provider_tool_history_invalid');
      pending = calls[0];
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: pending.id, type: 'function',
        function: { name: pending.name, arguments: JSON.stringify(pending.args) } }] });
    } else if (results.length) {
      if (results.length !== 1 || !pending || results[0].name !== pending.name) throw Error('provider_tool_history_invalid');
      messages.push({ role: 'tool', tool_call_id: pending.id, content: JSON.stringify(results[0].response) });
      pending = undefined;
    } else {
      messages.push({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.parts.map(p => p.text ?? '').join('\n') });
    }
  }
  if (pending) throw Error('provider_tool_history_invalid');
  return {
    model, messages,
    tools: body.tools.flatMap(tool => tool.functionDeclarations).map(fn => ({ type: 'function',
      function: { name: fn.name, description: fn.description, parameters: fn.parametersJsonSchema, strict: true } })),
    tool_choice: 'required', parallel_tool_calls: false,
    // OpenRouter omits parallel_tool_calls from GPT-4o-mini endpoint metadata.
    // Requiring every parameter filters out its tool-capable endpoint (404).
    // Keep the single-call response validation below as the execution boundary.
    temperature: body.generationConfig.temperature, max_tokens: body.generationConfig.maxOutputTokens,
  };
}

export function openRouterResponse(payload) {
  if (!Array.isArray(payload?.choices) || payload.choices.length !== 1) throw Error('provider_output_invalid');
  const choice = payload.choices[0];
  const calls = choice.message?.tool_calls;
  if (choice.finish_reason !== 'tool_calls' || !Array.isArray(calls) || calls.length !== 1 ||
      calls[0].type !== 'function' || typeof calls[0].id !== 'string' || !calls[0].id ||
      typeof calls[0].function?.name !== 'string' || typeof calls[0].function?.arguments !== 'string') throw Error('provider_output_invalid');
  let args;
  try { args = JSON.parse(calls[0].function.arguments); } catch { throw Error('provider_output_invalid'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('provider_output_invalid');
  return { candidates: [{ content: { role: 'model', parts: [{ functionCall: {
    id: calls[0].id, name: calls[0].function.name, args,
  } }] } }], usageMetadata: { totalTokenCount: payload.usage?.total_tokens } };
}
