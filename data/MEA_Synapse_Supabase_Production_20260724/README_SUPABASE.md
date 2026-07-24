# Supabase Production handoff

Target project: `synapse-01` (`fvdfduuanfrncrwuareb`)

นำ migration จาก repository หลักขึ้นตามลำดับ แล้วใช้
`synapse-pipeline import-actual-workbooks` ตาม `START_HERE.md`

ตัว import ตรวจ checksum ของ Excel ต้นฉบับ, บันทึก raw rows, normalize ไปยัง
relational staging, promote เข้า Core, สร้าง relation edges และบันทึก
owner-attested zero evidence สำหรับคู่ที่ไม่ปรากฏใน exhaustive source

หลัง import ต้องตรวจ:

- `analytics.v_source_observation_coverage`
- `analytics.v_production_readiness`
- `analytics.v_stock_health`
- `/api/health`
- `/api/health/ready`

Service role และ database password เป็น secret และห้าม commit ลง Git
