import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const [transport, roadMap, page, workerCanary, workerClient] = await Promise.all([
  readFile(new URL("app/transport.tsx", root), "utf8"),
  readFile(new URL("app/transport-road-map.tsx", root), "utf8"),
  readFile(new URL("app/page.tsx", root), "utf8"),
  readFile(
    new URL("app/api/internal/optimization-canary/route.ts", root),
    "utf8",
  ),
  readFile(new URL("app/api/optimization-worker.ts", root), "utf8"),
]);

test("transport UI uses the live zero-state and readiness contract", () => {
  assert.match(transport, /apiRequest<Row>\("\/v1\/transport\/readiness"/);
  assert.match(transport, /\["เขตรอจัดส่ง", data\.queue\.length, "จาก dispatch queue"\]/);
  assert.match(
    transport,
    /if \(demoMode\) \{[\s\S]{0,200}setData\(demoTransportData\(\)\)[\s\S]{0,200}return;/,
  );
  assert.match(
    transport,
    /if \(!token\) \{[\s\S]{0,200}setData\(emptyData\(\)\)[\s\S]{0,200}return;/,
  );
  for (const readinessKey of [
    "operational_writes_enabled",
    "route_readiness_status",
    "optimization_worker_status",
    "trip_persistence_status",
    "warehouse_route_readiness",
  ]) {
    assert.ok(transport.includes(readinessKey), readinessKey);
  }
  for (const renderedGate of [
    "canonical-route-gate",
    "road-engine-runtime",
    "optimization-worker",
    "trip-persistence",
  ]) {
    assert.ok(transport.includes(renderedGate), renderedGate);
  }
  assert.doesNotMatch(transport, /localData/);
});

test("governed optimizer queues the full locked plan and tracks its job", () => {
  assert.match(transport, /"\/v1\/transport\/optimization-jobs"/);
  assert.match(
    transport,
    /`\/v1\/transport\/optimization-jobs\/\$\{encodeURIComponent\(routeJobId\)\}`/,
  );
  assert.match(transport, /"X-Request-ID": idempotencyKey/);
  assert.match(transport, /matrix_source: "valhalla"/);
  assert.match(transport, /ส่งแผนเต็มเข้า OR-Tools \+ Valhalla/);
  assert.match(transport, /จุดที่เลือกบนแผนที่มีผลเฉพาะ heuristic preview/);
  assert.match(transport, /route-plan → trip activation ยังถูกล็อก/);
  assert.match(transport, /optimizationWorkerReady === true/);
  assert.match(transport, /optimization_eligible_plan_ids/);
  assert.match(
    transport,
    /optimizationEligiblePlanIds\.includes\(planId\)/,
  );
  assert.match(transport, /Plan-level queue gate/);
});

test("optimization attempts resume per actor and plan without duplicate queueing", () => {
  assert.match(transport, /synapse\.transport\.optimization\.v1/);
  assert.match(transport, /window\.sessionStorage\.getItem/);
  assert.match(transport, /window\.sessionStorage\.setItem/);
  assert.match(
    transport,
    /optimizationSessionKey\(actorId, attempt\.planId\)/,
  );
  assert.match(transport, /Reusing the persisted request ID/);
  assert.match(transport, /attemptActive \|\| attemptSucceeded/);
  assert.match(transport, /resumeInterruptedSubmission/);
  assert.match(transport, /attemptCanRestart[\s\S]*crypto\.randomUUID\(\)/);
  assert.match(transport, /Route plan สำเร็จแล้ว · immutable/);
  assert.match(transport, /failed\/cancelled/);
  assert.doesNotMatch(
    transport,
    /sessionStorage\.setItem\([\s\S]{0,300}(access_token|Authorization|token)/,
  );
});

test("transport affordances follow backend role rules", () => {
  assert.match(
    transport,
    /return role === "admin" \|\| role === "planner"/,
  );
  assert.match(
    transport,
    /transportNav\.filter\(\(\[view\]\) => view !== "planner"\)/,
  );
  assert.match(transport, /canMutate && \(/);
  assert.match(transport, /canMutate \? \([\s\S]*ดูเส้นทางถนน/);
  assert.match(transport, /อ่านอย่างเดียวตามสิทธิ์/);
  assert.match(transport, /dispatch queue และ trips ถูกจำกัดเขตจาก backend/);
  assert.match(page, /transportNavForRole\(role\)/);
  assert.match(page, /role=\{role\}/);
  assert.match(page, /actorId=\{backend\.identity\.user_id\}/);
});

test("vehicle activity is not promoted to operational availability", () => {
  assert.match(
    transport,
    /vehicle\.availability === "available"[\s\S]*vehicle\.currentWarehouse === warehouse/,
  );
  assert.match(transport, /is_active อย่างเดียวไม่ยืนยันว่ารถพร้อมออกงาน/);
  assert.match(transport, /\["รถ active ในทะเบียน", data\.vehicles\.filter\(\(vehicle\) => vehicle\.active\)\.length, availabilityKnown \? `พร้อมตามหลักฐาน \$\{available\}` : "ยังไม่ทราบ availability"\]/);
  assert.match(transport, /Weight-only split preview/);
  assert.match(transport, /ยังไม่ใช่ OR-Tools fleet solve/);
  assert.match(
    transport,
    /\(rawStatus === "available" \|\| row\.is_available === true\) &&[\s\S]*evidence/,
  );
  assert.doesNotMatch(transport, /<span>รถพร้อมใช้งาน<\/span>/);
});

test("dispatch groups retain canonical origin gates and block ineligible rows", () => {
  for (const field of [
    "origin_location_id",
    "origin_warehouse_id",
    "suggested_warehouse_geocode_status",
    "q.route_eligible === true",
  ]) {
    assert.ok(transport.includes(field), field);
  }
  assert.match(transport, /disabled=\{!group\.routeEligible\}/);
  assert.match(transport, /route_eligible=false/);
  assert.match(transport, /พิกัดคลังเป็น \$\{blocked\.originWarehouseGeocodeStatus\}/);
});

test("geocode labels match the backend status enum", () => {
  assert.match(
    transport,
    /type GeocodeStatus = "candidate" \| "verified" \| "quarantined"/,
  );
  assert.match(
    roadMap,
    /verificationStatus: "quarantined" \| "candidate" \| "verified"/,
  );
  assert.match(roadMap, /verificationStatus === "candidate"/);
  assert.match(roadMap, /พิกัด candidate รอการตรวจสอบ/);
});

test("legacy trip history cannot advance operational state", () => {
  assert.match(transport, /legacy illustrative \/ unverified/);
  assert.match(transport, /ไม่มี operational continuation/);
  assert.match(transport, /JSON\.stringify\(\{ status: "cancelled" \}\)/);
  assert.doesNotMatch(transport, /JSON\.stringify\(\{ status: "dispatched" \}\)/);
  assert.doesNotMatch(transport, /JSON\.stringify\(\{ status: "completed" \}\)/);
});

test("map and optimization remain real-road-only", () => {
  assert.match(transport, /"\/v1\/transport\/optimize"/);
  assert.match(transport, /Boolean\(result\.dataVersion\)/);
  assert.match(transport, /sourceChecksumSha256/);
  assert.match(
    transport,
    /if \(source === "demo"\) \{[\s\S]{0,300}planRoute\(/,
  );
  assert.doesNotMatch(transport, /\bkmDist\b|\bROUTES\b/);
  assert.match(
    roadMap,
    /ยังไม่มีเส้นถนน — แสดงเฉพาะหมุดที่ยืนยันแล้ว/,
  );
  assert.doesNotMatch(roadMap, /draftPositions|dashArray/);
  assert.match(
    roadMap,
    /process\.env\.NODE_ENV === "production"[\s\S]*controlledProductionTileConfig/,
  );
  assert.match(roadMap, /hostname === "tile\.openstreetmap\.org"/);
  assert.match(roadMap, /url\.protocol !== "https:"/);
});

test("one-time canary capability is consumed before the server-only worker call", () => {
  assert.match(workerCanary, /m14c_consume_worker_trigger/);
  assert.match(workerCanary, /await sha256\(token\)/);
  assert.match(workerCanary, /if \(!capability\.accepted/);
  assert.ok(
    workerCanary.indexOf("m14c_consume_worker_trigger") <
      workerCanary.indexOf('triggerOptimizationWorker("run-once"'),
  );
  assert.match(workerCanary, /productionProjectHost/);
  assert.doesNotMatch(workerCanary, /console\.|WORKER_API_KEY/);
  assert.match(workerClient, /OPTIMIZATION_WORKER_AUTH_TOKEN/);
  assert.match(workerClient, /Authorization: `Bearer \$\{configured\.token\}`/);
});
