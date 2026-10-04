# Proactive Agentic Alert

สถานะ: implementation และการตรวจฐานข้อมูลผ่าน กำลัง deploy และทดสอบ runtime (2026-10-04)

## ผลลัพธ์ที่ต้องส่งมอบ

- แนะนำก่อนผู้ใช้ถาม: วัสดุไหนเสี่ยงขาด ควรส่งสถานที่ไหนก่อน และวันนี้ต้องทำอะไร
- ใช้ข้อมูลจริง พร้อมหลักฐาน เวลาของข้อมูล และขอบเขตสิทธิ์ผู้ใช้
- แสดงที่กระดิ่งมุมขวาบนและรายการงานวันนี้ตามหน้าตาของ template เดิม
- ประเมินใหม่เมื่อข้อมูลเปลี่ยนและตามรอบรายวัน กันรายการซ้ำ และอัปเดตเมื่อปัญหาคลี่คลาย
- ตรวจการทำงานครบเส้นทาง push dev และ deploy Vercel Preview

## หลักการที่ตกลงจากแผน

1. โค้ดและ SQL คำนวณตัวเลข LLM ตรวจบริบท เลือกอ่านหลักฐานเพิ่มเติม และอธิบายข้อเสนอ
2. คำนวณแยกวัสดุและสถานที่ ไม่รวมยอดต่างสถานที่เพื่อสรุปความเสี่ยง
3. ใช้ระบบ Alert และ OpenRouter เดิม และเลือกโมเดลผ่าน env
4. จำกัดเครื่องมือ สิทธิ์ เวลา และจำนวนการเรียก LLM; provider ล้มเหลวต้องยังอ่านแจ้งเตือนพื้นฐานได้
5. การสร้างหรือแก้แผนส่งต้องให้ผู้ใช้ยืนยันในระยะแรก

## ข้อเท็จจริงที่ตรวจพบ

- กระดิ่งใน dashboard/app/page.tsx พาไปหน้า Operations; badge นับ alerts ที่โหลดทั้งหมด
- ops.system_alerts มี open/acknowledged/resolved แต่ unique index กันซ้ำเฉพาะ open
- มี refresh_operational_alerts สำหรับ import_failed, job_failed และ data_stale
- deploy/cron/synapse-intelligence.crontab.example เป็นตัวอย่างรอบตรวจ 15 นาที การติดตั้งจริงยังไม่ยืนยัน
- analytics.v_stock_health ใน 202607240022_production_completion_attestation.sql ใช้ข้อมูลระดับเขต มี months_available และ source_stock_missing; ข้อมูลขาดต้องไม่แปลว่า stock เป็นศูนย์
- ต้องตรวจคลังส่วนกลาง การจอง ของเข้า และวันจัดส่งแยกก่อนสร้างสูตรคาดการณ์วันขาด

### แหล่งข้อมูลที่ยืนยันจาก schema

| แหล่งข้อมูล | ใช้ทำอะไร | ข้อจำกัดที่ต้องรักษา |
|---|---|---|
| analytics.v_stock_health, migration 202607240022 บรรทัด 596–748 | stock และอัตราใช้รายวัสดุ × เขต; months_available=stock/CMP รายเดือน | ตรวจ source_stock_missing และ fixture/mixed ก่อนจัดเป็นความเสี่ยง; coverage รายเดือนไม่ใช่วันหมดที่ยืนยันแล้ว |
| core handling units, migration 202607230014 บรรทัด 239–259 | stock คลังพร้อมจัดสรร = available_qty-reserved_qty | การจองของคลังไม่หักจาก stock เขต; ตัดของ quarantined/หลักฐานไม่ชัดตามกฎ FIFO เดิม |
| ops.calculation_policies, migration 202607230014 บรรทัด 523 | เกณฑ์เติมเดิม trigger 3.5 เดือน เป้าขั้นต่ำ 4 เดือน | แสดงเวอร์ชันนโยบายและใช้ค่าปัจจุบันจริงก่อนคำนวณ |
| replenishment queue/items ใน production operations | งาน pending/confirmed/approved/shipped และลำดับที่ระบบกำหนด | งาน shipped ไม่ใช่หลักฐานว่าปลายทางรับแล้ว |
| analytics.demand_monthly_features และ forecast_results, migration 202607150005 | ประวัติ demand และ forecast ระดับวัสดุ × เขต | lead_time_days เป็นข้อมูลย้อนหลัง nullable; forecast ยังไม่อยู่ใน production API contract ต้องตรวจทางเข้าที่มีสิทธิ์ก่อนใช้ |
| trips, migration 202607250001 | วันเที่ยว สถานะ เขตในเส้นทางและเวลาการเดินทาง | travel_minutes ไม่ใช่ procurement lead time และไม่ยืนยันเวลารับของ; integration route-plan→trip ยังไม่ configured ใน OpenAPI |

