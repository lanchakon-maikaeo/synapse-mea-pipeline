#!/usr/bin/env node
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

const REF = "vtwtfgocokuktxfumjuz";
const PROJECT = "test-synapse-mea";
const BASE_URL = `https://${REF}.supabase.co`;
const PREFIX = "p01-vmi-chat";
const actors = [
  ["poc_admin", "admin", null],
  ["poc_planner", "planner", null],
  ["poc_academic", "academic", null],
  ["poc_picker", "picker", null],
  ["poc_viewer", "viewer", null],
  ["poc_district_5501", "district", "5501"],
  ["poc_district_5502", "district", "5502"],
  ["poc_denied_inactive", "viewer", null, false],
];

const emailFor = (alias) => `${PREFIX}-${alias.replaceAll("_", "-")}@example.invalid`;
const parse = (text) => { try { return text ? JSON.parse(text) : null; } catch { return text; } };
const at = (value, path) => path.split(".").reduce((current, key) => current?.[key], value);
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { status: response.status, body: parse(text) };
}
function must(condition, message) {
  if (!condition) throw new Error(message);
}
function fakeJwt(exp, issuer) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ aud: "authenticated", role: "authenticated", sub: randomUUID(), exp, iss: issuer });
  const sig = createHmac("sha256", randomBytes(32)).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const accessToken = (process.env.SUPABASE_ACCESS_TOKEN ||
  await readFile(`${homedir()}/.supabase/access-token`, "utf8")).trim();
const management = { Authorization: `Bearer ${accessToken}` };
const project = await request(`https://api.supabase.com/v1/projects/${REF}`, { headers: management });
must(project.status === 200 && project.body.ref === REF && project.body.name === PROJECT,
  "Refusing actor writes: Supabase Test identity mismatch");
must(REF !== "fvdfduuanfrncrwuareb", "Refusing Production ref");

const keyResponse = await request(
  `https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`, { headers: management });
must(keyResponse.status === 200 && Array.isArray(keyResponse.body), "Could not read Test API keys");
const anon = keyResponse.body.find((key) => key.name === "anon")?.api_key;
const service = keyResponse.body.find((key) => key.name === "service_role")?.api_key;
must(anon && service, "Legacy anon/service_role keys are required for this P01 smoke check");
const adminHeaders = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };
const anonHeaders = { apikey: anon, "Content-Type": "application/json" };

const listed = await request(`${BASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, { headers: adminHeaders });
must(listed.status === 200, `Could not list Test users (${listed.status})`);
const existing = new Map((listed.body.users || []).map((user) => [user.email, user]));

if (process.argv.includes("--cleanup-actors")) {
  for (const [alias] of actors) {
    const user = existing.get(emailFor(alias));
    if (user) must((await request(`${BASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: "DELETE", headers: adminHeaders,
    })).status === 200, `Could not delete ${alias}`);
  }
  console.log(`P01 Test actors removed from ${PROJECT}/${REF}`);
  process.exit(0);
}

