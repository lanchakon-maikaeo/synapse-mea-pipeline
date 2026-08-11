import type { Session } from "@supabase/supabase-js";
import type { Identity, Role } from "./lib";
import type { DashboardData, RecordRow, VmiContext } from "./use-synapse-backend";

export const DEMO_MODE = process.env.NEXT_PUBLIC_SYNAPSE_DEMO_MODE === "true";

const snapshot = "2026-07-21T00:00:00.000Z";
const districtPairs = [
  ["5501", "เขตนวลจันทร์"], ["5601", "เขตสามเสน"], ["5701", "เขตนนทบุรี"],
  ["5801", "เขตธนบุรี"], ["5901", "เขตบางใหญ่"], ["6001", "เขตลาดกระบัง"],
  ["6501", "เขตบางนา"], ["6601", "เขตวัดเลียบ"], ["6701", "เขตคลองเตย"],
  ["6801", "เขตราษฎร์บูรณะ"], ["6901", "เขตยานนาวา"], ["7001", "เขตบางขุนเทียน"],
  ["7501", "เขตบางบัวทอง"], ["7601", "เขตบางกะปิ"], ["7701", "เขตสมุทรปราการ"],
  ["7801", "เขตบางพลี"], ["7901", "เขตมีนบุรี"], ["8001", "เขตบางเขน"],
] as const;

export const demoDistricts: RecordRow[] = districtPairs.map(([district_id, district_name_th]) => ({
  district_id,
  district_name_th,
  is_active: true,
}));

export const demoMaterials: RecordRow[] = [
  { material_id: "592038410000", material_name: "Fuse cutout 12kA", base_unit: "EA" },
  { material_id: "21920122300", material_name: "Transformer unit", base_unit: "EA" },
  { material_id: "21920522320", material_name: "Transformer 1000kVA", base_unit: "EA" },
];

const materialConfig: Record<string, { name: string; warehouse: number; cmp: number }> = {
  "592038410000": { name: "Fuse cutout 12kA", warehouse: 655, cmp: 110 },
  "21920122300": { name: "Transformer unit", warehouse: 84, cmp: 8 },
  "21920522320": { name: "Transformer 1000kVA", warehouse: 30, cmp: 3 },
};
const monthPattern = [2, 2.7, 3.2, 3.8, 4.4, 5, 6.2, 7.1, 1.4, 2.2, 3.6, 4.9, 5.7, 6.8, 0, 2.9, 4.1, 7.5];

export const demoStock: RecordRow[] = Object.entries(materialConfig).flatMap(([material_id, config], materialIndex) =>
  districtPairs.map(([district_id, district_name_th], index) => {
    const months = monthPattern[(index + materialIndex * 3) % monthPattern.length];
    const current = Math.round(config.cmp * months);
    return {
      material_id, material_name: config.name, district_id, district_name_th,
      current_stock_qty: current, cmp_monthly: config.cmp, months_available: months,
      health_band: months <= 3.5 ? "critical" : months > 6 ? "overstock" : "normal",
      stock_source_status: "demo_fixture", fixture_backed: true, snapshot_at: snapshot,
    };
  }),
);

const queueSeeds = [
  ["RPI-DEMO-001", "RP-DEMO-W30", "5501", "592038410000", 225, 110, 420],
  ["RPI-DEMO-002", "RP-DEMO-W30", "5501", "21920122300", 22, 8, 26],
  ["RPI-DEMO-003", "RP-DEMO-W30", "5601", "21920522320", 4, 3, 14],
] as const;

export const demoReplenishment: RecordRow[] = queueSeeds.map(([replenishment_item_id, replenishment_plan_id, district_id, material_id, stock, cmp, suggested], index) => {
  const district = demoDistricts.find((row) => row.district_id === district_id) ?? {};
  const material = materialConfig[material_id];
  return {
    replenishment_item_id, replenishment_plan_id, plan_code: "WP-2569-W30", plan_version: 1,
    district_id, district_name_th: district.district_name_th, material_id, material_name: material.name,
    current_stock_qty: stock, cmp_monthly: cmp, months_available: stock / cmp,
    min_fill_qty: Math.max(0, cmp * 4 - stock), max_fill_qty: Math.max(0, cmp * 6 - stock),
    suggested_qty: suggested, confirmed_qty: suggested, needs_fill: true,
    priority_score: 100 - index * 8, priority_band: index === 0 ? "high" : "normal",
    response_status: index === 1 ? "change_requested" : "pending_district",
    plan_status: "district_review", created_at: snapshot,
  };
});

