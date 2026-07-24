# MEA Synapse — Master Requirements, Decisions and Current Status

วันที่จัดทำ: **22 กรกฎาคม 2026**  
สถานะ: **Master Source of Truth จากการสนทนาและข้อตกลงทั้งหมดถึงเวลาจัดทำเอกสาร**  
ขอบเขต Environment: **Staging เท่านั้น — ห้ามแก้ Production**

เอกสารนี้รวม Requirement, Business Rules, Workflow, Data, UX/UI, Database, Traceability, Decision Support, Transport, Security, สถานะการพัฒนา และเรื่องที่ยังต้องยืนยันไว้ในไฟล์เดียว หากเอกสารเก่าขัดกับเอกสารนี้ ให้ใช้ข้อมูลที่ระบุว่า **Confirmed/Frozen** และ Correction ในเอกสารนี้ก่อน

## 1. Status Legend

| สถานะ | ความหมาย |
|---|---|
| **FROZEN** | ตกลงแล้ว การเปลี่ยนต้องออก Business Rules version ใหม่ |
| **CONFIRMED** | ผู้ใช้ยืนยันแล้ว แต่ไม่จำเป็นต้องเป็นกฎคำนวณที่ Freeze |
| **IMPLEMENTED — LOCAL** | สร้างใน Source Code บนเครื่องและทดสอบแล้ว แต่ยังไม่ Push/Deploy |
| **PUSHED BASELINE** | อยู่ใน GitHub commit แรกแล้ว |
| **DATA/API GATED** | มี Design/Schema/UI แล้ว แต่ยังทำงานจริงไม่ได้เพราะไม่มี Database/API/ข้อมูลจริง |
| **OPEN** | ยังต้องได้รับข้อมูลหรือการยืนยันเพิ่มเติม |
| **FUTURE** | อยู่ใน Roadmap ไม่ใช่ Scope ใช้งานจริงของรอบปัจจุบัน |

## 2. Corrections และข้อมูลล่าสุดที่ใช้แทนข้อมูลเก่า

1. **คลังคลองเตย = Plant `2401` + Storage Location `0001`** ข้อมูลนี้แทนข้อความก่อนหน้าที่เคยสับสนว่า Plant 0001
2. แผนหลักเป็น **Weekly Plan**; Daily ใช้เฉพาะ Alert/Exception ไม่คำนวณทับแผนหลักทุกวัน
3. CMP หมายถึง **อัตราการใช้งานเฉลี่ยต่อเดือน** ไม่ใช่เปอร์เซ็นต์
4. Database foundation เดิมมี 18 ตาราง แต่หลัง Decision Intelligence Migration ปัจจุบันมี **24 ตารางใน Source Code**
5. Migration `0002_wise_jamie_braddock.sql` ถูกสร้างแล้ว ไม่ใช่เพียง Next Step
6. GitHub commit `c88c443` มีเฉพาะ Initial Staging Database Foundation; งาน UI/Schema/Migration/เอกสารล่าสุดยัง **ไม่ได้ Commit/Push/Deploy**
7. เว็บไซต์ที่ใช้อ้างอิงปัจจุบันคือ Vercel Staging: <https://mea-synapse-staging.vercel.app/> ส่วน ChatGPT-hosted site เป็น Target เดิม
8. UI รุ่นเดิมระบุ Release แบบ Non-AI และ M11 AI excluded; ความต้องการ Quantity Suggestion ถูกเพิ่มภายหลัง แต่ **Recommendation Engine/AI จริงยังไม่ Operational** ห้ามแสดงผล AI จำลอง
9. ชื่อ Vendor จริงยังปิดเพื่อความลับ; Staging ใช้ Vendor alias/Dummy คงที่จนกว่าจะได้รับอนุญาต
10. Fixed rounding เช่น 50/100/500/1,000 ยังไม่ได้รับการยืนยันเป็น Business Rule หลัก การจ่ายต้องยึด Packaging Profile/Pallet จริงและรองรับ Partial Pallet + Remain

## 3. Product Vision และเป้าหมายระบบ

MEA Synapse เป็นระบบบริหารและสนับสนุนการตัดสินใจสำหรับการจ่ายพัสดุจากคลังคลองเตยไปยัง 18 เขต ครอบคลุม:

1. รับและตรวจสอบข้อมูลจาก SAP/Excel
2. แสดง Stock คลังกลางและคลังเขต
3. คำนวณ CMP, Stock Coverage และจำนวนที่ควรเติม
4. สร้าง Weekly Replenishment Plan
5. ให้เขตยืนยัน ปฏิเสธ เพิ่มรายการ หรือขอปรับจำนวน
6. ตรวจคำขอเบิกผิดปกติ/เสี่ยงกักตุนโดยใช้หลักฐาน
7. อนุมัติตามลำดับ Planner → นักวิชาการ → Lock
8. เลือก Contract/Lot/Pallet ตาม FIFO และคำนวณ Remain
9. สร้าง Picking/Issue Movement ที่ Trackback ได้
10. จัดรอบรถคลังคลองเตย 2 คันหรือกำหนดให้รถเขตรับเอง
11. เก็บ Estimated/Actual และต้นทุนขนส่ง
12. สอบกลับของที่มีปัญหาจาก Contract/Vendor/Lot/Pallet ไปยังทุกเขตที่ได้รับ
13. รองรับการขยายจากคลังคลองเตยไปยังคลังบางพลีและคลังเมืองใหม่ในอนาคต

## 4. Product Name, UX/UI และ Navigation

### 4.1 Branding และภาษา — CONFIRMED