หลักฐานนี้ยืนยันโครงสร้างและสูตรใน repo ยังไม่ยืนยันความครบถ้วนและความสดของข้อมูลบนระบบจริง ห้ามนำจำนวนเดือนที่เหลือไปแสดงเป็นวันขาดแบบแน่นอนโดยไม่มีข้อมูลรองรับ

### การตรวจ runtime วันที่ 2026-10-04

- Management API ยืนยัน stock-health จริง 4,014 แถว input_data_class=actual แต่ snapshot_at ทุกแถวเป็น 2026-07-21: ห้ามสรุปความเสี่ยงปัจจุบันจาก snapshot นี้โดยไม่แจ้งข้อมูลเก่า
- มี warehouse snapshots 1,519 แถว handling units 566 และ active plans 3 แผน; จำนวนแถวไม่พิสูจน์ว่าข้อมูลครบหรือสด
- นโยบายจริงยืนยัน months_trigger=3.5/min_months=4 เช่นเดียวกับ repo
- pg_cron และ pg_net ยังไม่ได้ติดตั้งในฐานข้อมูล; ตัวอย่าง cron ไม่ใช่ scheduler ที่ใช้งานจริง
- Vercel dev มี LLM env แต่ยังไม่มี CRON_SECRET หรือ credential ของ worker ต้องจัดตั้งงานตามเวลาที่มีสิทธิ์จำกัดและตรวจ invocation จริง
- Vercel Cron เรียก Production URL ตามเอกสาร ดังนั้น dev Preview ต้องใช้ scheduler ที่เรียก Preview โดยตรง ไม่ deploy dev เป็น Production เพื่อให้ cron ทำงาน

## ความคืบหน้า implementation

- เพิ่ม dashboard/app/agentic-alerts.mjs สำหรับคำนวณ coverage รายเดือนและส่วนขาดของ stock คลังเทียบงานที่ต้องจัดสรร โดยไม่ใช้ LLM คิดตัวเลข
- ตรวจ missing/fixture/invalid/stale district stock ก่อนแนะนำ; ไม่มีการกำหนดวันหมดจากค่าเดือนแบบแน่นอน
- inventory_complete ต้องยืนยันก่อนสรุป shortfall ของคลัง; stock ที่ไม่รู้ไม่แปลเป็นศูนย์
- ทดสอบ node --test dashboard/tests/agentic-alerts.test.mjs ผ่าน 2 tests ครอบคลุมข้อมูลขาด ข้อมูลเก่า stock ศูนย์จริง threshold การจองข้ามคลังและ handling-unit ซ้ำ
- เชื่อม RPC/persistence, worker lease, Agent เลือกอ่านหลักฐานและ independent review, feed ตามสิทธิ์ และ panel กระดิ่งแล้ว
- จัดกลุ่มงาน workflow ต่อแผนและเขต ได้ 121 candidates จากข้อมูลจริง: warehouse 49 / district 18 / workflow 54; ยังไม่ใช่หลักฐานว่า Agent วิเคราะห์ทั้งหมดแล้ว
- Tests ผ่าน 5 tests ใหม่และ 38 Agent tests เดิม; scoped lint, TypeScript และ production build ผ่าน
- Rollback-only DB verification ผ่าน grants, เขต, picker, viewer, acknowledgment, dedup, resolution, worsening และ lease; ไม่มีแถวทดสอบหรือการเปลี่ยน profile ค้าง
- Migration 20261004024530 ใช้จริงและลงทะเบียนแล้ว; เพิ่ม pg_cron/pg_net และ invoker อ่าน invocation secret จาก Vault
- ตั้ง worker credentials เฉพาะ sensitive Preview/dev env; cron jobs 07:30 ไทยและทุก 15 นาทีเปิดใช้งานแล้ว
- HTTP worker ผ่าน Preview protection ด้วย automation bypass ใน Vault: 200, saved 121; รอบแรก analyzed 0/6 เพราะ provider_output_invalid จึงยังไม่ถือว่าการทดสอบ LLM สำเร็จ
- UI live ตรวจกระดิ่ง 121 รายการ หลักฐาน รับทราบแล้วลดเป็น 120 และย้ายแท็บ ถาม Agent เติมข้อความ และเปิด FIFO ต้นทางได้; คืนสถานะรายการที่ใช้ทดสอบแล้ว
- Dev commit 50f57a9 และ prebuilt deployment อยู่ในคิว Vercel; ต้องตรวจ LLM และ UI รุ่นล่าสุดก่อนสำเร็จ
- Security advisor มี 3 findings ที่เกี่ยวข้อง: private run table RLS ไม่มี policy และ scoped security-definer feed/ack ที่ authenticated เรียกได้ เป็นสิทธิ์ตั้งใจและตรวจ authorization แล้ว ไม่อ้างว่าทั้งฐานข้อมูลสะอาด