export const demoWarehouseStock: RecordRow[] = demoMaterials.map((material) => ({
  material_id: material.material_id, material_name: material.material_name,
  quantity_on_hand: materialConfig[String(material.material_id)].warehouse,
  unit: "EA", location_id: "WH-KT", location_name_th: "คลังคลองเตย",
  plant: "2401", storage_location: "0001", snapshot_at: snapshot,
}));

const fifoSeed = [
  ["HU-KT-000184", "592038410000", "PO-450001", "C-001", "Drummy Vendor A", "2026-07-12", 100, "FULL_PALLET", 100],
  ["HU-KT-000191", "592038410000", "PO-450014", "C-014", "Drummy Vendor A", "2026-07-18", 200, "FULL_PALLET", 200],
  ["HU-KT-000207", "592038410000", "PO-450021", "C-021", "Drummy Vendor B", "2026-07-22", 180, "FULL_PALLET", 180],
  ["HU-KT-000072", "21920122300", "PO-449881", "C-881", "Drummy Vendor D", "2026-06-02", 10, "BOX", 5],
  ["HU-KT-000119", "21920122300", "PO-449940", "C-940", "Drummy Vendor E", "2026-06-20", 30, "BOX", 5],
  ["HU-KT-000151", "21920522320", "PO-449970", "C-970", "Drummy Vendor F", "2026-06-29", 12, "CRATE", 1],
  ["HU-KT-000211", "21920522320", "PO-450024", "C-024", "Drummy Vendor F", "2026-07-24", 18, "CRATE", 1],
] as const;

export const demoFifo: RecordRow[] = fifoSeed.map(([handling_unit_code, material_id, purchase_order, contract_number, vendor_name, acceptance_date, allocatable_qty, unit_type, units_per_handling_unit], index) => ({
  handling_unit_id: `HU-DEMO-${index + 1}`, handling_unit_code, material_id,
  material_name: materialConfig[material_id].name, location_id: "WH-KT",
  purchase_order, contract_number, vendor_name, acceptance_date,
  line_item: "10", installment_no: String((index % 3) + 1), lot_code: `${contract_number}-LOT`,
  allocatable_qty, remaining_qty: allocatable_qty, fifo_sequence: index + 1,
  unit_type, units_per_handling_unit, opening_status: "SEALED", status: "available",
}));

const demoHandlingUnits = demoFifo.map((row) => ({ ...row, initial_qty: row.allocatable_qty, current_qty: row.allocatable_qty }));

