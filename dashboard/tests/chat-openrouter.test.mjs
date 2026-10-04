import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_API_URL, providerConfig, openRouterRequest, openRouterResponse } from '../app/api/chat/openrouter.mjs';
import { runAgent } from '../app/api/chat/harness.mjs';
import { composeAnswer } from '../app/api/chat/answer.mjs';
import { parseToolDecision } from '../app/api/chat/tools.mjs';

const response = (name, args, id = 'call-1') => ({ choices: [{ finish_reason: 'tool_calls', message: {
  role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
} }], usage: { total_tokens: 10 } });

test('LLM_API_KEY selects GPT-4o-mini through OpenRouter without sending Google keys there', () => {
  const config = providerConfig({ LLM_API_KEY: ' sk-or-test ' });
  assert.equal(config.apiKey, 'sk-or-test'); assert.equal(config.model, 'openai/gpt-4o-mini');
  assert.equal(config.apiUrl, CHAT_API_URL);
  assert.deepEqual(openRouterRequest({contents:[],tools:[],generationConfig:{temperature:0,maxOutputTokens:100}}).provider,{only:['openai']});
  assert.equal(providerConfig({ LLM_API_KEY: 'sk-or-test', LLM_MODEL: '  ' }).model, config.model);
  for (const env of [{}, { LLM_API_KEY: 'AIza-google-key' }, { LLM_API_KEY: 'sk-or-test', LLM_TIMEOUT_MS: 'bad' },
    { LLM_API_KEY: 'sk-or-test', LLM_MODEL: 'gpt-4o-mini' }, { LLM_API_KEY: 'sk-or-test', LLM_MODEL: 'openai/gpt mini' }]) {
    assert.equal(providerConfig(env), null);
  }
});

test('OpenRouter runs the existing read loop and evidence-checked answer with matched tool IDs', async () => {
  const config = providerConfig({ LLM_API_KEY: 'sk-or-test', LLM_MODEL: ' openai/gpt-4o ' });
  const calls = [
    ['get_operations_overview', { view: 'risk', material_id: null, district_id: null }],
    ['finish', {}], ['write_answer', { answer: 'ยังไม่พบข้อมูลสต็อกที่ต้องเฝ้าระวัง', evidence_ids: [1] }],
    ['check_answer', { supported: true, answers_question: true, citations_valid: true }],
  ];
  const requests = [];
  const generate = async body => {
    const request = openRouterRequest(body, config.model); requests.push(request);
    assert.equal(request.model, 'openai/gpt-4o'); assert.equal(request.tool_choice, 'required');
    assert.equal(request.parallel_tool_calls, false);
    assert.notEqual(request.provider?.require_parameters, true);
    const [name, args] = calls.shift();
    assert.ok(request.tools.some(tool => tool.function.name === name));
    assert.ok(request.tools.every(tool => tool.function.strict === true));
    return openRouterResponse(response(name, args, `call-${requests.length}`));
  };
  const result = await runAgent({ message: 'คลังไหนใกล้หมด', history: [{ role: 'assistant', text: 'สอบถามได้เลย' }],
    temperature: 0, scope: { role: 'admin' }, generate,
    read: async () => ({ tool: 'get_operations_overview', view: 'risk', status: 'no_data', data: [], scope: { role: 'admin' } }),
  });
  assert.equal(result.stop_reason, 'complete');
  const tool = requests[1].messages.find(message => message.role === 'tool');
  assert.equal(tool.tool_call_id, 'call-1');
  assert.equal(requests[1].messages.find(message => message.tool_calls)?.tool_calls[0].id, 'call-1');
  assert.equal(requests[0].messages[1].role, 'assistant');
  const answer = await composeAnswer({ result, question: 'คลังไหนใกล้หมด', generate });
  assert.equal(answer.answer_mode, 'synthesized'); assert.equal(answer.answer_validation, 'accepted');
  assert.equal(calls.length, 0);
});

test('invalid, parallel, truncated and unknown calls cannot become executable decisions', () => {
  const valid = response('finish', {});
  for (const payload of [{ choices: [] }, { choices: [valid.choices[0], valid.choices[0]] },
    { choices: [{ ...valid.choices[0], finish_reason: 'length' }] },
    response('finish', []), response('finish', null),
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [...valid.choices[0].message.tool_calls, ...valid.choices[0].message.tool_calls] } }] }]) {
    assert.throws(() => openRouterResponse(payload), /provider_output_invalid/);
  }
  assert.throws(() => parseToolDecision(openRouterResponse(response('write_database', {}))));
});

test('a mismatched result cannot be attached to another tool call', () => {
  const content = openRouterResponse(response('get_stock_status', {})).candidates[0].content;
  assert.throws(() => openRouterRequest({ contents: [content, { role: 'user', parts: [{ functionResponse: { name: 'query_database', response: {} } }] }] }), /provider_tool_history_invalid/);
});