### ต้นไม้การตัดสินใจ

- ขอบเขตคลัง → แหล่ง demand/inbound ของแต่ละระดับ → สูตรคาดการณ์และสิทธิ์ผู้รับ
- นโยบายข้อมูลเวลาที่ขาด → ใช้หลักฐานเท่าที่มีหรือค่า fallback ธุรกิจ → วิธีแสดงความไม่แน่นอนและลำดับส่ง
- รอบสรุปและความสำคัญ → วันทำงาน/cutoff → scheduler และเงื่อนไขแจ้งเตือนซ้ำ
- เมื่อตอบ frontier ปัจจุบันแล้ว ตรวจคำถามที่ขึ้นกับคำตอบเหล่านี้และยืนยันความเข้าใจร่วมกันตาม grilling ก่อน implementation

## เกณฑ์ที่ผู้ใช้ยืนยัน

- ครอบคลุมทั้งคลังส่วนกลางและคลังประจำเขต แสดงขอบเขตแยกกัน
- ข้อมูลขาดให้แจ้งตรวจสอบและแนะนำสิ่งที่ทำได้จากหลักฐานที่มี โดยไม่สร้างตัวเลขทดแทนเอง
- สรุปทุกวัน 07:30 Asia/Bangkok (00:30 UTC)
- ใช้เกณฑ์ความเร่งด่วนตามแผนและนโยบายเติมที่มีอยู่ หากไม่มีหลักฐานวันของถึงต้องระบุข้อจำกัดในการจัดลำดับส่ง
- ผู้ใช้ตอบเกณฑ์เหล่านี้หลังสั่ง go ahead follow plan ถือเป็นยืนยันความเข้าใจร่วมกันเพื่อเริ่ม implementation

## ลำดับดำเนินงานและหลักฐานยืนยัน

1. ตรวจ schema/API และข้อมูลจริง: บันทึก source และ field สำหรับ stock, reservation, demand, inbound และ delivery
2. ตัวคำนวณ: ตรวจกรณี stock ขาด/ศูนย์ ไม่มี demand ของเข้าซ้ำและข้อมูลเก่า; ไม่หัก reservation ข้ามสถานที่
3. วงจรชีวิต Alert: ตรวจเหตุการณ์ซ้ำ งานชนกัน รับทราบ และเงื่อนไขคลี่คลาย
4. Agent: ตรวจ tool calling หลักฐานจริง ข้อเสนอที่ไม่มีหลักฐาน และ provider ล้มเหลว
5. Scheduler: ยืนยันรอบจริง สิทธิ์ worker และการประมวลผลซ้ำอย่างปลอดภัย
6. UI: ตรวจ badge จาก count ฝั่ง server, panel, งานวันนี้, หลักฐานและเปิดงานต้นทาง รวมมือถือและสิทธิ์
7. Dev deploy: ทดสอบครบเส้นทางบน Preview พร้อมหลักฐาน runtime; ตรวจ main/Production แยกก่อนรายงานสำเร็จ

## UX ที่ผู้ใช้เพิ่มระหว่าง implementation