- เปลี่ยนชื่อจาก **MEA WMS** เป็น **MEA Synapse**
- ใช้ Modern Enterprise UI ที่เรียบ สวย อ่านง่าย และเหมาะกับงานองค์กร
- ภาษาอังกฤษเป็นหัวข้อหลัก พร้อมคำอธิบายภาษาไทย
- คงศัพท์หน้างาน เช่น Stock, CMP, MIN, MAX, FIFO, Pallet, Remain
- Font ไทยต้อง Smooth และกลมกลืนกับ UI สมัยใหม่

### 4.2 Login — CONFIRMED

- Login ต้อง Modern, สะอาด และภาษาอังกฤษเป็นหลัก
- ห้ามแสดงข้อมูลหลังบ้านหรือข้อมูลธุรกิจก่อนยืนยันตัวตน
- รองรับ Role-based login/workspace
- Demo Login ใน Staging ต้องระบุชัดว่าเป็น Demo/Staging ไม่ใช่ Production authentication

### 4.3 Role-based UI — CONFIRMED

- User ต้องเห็นเฉพาะเมนู ข้อมูล เขต และ Action ที่เกี่ยวข้องกับ Role
- District User ห้ามเห็นข้อมูลเขตอื่น
- Viewer อ่านได้แต่แก้ไข/อนุมัติไม่ได้
- **Control Tower** เป็นหลังบ้านสำหรับ Admin/Planner/ผู้ควบคุม ไม่แสดงแก่ District User ทั่วไป

### 4.4 เมนูที่ต้องรองรับ

- Dashboard / Operations Dashboard
- Replenishment Calculation / คำนวณการจ่าย
- Quantity Suggestions
- Abnormal Request Review
- District Confirmation / ยืนยันรายการพัสดุ
- Final Plan Summary
- Plan History / ประวัติแผนการจ่าย
- Issue Traceback
- Stock Overview / ข้อมูล Stock
- Stock Import / อัปเดต Stock
- SAP Data / ข้อมูล SAP
- Contract/FIFO/Pallet
- Demand Forecast
- Ad-hoc Issue / งานจ่ายนอกแผน
- Transport Planning
- Transport Dashboard และ Transport History
- Control Tower / System Administration ตามสิทธิ์

### 4.5 หน้าเว็บอ้างอิง

- หน้าและ Module ล่าสุดเป็นฐานหลักในการพัฒนาต่อ
- `mea_wms_main.html` เป็น Reference สำหรับ Requirement/Workflow ที่เดิมค่อนข้างสมบูรณ์
- เมนูที่ไม่มีจริงหรือซ้ำกันต้องปรับให้ตรงกับ Functional Scope ไม่เพิ่มเมนูเพียงเพื่อให้หน้าจอดูเต็ม
- หน้าจอคำนวณการจ่ายเป็นจุดเริ่มต้นของการดำเนินงานจ่ายและต้องค้นหาได้ง่าย

## 5. Organizational และ Warehouse Scope

### 5.1 ปัจจุบัน — CONFIRMED

- ทำเฉพาะ **คลังคลองเตย**
- Source Warehouse: Plant `2401`, Storage Location `0001`
- เป้าหมายปลายทาง: 18 เขต
- District User มี 1 คนต่อเขตสำหรับยืนยันรายการ

### 5.2 อนาคต — FUTURE

- ฝ่ายพัสดุมี 3 คลัง: คลังคลองเตย, คลังบางพลี, คลังเมืองใหม่
- Admin/Data Model ต้องรองรับ Multi-Warehouse
- คลังอีก 2 แห่งมีรูปแบบส่งของวันละเขต ของขนาดใหญ่กว่า และไม่ค่อยจ่ายย่อย จึงต้องใช้ Policy/Vehicle/Packaging Profile แยกคลังได้

## 6. Data Sources และ Cadence

| ไฟล์/Source | ใช้งาน | ความถี่ | สถานะ |
|---|---|---:|---|
| `Stock.xlsx` | Stock คลังคลองเตยและคลังเขต | ทุกวัน | CONFIRMED |
| `อัตราการใช้งาน.xlsx` | LY, 12M, 6M, 4M และ CMP | เดือนละครั้ง | CONFIRMED |
| `รวมสัญญา.xlsx` | Contract, PO, PO Item/งวด, วันที่ผ่านตรวจรับ, FIFO | ทุกวัน | CONFIRMED |
| `คลังคลองเตย (1).xlsx` | วิธีทำงานเดิม, Transport/Actual/Route reference | ใช้ออกแบบและ Mapping | CONFIRMED |
| SAP | แหล่งดาวน์โหลดไฟล์และเลขอ้างอิงการเบิก/จ่าย | ตามกระบวนการ | CONFIRMED |

### 6.1 Import Governance — CONFIRMED

- SAP export อาจต้องใส่สูตรเพื่อดึงค่าที่ต้องการก่อน Import
- เก็บไฟล์/แถว Raw ก่อน Transform เพื่อ Trackback สูตรและ Source
- ทุก Import ต้องมี Batch ID, filename, sheet, checksum, business date, imported time, imported by, row count และ Source Row Lineage
- Daily file เปลี่ยนข้อมูลเก่าและเพิ่มข้อมูลใหม่ได้
- การนำเข้ารอบใหม่อัปเดต Current Interpretation แต่ไม่ลบ Version History
- Duplicate file/checksum ต้องไม่สร้างข้อมูลซ้ำ
- Validation error ต้องเก็บเป็น Import Issue ไม่แก้ Core เพื่อซ่อนปัญหา

