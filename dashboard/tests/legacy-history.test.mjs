import test from "node:test";
import assert from "node:assert/strict";
import { parseLegacyWorkbook } from "../app/legacy-history.ts";

const head = ["Timestamp", "SourceSheet", "ลำดับ", "รหัสพัสดุ", "รายการพัสดุ", "จำนวนการเติมเต็มพัสดุ", "หน่วย", "Lot Size", "แผนวันที่จ่ายพัสดุ", "สถานะการจ่าย", "วันที่จ่ายพัสดุจริง", "จำนวนที่จ่ายได้จริง", "หน่วย", "ประเภทการเติมของ", "หมายเหตุ", "ใครยืนยันไม่รับ"];
const districtHead = ["ลำดับ", "รหัสพัสดุ", "รายการพัสดุ", "จำนวนการเติมเต็มพัสดุ", "หน่วย", "Lot Size", "แผนวันที่จ่ายพัสดุ", "สถานะการจ่าย", "วันที่จ่ายพัสดุจริง", "จำนวนที่จ่ายได้จริง", "หน่วย", "ประเภทการเติมของ", "หมายเหตุ", "ใครยืนยันไม่รับ"];

test("legacy workbook: history + district sheets become issue events with flags", () => {
  const result = parseLegacyWorkbook([
    { name: "M_Districts", matrix: [["DistrictCode", "DistrictName"], ["5501", "เขตนวลจันทร์"], ["5701", "เขตนนทบุรี"]] },
    { name: "History จ่ายได้ตามแผน", matrix: [
      head,
      ["", "นวลจันทร์", "1", "4.71050004E11", "PVC CONDUIT", "100", "EA", "(2มัด@50)", "46057", "จ่ายได้ตามแผน", "46058", "100", "EA", "จ่ายตาม VMI", "", ""],
      ["", "นวลจันทร์", "1", "471050004000", "PVC CONDUIT", "100", "EA", "(2มัด@50)", "46057", "จ่ายได้ตามแผน", "46058", "100", "EA", "จ่ายตาม VMI", "", ""],
      ["", "นนทบุรี", "2", "473055210000", "BOLT", "300", "EA", "", "46058", "ปรับจำนวน", "46059", "600", "EA", "เขตแจ้งใช้", "ขอเพิ่ม", ""],
      ["", "นนทบุรี", "3", "614525500750", "TAPE", "100", "EA", "", "46058", "จ่ายได้ตามแผน", "46059", "50", "EA", "ของผ่านทดสอบ", "", ""],
    ] },
    { name: "History ไม่รับของ", matrix: [
      head,
      ["", "นนทบุรี", "5", "521068103820", "SEALS", "2000", "EA", "", "46058", "ไม่รับของ", "", "", "#N/A", "จ่ายตาม VMI", "ใช้งานน้อย", "นาง ข"],
    ] },
    { name: "นวลจันทร์", matrix: [
      ["รายการพัสดุที่ต้องจ่าย"], [], [], [],
      districtHead,
      ["1", "560500441400", "BOLT 1/2", "1050", "EA", "(14กระสอบ@75)", "46266", "จ่ายได้ตามแผน", "46267", "1050", "", "ของผ่านทดสอบ", "", ""],
      ["2", "592035302600", "FUSE LINK", "900", "EA", "", "46300", "", "", "", "", "", "", ""],
    ] },
  ]);
  assert.deepEqual(result.sheetsRead, ["History จ่ายได้ตามแผน", "History ไม่รับของ", "นวลจันทร์"]);
  assert.equal(result.pending, 1);
  assert.equal(result.rows.length, 5);
  const first = result.rows[0];
  assert.equal(first.material_id, "471050004000");
  assert.equal(first.district_id, "5501");
  assert.equal(first.plan_date, "2026-02-04");
  assert.equal(first.actual_date, "2026-02-05");
  assert.equal(first.fill_type, "vmi");
  assert.ok(first.review_flags.includes("duplicate_in_file"));
  const adjusted = result.rows.find((row) => row.outcome === "adjusted");
  assert.equal(adjusted.issued_qty, 600);
  assert.equal(adjusted.fill_type, "district_request");
  const mismatch = result.rows.find((row) => row.material_id === "614525500750");
  assert.ok(mismatch.review_flags.includes("qty_differs_but_marked_full"));
  const refused = result.rows.find((row) => row.outcome === "refused");
  assert.equal(refused.issued_qty, 0);
  assert.equal(refused.actual_date, null);
  assert.equal(refused.note, "ใช้งานน้อย");
  assert.equal(refused.refused_by, "นาง ข");
  assert.ok(refused.review_flags.includes("unknown_unit") === false);
  const fromDistrictSheet = result.rows.find((row) => row.source_sheet === "นวลจันทร์");
  assert.equal(fromDistrictSheet.fill_type, "passed_test");
  assert.equal(fromDistrictSheet.source_row, 6);
});