const sessions = {};
const identities = {};
for (const [alias, role, district_id, is_active = true] of actors) {
  const email = emailFor(alias);
  const password = `P01-${randomBytes(24).toString("base64url")}!a1`;
  let user = existing.get(email);
  if (user) {
    const updated = await request(`${BASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: "PUT", headers: adminHeaders,
      body: JSON.stringify({ password, email_confirm: true, user_metadata: { display_name: alias, p01_fixture: true } }),
    });
    must(updated.status === 200, `Could not reset ${alias} (${updated.status})`);
    user = updated.body.user || updated.body;
  } else {
    const created = await request(`${BASE_URL}/auth/v1/admin/users`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ email, password, email_confirm: true,
        user_metadata: { display_name: alias, p01_fixture: true } }),
    });
    must(created.status === 200, `Could not create ${alias} (${created.status})`);
    user = created.body.user || created.body;
  }
  identities[alias] = user.id;
  const profile = await request(`${BASE_URL}/rest/v1/user_profiles?user_id=eq.${user.id}`, {
    method: "PATCH", headers: { ...adminHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ role, district_id, is_active, display_name: alias }),
  });
  must(profile.status === 200 && profile.body.length === 1, `Could not set ${alias} profile (${profile.status})`);
  const signIn = await request(`${BASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: anonHeaders, body: JSON.stringify({ email, password }),
  });
  must(signIn.status === 200 && signIn.body.access_token, `Could not sign in ${alias} (${signIn.status})`);
  sessions[alias] = signIn.body.access_token;
}

const checks = [];
const check = (name, pass) => { checks.push([name, Boolean(pass)]); must(pass, name); };
async function rpc(alias, tool, args, requestId = randomUUID()) {
  return request(`${BASE_URL}/rest/v1/rpc/vmi_chat_read`, {
    method: "POST",
    headers: { ...anonHeaders, Authorization: `Bearer ${sessions[alias]}` },
    body: JSON.stringify({ p_tool: tool, p_args: args, p_request_id: requestId }),
  });
}

let r = await rpc("poc_picker", "get_stock_status", { material_id: "471050004000", scope: "warehouse" });
check("stock_warehouse", r.status === 200 && r.body.status === "ok" && r.body.data[0].quantity_on_hand === 17650 && r.body.data[0].unit === "อัน");
r = await rpc("poc_district_5501", "get_stock_status", { material_id: "471050004000", scope: "district", district_id: "5501" });
check("stock_same_district", r.status === 200 && r.body.status === "ok" && r.body.data[0].current_stock_qty === 62);
r = await rpc("poc_district_5501", "get_stock_status", { material_id: "471050004000", scope: "district", district_id: "5502" });
check("stock_cross_district", r.status === 200 && r.body.status === "forbidden" && r.body.data.length === 0);
r = await rpc("poc_planner", "get_replenishment_recommendation", { material_id: "471050004000", district_id: "5502" });
check("replenishment", r.status === 200 && r.body.status === "ok" && r.body.data[0].recommended_qty === 100 && r.body.data[0].rule_version === "v1.0.0");
r = await rpc("poc_academic", "get_replenishment_recommendation", { material_id: "471050005000", district_id: "5508" });
check("replenishment_cmp_zero_evidence", r.status === 200 && r.body.status === "ok" && r.body.data[0].cmp_monthly === 0 && r.body.data[0].recommended_qty === null && r.body.data[0].evidence.reason === "cmp_zero_not_eligible");
r = await rpc("poc_planner", "get_plan_status", { plan_id: "00000000-0000-4000-8000-000000005501" });
check("plan", r.status === 200 && r.body.status === "ok" && r.body.data[0].plan_status === "pending_planner_approval");
r = await rpc("poc_district_5502", "get_plan_status", { plan_id: "00000000-0000-4000-8000-000000005501" });
check("plan_foreign_hidden", r.status === 200 && r.body.status === "no_data" && r.body.data.length === 0);
r = await rpc("poc_viewer", "get_contract_status", { purchase_order: "990000000000000001" });
check("contract", r.status === 200 && r.body.status === "ok" && r.body.data[0].contract_number === "POC-CNT-001");
r = await rpc("poc_district_5501", "get_contract_status", { purchase_order: "990000000000000001" });
check("contract_district_denied", r.status === 200 && r.body.status === "forbidden" && r.body.data.length === 0);
r = await rpc("poc_picker", "get_traceability", { issue_reference: "POC-ISSUE-5501-001-V1" });
check("traceability", r.status === 200 && r.body.status === "ok" && r.body.data[0].purchase_order === "990000000000000002" && r.body.data[0].provenance_kind === "issued_movement");
r = await rpc("poc_picker", "get_traceability", { issue_reference: "POC-ISSUE-5501-001" });
check("traceability_exact_plan_reference", r.status === 200 && r.body.status === "ok" && r.body.data[0].issue_reference === "POC-ISSUE-5501-001-V1");
r = await rpc("poc_district_5502", "get_traceability", { handling_unit_code: "POC-HU-5501-001" });
check("trace_foreign_hidden", r.status === 200 && r.body.status === "no_data" && r.body.data.length === 0);
r = await rpc("poc_denied_inactive", "get_traceability", { material_id: "471050004000" });
check("inactive_profile", r.status === 200 && r.body.status === "forbidden" && r.body.data.length === 0);
r = await rpc("poc_viewer", "get_traceability", { material_id: "471050004000", date_from: "2026-01-01" });
check("date_argument_rejected", r.status === 200 && r.body.status === "invalid_input");

const escalate = await request(`${BASE_URL}/rest/v1/user_profiles?user_id=eq.${identities.poc_district_5501}`, {
  method: "PATCH",
  headers: { ...anonHeaders, Authorization: `Bearer ${sessions.poc_district_5501}`, Prefer: "return=representation" },
  body: JSON.stringify({ role: "admin", district_id: null }),
});
const profileAfter = await request(`${BASE_URL}/rest/v1/user_profiles?user_id=eq.${identities.poc_district_5501}&select=role,district_id`, {
  headers: { apikey: anon, Authorization: `Bearer ${sessions.poc_district_5501}` },
});
check("profile_escalation_denied", [200, 401, 403].includes(escalate.status) && profileAfter.status === 200 && profileAfter.body[0].role === "district" && profileAfter.body[0].district_id === "5501");

for (const [name, schema, relation] of [["direct_table_denied", "core", "stock_snapshots"], ["direct_view_denied", "analytics", "v_issue_traceback"], ["direct_audit_denied", "audit", "vmi_chat_requests"]]) {
  const direct = await request(`${BASE_URL}/rest/v1/${relation}?select=*&limit=1`, {
    headers: { apikey: anon, Authorization: `Bearer ${sessions.poc_viewer}`, "Accept-Profile": schema },
  });
  check(name, direct.status >= 400);
}

const unauth = await request(`${BASE_URL}/rest/v1/rpc/vmi_chat_read`, {
  method: "POST", headers: anonHeaders,
  body: JSON.stringify({ p_tool: "get_stock_status", p_args: { material_id: "471050004000", scope: "warehouse" }, p_request_id: randomUUID() }),
});
check("absent_jwt_rejected", unauth.status === 401 || unauth.status === 403);
for (const [name, token] of [
  ["wrong_project_jwt_rejected", fakeJwt(Math.floor(Date.now() / 1000) + 3600, "https://wrong-project.supabase.co/auth/v1")],
  ["expired_jwt_rejected", fakeJwt(Math.floor(Date.now() / 1000) - 60, `${BASE_URL}/auth/v1`)],
]) {
  const rejected = await request(`${BASE_URL}/rest/v1/rpc/vmi_chat_read`, {
    method: "POST", headers: { ...anonHeaders, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ p_tool: "get_stock_status", p_args: { material_id: "471050004000", scope: "warehouse" }, p_request_id: randomUUID() }),
  });
  check(name, rejected.status === 401 || rejected.status === 403);
}