### 6.2 Data Privacy — CONFIRMED

- ไม่ใส่ชื่อ Vendor จริงใน Staging ปัจจุบัน
- ใช้ alias คงที่ เช่น `SUP-UNKNOWN` แทนการแต่งชื่อผู้ขายหลายชื่อ
- Vendor จริงจะมาจาก SAP ภายหลังเมื่อได้รับอนุญาต
- การแสดง Vendor ต้องควบคุมตาม Role และนโยบายข้อมูล

## 7. Stock Rules — FROZEN

1. ใช้เฉพาะคอลัมน์ **Unrestricted / ไม่จำกัด**
2. ไม่รวม **Stock in Transfer / การส่ง/การโอน**
3. Stock เขต = ผลรวม Unrestricted ของ **ทุก Storage Location** ภายใต้ Plant ของเขตนั้น
4. ปัจจุบันยังไม่มี Storage Location ใดที่ให้ตัดออก
5. หาก Material + Plant ไม่มีแถว ให้ถือ Stock = `0` และติดธง `Source Missing / Assumed 0`
6. หน้าจอ Stock ต้องดูได้ทั้ง:
   - ราย Warehouse/เขต
   - ราย Material
   - รายการพัสดุทั้งหมดของคลัง
   - สถานะ Replenishment/Alert
7. ต้องแยก Warehouse Stock กับ District Stock ชัดเจน
8. ห้ามสร้าง District Stock จำลองเมื่อ Source ยังไม่พร้อม

## 8. Usage และ CMP Rules — FROZEN

- `-` ในประวัติการใช้งานหมายถึงเดือนนั้นไม่มีการใช้งานและแปลงเป็น `0`
- CMP คือ Average Monthly Usage quantity
- CMP ปัดเป็นจำนวนเต็ม

```text
CMP = ROUND(AVERAGE(LY, 12M, 6M, 4M), 0)
3M Reference = CMP × 3
MIN Target = CMP × 4
MAX Target / 6M = CMP × 6
MIN Fill = MAX((CMP × 4) - District Stock, 0)
MAX Fill = MAX((CMP × 6) - District Stock, 0)
Months Remaining = District Stock ÷ CMP
```

- หาก CMP = 0:
  - แสดง CMP = 0
  - หมายถึงไม่มีการเบิกใช้งานตาม Source
  - ไม่คำนวณ MIN/MAX และ Months Remaining
  - คำขอจำนวนสูงต้องถูก Risk Review

## 9. Replenishment Policy — FROZEN

- Stock Trigger: เหลือไม่เกิน `3.5` เดือน
- MIN Target: `4` เดือน
- 3M: Reference เท่านั้น
- MAX Target: `6` เดือน
- หลังรับเกิน 6 เดือน: Warning
- หลังรับเกิน 9 เดือน: Special Approval
- Business Rules v1 มีผลวันที่ 22 กรกฎาคม 2026
- การเปลี่ยน Threshold/สูตรต้องสร้าง Version ใหม่และห้ามแก้ผล Plan/Movement ย้อนหลัง

## 10. Calculation Screen Requirements

### 10.1 Fields ที่ต้องแสดง

- District/เขต
- Material code และ description
- District Stock
- CMP
- 6M / MAX Target
- MAX Fill
- 3M Reference
- 4M / MIN Target
- MIN Fill
- Months Remaining
- Last/Mean/Median/P90 issue history เมื่อมี
- Policy Suggested Qty
- History-assisted Suggested Qty
- Final Requested/Approved Qty
- Priority/Risk
- Data freshness และ Source Batch

### 10.2 Behavior

- คำนวณได้ทั้งราย Material และราย District
- Filter ตามเขต, Priority, Material code/name
- มี Summary จำนวนรายการและจำนวนรวม
- คำแนะนำต้องมี Evidence และ Version
- ทุก Manual Override ต้องมีเหตุผล ผู้แก้ และเวลา
- ห้ามสร้างผลเมื่อ District Stock หรือ Source สำคัญไม่พร้อม

## 11. Planning Cadence และ End-to-End Workflow — FROZEN/CONFIRMED

### 11.1 Cadence

- Main Plan: รายสัปดาห์
- Daily: Stock refresh + Alert/Exception + Ad-hoc issue
- CMP: เดือนละครั้งเพราะ SAP export ใช้เวลานาน
- Contract: ทุกวันเพราะข้อมูลเดิมอาจอัปเดตและมีสัญญาใหม่
- Daily processing ห้ามทับ Weekly Plan ที่ Lock แล้ว

### 11.2 Workflow

```text
Daily Stock + Daily Contract + Monthly CMP
→ Data Validation and Reconciliation
→ Weekly Calculation
→ Quantity Recommendation with Evidence
→ District Confirmation / Reject / Add / Adjust
→ Abnormal Request Risk Review
→ Planner คลังคลองเตย Approve
→ นักวิชาการ Approve
→ Lock Final Plan
→ Reserve Stock
→ FIFO Pallet Allocation
→ Picking / Issue
→ Transport Planning
→ Delivery or District Pickup
→ Actual Movement and Cost
→ Traceback / Reports
```

### 11.3 District Confirmation — CONFIRMED

- เขตเห็นเฉพาะรายการของตนเอง
- เขตยืนยันว่า รับ/ไม่รับ
- เขตเพิ่ม Material อื่นหรือขอปรับจำนวนได้
- ทุกการเพิ่ม/ปรับต้องระบุเหตุผลและชื่อผู้ร้องขอ
- เขตตอบภายในวันถัดไปจากวันที่ส่งรายการ
- หากไม่ตอบ: ยังไม่ถือว่ายืนยัน, ระบบ Alert, Planner โทรติดตามและบันทึกแทนได้

