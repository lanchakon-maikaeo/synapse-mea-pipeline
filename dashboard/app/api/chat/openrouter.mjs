import { DB_TOOLS } from './tools.mjs';
// Keep the existing agent's validated tool contract while using OpenRouter on the wire.
export const CHAT_MODEL = 'openai/gpt-4o-mini';
export const CHAT_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// LLM_PROVIDER picks where chat and alert requests go; all speak OpenAI chat completions.
//   openrouter (default)  key sk-or-…, LLM_MODEL provider/model; the only one with embeddings
//   typhoon               api.opentyphoon.ai, LLM_MODEL typhoon-… (default below)
//   openai-compatible     any https …/chat/completions in LLM_API_URL, LLM_MODEL required
// Without embeddings, document search (BGE-M3 via OpenRouter) is off.
export const TYPHOON_API_URL = 'https://api.opentyphoon.ai/v1/chat/completions';
export const TYPHOON_MODEL = 'typhoon-v2.5-30b-a3b-instruct';

function compatibleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.endsWith('/chat/completions') ? url.href : null;
  } catch { return null; }
}

export function providerConfig(env = process.env) {
  const provider = env.LLM_PROVIDER?.trim().toLowerCase() || 'openrouter';
  const apiKey = env.LLM_API_KEY?.trim() || '';
  const model = env.LLM_MODEL?.trim() || { openrouter: CHAT_MODEL, typhoon: TYPHOON_MODEL }[provider] || '';
  // Choosing tools and writing answers run at 0.4; reviewing and ranking stay at 0.
  const temperature = Number(env.LLM_TEMPERATURE?.trim() || '0.4');
  const timeoutMs = Number(env.LLM_TIMEOUT_MS?.trim() || '30000');
  const plainKey = /^[\x21-\x7e]{8,512}$/.test(apiKey) && !apiKey.startsWith('sk-or-');
  const apiUrl = { openrouter: CHAT_API_URL, typhoon: TYPHOON_API_URL,
    'openai-compatible': compatibleUrl(env.LLM_API_URL?.trim() || '') }[provider];
  const valid = {
    openrouter: apiKey.startsWith('sk-or-') && model.length <= 200 && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(model),
    typhoon: plainKey && /^typhoon-[a-z0-9._-]{1,100}$/i.test(model),
    'openai-compatible': plainKey && /^[a-z0-9][a-z0-9._:/-]{0,199}$/i.test(model),
  }[provider];
  if (!valid || !apiUrl ||
      !Number.isFinite(temperature) || temperature < 0 || temperature > 2 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 40000) return null;
  return { provider, apiKey, model, temperature, timeoutMs, apiUrl, embeddings: provider === 'openrouter' };
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
      pending = { ...calls[0], deferred: turn.parts.flatMap(p=>p.deferredFunctionCalls??[]) };
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: pending.id, type: 'function',
        function: { name: pending.name, arguments: JSON.stringify(pending.args) } },
        ...pending.deferred.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))] });
    } else if (results.length) {
      if (results.length !== 1 || !pending || results[0].name !== pending.name) throw Error('provider_tool_history_invalid');
      messages.push({ role: 'tool', tool_call_id: pending.id, content: JSON.stringify(results[0].response) });
      for(const call of pending.deferred)messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({status:'deferred',message:'This read was not executed. Choose it again after inspecting the completed read if still needed.'})});
      pending = undefined;
    } else {
      messages.push({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.parts.map(p => p.text ?? '').join('\n') });
    }
  }
  if (pending) throw Error('provider_tool_history_invalid');
  return {
    model, messages,
    // The Azure mini endpoints omit tools from their supported parameters.
    ...(model === CHAT_MODEL ? { provider: { only: ['openai'] } } : {}),
    tools: body.tools.flatMap(tool => tool.functionDeclarations).map(fn => ({ type: 'function',
      function: { name: fn.name, description: fn.description, parameters: fn.parametersJsonSchema, strict: true } })),
    tool_choice: body.tools.flatMap(tool=>tool.functionDeclarations).length===1
      ? {type:'function',function:{name:body.tools[0].functionDeclarations[0].name}} : 'required', parallel_tool_calls: false,
    // OpenRouter omits parallel_tool_calls from GPT-4o-mini endpoint metadata.
    // Requiring every parameter filters out its tool-capable endpoint (404).
    // Keep the single-call response validation below as the execution boundary.
    temperature: body.generationConfig.temperature, max_tokens: body.generationConfig.maxOutputTokens,
  };
}

export function openRouterResponse(payload) {
  if (!Array.isArray(payload?.choices) || payload.choices.length !== 1) throw Error('provider_output_invalid_choices');
  const choice = payload.choices[0];
  const calls = choice.message?.tool_calls;
  // Typhoon does not enforce tool_choice "required" and may answer in plain text instead.
  if (choice.finish_reason === 'stop' && !calls?.length && typeof choice.message?.content === 'string' && choice.message.content.trim()) throw Error('provider_text_reply');
  if (choice.finish_reason !== 'tool_calls') throw Error(choice.finish_reason === 'length' ? 'provider_output_invalid_length' : 'provider_output_invalid_finish');
  if(!Array.isArray(calls)||!calls.length||calls.length>6)throw Error('provider_output_invalid_call');
  if(calls.length>1&&!calls.every(call=>DB_TOOLS.has(call.function?.name)||call.function?.name==='read_evidence'))throw Error('provider_output_invalid_parallel');
  const normalized=calls.map(call=>{
    if(call.type!=='function'||typeof call.id!=='string'||!call.id||typeof call.function?.name!=='string'||typeof call.function?.arguments!=='string')throw Error('provider_output_invalid_call');
    let args;try{args=JSON.parse(call.function.arguments);}catch{throw Error('provider_output_invalid_json');}
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('provider_output_invalid');
    return {id:call.id,name:call.function.name,args};
  });
  if(new Set(normalized.map(call=>call.id)).size!==normalized.length)throw Error('provider_output_invalid_call');
  // The harness still executes one validated read per step. Account for every
  // provider call ID, explicitly deferring the rest rather than claiming results.
  return { candidates: [{ content: { role: 'model', parts: [{ functionCall: normalized[0],
    ...(normalized.length>1?{deferredFunctionCalls:normalized.slice(1)}:{})
  }] } }], usageMetadata: { totalTokenCount: payload.usage?.total_tokens } };
}
