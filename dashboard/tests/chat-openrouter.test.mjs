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
    assert.equal(request.model, 'openai/gpt-4o'); assert.deepEqual(request.tool_choice,request.tools.length===1?{type:'function',function:{name:request.tools[0].function.name}}:'required');
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

test('parallel read proposals execute one at a time and every unused call receives a deferred result',async()=>{
 const first=response('get_operations_overview',{view:'risk',material_id:null,district_id:null},'risk-1');
 first.choices[0].message.tool_calls.push(response('get_operations_overview',{view:'delivery',material_id:null,district_id:null},'delivery-deferred').choices[0].message.tool_calls[0]);
 let turns=0;const reads=[];
 const result=await runAgent({message:'คลังไหนใกล้หมดและควรส่งไหนก่อน',temperature:0,scope:{role:'admin'},
  generate:async body=>{turns++;const request=openRouterRequest(body);
   if(turns===1)return openRouterResponse(first);
   if(turns===2){const replies=request.messages.filter(x=>x.role==='tool');assert.equal(replies.length,2);assert.equal(replies[1].tool_call_id,'delivery-deferred');assert.equal(JSON.parse(replies[1].content).status,'deferred');assert.deepEqual(reads,['risk']);return openRouterResponse(response('get_operations_overview',{view:'delivery',material_id:null,district_id:null},'delivery-2'));}
   return openRouterResponse(response('finish',{},'finished'));
  },read:async decision=>{reads.push(decision.args.view);return {tool:decision.name,status:'no_data',data:[],view:decision.args.view};}});
 assert.deepEqual(reads,['risk','delivery']);assert.equal(result.stop_reason,'complete');
 const duplicate=structuredClone(first);duplicate.choices[0].message.tool_calls[1].id='risk-1';assert.throws(()=>openRouterResponse(duplicate),/invalid_call/);
 const unsafe=structuredClone(first);unsafe.choices[0].message.tool_calls[1].function.name='write_database';assert.throws(()=>openRouterResponse(unsafe),/invalid_parallel/);
});
