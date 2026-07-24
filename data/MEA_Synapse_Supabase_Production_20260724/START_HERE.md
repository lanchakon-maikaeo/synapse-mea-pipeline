# MEA Synapse — Production data package

แพ็กเกจนี้เป็นชุดข้อมูล Production ที่เจ้าของโครงการอนุมัติสำหรับ Supabase
project `fvdfduuanfrncrwuareb` เท่านั้น

## Source of truth

Excel ต้นฉบับ 4 ไฟล์อยู่ใน `source_files/` และมี SHA-256 กำกับใน
`PACKAGE_MANIFEST.json`

- `Stock.xlsx`
- `อัตราการใช้งาน.xlsx`
- `คลังคลองเตย (1).xlsx`
- `รวมสัญญา.xlsx`

## กติกา Production

- Stock ใช้ `ไม่จำกัด` และไม่รวม `การส่ง/การโอน`
- CMP คำนวณด้วย `ROUND(AVERAGE(LY, 12M, 6M, 4M), 0)`
- ค่า dash ในประวัติ usage แปลงเป็นศูนย์พร้อมเก็บ lineage
- ภายใน active VMI × 18 districts แถวที่ไม่ปรากฏใน exhaustive source
  หมายถึงศูนย์ตาม owner attestation
- ศูนย์จาก omission ต้องติดป้าย `owner_attested_zero` ไม่ใช่
  `source_observed`
- ไม่สร้าง pallet, supplier, receipt lot หรือยอดอื่นที่ไม่มีหลักฐาน

## Import

ใช้ importer หลักจาก repository root:

```bash
synapse-pipeline import-actual-workbooks \
  --data-dir data \
  --attested-by "synapse.mea project owner" \
  --attestation-text "Owner confirms the four checksummed workbooks are complete for the declared Production scope; exhaustive source omission means zero." \
  --change-ticket "SYNAPSE-PROD-20260724" \
  --confirm-actual-data \
  --confirm-production-attestation
```

คำสั่งนี้ทำ Raw → Staging → Core → Relation lineage และ Production
completion evidence โดย database RPC จำกัดสิทธิ์ไว้ที่ service role