### 11.4 Approval — FROZEN

- ผู้อนุมัติ Final มี 2 Role:
  1. Planner คลังคลองเตย
  2. นักวิชาการ
- ต้องอนุมัติตามลำดับ Planner → นักวิชาการ
- หลังครบจึง Lock และนำไปวางแผนขนส่ง
- หากเกิน 9 เดือน นักวิชาการต้องเห็น Special Approval evidence

### 11.5 Version, Lock, Change, Cancel — CONFIRMED

- Plan Lock แล้วต้องไม่ถูกแก้เงียบ ๆ
- รองรับ Change/Cancel ด้วย Version และ Audit Trail
- ยกเลิกแล้วต้องคืน Reserve
- ห้ามลบ Approval/Recommendation/Allocation evidence เดิม
- ใช้ Reversal/New record แทนแก้ Movement ย้อนหลัง

## 12. Contract, Receipt Lot และ FIFO — FROZEN

### 12.1 Eligibility

- Import contract เฉพาะแถวที่มี Material
- รายการที่เตรียมรอจ่าย/FIFO ได้ต้องมีทั้ง Material และ Contract
- สัญญาเดิมอาจถูกอัปเดตทุกวัน จึงต้องเก็บ Contract Item Version

### 12.2 ความหมายข้อมูล

- `รายการที่` = PO Item/งวดส่งมอบตาม Source ที่ให้มา
- หนึ่ง PO/สัญญามีหลายงวดได้
- แต่ละการส่งของ/รับเข้าต้องเป็น Receipt Lot แยก เพราะงวด 1/2/3/4 อาจมีคนละวันผ่านตรวจรับ

### 12.3 FIFO Order

1. `วันผ่านตรวจรับ` จากเก่าไปใหม่
2. PO/รหัสจัดหา
3. PO Item/Installment
4. Source Row order เป็น deterministic tie-breaker

### 12.4 Output ที่ต้องบอก

- Material
- Contract/PO/รหัสจัดหา
- PO Item
- งวดส่งมอบ
- วันผ่านตรวจรับ
- Vendor/Vendor alias
- Receipt Lot
- Handling Unit/Pallet
- จำนวนที่จ่ายและ Remain

## 13. Pallet, Packaging และ Remain — FROZEN/CONFIRMED

### 13.1 Scope

- เริ่ม Pallet/Handling Unit ID กับพัสดุทุกชนิดในคลังคลองเตย
- เริ่มเก็บจริงแบบ Progressive ตั้งแต่ Go-Live
- ห้ามแต่ง Movement ก่อน Go-Live
- Opening Stock ที่ Lineage ไม่ชัด = `OPENING_UNKNOWN`

### 13.2 Packaging Types

- Full Pallet
- Box
- Crate
- Bundle/Loose
- Long Material

### 13.3 Packaging Data

- ปัจจุบันจำนวนต่อ Pallet/Box/Crate, dimension และ weight ยังไม่ครบ
- Staging ใช้ `DUMMY` หรือ `ESTIMATED` ได้
- ต้องแสดง Data Quality ชัดเจน
- Dummy/Estimated Packaging ห้าม Auto-approve real vehicle load
- ภายหลังเก็บ Material-level Packaging Profile: units, L×W×H, gross weight, stackable, side-loadable, forklift required, max layers

### 13.4 Pallet ID เมื่อยังไม่มี Printer

- ระบบสร้าง Internal Handling Unit ID ได้ทันที
- ระยะแรกแสดง ID ในระบบและ Picking Document/Pallet Card ที่เขียนหรือพิมพ์ทั่วไปได้
- QR/Barcode Label Printer เป็น Enhancement ภายหลัง
- ต้อง Track Contract, Vendor, Receipt Lot, Installment และตำแหน่งของ Pallet

### 13.5 Allocation และ Remain

- พยายามจ่าย Full Pallet
- หากจำนวนไม่เต็ม Pallet ให้จ่ายย่อยจาก Pallet ตาม FIFO
- บันทึก Remain Before และ Remain After
- ใช้ Pallet เก่าที่เปิดแล้วให้หมดก่อนเปิด Pallet ถัดไปใน FIFO Lot เดียวกัน
- ระบบต้องเสนอ Pallet ปัจจุบันและ Pallet ถัดไป
- Allocation ต้องมี sequence เพื่อสอบกลับลำดับหยิบ

## 14. Inventory Movement และ Returns — FROZEN/CONFIRMED

- Movement types ต้องรองรับ Opening, Receipt, Reserve, Release, Issue, Return, Transfer, Adjustment, Quarantine
- Movement History เป็น Append-only
- เก็บ Actor, time, reason, SAP document, business reference, from/to location และ quantity delta
- ของคืนจากการยืมหรือทดสอบต้องอ้างอิง Issue เดิมและคืนเข้า Handling Unit เดิม
- ของเสีย/ไม่ผ่านทดสอบไป Quarantine ไม่กลับ Available อัตโนมัติ
- Cancellation ใช้ Release/Reversal และคืน Reserve
- Reconcile Handling Unit totals กับ SAP Stock ที่ Material + Plant + Storage Location เพราะ SAP ไม่มี Pallet Balance รายใบ
- ผลต่างต้องเป็น Reconciliation Issue ห้ามแก้ตัวเลขเพื่อให้ตรงโดยไม่มีหลักฐาน

