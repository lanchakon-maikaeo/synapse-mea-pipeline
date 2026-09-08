# POC 2 — Web chat ผ่าน Commercial LLM API

วันที่: 8 กันยายน 2026 | สถานะ: Harness v2 implemented — build/60 tests และ Test SQL 11 assertions ผ่าน; live acceptance แยกจาก scripted tests

POC 2 คือทางเลือกของ SYNAPSE VMI chat ที่ใช้ API โมเดลซึ่งผู้ให้บริการดูแล inference ให้ ไม่ต้อง self-host Qwen/vLLM หรือจัดหา GPU เอง ใช้หน้าเว็บ Next.js และ Supabase Auth/Database เดิม เป้าหมายคือผู้ใช้ถามข้อมูลสต็อก การเติมวัสดุ แผน สัญญา และการสอบกลับตามสิทธิ์ของตน

ในเอกสารนี้ **POC 1** หมายถึงแผนเดิมใน [poc/README.md](poc/README.md) ส่วน **P02** หมายถึงโมดูล Backend Tools ของแผนเดิม ไม่ใช่ POC 2 แผนนี้ไม่เปลี่ยนสถานะความสำเร็จของ POC 1

## ความแตกต่าง

| ประเด็น | POC 1 — แผนเดิม | POC 2 — แผนนี้ |
|---|---|---|
| ช่องทางใช้งาน | หน้า Chat ใน Next.js dashboard | หน้า Chat ใน Next.js dashboard เดิม |
| โมเดล | Qwen3-8B ผ่าน vLLM-compatible endpoint ที่ดูแลเอง | Google Gemini 3.5 Flash-Lite ผ่าน Gemini native API |
| งานดูแล inference | GPU, deployment, model revision, capacity และ startup | API credentials, model version, quotas, timeout และ provider outage |
| ค่าใช้จ่ายที่ต้องวัด | ค่าเครื่อง/GPU รวมเวลาว่างและงานดูแล | ค่า token/request ตามผู้ให้บริการ รวมคำขอที่ล้มเหลวหรือ retry |
| ขอบเขตข้อมูล | ควบคุม inference environment ได้ตาม hosting ที่เลือก | คำถาม ประวัติจำกัด และผลอ่าน DB ตามสิทธิ์ส่งไปยัง Gemini เพื่อเลือกขั้นถัดไป |
| ฐานข้อมูล/สิทธิ์ | Supabase Test, user JWT, สิทธิ์ตามบทบาทและเขต | ใช้สิทธิ์เดิม; dev ใช้ฐานข้อมูลเดียวกับ main ตามคำยืนยันผู้ใช้ |
| การตอบ | LLM เลือกหนึ่ง tool; ระบบจัดคำตอบจากผล DB | อ่านได้สูงสุด 3 tools ต่อคำถามและส่งผลกลับให้โมเดล; server จัดตัวเลขจาก DB |
| งานที่นำกลับมาใช้ | P00–P01 ที่เสร็จแล้ว; P02/P04/P05 ตามแผน | นำ P00–P01 มาใช้หลังตรวจ target; ทำ P02 ร่วมกัน; ปรับ P03 และ acceptance ของ P04/P05 ให้ใช้ commercial endpoint |

คาดว่าจะลดงานตั้งค่าและดูแล inference แต่ยังสรุปไม่ได้ว่าเร็วกว่า แม่นกว่าหรือถูกกว่า จนกว่าจะวัดกับคำถามและเงื่อนไขเดียวกัน

## Pipeline

```text
Web Chat → Next.js server ตรวจ JWT/profile/scope และจำกัดคำขอ
         → Commercial LLM API: คำถาม → tool + arguments / clarify / unsupported
         → Backend ตรวจ schema และ dispatch เฉพาะ tool ที่กำหนด
         → Supabase vmi_chat_read ด้วย JWT ผู้ใช้
         → ตรวจผลและจัดคำตอบจากค่าฐานข้อมูล พร้อมหน่วย/วันที่/แหล่งข้อมูล
         → Web Chat + audit metadata
```

ใช้ห้า tools เดิมและเพิ่ม `get_operations_overview` สำหรับค้นเขตที่สต็อกต่ำและคิวแนะนำจัดส่ง; `finish`, `clarify`, `unsupported` เป็นตัวควบคุม ไม่ใช่คำสั่งฐานข้อมูล

Harness v2 ตรวจ arguments ก่อนอ่านด้วย JWT ผู้ใช้ ส่งผลอ่านที่จำกัดขนาดกลับให้ Gemini เลือกขั้นต่อไป และจัดคำตอบจากค่าฐานข้อมูลโดยตรง จำกัด 3 reads / 4 model calls / 90 วินาที / ประวัติ 6 ข้อความ หยุดการเรียกซ้ำและแสดง partial เมื่อไม่ครบ ไม่ส่ง API key หรือ JWT ใน prompt; header API key ใช้ยืนยันกับ Google ตามปกติ

