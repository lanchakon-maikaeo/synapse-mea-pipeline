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
