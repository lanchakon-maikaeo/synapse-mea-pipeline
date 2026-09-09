# SYNAPSE Chat PoC — แผนแยกโมดูลสำหรับ Codex

> **สถานะปัจจุบัน 9 กันยายน 2026:** ใช้ POC 2 / Gemini และ Database Agent v4 ใน production code path ดู [P06 — Notebook → production](P06-notebook-production.md) และ [STATE](STATE.md) งาน v4 อยู่ใน local worktree ยังไม่ push/deploy ส่วนรายละเอียด P00–P05 ด้านล่างเป็นแผน **POC 1 เดิม** ไม่ใช่ข้อจำกัดของ Agent ปัจจุบัน

ชื่ออ้างอิง: **POC 1** — Qwen/vLLM แบบ self-host; ทางเลือกใช้ Commercial LLM API อยู่ใน [POC 2](../POC2_COMMERCIAL_API.md) ทั้งสองแผนมีหน้าแชทในเว็บแอป และใช้ฐานข้อมูล/สิทธิ์/ห้า tools ร่วมกัน ส่วน `P02` ด้านล่างเป็นชื่อโมดูล Backend Tools ไม่ใช่ POC 2

จัดทำ 8 กันยายน 2026 | สถานะ: แผนงาน ยังไม่ได้ implement/deploy

**เริ่มบน Supabase Test ที่ยืนยันตัวตนโครงการแล้ว ใช้ Next.js/API เดิม และเพิ่ม Qwen เฉพาะแปลงคำถามเป็น tool** คำตอบ V1 ใช้ตาราง/ข้อความมาตรฐานจากผลฐานข้อมูล เรียก LLM หนึ่งครั้งต่อคำถาม; ปุ่มอนุมัติและจ่ายของยังอยู่ใน workflow เดิม

แผนนี้ยึด VMI repo ปัจจุบันและ [ผลประเมิน](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/PIPELINE_AND_SECURE_CHAT_REVIEW_2026-09-08.md>) เฉพาะส่วนที่เกี่ยวกับ VMI โดยตรวจ migrations/API ปัจจุบันเป็นหลัก ไม่ใช้ schema หรือ use case จากธุรกิจอื่น

| ลำดับ | โมดูล | ผลงานที่ต้องได้ | เกณฑ์จบหลัก |
|---|---|---|---|
| 0 | [P00 — Scope/Contract](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/poc/P00-contract.md>) | ยืนยัน Supabase Test, 5 tools, ข้อมูล/สิทธิ์/คำถามอ้างอิง | รู้ว่าแต่ละคำถามอ่านข้อมูลใดและใครอ่านได้ |
| 1 | [P01 — Supabase](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/poc/P01-supabase.md>) | Read contracts, RLS/grants, test fixtures, audit storage | อ่านด้วย JWT ผู้ใช้จริงบน Test; ข้ามเขต/เรียกตรงไม่เกินสิทธิ์ |
| 2 | [P02 — Backend Tools](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/poc/P02-tools.md>) | Validator, fixed tool dispatch, result envelope, audit | เรียก 5 tools กับ Supabase ได้โดยยังไม่ต้องใช้ LLM |
| 3 | [P03 — Qwen](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/poc/P03-qwen.md>) | Qwen3-8B/vLLM adapter + constrained JSON + budgets | คำถามภาษาไทย → tool → Supabase จริง; timeout หยุดถูกต้อง |
| 4 | [P04 — Chat UI](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/poc/P04-ui.md>) | หน้า Chat ภายใต้ Auth เดิม พร้อมตัวเลข/หน่วย/วันข้อมูล | ผู้ใช้ถามและตรวจที่มาคำตอบได้; ไม่เปลี่ยน workflow หลัก |
| 5 | [P05 — Acceptance](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/poc/P05-acceptance.md>) | ชุดประเมิน held-out, security/E2E, runbook | มีหลักฐานผ่านทั้ง local และ Supabase Test + Qwen endpoint |

ทำตามลำดับ `P00 → P01 → P02 → P03 → P04 → P05` ก่อนเริ่ม P03 ต้องพิสูจน์ backend+DB ได้แล้ว เพื่อแยกปัญหาข้อมูล/สิทธิ์ออกจากพฤติกรรมโมเดล ความพร้อมของ Supabase และ endpoint เป็น dependency จริง ไม่ใช้ mock แทนหลักฐาน live

**Scope V1**

**ขอบเขตธุรกิจตายตัว:** คลังคลองเตย Plant `2401` / Storage Location `0001`, วัสดุ VMI ตาม master จริง, เขตตามสิทธิ์ผู้ใช้, Stock ประเภท Unrestricted, CMP/แผนเติมของรายสัปดาห์ตาม Business Rules v1, สัญญา/PO และการสอบกลับ Lot/HU/Issue ที่มีหลักฐาน ห้ามนำข้อมูลผู้ใช้ไฟ มิเตอร์ kWh บิล ค่าไฟ หรือ customer profile จากเอกสารตัวอย่างเข้ามา

