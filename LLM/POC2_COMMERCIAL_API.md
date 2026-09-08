# POC 2 — Web chat ผ่าน Commercial LLM API

วันที่: 8 กันยายน 2026 | สถานะ: implemented — local และ Supabase Test ผ่าน; รอผู้ใช้เติม Gemini API key เพื่อทดสอบ live inference

POC 2 คือทางเลือกของ SYNAPSE VMI chat ที่ใช้ API โมเดลซึ่งผู้ให้บริการดูแล inference ให้ ไม่ต้อง self-host Qwen/vLLM หรือจัดหา GPU เอง ใช้หน้าเว็บ Next.js และ Supabase Auth/Database เดิม เป้าหมายคือผู้ใช้ถามข้อมูลสต็อก การเติมวัสดุ แผน สัญญา และการสอบกลับตามสิทธิ์ของตน

ในเอกสารนี้ **POC 1** หมายถึงแผนเดิมใน [poc/README.md](poc/README.md) ส่วน **P02** หมายถึงโมดูล Backend Tools ของแผนเดิม ไม่ใช่ POC 2 แผนนี้ไม่เปลี่ยนสถานะความสำเร็จของ POC 1

## ความแตกต่าง

| ประเด็น | POC 1 — แผนเดิม | POC 2 — แผนนี้ |
|---|---|---|
| ช่องทางใช้งาน | หน้า Chat ใน Next.js dashboard | หน้า Chat ใน Next.js dashboard เดิม |
| โมเดล | Qwen3-8B ผ่าน vLLM-compatible endpoint ที่ดูแลเอง | Google Gemini 3.5 Flash-Lite ผ่าน Gemini native API |
| งานดูแล inference | GPU, deployment, model revision, capacity และ startup | API credentials, model version, quotas, timeout และ provider outage |
| ค่าใช้จ่ายที่ต้องวัด | ค่าเครื่อง/GPU รวมเวลาว่างและงานดูแล | ค่า token/request ตามผู้ให้บริการ รวมคำขอที่ล้มเหลวหรือ retry |
| ขอบเขตข้อมูล | ควบคุม inference environment ได้ตาม hosting ที่เลือก | คำถามและ tool schema ส่งไปยังผู้ให้บริการภายนอก |
| ฐานข้อมูล/สิทธิ์ | Supabase Test, user JWT, สิทธิ์ตามบทบาทและเขต | ใช้สัญญาอ่านข้อมูลและสิทธิ์เดิม |
| การตอบ | LLM เลือกหนึ่ง tool; ระบบจัดคำตอบจากผล DB | คงรูปแบบเดียวกันเพื่อเทียบผลได้ |
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

ใช้ห้า tools เดิม: `get_stock_status`, `get_replenishment_recommendation`, `get_plan_status`, `get_contract_status`, `get_traceability` ตาม [สัญญาเดิม](poc/CONTEXT.md) ไม่ใช้ Supabase management MCP เป็นช่องทางของผู้ใช้เว็บ

เวอร์ชันแรกเรียก LLM หนึ่งครั้งต่อคำถามเพื่อเลือก tool จากนั้น server อ่าน DB และสร้างคำตอบเอง จึงไม่ต้องส่งผลสต็อก/สัญญาทั้งชุดกลับไปให้ provider อย่างไรก็ตามคำถามอาจมีรหัสวัสดุ PO หรือข้อมูลธุรกิจ ต้องกำหนดข้อมูลที่ส่งได้และลดข้อมูลก่อนเรียกจริง ไม่ส่ง JWT, API key, user profile หรือผล DB ไปใน prompt

หากภายหลังต้องการให้ LLM เรียบเรียงผล DB หรือวิเคราะห์หลาย tools ให้แยกเป็นการขยายขอบเขต เพราะเปลี่ยนทั้งจำนวน API calls ค่าใช้จ่าย ข้อมูลที่ออกจากระบบ และเกณฑ์ตรวจคำตอบ

## งานตามลำดับ

1. ตรวจสถานะและ target จาก [STATE](poc/STATE.md): บันทึกปัจจุบันระบุ P00/P01 done บน Supabase Test; P02–P05 ยัง planned ใช้ fixtures ที่มีป้าย Test และตรวจสิทธิ์ใหม่เมื่อเชื่อมระบบ ไม่คัดลอก Production มาใช้โดยอัตโนมัติ
2. ทำ [P02 Backend Tools](poc/P02-tools.md) ให้ครบ: validators, fixed dispatch, result envelope, คำตอบมาตรฐาน, rate limit และ audit ใช้ Next.js เดิม ไม่เพิ่ม backend หรือ agent framework อีกชุด
3. ทำ Gemini native adapter แทนข้อกำหนด Qwen/vLLM ใน P03 โดยใช้ `gemini-3.5-flash-lite` และ function calling แบบ `ANY`; server ตรวจชื่อ tool และ arguments ซ้ำทุกครั้ง
4. ทำ [P04 Web Chat](poc/P04-ui.md) โดยเปลี่ยน dependency จาก Qwen เป็น commercial adapter: loading/cancel/error, คำถามกำกวม, วันข้อมูลจริง และล้างประวัติเมื่อเปลี่ยนผู้ใช้
5. ใช้ [P05 Acceptance](poc/P05-acceptance.md) โดยทดสอบกับ commercial endpoint จริงและ Supabase Test เก็บ provider/model/prompt/schema/dataset/Git version, token, p50/p95 latency และค่าใช้จ่ายต่อคำตอบสำเร็จ

เลือก provider/model แล้วเป็น Google Gemini / `gemini-3.5-flash-lite` ซึ่งเป็นรุ่น stable ที่รองรับ thinking, function calling และ structured output งานนี้ให้โมเดลเลือก tool ครั้งเดียวเท่านั้น ส่วนตัวเลขธุรกิจอ่านจาก Supabase และจัดคำตอบแบบ deterministic ฝั่ง server ผู้ใช้จะเติม API key ภายหลัง จึงยังไม่ถือว่าผ่าน live acceptance

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

ยังต้องกำหนด budget/retention ที่บัญชี Google และรัน P05 live acceptance หลังเติม API key ก่อนใช้กับ Production
