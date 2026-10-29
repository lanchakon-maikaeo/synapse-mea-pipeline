import type { HistoryEvent, HistoryPayload } from "./operation-history";

// Demo-mode sample for the operation history page (no backend).
let cached: HistoryPayload | null = null;

export function demoHistoryPayload(): HistoryPayload {
  cached ??= buildDemoHistory();
  return cached;
}

function buildDemoHistory(): HistoryPayload {
  const base = {
    source: "synapse" as const,
    plan_id: "demo-plan",
    status: null,
    note: null,
    actor: null,
    ref_qty: null,
    reference: null,
  };
  const event = (partial: Partial<HistoryEvent> & Pick<HistoryEvent, "event_id" | "event_at" | "event_type" | "category">): HistoryEvent => ({
    ...base,
    event_date: partial.event_at.slice(0, 10),
    district_id: null,
    district_name: null,
    material_id: null,
    material_name: null,
    unit: null,
    qty: null,
    plan_number: "RP-2026-W43",
    ...partial,
  });
  const events: HistoryEvent[] = [
    event({ event_id: "e1", event_at: "2026-10-28T09:12:00+07:00", event_type: "issue", category: "issue",
      district_id: "5501", district_name: "นวลจันทร์", material_id: "471050004000", material_name: "ฟิวส์ลิงค์ 10K",
      unit: "EA", qty: 200, ref_qty: 200, reference: "HU-000231 · LOT-105-5000123", actor: "สมชาย (คลัง)" }),
    event({ event_id: "e2", event_at: "2026-10-28T08:40:00+07:00", event_type: "issue", category: "issue",
      district_id: "5502", district_name: "สามเสน", material_id: "471050004000", material_name: "ฟิวส์ลิงค์ 10K",
      unit: "EA", qty: 150, ref_qty: 200, reference: "HU-000232", actor: "สมชาย (คลัง)" }),
    event({ event_id: "e3", event_at: "2026-10-27T15:20:00+07:00", event_type: "plan_locked", category: "plan",
      actor: "ณัฐกานต์" }),
    event({ event_id: "e4", event_at: "2026-10-27T11:02:00+07:00", event_type: "change_rejected", category: "change",
      district_id: "5509", district_name: "คลองเตย", material_id: "120030001000", material_name: "สายอะลูมิเนียม 185 ตร.มม.",
      unit: "M", qty: 4000, ref_qty: 1200, note: "เกินความต้องการใช้ 6 เดือน", actor: "ณัฐกานต์" }),
    event({ event_id: "e5", event_at: "2026-10-26T14:45:00+07:00", event_type: "change_requested", category: "change",
      district_id: "5509", district_name: "คลองเตย", material_id: "120030001000", material_name: "สายอะลูมิเนียม 185 ตร.มม.",
      unit: "M", qty: 4000, ref_qty: 1200, reference: "เกิน 6 เดือน", note: "มีงานโครงการย้ายสายลงดิน", actor: "นาย ข" }),
    event({ event_id: "e6", event_at: "2026-10-26T10:15:00+07:00", event_type: "district_rejected", category: "district",
      district_id: "5503", district_name: "นนทบุรี", material_id: "330010002000", material_name: "ลูกถ้วยแขวน",
      unit: "EA", qty: 0, ref_qty: 300, note: "ยังมีของในคลังเขตพอใช้", actor: "นาง ค (เขตนนทบุรี)" }),
    event({ event_id: "e7", event_at: "2026-10-26T09:30:00+07:00", event_type: "district_confirmed", category: "district",
      district_id: "5502", district_name: "สามเสน", material_id: "471050004000", material_name: "ฟิวส์ลิงค์ 10K",
      unit: "EA", qty: 150, ref_qty: 200, note: "ขอลดเหลือ 150", actor: "เขตสามเสน" }),
    event({ event_id: "e8", event_at: "2026-10-24T16:00:00+07:00", event_type: "plan_created", category: "plan",
      qty: 42, reference: "สัปดาห์ 2026-10-26", actor: "ณัฐกานต์" }),
    event({ event_id: "e9", event_at: "2026-10-23T13:10:00+07:00", event_type: "receipt", category: "stock",
      material_id: "471050004000", material_name: "ฟิวส์ลิงค์ 10K", unit: "EA", qty: 2000,
      reference: "HU-000231 · LOT-105-5000123", plan_number: null, actor: "สมชาย (คลัง)" }),
    event({ event_id: "e10", event_at: "2026-02-10T00:00:00+07:00", event_type: "legacy_adjusted", category: "issue",
      source: "legacy", district_id: "5502", district_name: "สามเสน", material_id: "330010002000", material_name: "ลูกถ้วยแขวน",
      unit: "EA", qty: 60, ref_qty: 100, plan_number: null, reference: "VMI · แผน 2026-02-09", note: "ขอลด" }),
    event({ event_id: "e11", event_at: "2026-02-09T00:00:00+07:00", event_type: "legacy_refused", category: "district",
      source: "legacy", district_id: "5501", district_name: "นวลจันทร์", material_id: "120030001000", material_name: "สายอะลูมิเนียม 185 ตร.มม.",
      unit: "M", qty: 300, ref_qty: 300, plan_number: null, reference: "ของผ่านทดสอบ · แผน 2026-02-09", note: "ใช้งานน้อย", actor: "นาง ก" }),
  ];
  const weekly = [
    ["2026-10-26", 42, 30, 6, 3, 3, 18, 5200, 12],
    ["2026-10-19", 38, 31, 4, 3, 0, 22, 6100, 14],
    ["2026-10-12", 40, 28, 5, 7, 0, 20, 4900, 13],
    ["2026-10-05", 35, 30, 3, 2, 0, 19, 5400, 11],
    ["2026-09-28", 44, 33, 6, 5, 0, 25, 7300, 16],
  ].map(([week_start, planned_lines, on_plan, adjusted, refused, pending, issue_events, issued_qty, issued_materials]) => ({
    week_start: String(week_start), planned_lines: Number(planned_lines), on_plan: Number(on_plan),
    adjusted: Number(adjusted), refused: Number(refused), pending: Number(pending), planned_qty: 0,
    issue_events: Number(issue_events), issued_qty: Number(issued_qty), issued_materials: Number(issued_materials),
  }));
  const by_district = [
    ["5501", "นวลจันทร์", 64, 52, 6, 4, 2],
    ["5502", "สามเสน", 58, 41, 9, 7, 1],
    ["5503", "นนทบุรี", 51, 33, 4, 14, 0],
    ["5509", "คลองเตย", 47, 40, 3, 3, 1],
  ].map(([district_id, district_name, planned_lines, on_plan, adjusted, refused, pending]) => ({
    district_id: String(district_id), district_name: String(district_name), planned_lines: Number(planned_lines),
    on_plan: Number(on_plan), adjusted: Number(adjusted), refused: Number(refused), pending: Number(pending),
    last_plan_date: "2026-10-26",
  }));
  return {
    total: events.length,
    limit: 200,
    offset: 0,
    scope_district_id: null,
    counts: { issue: 3, district: 3, change: 2, plan: 2, stock: 1 },
    sources: { synapse: 9, legacy: 2 },
    first_event_date: "2026-02-09",
    last_event_date: "2026-10-28",
    outcomes: { planned_lines: 199, on_plan: 152, adjusted: 24, refused: 20, pending: 3 },
    weekly,
    by_district,
    events,
  };
}
