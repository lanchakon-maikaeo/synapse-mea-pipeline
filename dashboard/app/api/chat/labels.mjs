// Thai names for database columns and stored codes, so an answer never shows a raw column name.
// A column is named from its words, last word first (material_name → ชื่อ + วัสดุ);
// COLUMNS holds the names that word order gets wrong and the ones users read most.
const WORDS = {
  "12m": "12 เดือน", "24h": "24 ชั่วโมง", "3m": "3 เดือน", "4m": "4 เดือน", "6m": "6 เดือน", 80: "80%",
  abnormal: "ผิดปกติ", academic: "ฝ่ายวิชาการ", acceptance: "ตรวจรับ", accuracy: "ความแม่นยำ", acknowledged: "รับทราบ",
  acted: "ดำเนินการ", active: "ที่ใช้งาน", actor: "ผู้ดำเนินการ", actual: "จริง", adjusted: "ปรับ", adjustment: "การปรับยอด",
  aggregation: "การรวม", alert: "การแจ้งเตือน", algorithm: "อัลกอริทึม", alias: "ชื่อเรียกอื่น", aliases: "ชื่อเรียกอื่น",
  allocatable: "ที่จัดสรรได้", allocated: "ที่จัดสรร", allocation: "การจัดสรร", amount: "จำนวนเงิน", applied: "นำไปใช้",
  approval: "การอนุมัติ", approved: "อนุมัติ", artifact: "ไฟล์ต้นฉบับ", asserted: "ที่ระบุ", asset: "ทรัพย์สิน",
  assumption: "สมมติฐาน", at: "เวลา", attempt: "การลอง", attempts: "ครั้งที่ลอง", attestation: "การรับรอง", attested: "รับรอง",
  availability: "ความพร้อม", available: "ที่ใช้ได้", avg: "เฉลี่ย", backtest: "ทดสอบย้อนหลัง", backup: "สำรองข้อมูล",
  balance: "ยอดยกมา", band: "ระดับ", base: "ฐาน", baseline: "ฐาน", basis: "หลักเกณฑ์", batch: "ชุดนำเข้า", bias: "ความเอนเอียง",
  bid: "ประกวดราคา", box: "กล่อง", boxes: "กล่อง", calculated: "ที่คำนวณ", cancellation: "การยกเลิก", cancelled: "ยกเลิก",
  candidate: "ตัวเลือก", canonical: "หลัก", capacity: "ความจุ", captured: "บันทึก", category: "หมวด", cell: "ช่อง",
  central: "ส่วนกลาง", change: "การเปลี่ยนแปลง", changeset: "ชุดแก้ไข", checked: "ตรวจ", checksum: "ค่าตรวจสอบ", class: "ประเภท",
  cmp: "CMP", code: "รหัส", color: "สี", complete: "ครบ", completed: "เสร็จ", completion: "การเสร็จสิ้น", confidence: "ความเชื่อมั่น",
  configured: "ตั้งค่า", confirmed: "ยืนยัน", connector: "ตัวเชื่อม", contract: "สัญญา", coordinate: "พิกัด", core: "หลัก",
  cost: "ค่า", costing: "การคิดต้นทุน", count: "จำนวน", counts: "จำนวน", created: "สร้าง", currency: "สกุลเงิน",
  current: "ปัจจุบัน", cutoff: "ตัดยอด", cutover: "การย้ายระบบ", dash: "ขีด", data: "ข้อมูล", date: "วันที่", decision: "การตัดสินใจ",
  delivery: "ส่งมอบ", delta: "ส่วนต่าง", demand: "ความต้องการ", depart: "ออกเดินทาง", deployed: "ติดตั้ง", deployment: "การติดตั้ง",
  derived: "ที่คำนวณ", description: "รายละเอียด", detail: "รายละเอียด", details: "รายละเอียด", detected: "ตรวจพบ", direct: "ตรง",
  display: "แสดง", distance: "ระยะทาง", distances: "ระยะทาง", district: "เขต", document: "เอกสาร", downloaded: "ดาวน์โหลด",
  dq: "คุณภาพข้อมูล", drift: "การเปลี่ยน", drill: "ซ้อม", driver: "คนขับ", drivers: "คนขับ", due: "กำหนด", duration: "ระยะเวลา",
  durations: "ระยะเวลา", edge: "เส้นเชื่อม", edges: "เส้นเชื่อม", eligible: "ที่ใช้ได้", employee: "พนักงาน", en: "ภาษาอังกฤษ",
  enabled: "เปิดใช้", end: "สิ้นสุด", endpoint: "ปลายทาง", engine: "เครื่องมือ", entity: "ชนิดข้อมูล", entry: "ทางเข้า",
  environment: "สภาพแวดล้อม", error: "ข้อผิดพลาด", estimate: "ประมาณ", estimated: "โดยประมาณ", eta: "เวลาถึงโดยประมาณ",
  event: "เหตุการณ์", evidence: "หลักฐาน", exceeds: "เกิน", excluded: "ที่ตัดออก", executed: "ดำเนินการ", exit: "ทางออก",
  expected: "ที่คาด", expires: "หมดอายุ", external: "ภายนอก", failed: "ล้มเหลว", family: "ตระกูล", feature: "ตัวแปร",
  field: "ช่องข้อมูล", fifo: "FIFO", file: "ไฟล์", fill: "เติม", final: "สุดท้าย", finished: "เสร็จ", first: "ครั้งแรก",
  fixed: "คงที่", fixture: "ข้อมูลทดสอบ", forecast: "พยากรณ์", freshness: "ความใหม่", from: "ต้นทาง", fuel: "น้ำมัน",
  full: "เต็ม", generated: "สร้าง", geocode: "พิกัด", geocodes: "พิกัด", geojson: "GeoJSON", geometry: "รูปทรง", git: "Git",
  gross: "รวม", has: "มี", hash: "ค่าแฮช", health: "สุขภาพ", height: "ความสูง", history: "ประวัติ", home: "ประจำ",
  horizon: "ช่วงพยากรณ์", id: "รหัส", idempotency: "กันซ้ำ", identity: "ตัวตน", ids: "รหัส", implementation: "การติดตั้ง",
  import: "นำเข้า", imported: "นำเข้า", ingested: "รับเข้า", inner: "ใน", input: "ข้อมูลเข้า", installment: "งวด",
  instance: "อินสแตนซ์", inventory: "คลังสินค้า", issue: "จ่าย", issued: "จ่าย", item: "รายการ", job: "งาน", jobs: "งาน",
  key: "คีย์", last: "ล่าสุด", latest: "ล่าสุด", latitude: "ละติจูด", layer: "ชั้น", layers: "ชั้น", lead: "รอของ",
  legacy: "ระบบเดิม", length: "ความยาว", level: "ระดับ", license: "ใบขับขี่", light: "อ่อน", line: "บรรทัด", lines: "บรรทัด",
  linked: "ที่เชื่อม", load: "บรรทุก", loaded: "โหลด", loan: "ยืม", location: "ที่ตั้ง", locations: "ที่ตั้ง", locked: "ล็อก",
  longitude: "ลองจิจูด", lot: "Lot", lower: "ต่ำ", ly: "ปีก่อน", mae: "MAE", map: "แผนที่", mapping: "การจับคู่", master: "หลัก",
  material: "วัสดุ", materials: "วัสดุ", matrix: "เมทริกซ์", max: "สูงสุด", mean: "เฉลี่ย", message: "ข้อความ", messages: "ข้อความ",
  metadata: "ข้อมูลประกอบ", method: "วิธี", metric: "ตัวชี้วัด", metrics: "ตัวชี้วัด", min: "ต่ำสุด", missing: "ที่ขาด",
  model: "โมเดล", modified: "แก้ไข", module: "โมดูล", month: "เดือน", monthly: "รายเดือน", months: "เดือน", moq: "MOQ",
  movement: "ความเคลื่อนไหว", name: "ชื่อ", negative: "ติดลบ", new: "ใหม่", no: "เลขที่", normalized: "ที่ปรับรูปแบบ",
  note: "บันทึก", notes: "บันทึก", number: "เลขที่", observation: "การสังเกต", observed: "ที่พบ", occurred: "เกิด", only: "เท่านั้น",
  open: "เปิด", opened: "เปิด", opening: "ยกมา", operational: "ใช้งานจริง", operator: "ผู้ให้บริการ", or: "หรือ", order: "สั่งซื้อ",
  ordered: "ที่เรียงลำดับ", origin: "ต้นทาง", original: "เดิม", osm: "OSM", override: "การแก้ค่า", owner: "เจ้าของ", pack: "แพ็ก",
  package: "บรรจุภัณฑ์", packaging: "บรรจุภัณฑ์", pairs: "คู่", pallet: "พาเลท", pallets: "พาเลท", parameters: "พารามิเตอร์",
  parent: "แม่", partial: "บางส่วน", path: "ที่อยู่ไฟล์", payload: "ข้อมูล", period: "งวด", physical: "จริง",
  pipeline: "ขั้นตอนประมวลผล", plan: "แผน", planned: "ตามแผน", planner: "ผู้วางแผน", plans: "แผน", plant: "Plant",
  plate: "ทะเบียนรถ", plaza: "ด่าน", policy: "นโยบาย", predicted: "ที่พยากรณ์", previous: "ก่อนหน้า", price: "ราคา",
  priority: "ความสำคัญ", procurement: "จัดซื้อ", production: "ระบบจริง", profile: "โปรไฟล์", project: "โครงการ",
  projected: "คาดการณ์", promoted: "ที่นำเข้าระบบหลัก", promotion: "การนำเข้าระบบหลัก", provider: "ผู้ให้บริการ",
  publication: "การเผยแพร่", published: "เผยแพร่", purchase: "จัดซื้อ", qty: "จำนวน", quality: "คุณภาพ", quantity: "จำนวน",
  quarantine: "กักกัน", quarantined: "กักกัน", rate: "อัตรา", raw: "ดิบ", read: "ที่อ่าน", readiness: "ความพร้อม", ready: "พร้อม",
  reason: "เหตุผล", receipt: "รับเข้า", received: "ที่รับ", recommendation: "คำแนะนำ", recommended: "ที่แนะนำ",
  reconciliation: "กระทบยอด", record: "บันทึก", recovery: "กู้คืน", ref: "อ้างอิง", reference: "อ้างอิง", refs: "อ้างอิง",
  region: "ภูมิภาค", registered: "ที่ลงทะเบียน", rejected: "ที่ปฏิเสธ", rejection: "การปฏิเสธ", relation: "ความสัมพันธ์",
  release: "ปล่อย", released: "ปล่อย", remaining: "คงเหลือ", remediations: "การแก้ไข", replenishment: "เติม", request: "คำขอ",
  requested: "ที่ขอ", requester: "ผู้ขอเติม", required: "ต้องมี", reserved: "ที่จอง", resolved: "แก้ไขแล้ว", response: "การตอบ",
  responses: "การตอบ", restore: "กู้คืน", result: "ผลลัพธ์", return: "กลับ", review: "ตรวจทาน", reviewed: "ตรวจทาน",
  risk: "ความเสี่ยง", road: "ถนน", role: "บทบาท", rollback: "ย้อนกลับ", rolled: "ย้อนกลับ", route: "เส้นทาง", routing: "จัดเส้นทาง",
  row: "แถว", rows: "แถว", rule: "กฎ", run: "การรัน", sap: "SAP", scope: "ขอบเขต", score: "คะแนน", seen: "พบ", selected: "ที่เลือก",
  sequence: "ลำดับ", series: "อนุกรม", served: "ที่ให้บริการ", service: "บริการ", severity: "ความรุนแรง", sha: "SHA",
  sha256: "SHA-256", sheet: "ชีต", signals: "สัญญาณ", signed: "มีเครื่องหมาย", singleton: "ค่าเดียว", size: "ขนาด", skipped: "ที่ข้าม",
  snapshot: "สแนปช็อต", solver: "ตัวคำนวณ", source: "ต้นทาง", special: "พิเศษ", spreadsheet: "สเปรดชีต", sqlstate: "SQLSTATE",
  stack: "ซ้อน", stage: "ขั้น", staging: "พักข้อมูล", stale: "ข้อมูลเก่า", start: "เริ่ม", started: "เริ่ม", status: "สถานะ",
  stock: "สต็อก", stockout: "ของขาด", stop: "จุดส่ง", storage: "จัดเก็บ", submission: "การส่ง", suggested: "ที่แนะนำ",
  system: "ระบบ", tare: "เปล่า", target: "เป้าหมาย", tariff: "อัตราค่าผ่านทาง", text: "ข้อความ", threshold: "เกณฑ์",
  ticket: "ตั๋วงาน", tileset: "ชุดแผนที่", time: "เวลา", timeout: "หมดเวลา", to: "ปลายทาง", toll: "ทางด่วน", total: "รวม",
  traceability: "การสอบกลับ", training: "ฝึกโมเดล", transaction: "ธุรกรรม", transfer: "โอน", transport: "ขนส่ง",
  travel: "เดินทาง", trip: "เที่ยว", type: "ประเภท", unit: "หน่วย", units: "หน่วย", unlinked: "ที่ไม่เชื่อม", unload: "ขนลง",
  unmapped: "ที่ไม่จับคู่", unrestricted: "ไม่จำกัดการใช้", unserved: "ที่ไม่ได้ส่ง", uom: "หน่วยนับ", updated: "อัปเดต",
  upper: "สูง", upstream: "ต้นทาง", url: "URL", usable: "ใช้ได้", usage: "การใช้", user: "ผู้ใช้", utilization: "อัตราการใช้",
  valid: "มีผล", validation: "การตรวจ", validator: "ตัวตรวจ", value: "ค่า", values: "ค่า", vehicle: "รถ", vehicles: "รถ",
  vendor: "ผู้ขาย", verification: "การยืนยัน", verified: "ยืนยัน", version: "รุ่น", vmi: "VMI", volume: "ปริมาตร", wape: "WAPE",
  warehouse: "คลัง", warning: "คำเตือน", was: "เป็น", waypoint: "จุดแวะ", week: "สัปดาห์", weight: "น้ำหนัก",
  weighted: "ถ่วงน้ำหนัก", width: "ความกว้าง", window: "ช่วง", workbook: "สมุดงาน", writes: "การเขียน", written: "ที่เขียน",
  x: "X", y: "Y", zero: "ศูนย์",
};
// Words that carry no meaning in Thai: is_active is "ใช้งานอยู่", district_name_th is "ชื่อเขต".
const SILENT = new Set(["is", "th", "as", "of", "on"]);
const UNITS = { kg: "กก.", cm: "ซม.", m: "ม.", m3: "ลบ.ม.", km: "กม.", s: "วินาที", seconds: "วินาที", min: "นาที",
  minutes: "นาที", meters: "ม.", thb: "บาท", bytes: "ไบต์", days: "วัน", l: "ลิตร" };