## 15. End-to-End Traceback และ Recall — CONFIRMED

### 15.1 Forward Trace

จากของที่จ่ายให้เขต ต้องตอบได้ว่า:

```text
District + Issue/SAP Document
→ Final Plan Item
→ District request and reason
→ Planner/Academic approvals
→ FIFO Allocation
→ Handling Unit/Pallet + Remain
→ Receipt Lot + accepted date
→ PO Item/Installment
→ Contract/PO
→ Vendor/Vendor alias
```

### 15.2 Reverse Trace/Recall

เมื่อพบของมีปัญหาจาก Vendor, Contract, PO, Installment, Receipt Lot หรือ Pallet ต้องค้นกลับได้ว่า:

- Material ใดได้รับผลกระทบ
- Pallet/Remain ใดยังอยู่คลัง
- เขตใดได้รับไป
- วันที่และจำนวนที่แต่ละเขตรับ
- แผน/ใบเบิก/SAP document ใด
- ใครขอ ใครยืนยัน ใครอนุมัติ และเหตุผล
- ส่วนใดต้อง Quarantine/Recall/Follow-up

### 15.3 Truth Boundary

- ก่อน Go-Live ถ้าไม่มี Movement/Handling Unit จริง ระบบต้องแสดง Coverage/Unknown
- ห้ามสร้าง Traceback จำลอง
- Vendor จริงแสดงตามสิทธิ์; Staging ใช้ alias

## 16. Quantity Recommendation / AI Suggestion — CONFIRMED, DATA/API GATED

### 16.1 เป้าหมาย

- ระบบช่วยแนะนำจำนวนโดยดู Policy และประวัติว่าเขตเคยรับเท่าไร
- Planner เห็นเหตุผลว่าครั้งนี้ควรจ่ายเท่าไร
- Recommendation เป็น Decision Support ไม่ใช่ Approval

### 16.2 Evidence ที่ต้องเก็บ

- District Stock, CMP, Months Remaining ณ เวลาคำนวณ
- Policy Suggested Qty
- History range และ freshness
- Last Issue Qty
- Mean, Median, P90
- Sample size
- Lower/Upper range เมื่อคำนวณได้อย่างน่าเชื่อถือ
- Confidence score เมื่อมีเหตุผลทางสถิติ
- Policy version
- Recommendation Engine/Model version
- Risk/Outlier signals
- Machine-readable explanation/evidence
- ผู้ Accept/Override, เหตุผล และเวลา

### 16.3 Safety

- ถ้า Source ไม่ครบให้ `DATA GATED`
- ห้ามแสดง AI result ปลอม
- ห้าม Auto-approve
- History น้อยต้องลด Confidence หรือส่ง Manual Review
- Actual AI/ML ยังไม่ Operational; เริ่มจาก Explainable Rule/History-assisted recommendation ก่อน

## 17. Abnormal Request และ Stockpiling Control — CONFIRMED, DATA/API GATED

### 17.1 หลักการ

- ระบบตรวจความผิดปกติและแจ้งเตือน ไม่กล่าวหาว่าผู้ขอกักตุน
- คนเป็นผู้พิจารณาหลักฐานและอนุมัติ

### 17.2 ข้อมูลบังคับ

- Original Suggested Qty
- Requested Qty
- Delta และ Delta Percent
- Projected Months after receipt
- ชื่อผู้ขอ
- Authenticated User ID
- เหตุผลอย่างมีรายละเอียด
- วันที่เวลา
- History comparison
- Risk signals
- Planner review/decision/reason
- Academic Officer approval เมื่อจำเป็น

### 17.3 Automatic Signals

- สูงกว่าครั้งก่อน/Mean/Median/P90 ผิดปกติ
- หลังรับเกิน 6 เดือน
- หลังรับเกิน 9 เดือน
- ขอเพิ่มซ้ำในช่วงสั้น
- CMP ต่ำหรือ 0 แต่ขอสูง
- Stock/Usage stale หรือ history sample น้อย
- District ปรับจำนวนเกิน MAX

### 17.4 Outcome

- Risk Level: Normal, Watch, High, Critical
- สามารถ Approve/Reject พร้อมเหตุผล
- เกิน 9 เดือนต้อง Special Approval
- ทุก Decision ต้อง Trackback ได้

## 18. Ad-hoc / Urgent Issue — CONFIRMED DESIGN, NOT YET IMPLEMENTED

### 18.1 แนวทาง

- มีเมนูแยกจาก Weekly Plan
- งานด่วนจ่ายได้ทันทีตามใบเบิก SAP
- ไม่บังคับคำนวณ Weekly Plan ใหม่ทุกวัน
- บันทึก Actual เพื่อไม่สูญเสียประวัติและนำไปคำนวณ Usage/Suggestion รอบต่อไป

### 18.2 Minimum Fields

- วันที่เวลา
- District/ผู้รับ
- SAP Requisition/ใบเบิก/เลขอ้างอิง
- Material และจำนวน
- เหตุผลและ Urgency
- ผู้ร้องขอและผู้อนุมัติ
- Planner/Picker/Outsource operator
- Contract, Receipt Lot, Handling Unit ที่ FIFO เลือก
- Remain before/after
- รถคลังส่งหรือรถเขตรับเอง
- SAP posting status/document

### 18.3 Reporting

- นับใน Actual Usage
- นับใน Movement History
- นับใน Transport Actual
- แสดงใน Dashboard/Traceback
- ไม่แก้ Weekly Plan เดิมย้อนหลัง