- หน้าต่างผู้ช่วยเปิดแบบคลี่จากกระดิ่ง มีการ์ดแนะนำและหลักฐานที่เปิดอ่านเพิ่มได้
- เหตุการณ์ใหม่ระดับ critical เปิดการ์ดผู้ช่วยอัตโนมัติ โดยไม่แย่ง focus; ย่อแล้วไม่เปิดซ้ำสำหรับ fingerprint เดิม
- งานทั่วไปเปิดด้วยการกด และยังรองรับรับทราบ/ประวัติ/เปิดข้อมูลต้นทาง/ถาม Agent ต่อ
- แชทใช้ข้อความหลัก 16px และช่องพิมพ์สองบรรทัด พร้อม reduced-motion และขนาดมือถือ/desktop
- Commit 0eea915 มี UX ข้างต้นและการแยกรหัส provider error เพิ่มเติม; ต้องตรวจ Preview/UI/runtime ก่อนถือว่าสำเร็จ

### Provider read serialization verification

Preview 0eea915 was READY and the modern drawer/chat passed desktop and 390px checks. Live worker request 8 saved 121 alerts but reviewed 0 of 6 attempts (`provider_output_invalid_parallel`); the broad chat question also failed. Evidence reads now use a bounded source batch. The shared provider adapter executes one read proposal per step and explicitly defers unused call IDs. Duplicate IDs, unknown/mixed terminal batches, permissions and budgets remain guarded. All 38 agent tests passed, including read → deferred read → finish. Live verification of this correction is pending.

Live worker request 11 on 0ccd7bf returned HTTP 200 and saved 121 alerts, but all six drafts were rejected by the independent checker. Added bounded rejection categories (no raw drafts or secrets in diagnostics) and clarified that verification/conditional advice is valid while stale current-stock assertions remain rejected. The shared adapter correction is still awaiting dev build.

Preview 1a23191 READY. Live request 12 returned `unsupported_stale_current_claim:6`. Broad chat now executed its reads but incorrectly recommended today’s delivery from July stock. Added explicit assessment time and stock freshness metadata to chat tool evidence/writer/reviewer, with historical fallback notices. Proactive drafts may repair a stale-current-stock rejection once using the same evidence, followed by a fresh independent review; a second rejection stays evidence-only. Pending live verification.

Preview e5b5062 READY and dev alias SHA verified. Live worker request 15 still rejected all six attempts (`unsupported_stale_current_claim`), including the single repair. Chat live returned historical snapshot dates and a verification-first fallback; runtime trace confirms completed tool read plus rejected synthesis. Added bounded rejected-draft/reviewer explanation diagnostics to private Vercel operator logs, with credential redaction and hashed candidate identity; rejected drafts are never stored in the public alert feed. Live diagnosis remains required.

Preview e057d48 READY. Live request 17: 4 rejected workflow drafts plus 2 HTTP 402 responses. Private diagnostics show workflow-only proposals (check pending district confirmation; confirm only when complete), with rejection explanations incorrectly referring to unused July stock. Review now receives only cited evidence and explicitly distinguishes active workflow facts, dated historical facts and verification requests from unsupported current-stock claims. Repair feedback is identified as fixed server validation. Added safe classification of 402 in-flight budget (metadata plus Retry-After) versus billing/credit limit; billing refusals stop further calls in that run while all alerts remain saved. Requested account/key credit-limit confirmation from the user without requesting the key. Live verification remains pending.

Preview e4590f9 READY. Live requests 19 and 20, separated by a wait, both saved 121 alerts with `provider_capacity_budget:6`; this is explicitly a temporary in-flight hold with Retry-After, not proof of an empty wallet. Shared provider fetch now honors short Retry-After (up to 10 seconds) once within cancellation/deadline limits, never retries billing, and stops the run after a continuing capacity hold while returning its retry delay. Actual HTTP attempts remain inside the chat model-call budget. Workflow evidence now matches its plan/district, materials and material-origin pairs instead of mixing other plans or arbitrary warehouse rows. Regression checks cover retry, billing, long holds, persistence and cross-plan/origin evidence. See OpenRouter limits documentation: https://openrouter.ai/docs/api_reference/limits . Live reviewed advice is still unverified due to the provider hold.
