// PROTOTYPE, wipe me: throwaway trial of DeepSeek Harness (dsh), never production.
// The chat route's read tools as an MCP stdio server, answered by evals/fixture.mjs (never a
// database). Same argument checks and district binding as the chat route; discovery returns
// every permitted source (no model ranking here). Newline-delimited JSON-RPC, hand-rolled.
import { createInterface } from 'node:readline';
import { CHAT_TOOLS, validateDecision, bindDistrictScope } from '../../app/api/chat/tools.mjs';
import { retrieveDatabase } from '../../app/api/chat/retrieval.mjs';
import { fixtureDatabase } from '../fixture.mjs';

const role = process.env.TRIAL_ROLE || 'planner';
const district = process.env.TRIAL_DISTRICT || null;
const scope = { role, district_id: district };
const fixture = fixtureDatabase({ role, district });
const HIDDEN = new Set(['search_knowledge', 'conversation', 'finish', 'clarify', 'unsupported']);
const tools = CHAT_TOOLS.filter(t => !HIDDEN.has(t.name)).map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters }));

async function call(name, args) {
  let decision;
  try { decision = bindDistrictScope(validateDecision({ name, args }), scope); } catch (error) {
    const code = String(error?.message ?? error);
    // The same correction harness v5 sends back to the model (harness.mjs CORRECTIONS).
    return { status: 'invalid_input', problems: [code], ...(code === 'provider_tool_arguments_invalid' && { correction: `argument ของ ${name} ไม่ผ่านการตรวจ ใช้ชนิดและรูปแบบตาม schema และคำอธิบายของ function; ถ้ายังไม่มีรหัสในรูปแบบที่ถูกต้อง ให้ค้นด้วย discover_database ก่อน` }) };
  }
  const rpc = (fn, a) => fixture.rpc(fn, a);
  if (['discover_database', 'query_database'].includes(decision.name)) {
    return retrieveDatabase({ decision, question: '', topK: 30, generate: async () => { throw new Error('no_ranker'); },
      rpc: q => rpc('vmi_chat_database', { p_tool: q.name, p_args: q.args, p_request_id: 'trial' }) });
  }
  return rpc(decision.name === 'get_operations_overview' ? 'vmi_chat_overview' : 'vmi_chat_read', { p_tool: decision.name, p_args: decision.args, p_request_id: 'trial' });
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  try {
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'synapse-fixture', version: '0.0.0-prototype' } } });
    } else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools } });
    else if (msg.method === 'tools/call') {
      const result = await call(msg.params?.name, msg.params?.arguments ?? {});
      send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: ['invalid_input', 'forbidden'].includes(result?.status) } });
    } else if (msg.method === 'ping') send({ id: msg.id, result: {} });
    else send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  } catch (error) {
    send({ id: msg.id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
}