const evalCases = (await readFile(new URL("../LLM/poc/eval-dev.jsonl", import.meta.url), "utf8"))
  .trim().split("\n").map(JSON.parse);
for (const item of evalCases) {
  const evaluated = await rpc(item.actor, item.expected.decision, item.expected.arguments);
  check(`eval_${item.id}`, evaluated.status === 200 &&
    evaluated.body.status === item.expected.status &&
    evaluated.body.tool === item.expected.decision &&
    Array.isArray(evaluated.body.data) && evaluated.body.data.length <= 20 &&
    item.reference.assertions.every(({ path, equals }) =>
      JSON.stringify(at(evaluated.body, path)) === JSON.stringify(equals)));
}

let limited;
for (let i = 0; i < 11; i++) limited = await rpc("poc_admin", "get_stock_status", { material_id: "471050004000", scope: "warehouse" });
check("rate_limit_11th", limited.status === 200 && limited.body.status === "unavailable" && limited.body.warnings[0] === "rate_limited");

console.log(`P01 managed JWT smoke: ${checks.length}/${checks.length} passed`);
console.log(`Target: ${PROJECT}/${REF}; actors: ${actors.length}; secrets/JWTs/passwords: not printed or stored`);
for (const [name] of checks) console.log(`PASS ${name}`);