const COLUMNS = {
  material_id: "SKU", material_name: "ชื่อวัสดุ", material_code: "รหัสวัสดุ", unit: "หน่วย", base_uom: "หน่วยนับหลัก",
  district_id: "รหัสเขต", district_name_th: "ชื่อเขต", warehouse_name_th: "ชื่อคลัง", location_name_th: "ชื่อที่ตั้ง",
  name_th: "ชื่อภาษาไทย", name_en: "ชื่อภาษาอังกฤษ", display_name: "ชื่อที่แสดง", id: "รหัส",
  match_score: "ความมั่นใจ", plan_number: "เลขแผน", plan_status: "สถานะแผน", item_status: "สถานะรายการ", status: "สถานะ", version_no: "ฉบับที่",
  week_start_date: "สัปดาห์ที่เริ่ม", parent_plan_id: "รหัสแผนฉบับก่อน", response_due_at: "กำหนดตอบกลับ",
  requester_name: "ผู้ขอเติม", district_note: "บันทึกของเขต", planner_note: "บันทึกของผู้วางแผน",
  current_stock_qty: "สต็อกคงเหลือ", quantity_on_hand: "คงเหลือในคลัง", months_available: "ใช้ได้อีก (เดือน)",
  cmp_monthly: "CMP ต่อเดือน", cmp_monthly_raw: "CMP ต่อเดือน (ค่าดิบ)", derived_cmp_monthly: "CMP ต่อเดือนที่คำนวณ",
  calculated_cmp_raw: "CMP ที่คำนวณ (ค่าดิบ)", suggested_qty: "จำนวนที่แนะนำ", confirmed_qty: "จำนวนที่เขตยืนยัน",
  requested_qty: "จำนวนที่ขอ", final_qty: "จำนวนสุดท้าย", planner_qty: "จำนวนที่ผู้วางแผนกำหนด", allocated_qty: "จำนวนที่จัดสรร",
  min_fill_qty: "จำนวนเติมขั้นต่ำ", max_fill_qty: "จำนวนเติมสูงสุด", priority_score: "คะแนนความเร่งด่วน",
  priority_band: "ระดับความเร่งด่วน", health_band: "ระดับสต็อก", exceeds_six_months: "เกิน 6 เดือน",
  projected_months_after: "ใช้ได้หลังเติม (เดือน)", special_approval_required: "ต้องขออนุมัติพิเศษ",
  abnormal_signals: "สัญญาณผิดปกติ", source_stock_missing: "ไม่มีข้อมูลสต็อกต้นทาง", district_decision: "การตัดสินใจของเขต",
  confirmed_on_behalf: "ยืนยันแทนเขต", planner_source: "ที่มาของรายการ", planner_selected_at: "เวลาที่ผู้วางแผนเลือก",
  snapshot_at: "เวลาของข้อมูลสต็อก", as_of_date: "ข้อมูล ณ วันที่", usage_as_of_date: "ข้อมูลการใช้ ณ วันที่",
  purchase_order: "เลข PO", contract_number: "เลขสัญญา", contract_no: "เลขสัญญา", vendor_name: "ชื่อผู้ขาย", vendor: "ผู้ขาย",
  item_description: "รายการวัสดุ", installment_no: "งวดที่", handling_unit_code: "รหัส HU", handling_unit_id: "รหัสอ้างอิง HU",
  handling_unit_count: "จำนวน HU", lot_code: "รหัส Lot", issue_reference: "เลขอ้างอิงการจ่าย", issue_number: "เลขที่การจ่าย",
  issue_count: "จำนวนปัญหาคุณภาพข้อมูล", issue_id: "รหัสปัญหา", issue_message: "ข้อความปัญหา", issue_type: "ประเภทการจ่าย",
  ad_hoc_issue_id: "รหัสการจ่ายเฉพาะกิจ", is_active: "ใช้งานอยู่", is_available: "พร้อมใช้", is_current: "เป็นข้อมูลล่าสุด",
  is_vmi: "เป็นวัสดุ VMI", is_warehouse: "เป็นคลัง", has_toll: "ผ่านทางด่วน", availability_is_current: "ความพร้อมเป็นข้อมูลล่าสุด",
  allows_partial_issue: "จ่ายบางส่วนได้", stock_in_transfer_qty: "สต็อกระหว่างโอน", from_status: "สถานะเดิม", to_status: "สถานะใหม่",
  lead_time_days: "ระยะเวลารอของ (วัน)", stockout_days: "จำนวนวันที่ของขาด", travel_minutes: "เวลาเดินทาง (นาที)",
  total_travel_minutes: "เวลาเดินทางรวม (นาที)", service_minutes: "เวลาให้บริการ (นาที)",
  unload_fixed_min: "เวลาขนลงคงที่ (นาที)", unload_per_pallet_min: "เวลาขนลงต่อพาเลท (นาที)", timeout_seconds: "หมดเวลา (วินาที)",
  fuel_price_thb_per_l: "ราคาน้ำมัน (บาท/ลิตร)", fuel_rate_km_per_l: "อัตราสิ้นเปลือง (กม./ลิตร)",
  avg_12m: "เฉลี่ย 12 เดือน", avg_12m_raw: "เฉลี่ย 12 เดือน (ค่าดิบ)", avg_4m: "เฉลี่ย 4 เดือน", avg_4m_raw: "เฉลี่ย 4 เดือน (ค่าดิบ)",
  avg_6m: "เฉลี่ย 6 เดือน", avg_6m_raw: "เฉลี่ย 6 เดือน (ค่าดิบ)", avg_ly: "เฉลี่ยปีก่อน", avg_ly_raw: "เฉลี่ยปีก่อน (ค่าดิบ)",
  reference_3m_qty: "จำนวนอ้างอิง 3 เดือน", lower_80: "ค่าต่ำของช่วงความเชื่อมั่น 80%", upper_80: "ค่าสูงของช่วงความเชื่อมั่น 80%",
  map_x: "ตำแหน่ง X บนแผนที่", map_y: "ตำแหน่ง Y บนแผนที่", color_light: "สีอ่อน", natural_key: "คีย์ธุรกิจ",
  fixture_backed: "อ้างอิงข้อมูลทดสอบ", rolled_back_at: "เวลาย้อนกลับ", rollback_of: "ย้อนกลับจาก", failed_job_count_24h: "งานล้มเหลวใน 24 ชั่วโมง",
  inner_pack_qty: "จำนวนต่อแพ็กใน", full_pallet_qty: "จำนวนต่อพาเลทเต็ม", opening_balance_evidence_id: "รหัสหลักฐานยอดยกมา",
  source_was_dash: "ค่าต้นทางเป็นขีด", operational_writes_enabled: "เปิดให้เขียนข้อมูลจริง", zero_completion_policy: "นโยบายเมื่อยอดเป็นศูนย์",
  service_or_unmapped_line_count: "จำนวนบรรทัดบริการหรือที่ไม่จับคู่", contract_only_material_count: "จำนวนวัสดุที่มีเฉพาะในสัญญา",
  production_completion_attestation_id: "รหัสการรับรองความพร้อมระบบจริง", raw_quantity_signed: "จำนวนดิบ (มีเครื่องหมาย)",
  owner_attested_stock_zero_count: "จำนวนสต็อกศูนย์ที่เจ้าของรับรอง", owner_attested_usage_zero_count: "จำนวนการใช้ศูนย์ที่เจ้าของรับรอง",
  owner_attested_zero_district_stock_pairs: "คู่สต็อกเขตที่เจ้าของรับรองว่าเป็นศูนย์",
  owner_attested_zero_usage_pairs: "คู่การใช้ที่เจ้าของรับรองว่าเป็นศูนย์",
  owner_attested_zero_warehouse_stock_materials: "วัสดุสต็อกคลังที่เจ้าของรับรองว่าเป็นศูนย์", count_rows: "จำนวนรายการ",
  alias_name: "ชื่อเรียกอื่น", applied_values: "ค่าที่นำไปใช้", approved_replenishment_plans: "แผนเติมที่อนุมัติ",
  calculated_pallet_gross_kg: "น้ำหนักรวมพาเลทที่คำนวณ (กก.)", max_pallet_gross_kg: "น้ำหนักรวมพาเลทสูงสุด (กก.)",
  pallet_tare_kg: "น้ำหนักเปล่าพาเลท (กก.)", fuel_cost_actual_thb: "ค่าน้ำมันจริง (บาท)", fuel_cost_estimate_thb: "ค่าน้ำมันประมาณการ (บาท)",
  endpoint_geocodes_eligible: "พิกัดปลายทางที่ใช้ได้", forecast_operational_ready: "พยากรณ์พร้อมใช้งานจริง",
  route_operational_ready: "เส้นทางพร้อมใช้งานจริง", route_eligible: "ใช้จัดเส้นทางได้", road_evidence_usable: "หลักฐานถนนใช้ได้",
  horizon_months: "ช่วงพยากรณ์ (เดือน)", input_data_class: "ประเภทข้อมูลเข้า", input_payload: "ข้อมูลเข้า",
  materials_promoted: "วัสดุที่นำเข้าระบบหลัก", packaging_promoted: "บรรจุภัณฑ์ที่นำเข้าระบบหลัก",
  stock_promoted: "สต็อกที่นำเข้าระบบหลัก", usage_promoted: "การใช้ที่นำเข้าระบบหลัก", open_alert_count: "จำนวนการแจ้งเตือนที่เปิดอยู่",
  district_confirmed_at: "เวลาที่เขตยืนยัน", district_responses_completed_at: "เวลาที่เขตตอบครบ",
  planner_approved_at: "เวลาที่ผู้วางแผนอนุมัติ", academic_approved_at: "เวลาที่ฝ่ายวิชาการอนุมัติ", resolved_at: "เวลาที่แก้ไข",
  loaded_rows: "แถวที่โหลด", rows_read: "แถวที่อ่าน", rows_rejected: "แถวที่ปฏิเสธ", rows_written: "แถวที่เขียน",
  loan_status: "สถานะการยืม", max_attempts: "จำนวนครั้งที่ลองสูงสุด", issued_qty: "จำนวนที่จ่าย", cutover_ready: "พร้อมย้ายระบบ",
  git_sha: "Git SHA", line_item: "ลำดับรายการ", opening_status: "สถานะการเปิดใช้", source_observed: "พบในต้นทาง",
  toll_thb: "ค่าทางด่วน (บาท)", total_toll_thb: "ค่าทางด่วนรวม (บาท)", toll_tariff_id: "รหัสอัตราค่าทางด่วน",
  valid_from: "มีผลตั้งแต่", valid_to: "มีผลถึง", verified_geocodes: "พิกัดที่ยืนยันแล้ว",
  verified_packaging_count: "จำนวนบรรจุภัณฑ์ที่ยืนยันแล้ว", backup_verified: "ยืนยันการสำรองข้อมูลแล้ว",
  restore_drill_verified: "ยืนยันการซ้อมกู้คืนแล้ว", weight_complete: "น้ำหนักครบ", selected: "ถูกเลือก", verified: "ยืนยันแล้ว",
  unrestricted_value: "มูลค่าไม่จำกัดการใช้",
};

