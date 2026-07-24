# Data Coverage and Limitations

## นำเข้าเป็นข้อมูลใช้งานได้

### Stock

- Source: `Stock.xlsx` / `update-stock`
- ใช้ `ไม่จำกัด`
- ไม่รวม `การส่ง/การโอน`
- เก็บทุก Plant + Storage Location
- District Stock รวมทุก Storage Location ของ Plant เขตผ่าน Analytics View

### Usage และ CMP

- Source: `อัตราการใช้งาน.xlsx` / `Check CMP`
- นำเข้า 18 Plant เขต
- `-` ถูกเก็บเป็น `0` พร้อม Flag `source_was_dash`
- เก็บ Monthly Usage 12 เดือน
- เก็บ LY, 12M, 6M, 4M และ CMP ที่คำนวณตาม Business Rules v1

### Contract/FIFO Reference

- Source: `รวมสัญญา.xlsx` / `รวมสัญญา`
- นำเข้าเฉพาะแถวที่มี Material, PO และจำนวนมากกว่า 0
- FIFO date = `วันผ่านตรวจรับ`
- `รายการที่` ใช้เป็น PO Item/Installment ตามข้อตกลงปัจจุบัน
- ไม่เปิดเผยผู้ขายจริง ใช้ Dummy Vendor
- เก็บ Raw JSON และ Checksum สำหรับสอบกลับ Source Row

## ข้อมูลที่ไม่มี source evidence และจะไม่สร้างขึ้น

### Pallet ID, Remain และ Handling Unit

ยังไม่มีข้อมูล Opening Balance รายพาเลทที่ยืนยันได้ จึงไม่สร้างข้อมูลปลอมใน:

- `core.receipt_lots`
- `core.handling_units`
- `core.inventory_movements`
- `ops.fifo_allocations`

ตารางเหล่านี้พร้อมรองรับเมื่อมี Physical Count/Opening Balance ที่อนุมัติ
แต่ Production cutover ครั้งนี้จะไม่สร้างยอดดังกล่าวขึ้นเอง

### Transportation และค่าใช้จ่าย

ข้อมูลประวัติอยู่ใน `คลังคลองเตย (1).xlsx` และแนบไว้ใน `source_files/`
ฐานข้อมูลเวอร์ชันนี้ยังไม่มีตาราง Transport Cost/Fuel/Toll/Trip Actual ครบถ้วน
จึงยังไม่ควรนำข้อมูลดังกล่าวยัดลงตารางอื่นที่ความหมายไม่ตรงกัน

### Website

Web app หลักอยู่ใน `dashboard/` ของ repository และใช้ Supabase ผ่าน
server-side API route เท่านั้น Service role ห้ามส่งไป browser

## Owner-attested zero completion

เจ้าของโครงการยืนยันว่า source ทั้งสี่ไฟล์ครบสำหรับขอบเขตที่ประกาศแล้ว
ดังนั้นคู่ active VMI × district/warehouse ที่ไม่ปรากฏใน exhaustive source
ถูกตีความเป็นศูนย์ และต้องมี lineage เป็น `owner_attested_zero`
แยกจาก `source_observed` อย่างชัดเจน
