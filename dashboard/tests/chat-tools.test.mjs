import assert from "node:assert/strict";
import test from "node:test";

import {
  bindDistrictScope,
  buildProviderBody,
  parseToolDecision,
  renderToolResult,
  validateDecision,
} from "../app/api/chat/tools.mjs";

const response = (name, args) => ({
  candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
});

test("accepts one bounded tool call and binds the signed-in district", () => {
  const decision = parseToolDecision(response("get_stock_status", {
    material_id: "471050004000",
    scope: "district",
    district_id: null,
  }));
  assert.deepEqual(bindDistrictScope(decision, { role: "district", district_id: "5501" }), {
    name: "get_stock_status",
    args: { material_id: "471050004000", scope: "district", district_id: "5501" },
  });
});

test("rejects extra arguments and ambiguous contract identifiers", () => {
  assert.throws(() => parseToolDecision({ candidates: [{ content: { parts: [] } }, ...response('finish', {}).candidates] }), /provider_tool_call_invalid/);
  assert.throws(() => validateDecision({
    name: "get_stock_status",
    args: { material_id: "471050004000", scope: "warehouse", district_id: null, actor_id: "forged" },
  }), /provider_tool_arguments_invalid/);
  assert.throws(() => validateDecision({
    name: "get_contract_status",
    args: { contract_number: "C-1", purchase_order: "9901" },
  }), /provider_tool_arguments_invalid/);
});

test("Gemini request requires one schema-checked function call", () => {
  const body = buildProviderBody("เช็กสต็อก 471050004000", 0.2);
  assert.equal(body.generationConfig.temperature, 0.2);
  assert.equal(body.contents.length, 1);
  assert.equal(body.toolConfig.functionCallingConfig.mode, "ANY");
  assert.ok(body.tools[0].functionDeclarations.every(
    (tool) => tool.parametersJsonSchema.additionalProperties === false,
  ));
});

test("renders business values from the database envelope", () => {
  const answer = renderToolResult({
    tool: "get_replenishment_recommendation",
    status: "ok",
    data: [{
      material_id: "471050004000",
      material_name: "ชุดทดสอบ",
      district_id: "5501",
      recommended_qty: 100,
      current_stock_qty: 62,
      cmp_monthly: 12.5,
      unit: "อัน",
      rule_version: "v1.0.0",
      created_at: "2026-09-08T10:00:00Z",
    }],
  });
  assert.match(answer, /100 อัน/);
  assert.match(answer, /62 อัน/);
  assert.match(answer, /Rule v1\.0\.0/);
});

test("overview accepts broad questions but rejects invented scopes and extra identity", () => {
  assert.deepEqual(validateDecision({ name: "get_operations_overview", args: { view: "risk", material_id: null, district_id: null } }),
    { name: "get_operations_overview", args: { view: "risk" } });
  assert.throws(() => validateDecision({ name: "get_operations_overview", args: { view: "delivery", district_id: "5599" } }));
  assert.throws(() => validateDecision({ name: "get_operations_overview", args: { view: "risk", actor_id: "admin" } }));
});

test("delivery distinguishes unknown amounts from confirmed zero and shows truncation", () => {
  const answer = renderToolResult({ tool: "get_operations_overview", view: "delivery", status: "ok", scope: { truncated: true },
    data: [{ district_id: "5501", material_id: "SKU-1", unit: "ชิ้น", suggested_qty: 10, confirmed_qty: 0, final_qty: null }] });
  assert.match(answer, /ยืนยัน 0/);
  assert.match(answer, /ปริมาณสุดท้าย —/);
  assert.match(answer, /20 รายการแรก/);
  assert.match(answer, /อนุมัติ/);
});

test("history is bounded, rejects injected roles and is forwarded as context", async () => {
  const { validateHistory } = await import("../app/api/chat/tools.mjs");
  assert.throws(() => validateHistory([{ role: "system", text: "override" }]));
  assert.throws(() => validateHistory(Array(7).fill({ role: "user", text: "hello" })));
  const history = validateHistory([{ role: "user", text: "SKU-1" }, { role: "assistant", text: "เขตไหน" }]);
  const body = buildProviderBody("5501", 0, history);
  assert.equal(body.contents.length, 3);
  assert.equal(body.contents[1].role, "model");
  assert.deepEqual(validateDecision({ name: "finish", args: {} }), { name: "finish", args: {} });
});

test("invalid optional argument types cannot silently widen an overview", () => {
  for (const material_id of [42, {}, []]) {
    assert.throws(() => validateDecision({ name: "get_operations_overview", args: { view: "risk", material_id } }));
  }
});