// Codes the database stores in status, band, level and similar columns.
const VALUES = {
  approved: "อนุมัติแล้ว", cancelled: "ยกเลิก", rejected: "ไม่อนุมัติ", confirmed: "ยืนยันแล้ว", created: "สร้างแล้ว",
  completed: "เสร็จแล้ว", draft: "ฉบับร่าง", pending: "รอดำเนินการ", shipped: "ส่งแล้ว", superseded: "มีฉบับใหม่แทน",
  locked: "ล็อกแล้ว", district_confirmed: "เขตยืนยันแล้ว", pending_district_confirmation: "รอเขตยืนยัน",
  pending_planner_approval: "รอผู้วางแผนอนุมัติ", pending_academic_approval: "รอฝ่ายวิชาการอนุมัติ",
  pending_approval: "รออนุมัติ", pending_review: "รอตรวจทาน", in_progress: "กำลังดำเนินการ", planned: "วางแผนแล้ว",
  dispatched: "ออกส่งแล้ว", issued: "จ่ายแล้ว", reserved: "จองแล้ว", released: "ปล่อยแล้ว", open: "เปิดอยู่",
  acknowledged: "รับทราบแล้ว", dismissed: "ปิดแล้ว", resolved: "แก้ไขแล้ว", queued: "รอคิว", running: "กำลังทำงาน",
  succeeded: "สำเร็จ", failed: "ล้มเหลว", partial: "สำเร็จบางส่วน", infeasible: "จัดไม่ได้", timeout: "หมดเวลา",
  published: "เผยแพร่แล้ว", deployed: "ติดตั้งแล้ว", rolled_back: "ย้อนกลับแล้ว", quarantined: "กักกัน",
  critical: "วิกฤต", high: "สูง", medium: "ปานกลาง", normal: "ปกติ", low: "ต่ำ", watch: "เฝ้าระวัง", healthy: "ปกติ",
  ok: "ปกติ", unknown: "ไม่ทราบ", stale: "ข้อมูลเก่า", fresh: "ข้อมูลใหม่", no_usage: "ไม่มีการใช้", degraded: "ทำงานไม่เต็มที่",
  stopping: "กำลังหยุด", info: "ข้อมูล", warning: "คำเตือน", error: "ข้อผิดพลาด", valid: "ผ่าน", verified: "ยืนยันแล้ว",
  unverified: "ยังไม่ยืนยัน", candidate: "รอตรวจ", legacy_unverified: "ข้อมูลเดิม ยังไม่ยืนยัน", quarantined_legacy: "ข้อมูลเดิมที่กักกัน",
  unmapped: "ยังไม่จับคู่", system: "ระบบเสนอ", added: "ผู้วางแผนเพิ่ม", actual: "ข้อมูลจริง", test_fixture: "ข้อมูลทดสอบ",
  reference_fixture: "ข้อมูลอ้างอิงทดสอบ", design_reference: "ข้อมูลอ้างอิงการออกแบบ", mixed: "ผสม",
  source_row_observed: "พบในไฟล์ต้นทาง", owner_attestation: "เจ้าของรับรอง", source_observed: "พบในไฟล์ต้นทาง",
  owner_attested_zero: "เจ้าของรับรองว่าเป็นศูนย์", source_derived: "คำนวณจากไฟล์ต้นทาง", source_missing_assumed_zero: "ไม่มีข้อมูลต้นทาง ถือเป็นศูนย์",
  district_response: "เขตตอบกลับ", planner: "ผู้วางแผน", academic: "ฝ่ายวิชาการ", lock: "ล็อกแผน", cancel: "ยกเลิก", version: "ออกฉบับใหม่",
  vmi: "VMI", passed_test: "ผ่านการทดสอบ", district_request: "เขตขอ", ad_hoc: "เฉพาะกิจ", change_request: "ขอเปลี่ยนแปลง",
  warehouse: "คลัง", district: "เขต", delivery: "ส่ง", pickup: "รับ", overflow: "เกินความจุ", complete: "ครบ", opening_unknown: "ไม่ทราบยอดยกมา",
  RECEIPT: "รับเข้า", RESERVE: "จอง", RESERVATION_RELEASE: "ปล่อยการจอง", ISSUE: "จ่าย", RETURN: "รับคืน", DAMAGE: "ชำรุด",
  QUARANTINE: "กักกัน", ADJUSTMENT: "ปรับยอด", TRANSFER_IN: "โอนเข้า", TRANSFER_OUT: "โอนออก", SEALED: "ยังไม่เปิด", OPEN: "เปิดแล้ว",
  DEPLETED: "หมดแล้ว", QUARANTINED: "กักกัน", OPENING_UNKNOWN: "ไม่ทราบสภาพ", HOME: "อยู่ประจำ", LOANED_OUT: "ให้ยืม",
  LOANED_IN: "ยืมมา", WAREHOUSE: "คลัง", DISTRICT: "เขต", SCHEDULED: "นัดส่งแล้ว", DISPATCHED: "ออกส่งแล้ว", DELIVERED: "ส่งถึงแล้ว",
  INSPECTED: "ตรวจแล้ว", ACCEPTED: "ตรวจรับแล้ว", REJECTED: "ไม่รับ", FULL_PALLET: "พาเลทเต็ม", BOX: "กล่อง", CRATE: "ลัง",
  BUNDLE: "มัด", LOOSE: "ชิ้น", LONG_MATERIAL: "วัสดุยาว", BUSINESS_RULE_V1: "กฎธุรกิจ v1", HISTORY_AVERAGE: "ค่าเฉลี่ยย้อนหลัง",
  missing_geocode: "ไม่มีพิกัด", missing_packaging: "ไม่มีข้อมูลบรรจุภัณฑ์", capacity: "เกินความจุ", time_window: "นอกช่วงเวลาส่ง",
  solver_timeout: "คำนวณหมดเวลา", recommendation_only: "เป็นคำแนะนำ",
};
const CODED = /(?:^|_)(status|band|level|decision|stage|severity|type|kind|mode|outcome|class|basis|source|method|role)$/;