## 19. Dashboard Requirements

### 19.1 Replenishment/Operations Dashboard

- สรุปว่าการจ่ายเป็นไปตามแผนหรือไม่
- Planned vs Confirmed vs Approved vs Actual
- แผนที่ถูกปรับและเหตุผล
- รายการรอยืนยัน/เกิน SLA
- Stock Alerts และ Priority
- จำนวนรายการ/จำนวนหน่วย/มูลค่าเมื่อมี Source
- เขตที่เสี่ยงขาด/เกิน
- Abnormal Requests และ Special Approvals
- Traceability Coverage

### 19.2 Stock Dashboard

- Warehouse/District/Material view
- Stock, CMP, Months Remaining
- Trigger/MIN/MAX status
- Source freshness, missing data และ import issues
- Handling Unit/Pallet coverage และ SAP reconciliation

### 19.3 Transport Dashboard

- Fuel cost รวมรายเดือนและต่อรถ
- Fuel price per litre
- Toll cost รวมรายเดือนและต่อรถ
- จำนวนเที่ยวส่ง 18 เขต
- จำนวนครั้งรถเขตมารับเองต่อเดือน
- Estimated vs Actual
- Weight/area utilization
- Route/เหตุผลที่รถคลังส่งหรือให้เขตรับ
- Plan delivery success/adjustment

## 20. Transport Planning — CONFIRMED DESIGN

### 20.1 Objective

- ใช้ Final Approved Plan จัดรอบรายวัน/สัปดาห์
- รถคลังคลองเตย 2 คันไปจ่ายเขตที่เหมาะสม
- ส่วนที่เหลือให้รถเขตมารับเพื่อลดต้นทุน
- แสดงเหตุผลของ Assignment/Unserved stop
- เก็บ Estimated และ Actual พร้อมเส้นทางจริงเดิม
- ใช้กฎการปฏิบัติงานเดิมจาก Source/ไฟล์อ้างอิงจนกว่าจะยืนยัน Master ใหม่

### 20.2 Vehicle Baseline

| รถ | ขนาดใช้งานที่ให้มา |
|---|---|
| พด.707 | กว้าง 2.45 ม. × ยาว 5.20 ม. |
| พด.708 | กว้าง 2.40 ม. × ยาว 5.10 ม. |

- น้ำหนักใช้งานจริงเฉลี่ยประมาณ 6 ตัน แต่ยังไม่ใช่ Legal/Safety certified limit
- ความสูงข้างกระบะประมาณ 0.50 ม.
- เปิดด้านข้าง 2 ข้างและกระบะเปิดสูงครึ่งเดียว
- ไม่ควรมีของยื่น
- ไม่มีอุปกรณ์ยก
- ซ้อนยาก จึง Default One Layer + Manual Review
- Long Material ต้องตรวจขนาดจริงเทียบกระบะ ห้าม Auto-load จาก Dummy dimension

### 20.3 Routing Inputs ที่ยังต้องมี

- Verified district coordinates/time window/service time
- Material dimension/weight/stackability
- Vehicle legal payload/capacity
- Driver availability
- Approved Plan
- Fuel/toll/route actual mapping

## 21. Roles และ Responsibilities — CONFIRMED

| Role | สิทธิ์และหน้าที่ |
|---|---|
| Admin | Users, Roles, Master Data, Warehouse, Source, Environment, expansion |
| Planner คลังคลองเตย | Calculation, Review, District follow-up, Planner approval, FIFO instruction |
| Transport Planner | เป็นคนเดียวกับ Planner คลังคลองเตยในปัจจุบัน |
| นักวิชาการ | Final second approval และ Special Approval |
| Warehouse Picker/Outsource | Planner สั่ง Outsource ให้หยิบ; บันทึกผลตามสิทธิ์ |
| District User | ผู้ใช้ 1 คนต่อเขต ยืนยัน/ปฏิเสธ/เพิ่ม/ขอปรับของเขตตนเอง |
| Viewer/Management | Read-only Dashboard/KPI/Report |

Security requirements:

- Authentication จริงก่อนเข้าข้อมูลธุรกิจ
- Role-based Navigation
- Row-level district scope
- Browser ห้ามมี Database/service-role credential
- Change/Approval/Movement มี Actor/Time/Audit

## 22. Database Architecture และ Current Delivery

### 22.1 Stack

- PostgreSQL
- Drizzle ORM
- Next.js 16 / React 19 / TypeScript
- 4 protected data schemas: `raw`, `core`, `ops`, `audit`
- Analytics view schema: `analytics`

### 22.2 Foundation 18 Tables — PUSHED BASELINE

Raw/Import:

- `raw.import_batches`
- `raw.source_rows`

Core/Master/Stock/Contract/Pallet:

- `core.districts`
- `core.locations`
- `core.materials`
- `core.stock_snapshots`
- `core.usage_observations`
- `core.vendor_aliases`
- `core.contracts`
- `core.contract_items`
- `core.contract_item_versions`
- `core.receipt_lots`
- `core.handling_units`
- `core.packaging_profiles`
- `core.inventory_movements`

Operations/Audit:

- `ops.calculation_policies`
- `ops.import_issues`
- `audit.change_log`

### 22.3 Decision Intelligence 6 Tables — IMPLEMENTED LOCAL

- `ops.replenishment_plans`
- `ops.replenishment_plan_items`
- `ops.quantity_recommendations`
- `ops.district_change_requests`
- `ops.plan_approvals`
- `ops.fifo_allocations`

Current Source Code total: **24 tables**