export const demoData: DashboardData = {
  materials: demoMaterials,
  districts: demoDistricts,
  stock: demoStock,
  warehouseStock: demoWarehouseStock,
  replenishment: demoReplenishment,
  fifo: demoFifo,
  handlingUnits: demoHandlingUnits,
  receiptOptions: demoFifo.slice(0, 4).map((row, index) => ({
    contract_item_id: index + 1, ...row, remaining_contract_qty: Number(row.allocatable_qty) * 2,
  })),
  recommendations: demoReplenishment.map((row) => ({
    ...row, recommendation_id: `REC-${row.replenishment_item_id}`,
    rule_suggested_qty: row.suggested_qty, ai_suggested_qty: row.suggested_qty,
    confidence_score: 0.88, evidence_status: "ready", generated_at: snapshot,
  })),
  changeRequests: [{
    change_request_id: "CR-DEMO-001", replenishment_item_id: "RPI-DEMO-002",
    plan_code: "WP-2569-W30", district_id: "5501", material_id: "21920122300",
    requested_qty: 40, original_qty: 26, projected_months_after: 7.8,
    risk_level: "high", status: "pending_review", reason: "รองรับงานเร่งด่วน",
    requester_name: "District Demo User", created_at: snapshot,
  }],
  approvals: [
    { approval_id: "APR-DEMO-001", replenishment_plan_id: "RP-DEMO-W29", plan_code: "WP-2569-W29", stage: "planner", decision: "approved", approver_name: "Planner Demo", approved_at: snapshot },
    { approval_id: "APR-DEMO-002", replenishment_plan_id: "RP-DEMO-W29", plan_code: "WP-2569-W29", stage: "academic", decision: "approved", approver_name: "Academic Demo", approved_at: snapshot },
  ],
  contracts: fifoSeed.slice(0, 5).map((row, index) => ({
    purchase_order: row[2], contract_number: row[3], vendor_name: row[4], item_count: 1,
    contract_status: "active", updated_at: snapshot, contract_item_id: index + 1,
  })),
  quality: [
    { rule_code: "STOCK_DAILY_FRESHNESS", severity: "normal", open_issue_count: 0, last_detected_at: snapshot },
    { rule_code: "PALLET_REMAIN_MATCH", severity: "warning", open_issue_count: 2, last_detected_at: snapshot },
  ],
  adHocIssues: [{
    ad_hoc_issue_id: "AH-DEMO-001", issue_reference: "AH-2569-0001", district_id: "5901",
    material_id: "592038410000", requested_qty: 20, reason: "งานแก้ไฟเร่งด่วน",
    requester_name: "District Demo User", status: "pending_approval", created_at: snapshot,
  }],
  traceability: [{
    inventory_movement_id: "MOV-DEMO-001", source_issue_movement_id: "MOV-DEMO-001",
    issue_reference: "ISS-2569-0142", issue_type: "weekly_plan", district_id: "5501",
    material_id: "592038410000", issued_qty: 100, handling_unit_code: "HU-KT-000184",
    lot_code: "C-001-LOT", acceptance_date: "2026-07-12", purchase_order: "PO-450001",
    line_item: "10", contract_number: "C-001", vendor_name: "Drummy Vendor A", issued_at: snapshot,
  }],
  inputSubmissions: [{ submission_id: "IN-DEMO-001", material_id: "592038410000", district_id: "5501", status: "published", created_at: snapshot }],
  readiness: {
    readiness_status: "DEMO_READY", data_contract_ready: true, identity_ready: true,
    recovery_ready: true, operational_writes_enabled: true,
  },
  operations: { database: "healthy", api: "healthy", auth: "demo", backup: "verified" },
  alerts: [{ created_at: snapshot, alert_type: "DEMO_DATA", severity: "warning", status: "open", message: "ข้อมูลชุดนี้ใช้สำหรับทดลอง UX เท่านั้น" }],
  legacyStatus: {
    totals: { materials: 2000, warehouse_stock_snapshots: 223, district_stock_snapshots: 250, usage_rates: 250 },
    sources: [
      { source_key: "Stock.xlsx", status: "fresh", expected_rows: 223, loaded_rows: 223, source_observed_at: snapshot, updated_at: snapshot },
      { source_key: "อัตราการใช้งาน.xlsx", status: "fresh", expected_rows: 250, loaded_rows: 250, source_observed_at: snapshot, updated_at: snapshot },
      { source_key: "รวมสัญญา.xlsx", status: "fresh", expected_rows: 120, loaded_rows: 120, source_observed_at: snapshot, updated_at: snapshot },
    ],
    warnings: ["Local Demo Mode — ห้ามใช้ข้อมูลนี้ประกอบการจ่ายจริง"],
  },
};

export const demoSession = {
  access_token: "local-demo-token", refresh_token: "local-demo-refresh", token_type: "bearer",
  expires_in: 86400, expires_at: 4102444800,
  user: { id: "demo-planner", aud: "authenticated", role: "authenticated", email: "demo@local", app_metadata: {}, user_metadata: {}, created_at: snapshot },
} as Session;

export function demoIdentity(role: Role): Identity {
  return { user_id: `demo-${role}`, role, district_id: role === "district" ? "5501" : null };
}

export function demoVmiContext(materialId: string, districtId: string): VmiContext {
  return {
    material: demoMaterials.find((row) => row.material_id === materialId) ?? {},
    district: demoDistricts.find((row) => row.district_id === districtId) ?? {},
    stock: demoStock.find((row) => row.material_id === materialId && row.district_id === districtId) ?? null,
    usage_rate: { material_id: materialId, district_id: districtId, ly: 110, m12: 108, m6: 112, m4: 110, cmp_monthly: 110 },
    history: [6, 5, 4, 3, 2, 1].map((month) => ({ month: `2026-${String(month).padStart(2, "0")}`, issued_qty: 100 + month * 3 })),
  };
}