const ascii = piece => /^[\x21-\x7e]/.test(piece);
// Thai words join without spaces; a code like SKU or CMP keeps a space on each side.
const join = pieces => pieces.filter(Boolean).reduce((out, piece) =>
  !out ? piece : out + (ascii(piece) || /[\x21-\x7e]$/.test(out) ? " " : "") + piece, "");
const words = list => join(list.filter(word => !SILENT.has(word)).toReversed().map(word => WORDS[word] ?? word));

// query_database names an aggregate after its function and column: sum_quantity, avg_current_stock_qty.
const AGGREGATES = { sum: "ผลรวม", count: "จำนวน", avg: "ค่าเฉลี่ย", min: "ค่าต่ำสุด", max: "ค่าสูงสุด" };

export function columnLabel(column) {
  if (Object.hasOwn(COLUMNS, column)) return COLUMNS[column];
  const parts = String(column).split("_");
  const rest = parts.slice(1).join("_");
  if (Object.hasOwn(AGGREGATES, parts[0]) && rest && (["sum", "count"].includes(parts[0]) || Object.hasOwn(COLUMNS, rest)))
    return join([AGGREGATES[parts[0]], columnLabel(rest)]);
  const unit = parts.length > 1 && Object.hasOwn(UNITS, parts.at(-1)) ? ` (${UNITS[parts.pop()]})` : "";
  // reviewed_by is the person who reviewed: ผู้ + ตรวจทาน.
  if (parts.length > 1 && parts.at(-1) === "by") return `ผู้${words(parts.slice(0, -1))}`;
  const per = parts.indexOf("per");
  return (per > 0 ? `${words(parts.slice(0, per))}ต่อ${words(parts.slice(per + 1))}` : words(parts)) + unit;
}