### 22.4 Analytics Views

Foundation:

- `analytics.v_current_stock`
- `analytics.v_district_stock`
- `analytics.v_handling_unit_balance`
- `analytics.v_fifo_queue`
- `analytics.v_traceability_coverage`

Decision Intelligence:

- `analytics.v_issue_traceback`
- `analytics.v_quantity_suggestion_evidence`
- `analytics.v_abnormal_request_queue`

### 22.5 Database Guards

- Source rows, Inventory Movements, Recommendations, Approvals และ FIFO Allocations เป็น Append-only evidence
- Plan/Plan Item/Change Request มี Audit trigger
- ตารางสำคัญเปิด RLS foundation
- Role-specific RLS policies และ authenticated API ยังต้องทำก่อน Operational use

### 22.6 Migrations

- `0000_famous_talos.sql`: 18 foundation tables
- `0001_staging_baseline_views_and_guards.sql`: Business Rules v1, views, audit/append-only, RLS foundation
- `0002_wise_jamie_braddock.sql`: 6 plan/recommendation/request/approval/allocation tables + 3 decision views/guards
- **ยังไม่ได้ Apply Migration ใดกับ Dedicated Online Staging PostgreSQL จาก workspace นี้**
- **ยังไม่มี SAP production data ถูก Import เข้าฐานข้อมูลใหม่นี้**

## 23. Screens Implemented in Local Source

- Modern role-based Login
- Dashboard ตาม Role
- Replenishment Calculation gated by verified District Stock
- Stock/SAP/Forecast/Transport/Admin workspaces
- **Quantity Suggestions** — explainable evidence layout
- **Abnormal Request Review** — requester/reason/risk/approval form and flow
- **Issue Traceback** — end-to-end search/trace path

Truth behavior:

- UI แสดง `DATA GATED` เมื่อข้อมูลไม่ครบ
- ไม่สร้าง Recommendation/Traceback/Route จำลอง
- Form ล่าสุดเป็น Staging preview; ยังไม่เขียน Online Database/API

## 24. Source Control และ Hosting Status

### 24.1 GitHub

- Private repository: <https://github.com/Naraya2026/mea-synapse-staging>
- Branch: `main`
- Initial commit: `c88c4436e228bb52921889f51c0709a5acbbe090`
- Initial commit message: `Add MEA Synapse staging database foundation`
- Initial baseline Push สำเร็จและ `HEAD` ตรง `origin/main` ณ เวลาตรวจครั้งนั้น
- งานหลัง Initial commit ที่ยัง Local:
  - Master/Session/Decision Intelligence docs
  - 3 Decision Intelligence screens
  - Migration 0002 และ schema 24 tables
  - updated tests
- งาน Local ล่าสุดยังไม่ได้ Commit/Push

### 24.2 Vercel

- Staging URL: <https://mea-synapse-staging.vercel.app/>
- ย้าย Hosting จาก ChatGPT-hosted target มาที่ Vercel เป็นตัวใหม่แล้ว
- Decision Intelligence changes ล่าสุดยังไม่ได้ Deploy ไป URL นี้

### 24.3 Production

- ไม่มีการแก้ Production
- ไม่มี Production migration
- ไม่มี Production credential ใน repository
- การ Deploy Production ต้องเป็น Release แยก มี Approval, Backup, Rollback และ Verification

## 25. Validation Status

ผลล่าสุดบน Local Source:

- TypeScript check: ผ่าน
- Drizzle schema check: ผ่าน
- Database contract tests: ผ่าน `5/5`
- Rendered/UI contract tests: ผ่าน `2/2`
- Next.js optimized build: ผ่าน
- Secret scan ของ Initial staged baseline: ไม่พบ credential values
- Local interactive dev server ถูก environment workspace symlink จำกัด แต่ optimized build และ built HTML tests ผ่าน

ข้อควรระวัง: Tests ที่ผ่านยืนยันโครงสร้าง/Build/Contract ไม่ได้แปลว่า Online Database/API/SAP Integration ทำงานแล้ว

## 26. Modules และ Readiness Context จากเอกสารเดิม

หน้า/Module เดิม M01–M12 ถูกใช้เป็นฐานอ้างอิง โดยสถานะ UI เดิมระบุ:

- Platform, Source, Ingestion, Data Quality, Core, API, Dashboard, Operations มี delivery artifacts
- Replenishment ยังรอ verified District Stock
- Forecast history สูงสุด 12 เดือน เทียบ operational gate 14 เดือนใน UI เดิม
- Transport/Route รอ verified routing master, packaging, vehicle และ approved plan
- M11 RAG/MCP/AI excluded จาก release เดิม

เอกสาร/ตัวเลข Module เดิมไม่ใช่หลักฐานว่า Database/API ปัจจุบันออนไลน์อยู่ ต้องใช้ Current Environment verification ก่อนทุกครั้ง

## 27. Open Data และ Decisions ที่ยังต้องเติม

### 27.1 Database/Environment

- Dedicated Staging PostgreSQL URL
- Credential owner และ secret management
- Backup/restore policy
- Data retention
- Auth provider และ Role/RLS mapping
- API endpoints และ idempotency contract

### 27.2 District/Master Data

- Mapping Plant ของ 18 เขต
- Storage Location list ของแต่ละเขต
- District user identity
- District address, coordinate, time window, service time

### 27.3 Material/Packaging

- UOM
- Units per Pallet/Box/Crate
- L×W×H
- Gross weight
- Stackability
- Side-loading/Forklift requirement
- Long material constraints
- Verified vs Estimated/Dummy status