5 tools: `get_stock_status`, `get_replenishment_recommendation`, `get_plan_status`, `get_contract_status`, `get_traceability` ครอบคลุม 20 intent (4 ต่อ tool) เริ่มในขอบเขตคลองเตย + เขตที่ได้รับอนุญาต ใช้ข้อมูลที่พร้อมจริงและ fixtures ที่ระบุว่า Test

ยังไม่รวม RAG/embeddings, arbitrary SQL, generic file/Python tools, agent loop, multi-agent, fine-tuning, forecast activation, route optimization, SSO migration และการเปลี่ยน Business Rules งานเหล่านี้เพิ่มเมื่อผลทดสอบชี้ความต้องการ

**วิธีใช้ Codex ให้ประหยัด token**

- ให้ทำครั้งละหนึ่งโมดูล ส่งชื่อไฟล์แทนการวางแผนทั้งหมดใน prompt เริ่มอ่านเพียง CONTEXT + STATE + module card แล้วตาม entry points/callers ที่จำเป็น
- สรุปสิ่งที่ตกลงไว้ใน [CONTEXT](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/poc/CONTEXT.md>) และผลล่าสุดใน [STATE](</Users/lanchakon-maikaeo/Library/CloudStorage/GoogleDrive-synapse.mea@gmail.com/My Drive/Project-Synapse/LLM/poc/STATE.md>) ไม่คัดลอก PDF/SQL/log ทั้งชุดเข้าแชต
- ใช้ task เดิมแก้ปัญหาในโมดูลเดียวกัน; ถ้า task ยาวและเปลี่ยนโมดูลแล้ว จะเปิด task ใหม่ก็ได้ โดยส่งไฟล์ handoff แทนประวัติทั้งหมด ไม่จำเป็นต้องแยกทุกข้อย่อย
- ให้ Codex ค้นแบบเจาะจงด้วย rg แล้วอ่าน implementation และ callers ให้พอ ไม่อ่านทั้ง repository และไม่ข้ามความเข้าใจเพื่อประหยัด token
- รัน targeted tests หลังแก้แต่ละโมดูล; เก็บ output เต็มในหลักฐานที่ลบ secrets แล้ว ส่งกลับเฉพาะสรุป/ข้อผิดพลาด รัน gate ครบตอน P05 และเมื่อการเปลี่ยนแปลงกระทบส่วนอื่นจริง
- คง model ปัจจุบันก่อน ไม่เพิ่ม subagents หรือสลับหลายโมเดลอัตโนมัติ การลดบริบทซ้ำเป็นแนวทางประหยัดในแผนนี้ ไม่ใช่การรับประกันลด token กี่เปอร์เซ็นต์
- ห้ามลดการทดสอบ JWT/RLS/ข้อมูลตัวเลข/ข้อผิดพลาดเพื่อประหยัด token ใช้เกณฑ์ผ่านจริงเป็นจุดจบ ไม่สั่ง review ซ้ำหลังผ่านโดยไม่มีเหตุใหม่

แนวทางให้เป้าหมาย ไฟล์ที่เกี่ยวข้อง ขอบเขต และการตรวจที่ชัดเจนสอดคล้องกับ [OpenAI Prompting guidance](https://learn.chatgpt.com/docs/prompting) ส่วนการแบ่ง cards/STATE เป็นรูปแบบ handoff ที่ออกแบบให้โปรเจกต์นี้

**Prompt เริ่ม P00 — คัดลอกใช้ได้**

```text
ทำ P00 ตาม LLM/poc/P00-contract.md
เริ่มอ่าน LLM/poc/CONTEXT.md และ LLM/poc/STATE.md แล้วตาม source ที่ card ระบุ
ใช้โค้ดปัจจุบันเป็นหลัก อ่าน dependency/callers ที่จำเป็น ไม่โหลด PDF/รายงานทั้งหมดซ้ำ
ทำให้ครบ acceptance ของ P00 เท่านั้น อัปเดต STATE และสรุปไฟล์ที่เปลี่ยน/ผลตรวจ/ข้อค้างสั้น ๆ
```

Prompt โมดูลถัดไป: เปลี่ยน `P00` และชื่อไฟล์เป็นโมดูลที่ต้องการ ไม่จำเป็นต้องส่ง README นี้ซ้ำ

**การส่งมอบและสถานะ**

ทุกโมดูลบันทึก `status | changed paths | exact checks/results | environment/ref | blocker | next module` ใน STATE แบบสั้น พร้อมลิงก์หลักฐาน ห้ามใส่ secrets/JWT/ข้อมูลส่วนบุคคล

`planned` = ยังไม่ได้ทำ, `in_progress` = กำลังทำ, `local_verified` = ผ่านเฉพาะ local, `test_verified` = ผ่านกับ Supabase Test จริง, `done` = ผ่านทุก acceptance ของโมดูลแล้ว สถานะไม่แปลว่า deploy Production

เป้าหมายแรกคือจบ P02 ให้ DB+tools ถูกต้องก่อนใช้งบ inference เป้าหมายสุดท้ายคือจบ P05 จึงเรียกว่า PoC พร้อมสาธิต การตั้งค่าแผนนี้ยังไม่ได้สร้าง Supabase project หรือใช้บริการ GPU ที่มีค่าใช้จ่าย