// A date, or a timestamp with its zone, as PostgREST returns them; a time with no zone is left as stored.
const STAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?))?$/;
const thaiDate = (value, withTime) => new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}), timeZone: "Asia/Bangkok" }).format(new Date(value));

export function valueLabel(column, value) {
  if (value == null || value === "") return "ไม่ทราบ";
  if (typeof value === "boolean") return value ? "ใช่" : "ไม่ใช่";
  if (Array.isArray(value)) return value.length ? value.map(item => valueLabel(column, item)).join(", ") : "ไม่มี";
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${columnLabel(key)} ${valueLabel(key, item)}`).join(", ");
  if (typeof value === "string" && STAMP.test(value) && !Number.isNaN(Date.parse(value))) return thaiDate(value, value.length > 10);
  return typeof value === "string" && CODED.test(column) && Object.hasOwn(VALUES, value) ? VALUES[value] : String(value);
}

// The writer gets the Thai names of what it read, so its answer can use them.
export function labelsFor(rows) {
  const columns = new Set(), codes = new Set();
  const walk = (value, column) => {
    if (Array.isArray(value)) return value.forEach(item => walk(item, column));
    if (value && typeof value === "object") return Object.entries(value).forEach(([key, item]) => { columns.add(key); walk(item, key); });
    if (typeof value === "string" && column && CODED.test(column) && Object.hasOwn(VALUES, value)) codes.add(value);
  };
  walk(rows);
  return { columns: Object.fromEntries([...columns].map(column => [column, columnLabel(column)])),
    values: Object.fromEntries([...codes].map(code => [code, VALUES[code]])) };
}