### 27.4 Contract/Vendor

- SAP Vendor field/report mapping เมื่อได้รับอนุญาต
- Vendor privacy roles
- PO Item/Installment mapping validation กับข้อมูลจริง
- Accepted date quality/duplicate handling

### 27.5 Transport

- Legal/safe payload ของ พด.707/708
- Actual fuel/toll/route file sheet/column mapping
- Fuel price source
- Driver/vehicle availability
- Route master และกฎเดิมในรูป machine-readable form

### 27.6 Operations

- Go-Live/Cutover date
- Initial Pallet verification procedure
- Pallet Card/QR/Barcode method
- District response notification channel
- SLA escalation beyond phone follow-up
- UAT users and acceptance scenarios

## 28. Recommended Delivery Sequence

1. Freeze/approve เอกสาร Master นี้เป็น Functional Baseline
2. สร้าง Dedicated PostgreSQL สำหรับ Staging เท่านั้น
3. ตั้ง `STAGING_DATABASE_URL` และ `STAGING_DB_CONFIRM=MEA_SYNAPSE_STAGING` ใน Secret Environment ห้าม Commit
4. Backup/snapshot ก่อน Migration เมื่อมีข้อมูล
5. Apply `0000` → `0001` → acceptance checks
6. Apply `0002` หลัง foundation acceptance ผ่าน
7. สร้าง authenticated RLS policies/API
8. สร้าง Import Preview/Validation สำหรับ Stock, Usage/CMP, Contract
9. Mapping 18 Districts และ Material/Contract ด้วยข้อมูลปกปิด
10. ทำ Weekly Plan/Confirmation/Approval API
11. ทำ Explainable Recommendation และ Risk Rules แบบ Rule-based ก่อน AI/ML
12. ทำ FIFO Allocation + Pallet/Remain + Picking/Issue Movement
13. ทำ Forward/Reverse Traceback UAT
14. ทำ Ad-hoc Issue
15. ทำ Transport Planning/Actual/Cost Dashboard
16. UAT ตาม Role และ Security
17. Commit/Push/Deploy เฉพาะ Staging
18. Production Release เป็นโครงการแยกหลัง Staging acceptance

## 29. Required UAT Scenarios

### 29.1 Stock/CMP

- Unrestricted only
- Transfer excluded
- Missing Material = 0 + flag
- `-` usage = 0
- CMP zero behavior
- District sum across all Storage Locations

### 29.2 Plan/Approval

- Trigger ≤3.5M
- MIN 4M/MAX 6M
- >6M warning
- >9M special approval
- District accepts/rejects/adds/changes
- Missing response + Planner phone record
- Planner before Academic
- Lock/change/cancel/release reserve

### 29.3 FIFO/Pallet

- Oldest accepted date first
- PO/PO Item/Installment tie-break
- Use opened Remain before next Pallet
- Partial Pallet remain calculation
- Return to original Handling Unit
- Quarantine damaged return
- SAP vs Handling Unit reconciliation

### 29.4 Traceback/Recall

- District Issue → Vendor/Contract/Lot/Pallet
- Vendor/Contract/Lot/Pallet → all District Issues
- Show Unknown for pre-Go-Live opening stock
- Vendor masking by Role

### 29.5 Recommendation/Risk

- History evidence shown
- Low sample/data stale gate
- Override with reason
- Above Median/P90 warning
- CMP 0 + high request
- >6M warning, >9M special approval
- Requester and approvals retained

### 29.6 Transport

- 2 vehicle capacity/size
- No overhang/no lift/one-layer review
- District pickup alternative
- Estimated vs Actual fuel/toll/trips

## 30. Non-Negotiable Safety and Truth Rules

1. ห้ามแก้ Production
2. ห้ามใช้ Staging migration กับ Production
3. ห้าม Commit secrets/vendor-sensitive data
4. ห้ามสร้าง Stock, AI suggestion, Traceback, Route หรือ Actual ปลอม
5. Dummy data ต้องติดป้ายชัดเจนและห้ามอนุมัติการปฏิบัติงานจริงอัตโนมัติ
6. ห้ามลบ/แก้ Movement, Recommendation, Approval, Allocation evidence ย้อนหลัง
7. Plan/Rule ทุกผลต้องผูก Version และ Source Batch
8. District scope และ Vendor privacy ต้องบังคับที่ API/RLS ไม่ใช่ซ่อนด้วย UI อย่างเดียว
9. การเปลี่ยน Business Rules v1 ต้องออก version ใหม่
10. Production rollout ต้องมี Approval, Backup, Rollback Plan, Security Test และ Release Verification แยกต่างหาก

## 31. Final Current-State Statement

ณ วันที่ 22 กรกฎาคม 2026:

- Business Rules v1 ถูก Freeze แล้ว
- Initial Staging foundation ถูก Push ไป Private GitHub แล้ว
- Vercel Staging มีเว็บไซต์ baseline อยู่แล้ว
- Source Code บนเครื่องมี UI/Schema/Migration สำหรับ Traceback, Quantity Suggestions และ Abnormal Request Review เพิ่มแล้ว
- Local Source รวม 24 ตารางและผ่าน Build/Contract tests
- Dedicated Online Staging Database, Import Pipeline, API, RLS policies, Operational AI/Recommendation, Pallet Movement หลัง Go-Live และ Transport Actual integration **ยังไม่เปิดใช้งานจริง**
- การเปลี่ยนแปลงล่าสุดยังไม่ Commit/Push/Deploy
- Production ไม่ถูกแก้ไข