ฐานข้อมูล dev เปลี่ยนเป็น `synapse-01` (`fvdfduuanfrncrwuareb`) ตามที่ผู้ใช้ยืนยันให้ใช้บัญชีและข้อมูลเดียวกับ main การขยาย Agent ทำให้ผลอ่านข้อมูลธุรกิจถูกส่งไปยัง commercial provider ด้วย ดูที่มาจาก SPAI และงานวิจัยใน [SPAI_APPLICATION.md](SPAI_APPLICATION.md)

## งานตามลำดับ

1. ตรวจสถานะและ target จาก [STATE](poc/STATE.md): ตรวจบน Test fixtures ก่อน; dev เชื่อมฐานข้อมูล main ตามคำยืนยันผู้ใช้แล้ว
2. ทำ [P02 Backend Tools](poc/P02-tools.md) ให้ครบ: validators, fixed dispatch, result envelope, คำตอบมาตรฐาน, rate limit และ audit ใช้ Next.js เดิม ไม่เพิ่ม backend หรือ agent framework อีกชุด
3. ทำ Gemini native adapter แทนข้อกำหนด Qwen/vLLM ใน P03 โดยใช้ `gemini-3.5-flash-lite` และ function calling แบบ `ANY`; server ตรวจชื่อ tool และ arguments ซ้ำทุกครั้ง
4. ทำ [P04 Web Chat](poc/P04-ui.md) โดยเปลี่ยน dependency จาก Qwen เป็น commercial adapter: loading/cancel/error, คำถามกำกวม, วันข้อมูลจริง และล้างประวัติเมื่อเปลี่ยนผู้ใช้
5. ใช้ [P05 Acceptance](poc/P05-acceptance.md) โดยทดสอบกับ commercial endpoint จริงและ Supabase Test เก็บ provider/model/prompt/schema/dataset/Git version, token, p50/p95 latency และค่าใช้จ่ายต่อคำตอบสำเร็จ

ค่าเริ่มต้นเป็น Google Gemini / `gemini-3.5-flash-lite`; model/API key/temperature เปลี่ยนได้ การทดสอบ scripted harness ไม่ถือว่าเป็น live model acceptance

ตั้งค่าที่ server environment ของ Next.js: `LLM_API_URL`, `LLM_API_KEY` หรือ `GEMINI_API_KEY`, `LLM_MODEL`, `LLM_TEMPERATURE` และ `LLM_TIMEOUT_MS` ห้ามใช้ prefix `NEXT_PUBLIC_*` กับ API key การเปลี่ยนค่ามีผลหลัง redeploy ระบบจำกัด input/output token และ 10 คำขอต่อผู้ใช้ต่อนาที ตรวจ timeout/429/5xx/invalid output และไม่ retry คำขอที่มีค่าใช้จ่ายอัตโนมัติ

## เกณฑ์จบและการเทียบ

- ใช้ชุด 20 development cases และ 80 held-out functional cases ตาม P05; เป้าหมาย tool+arguments accuracy อย่างน้อย 95% พร้อมผลราย tool ตามเกณฑ์เดิม
- ทุกตัวเลข หน่วย ขอบเขต และวันที่ในคำตอบตรงผล DB; ไม่มีการเปิดเผยข้อมูลเกินสิทธิ์ใน security cases; ไม่มี business writes จาก chat
- ผ่าน flow จริง browser → server → provider → tools → Supabase → answer/audit พร้อมทดสอบ provider failure, budget/rate limit และการเปลี่ยนผู้ใช้
- เทียบ POC 1 และ POC 2 เมื่อมีผลจริงของทั้งคู่เท่านั้น ด้วย dataset, tools, prompt intent และ concurrency เดียวกัน แยกค่า API/เครื่องออกจากแรงงานดูแล ไม่อ้างว่า POC 1 มี baseline แล้ว
- POC 2 ไม่ต้องรอ self-host endpoint ของ POC 1 แต่ยังต้องผ่าน DB/tools/UI/security gates ร่วมกัน การเสร็จ PoC ไม่หมายถึง deploy Production

## เอกสาร API ที่ตรวจประกอบแผน

- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite): รุ่น stable สำหรับงาน agent ปริมาณสูง รองรับ thinking และ function calling
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling): โหมด `ANY` บังคับให้โมเดลเลือก function และทำตาม schema
- [Gemini GenerateContent API](https://ai.google.dev/api/generate-content): endpoint, `systemInstruction`, tool declarations และ generation config ที่ adapter ใช้

P05 ชุด held-out และสถิติ latency/cost ยังเป็น acceptance แยกต่างหาก; การผ่าน unit tests หรือ smoke test ไม่ใช่ผล benchmark
