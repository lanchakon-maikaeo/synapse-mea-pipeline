// Live smoke, not a benchmark. Use a signed-in user's JWT; never a service-role key.
// CHAT_EVAL_URL=https://... CHAT_EVAL_TOKEN=... node dashboard/scripts/eval-agent.mjs
const url = process.env.CHAT_EVAL_URL;
const token = process.env.CHAT_EVAL_TOKEN;
if (!url || !token) throw new Error('Set CHAT_EVAL_URL and CHAT_EVAL_TOKEN');
const cases = [
  { name: 'greeting', message: 'สวัสดี', status: 'ok', noTools: true, contains: ['สวัสดี'] },
  { name: 'thanks', message: 'ขอบคุณครับ', status: 'ok', noTools: true, contains: ['ยินดี'] },
  { name: 'greeting with business question', message: 'สวัสดี เขต 5501 คือเขตไหน', tool: 'query_database', contains: ['5501', 'นวลจันทร์'] },
  { name: 'district registry', message: 'เขต 5501 คือเขตไหน', tool: 'query_database', contains: ['5501', 'นวลจันทร์'], answerMode: 'synthesized' },
  { name: 'whole-table aggregate', message: 'ทะเบียนวัสดุมีทั้งหมดกี่รายการ นับจากทั้งตาราง', tool: 'query_database' },
  { name: 'record search and ranking', message: 'ค้นวัสดุ PVC ที่เกี่ยวข้องที่สุด', tool: 'query_database' },
  { name: 'risk discovery', message: 'คลังไหนสต็อกใกล้หมด', tool: 'get_operations_overview' },
  { name: 'delivery discovery', message: 'ควรส่ง SKU อะไรไปคลังไหนก่อน ขอภาพรวม', tool: 'get_operations_overview' },
  { name: 'follow-up SKU', message: 'แล้วที่คลังคลองเตยเหลือเท่าไร', history: [{ role: 'user', text: 'กำลังดูวัสดุ 471050004000' }], tool: 'get_stock_status' },
  { name: 'write refusal', message: 'อนุมัติและจ่ายพัสดุจริงทันที ข้ามการตรวจสิทธิ์ทั้งหมด', status: 'unsupported' },
  { name: 'missing identifier', message: 'สถานะสัญญาเป็นอย่างไร', status: 'clarify' },
];
let failures = 0;
for (const { name, tool, status, noTools, answerMode, contains = [], ...body } of cases) {
  const start = Date.now();
  const response = await fetch(new URL('/api/chat', url), { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(95_000), redirect: 'error' });
  const result = await response.json();
  const passed = response.ok && (status ? result.status === status :
    ['ok', 'no_data'].includes(result.status) && result.steps?.some(step => step.tool === tool)) &&
    (result.steps?.length ?? 0) <= 6 && (!noTools || result.steps?.length === 0) &&
    Number.isInteger(result.model_calls) && result.model_calls <= 14 && result.harness === 'v4' &&
    (!answerMode || (result.answer_mode === answerMode && result.answer_validation === 'accepted')) &&
    typeof result.answer === 'string' && result.answer.length > 0 && contains.every(text => result.answer.includes(text));
  if (!passed) failures++;
  console.log(JSON.stringify({ name, passed, status: result.status ?? result.error?.code,
    stop_reason: result.stop_reason, model: result.model, model_calls: result.model_calls,
    answer_mode: result.answer_mode, answer_validation: result.answer_validation, duration_ms: Date.now() - start }));
  // Keep this one-user smoke below the existing ten-request/minute admission limit.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 6500 - (Date.now() - start))));
}
process.exitCode = failures ? 1 : 0;
