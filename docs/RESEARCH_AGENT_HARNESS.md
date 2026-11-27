# เทคนิค Agent Harness ที่ควรนำมาใช้กับ data-question agent (v6)

วันที่สำรวจ: 2026-11-26 · ขอบเขต: control loop, tool interface, guard, self-correction และ retrieval รอบ LLM
วิธี: อ่านจากแหล่งต้นทางเท่านั้น (paper บน arXiv/ACL/SIGIR, เอกสารทางการ, source/docs ของ framework) ไม่ใช้บล็อกสรุป ตัวเลขทุกตัวมาจากตารางหรือส่วนของ paper ที่ระบุ
ข้อจำกัด: ตัวเลขทั้งหมดวัดบน benchmark ภาษาอังกฤษและส่วนใหญ่ใช้โมเดลปิดขนาดใหญ่ (GPT-4, Gemini 1.5 Pro, o3) ผลที่ได้จึงย้ายมาใช้กับโมเดล open 30B ภาษาไทยได้ไม่ตรงตัว ต้องพิสูจน์ด้วย eval ของเราเอง

---

## TL;DR: 5 อันดับที่ควรทำต่อ

| # | เทคนิค | แก้จุดอ่อน | LLM call เพิ่ม | ที่มาหลัก |
|---|---|---|---|---|
| 1 | Value linking ก่อนเริ่ม loop + ตรวจรหัสที่ขอบ tool (poka-yoke) | เดารหัส | 0–1 | CHESS, CHASE-SQL, ReFoRCE, Anthropic ACI |
| 2 | วินิจฉัยผลว่าง/error แบบรายตัวกรอง + stuck detector เชิงความหมาย | query ซ้ำที่ fail, ยอมแพ้เร็ว | 0 | MAC-SQL, CHESS revise, OpenHands, SWE-agent |
| 3 | จัดกลุ่มตารางที่ซ้ำกันเป็น "family" พร้อมการ์ดบอกความต่าง | เลือกตารางที่เกือบซ้ำ | 0 | ReFoRCE, CHESS schema selector, Spider 2.0 |
| 4 | ขยายคำค้นข้ามภาษา: เติม alias ฝั่ง index + query variant ไทย/อังกฤษ รวมด้วย RRF | คำถามไทย vs ชื่อย่ออังกฤษ | 0–1 | Contextual Retrieval, HyDE, Query2doc, RRF |
| 5 | Dynamic few-shot จาก trajectory ที่ผ่านการตรวจแล้ว | ความแม่นยำโดยรวมของโมเดล 30B | 0 | DAIL-SQL, DSPy |

สิ่งที่ไม่แนะนำตอนนี้: CodeAct, Reflexion แบบหลายรอบ, Self-RAG/RQ-RAG (ต้อง fine-tune), multi-candidate + selector แบบ CHASE-SQL (เกินงบ 30 วินาที) และ DSPy/MIPRO แบบเต็ม (ชุดข้อมูล 23 เคสเล็กเกินไป) เหตุผลอยู่ในหัวข้อ 6

---

## 0. จับคู่จุดอ่อนกับหลักฐาน

| จุดอ่อนของ v6 | หลักฐานว่าเป็นปัญหาที่พบทั่วไป | เทคนิคที่ตอบโจทย์ |
|---|---|---|
| เดารหัส | การถอด entity/value retrieval ออกจาก CHESS ทำให้ EX ลด 4.76 จุด (Table 4) [CHESS](https://arxiv.org/abs/2405.16755) และการถอด LSH value retrieval ออกจาก CHASE-SQL ทำให้ลด 2.92 จุด (Table 7) [CHASE-SQL](https://arxiv.org/abs/2410.01943) | #1 |
| query ที่ fail ซ้ำเดิม | 47% ของความล้มเหลวของ ReAct เป็น reasoning error ซึ่งรวมการวนสร้าง thought/action เดิมซ้ำ (Table 2) [ReAct](https://ar5iv.labs.arxiv.org/html/2210.03629) | #2 |
| เลือกตารางเกือบซ้ำ | 27.6% ของ error ใน Spider 2.0 เป็น schema linking ผิด แบ่งเป็นตาราง 10.1% และคอลัมน์ 16.6% (Fig. 5) [Spider 2.0](https://arxiv.org/abs/2411.07763) | #3 |
| ยอมแพ้เร็ว | 23% ของความล้มเหลวของ ReAct มาจากผลค้นที่ว่างหรือไม่มีประโยชน์ ซึ่งทำให้ฟื้นตัวยาก (Table 2) [ReAct](https://ar5iv.labs.arxiv.org/html/2210.03629) | #2, #4 |
| ไทย vs ชื่อย่ออังกฤษ | บน Mr.TyDi ภาษาญี่ปุ่น HyDE ขยับ MRR@100 จาก 19.5 เป็น 30.7 แต่ยังแพ้ retriever ที่ fine-tune แล้ว (Table 3) [HyDE](https://ar5iv.labs.arxiv.org/html/2212.10496) | #4 |

---

## 1. Agent loop และการออกแบบ harness

### 1.1 ReAct
- **กลไก:** LLM สลับระหว่าง reasoning trace กับ action ที่เรียก tool แล้วอ่าน observation ก่อนตัดสินใจก้าวถัดไป [arXiv:2210.03629](https://arxiv.org/abs/2210.03629)
- **ผลที่รายงาน:**
  - ALFWorld +34% และ WebShop +10% (absolute success rate) เทียบกับ imitation/RL [abstract](https://arxiv.org/abs/2210.03629)
  - HotpotQA EM: ReAct 27.4, CoT 29.4, ReAct→CoT-SC 35.1 · FEVER: ReAct 60.9, CoT 56.3 (PaLM-540B, Table 1) [ar5iv](https://ar5iv.labs.arxiv.org/html/2210.03629)
  - Hallucination ของ ReAct อยู่ที่ 0% เทียบกับ 56% ของ CoT แต่ reasoning error อยู่ที่ 47% เทียบกับ 16% ผู้เขียนสงสัยว่า greedy decoding มีส่วนทำให้วน loop (Table 2) [ar5iv](https://ar5iv.labs.arxiv.org/html/2210.03629)
- **ต้นทุน:** 1 LLM call ต่อ step
- **เหมาะกับ 30B / 30 วินาที:** เหมาะ เพราะเป็นโครงพื้นฐานอยู่แล้ว แต่ failure mode ที่ paper รายงาน (วนซ้ำ, หลงทางเมื่อค้นไม่เจอ) ตรงกับจุดอ่อนของเราพอดี ต้องมี guard ครอบ
- **v6 มีแล้วหรือยัง:** มีแล้ว (loop แบบ function calling)

### 1.2 Reflexion และข้อจำกัดของ self-correction
- **กลไก:** หลังจบแต่ละ trial ให้ LLM เขียนสะท้อนตัวเองจาก feedback เก็บไว้ใน episodic memory แล้วลองใหม่ทั้งงาน [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)
- **ผลที่รายงาน:**
  - HumanEval pass@1 91.0 เทียบกับ 80.1 ของ GPT-4 · ALFWorld ทำได้ 130/134 งาน (+22% absolute ใน 12 trials) [ar5iv](https://ar5iv.labs.arxiv.org/html/2303.11366)
  - starchat-beta ไม่ได้ประโยชน์เลย (0.26 ทั้งก่อนและหลัง) ผู้เขียนมองว่าความสามารถ self-correct เกิดกับโมเดลที่ใหญ่และเก่งกว่า (Appendix A) [ar5iv](https://ar5iv.labs.arxiv.org/html/2303.11366)
- **หลักฐานฝั่งค้าน:** self-correction ที่ไม่มี feedback จากภายนอกทำให้ผลแย่ลง เช่น GPT-3.5 บน CommonSenseQA ตกจาก 75.8 เป็น 38.1 ในรอบแรก (Table 3) ผลบวกในงานก่อนหน้ามาจากการใช้ label จริงตัดสินว่าจะหยุดเมื่อไร [Huang et al. 2023](https://arxiv.org/abs/2310.01798) ส่วน Self-Debugging ที่ใช้ execution feedback ช่วยได้ +2–3% บน Spider และ +9% ในข้อยากสุด [arXiv:2304.05128](https://arxiv.org/abs/2304.05128)
- **ต้นทุน:** ทำงานซ้ำทั้งงานหลาย trial
- **เหมาะกับ 30B / 30 วินาที:** ไม่เหมาะในรูปแบบเต็ม เพราะเกินงบเวลาและไม่มี ground truth ตอน inference หลักที่ควรเก็บไว้คือ แก้ตัวเองจาก feedback ภายนอกเท่านั้น (error ของ DB, ผลว่าง, rule) ซึ่ง v6 ทำอยู่แล้ว
- **v6 มีแล้วหรือยัง:** บางส่วน (corrective feedback ภายใน episode จาก rule ภายนอก ไม่มี memory ข้าม episode)

### 1.3 CodeAct
- **กลไก:** ให้ action เป็นโค้ด Python ที่รันใน interpreter แทนการเรียก tool แบบ JSON [arXiv:2402.01030](https://arxiv.org/abs/2402.01030)
- **ผลที่รายงาน:**
  - success rate สูงขึ้นสูงสุด 20% จากการทดสอบ 17 LLM [abstract](https://arxiv.org/abs/2402.01030)
  - M3ToolEval (Table 3): gpt-4-1106 ได้ 74.4 เทียบกับ JSON 52.4 แต่ Llama-2-70B ได้ 11.0 เทียบกับ 3.7 และ CodeLlama-34B ได้ 2.4 เทียบกับ 0.0 [HTML](https://arxiv.org/html/2402.01030)
  - API-Bank (Table 2): ผู้เขียนบอกว่าผลดีของ CodeAct "เด่นกว่าในโมเดล open-source" [HTML](https://arxiv.org/html/2402.01030)
- **ต้นทุน:** ต้องมี sandbox รันโค้ด
- **เหมาะกับ 30B / 30 วินาที:** ไม่เหมาะตอนนี้ ข้อแรก ต้องเปิดให้ LLM รันโค้ดกับข้อมูลที่มี PII ข้อสอง harness แบบ coding-agent สำเร็จรูปที่ทดลองกับโมเดลนี้ได้แค่ 65–70% เทียบกับ 87% ของ v6 (บันทึกการทดลองภายใน 2026-11-25)
- **v6 มีแล้วหรือยัง:** ไม่มี (เลือกไม่ใช้โดยตั้งใจ)

### 1.4 SWE-agent: Agent-Computer Interface (ACI)
- **กลไก:** ออกแบบ tool ให้เหมาะกับ LM โดยตรงตาม 4 หลัก คือ action ง่าย, action กระชับ, feedback ให้ข้อมูลแต่สั้น และมี guardrail กัน error ลุกลาม (Section 2) [arXiv:2405.15793](https://arxiv.org/abs/2405.15793)
- **ผลที่รายงาน:** SWE-bench Lite กับ GPT-4 Turbo ได้ 18.0% (Table 3) [HTML](https://arxiv.org/html/2405.15793) โดย ablation แต่ละส่วนให้ผลดังนี้
  - เอา linter guard ออกจาก edit: 15.0
  - ใช้ search แบบวนค้นทีละขั้นแทนแบบสรุปผล: 12.0
  - แสดงไฟล์ทั้งไฟล์แทน window 100 บรรทัด: 12.7
  - ใส่ history เต็มแทน observation 5 รายการล่าสุด: 15.0
- **ต้นทุน:** ไม่มี LLM call เพิ่ม เป็นงานออกแบบ tool ล้วน
- **เหมาะกับ 30B / 30 วินาที:** เหมาะมาก เพราะลดภาระการคิดของโมเดล บทเรียนตรงคือ guard ที่ปฏิเสธ action ผิดก่อนรัน (แบบ linter) และผลลัพธ์ที่สรุปแล้วดีกว่าการให้โมเดลไล่ดูเอง
- **v6 มีแล้วหรือยัง:** บางส่วน error ของ query ส่งกลับพร้อมรายชื่อคอลัมน์และกฎที่ผิดแล้ว แต่ยังไม่มี "linter" ที่ปฏิเสธรหัสหรือค่า filter ที่ไม่มีอยู่จริงก่อนรัน

### 1.5 OpenHands
- **กลไก:** state เก็บเป็น event stream ของ action/observation, CodeActAgent เป็น agent หลัก, รันใน Docker sandbox และส่งงานย่อยด้วย AgentDelegateAction [HTML](https://arxiv.org/html/2407.16741) SDK มี stuck detector ที่เปิดไว้เป็นค่าเริ่มต้น ตรวจ 5 รูปแบบ [docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)
  - action เดิมได้ observation เดิม ≥4 ครั้ง
  - action เดิมได้ error ≥3 ครั้ง
  - agent พูดต่อเนื่องเอง ≥3 ข้อความ
  - action สองแบบสลับไปมา ≥6 รอบ
  - context window error ซ้ำ
- **ผลที่รายงาน:** SWE-bench Lite ได้ 26.0% (claude-3.5-sonnet), 22.0% (gpt-4o) และ 7.0% (gpt-4o-mini) (Table 4) ไม่มีผลของโมเดล open ในงาน agentic [HTML](https://arxiv.org/html/2407.16741)
- **ต้นทุน:** stuck detector เป็นโค้ดล้วน ไม่มี LLM call
- **เหมาะกับ 30B / 30 วินาที:** stuck detector เหมาะ แต่ทั้ง platform ใหญ่เกินไปสำหรับงานนี้
- **v6 มีแล้วหรือยัง:** บางส่วน มี feedback เมื่อเรียกซ้ำตรงตัว แต่ยังไม่จับรูปแบบสลับไปมา หรือ query ที่ต่างกันเล็กน้อยแต่ได้ error เดิม

### 1.6 smolagents
- **กลไก:**
  - ระดับ agency ไล่จาก router → tool call → multi-step → code agent [docs](https://huggingface.co/docs/smolagents/conceptual_guides/intro_agents)
  - คำแนะนำหลักคือ "Reduce the number of LLM calls as much as you can" รวม tool ที่เรียกคู่กันเสมอ และย้ายตรรกะไปเป็นฟังก์ชัน deterministic [docs](https://huggingface.co/docs/smolagents/tutorials/building_good_agents)
  - `final_answer_checks` คือรายการฟังก์ชันตรวจคำตอบสุดท้าย ถ้าตัวใดคืน False จะ log error แล้วให้ agent ทำต่อ [guided tour](https://huggingface.co/docs/smolagents/guided_tour)
  - `planning_interval` แทรกขั้นวางแผนเป็นระยะ โดยไม่เรียก tool [docs](https://huggingface.co/docs/smolagents/tutorials/building_good_agents)
  - system prompt มีกฎห้ามเรียก tool ซ้ำด้วยพารามิเตอร์เดิม และ "Don't give up!" [docs](https://huggingface.co/docs/smolagents/tutorials/building_good_agents)
- **ผลที่รายงาน:** docs ไม่มีตัวเลข benchmark ของตัวเอง
- **ต้นทุน:** `final_answer_checks` = 0 call ส่วน `planning_interval` = +1 call ต่อรอบวางแผน
- **เหมาะกับ 30B / 30 วินาที:** `final_answer_checks` เหมาะ ส่วน planning step เปลืองเวลาเมื่อมีแค่ 6 reads
- **v6 มีแล้วหรือยัง:** มีแล้วในรูป finish ที่ยอมให้เรียกได้เฉพาะเมื่อมี evidence จริง ยังไม่มี planning step

### 1.7 LangGraph
- **กลไก:**
  - `StateGraph` กับ conditional edges ใช้สร้าง pattern แบบ chaining with gate, routing, parallelization, orchestrator-worker, evaluator-optimizer และ agent loop [docs](https://docs.langchain.com/oss/python/langgraph/workflows-agents)
  - `recursion_limit` จำกัดจำนวน super-step ค่าเริ่มต้นคือ 10,007 ตั้งแต่ 1.1.4 และเกินแล้ว raise `GraphRecursionError` [graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)
- **ผลที่รายงาน:** ไม่มีตัวเลข benchmark
- **เหมาะกับ 30B / 30 วินาที:** ได้แนวคิด แต่ไม่จำเป็นต้องย้าย framework เพราะ v6 ทำสิ่งเทียบเท่าอยู่แล้ว
- **v6 มีแล้วหรือยัง:** มีสิ่งเทียบเท่าแล้ว (max 6 reads, step สุดท้ายให้แค่ finish)

### 1.8 OpenAI Agents SDK: guardrails และ handoffs
- **กลไก guardrail:** [docs](https://openai.github.io/openai-agents-python/guardrails/)
  - input guardrail ตรวจ input ของ agent ตัวแรก
  - output guardrail ตรวจผลลัพธ์สุดท้าย
  - tool guardrail ครอบทุกครั้งที่เรียก function tool ทั้งก่อนรัน (ข้ามการเรียก, แทนผลลัพธ์ หรือ trip ได้) และหลังรัน
  - tripwire หยุดการทำงานทันที
  - input guardrail เลือกได้ระหว่างโหมด parallel (เร็วกว่า แต่ agent อาจใช้ token ไปแล้ว) กับ blocking
- **กลไก handoff:** ส่งให้ LLM เห็นเป็น tool ชื่อ `transfer_to_<agent>` ค่าเริ่มต้นคือ agent ปลายทางเห็นประวัติทั้งหมด และกรองได้ด้วย `input_filter` [docs](https://openai.github.io/openai-agents-python/handoffs/)
- **ผลที่รายงาน:** ไม่มีตัวเลข benchmark
- **เหมาะกับ 30B / 30 วินาที:** tool guardrail แบบ blocking ตรงกับ #1 พอดี ส่วน handoff ไม่จำเป็นเพราะโดเมนเดียว
- **v6 มีแล้วหรือยัง:** input guard มีแล้ว (mask PII), output guard มีแล้ว (reviewer), tool guard มีบางส่วน (feedback หลังรัน ยังไม่ validate ก่อนรัน)

### 1.9 Strict tool schema และ constrained decoding
- **กลไก:**
  - OpenAI แนะนำให้เปิด `strict: true` ใช้ enum กัน state ที่ผิด ไม่ให้โมเดลกรอกค่าที่โค้ดรู้อยู่แล้ว และรวมฟังก์ชันที่เรียกคู่กันเสมอ [OpenAI docs](https://developers.openai.com/api/docs/guides/function-calling)
  - vLLM บังคับ JSON ให้ parse ได้ด้วย structured outputs เมื่อใช้ `tool_choice` แบบ named หรือ required แต่เตือนว่า "guaranteed a validly-parsable function call - not a high-quality one" ส่วนโหมด auto ที่ไม่มี strict อาจได้ argument ผิดรูป [vLLM docs](https://docs.vllm.ai/en/latest/features/tool_calling.html)
- **ข้อควรระวังของเรา:** endpoint ที่ใช้อยู่ไม่เคารพ `tool_choice: "required"` และ harness ที่ไม่ส่ง `strict` ทำให้โมเดลส่ง enum เป็น null แล้ววน loop (บันทึก eval ภายใน) จึงพึ่ง constrained decoding อย่างเดียวไม่ได้ ต้อง validate ฝั่ง server ด้วยเสมอ
- **v6 มีแล้วหรือยัง:** บางส่วน v6 ส่ง `strict: true` ทุก tool อยู่แล้ว (ตรวจใน `dashboard/app/api/chat/openrouter.mjs` และ `tools.mjs`) แต่ enum ของคอลัมน์ยังไม่ได้ผูกกับผลจาก discover

### 1.10 Anthropic: "Building effective agents", "Writing tools for agents" และ "Effective context engineering"
- **กลไก:**
  - เริ่มจาก "simplest solution possible" และแยกให้ชัดระหว่าง workflow ที่เส้นทางกำหนดไว้กับ agent ที่ LLM เลือกเอง มี pattern evaluator-optimizer สำหรับงานที่การปรับแก้วนรอบให้ค่าที่วัดได้ [BEA](https://www.anthropic.com/engineering/building-effective-agents)
  - ใช้ poka-yoke คือเปลี่ยน argument ให้ทำผิดได้ยาก ในตัวอย่าง SWE-bench การบังคับใช้ absolute path ทำให้ error แบบนั้นหายไป และทีมใช้เวลาปรับ tool มากกว่าปรับ prompt [BEA](https://www.anthropic.com/engineering/building-effective-agents)
  - tool ควรคืนค่าที่มีความหมาย เช่นชื่อแทน UUID ซึ่งลด hallucination ได้ มี `response_format` แบบ concise/detailed (concise ใช้ราว 1/3 ของ token) error ควรบอกทางแก้ และควรวัด tool errors, จำนวน call และ runtime บน held-out set [Writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
  - ใช้ toolset เล็กและไม่ซ้อนทับกัน คืนผลที่ประหยัด token ใช้ few-shot แบบ "canonical" ไม่กี่ตัวแทนการไล่ edge case ทั้งหมด และล้าง tool result เก่าทิ้ง ("safest lightest touch") [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **ผลที่รายงาน:** แทบไม่มีตัวเลข มีแค่ข้อความว่าหลังปรับคำอธิบาย tool แล้ว Claude 3.5 Sonnet ได้ SOTA บน SWE-bench Verified [Writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
- **เหมาะกับ 30B / 30 วินาที:** เหมาะ เพราะเกือบทั้งหมดเป็นงานออกแบบที่ไม่มี LLM call เพิ่ม
- **v6 มีแล้วหรือยัง:** มีบางส่วน writer + reviewer คือ evaluator-optimizer แต่ผลของ reviewer ไม่ได้ป้อนกลับเข้า loop (fallback ไปที่คำตอบ server-rendered แทน)

### 1.11 DSPy และ MIPRO
- **กลไก:** เขียน pipeline เป็น module แล้วให้ optimizer "compile" prompt และ demonstration ให้ได้ metric สูงสุด BootstrapFewShot รัน teacher บน train set แล้วเก็บเฉพาะ trace ที่ผ่าน metric มาเป็น demo [arXiv:2310.03714](https://arxiv.org/abs/2310.03714)
- **ผลที่รายงาน:**
  - llama2-13b-chat บน GSM8K ขยับจาก few-shot 4.3 เป็น bootstrap 28.0 (Table 1) และบน HotPotQA multihop จาก 34.7 เป็น 42.0 (Table 2) โดยใช้ train 200 และ dev 300 ตัวอย่าง [ar5iv](https://ar5iv.labs.arxiv.org/html/2310.03714)
  - MIPRO ชนะ optimizer อื่น 5 ใน 7 งาน ดีขึ้นสูงสุด 13% บน Llama-3-8B [arXiv:2406.11695](https://arxiv.org/abs/2406.11695)
- **ต้นทุน:** ไม่มี call เพิ่มตอน runtime แต่ต้องใช้ข้อมูลฝึกและ compute ตอน optimize
- **เหมาะกับ 30B / 30 วินาที:** แนวคิด bootstrap demo เหมาะมาก (ดู #5) แต่การ optimize เต็มรูปแบบด้วย 23 เคสเสี่ยง overfit (paper ใช้ 200/300)
- **v6 มีแล้วหรือยัง:** ไม่มี

---

## 2. Data agent และ text-to-SQL

### 2.1 CHESS
- **กลไก:** [HTML](https://arxiv.org/html/2405.16755)
  - Information Retriever ดึง keyword จากคำถามด้วย LLM แล้ว map เข้ากับค่าจริงใน DB ด้วย LSH, edit distance และ embedding
  - Schema Selector ตัดคอลัมน์และตารางทิ้ง
  - Candidate Generator มีขั้น `revise` ที่แก้ query ซึ่ง syntax ผิดหรือคืนผลว่าง
  - Unit Tester ใช้เลือกระหว่าง candidate
- **ผลที่รายงาน:** BIRD test 71.10 (Gemini 1.5 Pro) และ 66.69 (ชุดโมเดลปิด) บน subsampled dev ที่ระบบเต็มได้ 64.62 ablation (Table 4) ให้ผลดังนี้
  - ถอด entity/context retrieval: −4.76
  - ถอด `select_tables`: −6.12
  - ถอด `revise`: −6.80
  - จำกัด `revise` ไว้ที่ 1 รอบ: −3.40

  ผลอื่นที่เกี่ยวข้อง
  - Schema Selector ยก column precision จาก 0.11 เป็น 0.71 และ recall ลดจาก 1.0 เป็น 0.94 (Table 5)
  - ใช้ Llama-3-70B ทุกขั้นได้ 54.42 เทียบกับ 64.62 ของชุดโมเดลปิด (Table 8)
  - LSH ลดเวลาค้นค่าจากราว 5 นาทีเหลือ 5 วินาที
- **ต้นทุน:** ชุด low-budget เรียก GPT-4-turbo ราว 6 ครั้งต่อคำถาม
- **เหมาะกับ 30B / 30 วินาที:** ขั้น value retrieval กับ revise เหมาะ เพราะเป็น lookup ที่ถูกและ feedback ภายนอก ส่วน Unit Tester หลาย candidate เกินงบ
- **v6 มีแล้วหรือยัง:**
  - value retrieval: บางส่วน (มี near match ใน text search แต่ไม่ได้ link ล่วงหน้า)
  - schema selection: บางส่วน (LLM rerank ใน discover)
  - revise: มีแล้วสำหรับ error ส่วนผลว่างยังไม่ชัด

### 2.2 MAC-SQL
- **กลไก:** แบ่งเป็น 3 agent คือ Selector ตัด schema, Decomposer แตกคำถามย่อย 1–5 ข้อ และ Refiner แก้ SQL ที่ syntax ผิด รันพัง หรือคืนผลว่าง ได้สูงสุด 3 รอบ (Appendix A.3) [HTML](https://arxiv.org/html/2312.11242)
- **ผลที่รายงาน:**
  - BIRD dev 59.39 เทียบกับ GPT-4 เปล่าที่ 46.35 (Table 1)
  - ablation: ถอด Refiner −4.63, ถอด Decomposer −3.85, ถอด Selector −2.11 (Table 3)
  - SQL-Llama 7B ภายใน MAC-SQL ได้ 43.94
  - ข้อจำกัดที่ผู้เขียนระบุ: Refiner ไม่แก้ query ที่รันผ่านและได้ผลไม่ว่าง แม้จะผิดเจตนาของคำถาม [HTML](https://arxiv.org/html/2312.11242)
- **ต้นทุน:** +1 call ต่อรอบแก้
- **เหมาะกับ 30B / 30 วินาที:** Refiner ที่นับผลว่างเป็น error เหมาะ
- **v6 มีแล้วหรือยัง:** บางส่วน

### 2.3 CHASE-SQL
- **กลไก:** สร้าง candidate จาก 3 generator (divide-and-conquer, query-plan, synthetic examples) มี query fixer แก้ได้สูงสุด 3 รอบ แล้วใช้ selector ที่ fine-tune มาเปรียบเทียบ candidate ทีละคู่ [HTML](https://arxiv.org/html/2410.01943)
- **ผลที่รายงาน:** BIRD test 73.0 ablation (Table 7) ให้ผลดังนี้
  - ใช้ self-consistency แทน selector: −4.17
  - ถอด query fixer: −3.78
  - ถอด LSH value retrieval: −2.92

  oracle ของ candidate ทั้งหมดอยู่ที่ 82.79 ขณะที่ self-consistency ได้ 68.84 [HTML](https://arxiv.org/html/2410.01943)
- **ต้นทุน:** ใช้ 21 candidate ต่อคำถาม และ selector ต้อง fine-tune
- **เหมาะกับ 30B / 30 วินาที:** ไม่เหมาะทั้งระบบ ส่วนที่ยืมได้คือ value retrieval กับ fixer
- **v6 มีแล้วหรือยัง:** มีแค่ส่วน fixer

### 2.4 DIN-SQL
- **กลไก:** แตกงานเป็นขั้น schema linking → จัดระดับความยาก → สร้าง SQL → self-correction [arXiv:2304.11015](https://arxiv.org/abs/2304.11015)
- **ผลที่รายงาน:** Spider holdout 85.3 (SOTA เดิม 79.9) และ BIRD holdout 55.9 ดีกว่า few-shot ราว 10% [abstract](https://arxiv.org/abs/2304.11015) แต่บน Spider 2.0-lite ได้เพียง 1.46% (Table 4) [Spider 2.0](https://arxiv.org/html/2411.07763)
- **เหมาะกับ 30B / 30 วินาที:** แนวคิด route ตามความยากพอใช้ได้ แต่ยังไม่ใช่สิ่งเร่งด่วน
- **v6 มีแล้วหรือยัง:** ไม่มี

### 2.5 DAIL-SQL (การเลือก few-shot)
- **กลไก:** ซ่อนคำเฉพาะโดเมนในคำถาม แล้วเลือกตัวอย่างจากความใกล้ของ embedding ของคำถามที่ซ่อนคำแล้ว ร่วมกับความใกล้ของ SQL [HTML](https://arxiv.org/html/2308.15363)
- **ผลที่รายงาน:**
  - GPT-3.5-Turbo 5-shot: สุ่มตัวอย่างได้ 75.7, masked-question similarity 77.9, DAIL 78.1
  - GPT-4 5-shot: สุ่ม 79.5, DAIL 82.4 (Table 2, Spider-dev)
  - ได้ 86.6% บน Spider leaderboard [abstract](https://arxiv.org/abs/2308.15363)
- **ต้นทุน:** 0 call แต่ prompt ยาวขึ้น
- **เหมาะกับ 30B / 30 วินาที:** เหมาะ (ดู #5)
- **v6 มีแล้วหรือยัง:** ไม่มี few-shot แบบ dynamic (ตามคำอธิบายที่ได้รับ)

### 2.6 ReFoRCE
- **กลไก:** [HTML](https://arxiv.org/html/2502.00675)
  - บีบข้อมูล DB โดยรวมตารางที่ prefix/suffix คล้ายกันเป็นกลุ่ม เก็บตัวแทนไว้หนึ่งตาราง ที่เหลือแสดงแค่ชื่อ
  - column exploration ใช้ query สำรวจแบบ `SELECT DISTINCT ... LIMIT 20`
  - แก้ตัวเองจาก execution feedback สูงสุด 5 รอบ
  - ใช้ majority vote เป็นสัญญาณความมั่นใจ
- **ผลที่รายงาน:** o3 บน Spider 2.0-Snow ได้ 35.83 EX (Table 1) ablation (Table 3) ให้ผลดังนี้
  - ถอดการบีบข้อมูล DB: 32.18 (−3.65 ลดมากที่สุด)
  - ถอด column exploration: 33.27
  - ถอด majority vote: 33.82

  เฉลี่ยใช้ 3.52 LLM call ต่อตัวอย่าง [HTML](https://arxiv.org/html/2502.00675)
- **เหมาะกับ 30B / 30 วินาที:** การจัดกลุ่มตารางกับการสำรวจค่า distinct เหมาะเพราะเป็นงาน deterministic ส่วน majority vote เกินงบ
- **v6 มีแล้วหรือยัง:** ไม่มี

### 2.7 Spider 2.0 / Spider-Agent
- **กลไก:** agent แบบ ReAct มี action เช่น ExecuteSQL, GetTables, GetTabInfo, SampleRows, FAIL และ Terminate จำกัดไว้ 30 step และจบเองถ้าได้ผลเดิม 3 ครั้งติด (Appendix C.1, Table 18) [HTML](https://arxiv.org/html/2411.07763)
- **ผลที่รายงาน:**
  - o1-preview ได้ 21.36% บน Spider 2.0 (Table 5) และ 23.22% บน Spider 2.0-lite (Table 3)
  - CHESS+GPT-4o ได้เพียง 3.84% บน lite (Table 4)
  - error ที่พบ: วิเคราะห์ข้อมูลผิด 35.5%, schema linking ผิด 27.6%, JOIN ผิด 8.3% (Fig. 5) [HTML](https://arxiv.org/html/2411.07763)
- **เหมาะกับ 30B / 30 วินาที:** ได้แนวคิด guard สองแบบ คือ action FAIL และการหยุดเมื่อผลซ้ำ
- **v6 มีแล้วหรือยัง:** FAIL มีแล้ว (unsupported/clarify) ส่วนการหยุดเมื่อผลซ้ำมีบางส่วน

### 2.8 DS-STAR
- **กลไก:** มี agent แยกหน้าที่ดังนี้ วนสูงสุด 20 รอบ [HTML](https://arxiv.org/html/2509.21825)
  - analyzer เขียน script สรุปโครงสร้างแต่ละไฟล์
  - planner และ coder วางแผนแล้วเขียนโค้ด
  - verifier เป็น LLM judge ที่ตัดสินแบบ binary ว่าแผน "เพียงพอ" หรือยัง
  - router เลือกเพิ่ม step หรือย้อนไปตัดแผนที่ผิด
- **ผลที่รายงาน:** DABStep hard ได้ 45.24 เทียบกับ 41.01 (Table 1) ablation (Table 4) ให้ผลดังนี้
  - ถอด verifier: 34.66
  - ถอด analyzer: 26.98

  ต้นทุนอยู่ที่ 12.7 LLM call และราว 176 วินาทีต่องาน เทียบกับ ReAct ที่ 7.1 call และราว 73 วินาที (Table 9) [HTML](https://arxiv.org/html/2509.21825)
- **เหมาะกับ 30B / 30 วินาที:** ทั้งระบบช้าเกินไป แต่ verifier ความเพียงพอ 1 ครั้งก่อน finish พอทำได้
- **v6 มีแล้วหรือยัง:** บางส่วน มี reviewer หลังเขียนคำตอบ แต่ไม่ได้อยู่ใน loop

### 2.9 Agentic RAG survey
- นิยาม Agentic RAG ว่าเป็นการฝัง agent อัตโนมัติไว้ใน RAG pipeline มี pattern หลัก 4 แบบ คือ reflection, planning, tool use และ multi-agent collaboration และจัด taxonomy ตามจำนวน agent, control structure, autonomy และ knowledge representation (v4, เม.ย. 2026) [arXiv:2501.09136](https://arxiv.org/abs/2501.09136)

---

## 3. การปรับปรุง RAG

### 3.1 Reciprocal Rank Fusion (RRF)
- **กลไก:** `score(d) = Σ 1/(k + rank)` โดย k = 60 กำหนดจาก pilot ผู้เขียนพบว่า k ใกล้ค่าที่ดีที่สุด "but that the choice was not critical" (MAP 0.2145 ที่ k=60 และ 0.2072 ที่ k=0, Table 1) [Cormack et al. 2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- **ผลที่รายงาน:**
  - ดีกว่า Condorcet, CombMNZ และระบบเดี่ยวที่ดีที่สุดเฉลี่ย 4–5% (Section 1, Table 1–2)
  - บน LETOR 3 ดีกว่า learning-to-rank ทุกตัว (MAP 0.6051, Table 3) [paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
  - Azure AI Search ใช้ RRF เมื่อมี query ขนานตั้งแต่ 2 ตัวขึ้นไป ถ่วงน้ำหนัก vector query ได้ และรัน semantic ranker หลัง RRF [Azure docs](https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking)
- **นัยสำหรับเรา:** แต่ละ query variant (ไทย, อังกฤษ, ชื่อย่อ) เป็น ranked list ใหม่ที่ fuse เพิ่มได้ทันที
- **v6 มีแล้วหรือยัง:** มีแล้ว (keyword + semantic)

### 3.2 HyDE และ Query2doc (query expansion ด้วย LLM)
- **กลไก:** ให้ LLM เขียนเอกสารสมมติ แล้วใช้ embedding ของเอกสารนั้นไปค้นแทนคำถาม [HyDE](https://arxiv.org/abs/2212.10496) ส่วน Query2doc เอา pseudo-doc ไปต่อท้ายคำถามแล้วค้นทั้งแบบ sparse และ dense [Query2doc](https://arxiv.org/abs/2303.07678)
- **ผลที่รายงาน:**
  - HyDE ยก TREC DL19 nDCG@10 จาก 44.5 (Contriever) เป็น 61.3 (Table 1)
  - Mr.TyDi ภาษาญี่ปุ่นขยับจาก 19.5 เป็น 30.7 และภาษาเกาหลีจาก 22.3 เป็น 30.6 แต่ยังแพ้ mContrieverFT ที่ fine-tune แล้ว (Table 3) ผู้เขียนเตือนว่า LLM อาจฝึกภาษาทรัพยากรต่ำมาน้อย [ar5iv](https://ar5iv.labs.arxiv.org/html/2212.10496)
  - Query2doc ยก BM25 ได้ 3–15% [abstract](https://arxiv.org/abs/2303.07678)
- **ต้นทุน:** +1 LLM call ต่อการค้น
- **เหมาะกับ 30B / 30 วินาที:** พอได้ถ้ารวมไว้ใน call เดียวกับ keyword extraction (#1/#4) ไม่ควรเรียกแยกทุกครั้งที่ค้น
- **v6 มีแล้วหรือยัง:** ไม่มี

### 3.3 RQ-RAG
- **กลไก:** ฝึกโมเดลให้ rewrite, แตก (decompose) และ disambiguate คำถามก่อนค้น ผลคือ Llama2-7B ดีกว่า SOTA เฉลี่ย 1.9% บน single-hop QA 3 ชุด [arXiv:2404.00610](https://arxiv.org/abs/2404.00610)
- **เหมาะกับ 30B / 30 วินาที:** ไม่เหมาะ เพราะต้อง fine-tune
- **v6 มีแล้วหรือยัง:** ไม่มี

### 3.4 Reranking
- **ผลที่รายงาน:**
  - Contextual Retrieval: top-20 failure rate ลดลง 35% ด้วย contextual embeddings, 49% เมื่อเพิ่ม contextual BM25 และ 67% เมื่อเพิ่ม reranker (ดึง 150 chunk แล้วคัดเหลือ 20) [Anthropic](https://www.anthropic.com/news/contextual-retrieval)
  - RankGPT: GPT-4 ได้ nDCG@10 75.59 บน DL19 เทียบกับ BM25 50.58 แต่ใช้ 10 API call ต่อ query (sliding window 20/10 บน top-100) [HTML](https://arxiv.org/html/2304.09542)
  - LLM open ขนาดเล็กทำ listwise reranking ได้ใกล้ BM25 เท่านั้น เช่น Vicuna-13B 49.08 เทียบกับ BM25 50.58 (Table 6) [HTML](https://arxiv.org/html/2304.09542)
- **นัยสำหรับเรา:** ถ้าจะเพิ่ม reranker ให้ text search ควรใช้ cross-encoder เฉพาะทาง ไม่ใช่ให้โมเดล 30B ทำ listwise
- **v6 มีแล้วหรือยัง:** บางส่วน (LLM rerank เฉพาะใน discover)

### 3.5 Corrective RAG (CRAG)
- **กลไก:** evaluator ขนาดเล็ก (T5-large ที่ fine-tune) ให้คะแนนเอกสาร แล้วใช้ 2 threshold แบ่งเป็น 3 action [HTML](https://arxiv.org/html/2401.15884)
  - Correct: กรองเอาเฉพาะส่วนที่เกี่ยวข้อง
  - Incorrect: ทิ้งเอกสารแล้วค้นใหม่ด้วยคำค้นที่ rewrite
  - Ambiguous: ใช้ทั้งสองทาง
- **ผลที่รายงาน:**
  - LLaMA2-7b บน PopQA ขยับจาก 50.5 เป็น 54.9 และบน PubHealth จาก 48.9 เป็น 59.5 (Table 1)
  - evaluator ได้ความแม่นยำ 84.3 เทียบกับ ChatGPT 58.0 (Table 4)
  - เวลาเพิ่มจาก 0.363 เป็น 0.512 วินาทีต่อ instance (Table 6) [HTML](https://arxiv.org/html/2401.15884)
- **เหมาะกับ 30B / 30 วินาที:** เวอร์ชันที่ใช้ threshold บนคะแนน retrieval เดิมเหมาะกับ `search_knowledge`
- **v6 มีแล้วหรือยัง:** บางส่วน (near match ใน query_database)

### 3.6 Self-RAG
- **กลไก:** fine-tune generator ให้ปล่อย reflection token 4 ชนิด คือ Retrieve, IsRel, IsSup และ IsUse ใช้ข้อมูลราว 150k ตัวอย่าง [ar5iv](https://ar5iv.labs.arxiv.org/html/2310.11511)
- **ผลที่รายงาน:** Self-RAG 13B ได้ PopQA 55.8 และ PubHealth 74.5 เทียบกับ Llama2-chat 13B + retrieval ที่ 51.8 และ 52.1 (Table 2) [ar5iv](https://ar5iv.labs.arxiv.org/html/2310.11511)
- **เหมาะกับ 30B / 30 วินาที:** ไม่เหมาะ เพราะต้อง fine-tune โมเดลหลัก
- **v6 มีแล้วหรือยัง:** ไม่มี (reviewer ที่แยกเป็นอีก call ทำหน้าที่คล้าย IsSup แล้ว)

---

## 4. ตารางสรุป: v6 มีอะไรแล้ว

| เทคนิค | v6 | LLM call เพิ่ม | เหมาะกับ 30B / 30 วินาที |
|---|---|---|---|
| ReAct loop, step cap, finish gate | มีแล้ว | – | ✓ |
| Feedback ภายนอก (error + column list) | มีแล้ว | 0 | ✓ |
| Writer + reviewer (evaluator-optimizer) | มีแล้ว (ไม่ป้อนกลับเข้า loop) | – | ✓ |
| RRF hybrid search | มีแล้ว | 0 | ✓ |
| Value linking ล่วงหน้า (CHESS IR) | บางส่วน | 0–1 | ✓ |
| Tool guard ก่อนรัน / poka-yoke | บางส่วน | 0 | ✓ |
| Stuck detector หลายรูปแบบ | บางส่วน | 0 | ✓ |
| รวมตารางซ้ำเป็นกลุ่ม (ReFoRCE) | ไม่มี | 0 | ✓ |
| Query expansion ข้ามภาษา | ไม่มี | 0–1 | ✓ |
| Dynamic few-shot (DAIL/DSPy) | ไม่มี | 0 | ✓ |
| Sufficiency verifier ใน loop (DS-STAR) | บางส่วน | +1 | △ |
| Cross-encoder rerank สำหรับ text search | ไม่มี | 0 (มี model) | △ |
| Multi-candidate + selector | ไม่มี | +N | ✗ |
| CodeAct / Reflexion / Self-RAG | ไม่มี | มาก / fine-tune | ✗ |

---

## 5. Shortlist 5 อันดับ

**โปรโตคอล eval ที่ใช้ร่วมกันทุกข้อ**
- รัน A/B ระหว่าง v6 กับ v6+X แต่ละแขนรันอย่างน้อย 2 รอบ (แนะนำ 3) และรายงานทุกรอบ เพราะ heldout แกว่ง ±1–2 เคสต่อรอบแม้ใช้ commit เดียวกัน (บันทึก eval ภายใน)
- เกณฑ์ผ่าน: grounded ≥85% และไม่แย่กว่า main, redteam รั่ว 0 เคส, source-ranking ไม่ถอย
- เก็บ telemetry ของ harness ด้วย ได้แก่ จำนวน feedback แยกตามชนิด (unsourced code, repeated call), จำนวน read ต่อคำถาม, p95 latency และอัตรา fallback ไปคำตอบ server-rendered ตามที่ Anthropic แนะนำให้วัด tool errors, จำนวน call และ runtime [Writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
- ติด tag เคสใน heldout ตามจุดอ่อน (เดารหัส, ตารางซ้ำ, ไทย-อังกฤษ, ยอมแพ้เร็ว) เพื่อดูผลเฉพาะกลุ่ม
- ทำ component eval แบบ deterministic ควบคู่ไปด้วย เพราะไม่มี noise จาก LLM

### #1 Value linking ก่อน loop + ตรวจรหัสที่ขอบ tool
- **เหตุผล:** จุดอ่อนอันดับหนึ่งคือโมเดลเดารหัส ใน paper text-to-SQL ชั้นนำ การ map คำในคำถามเข้ากับค่าจริงใน DB เป็นส่วนที่ถอดออกแล้วเสียมากเป็นอันดับต้นๆ (CHESS −4.76 ใน Table 4 [CHESS](https://arxiv.org/abs/2405.16755), CHASE-SQL −2.92 ใน Table 7 [CHASE-SQL](https://arxiv.org/abs/2410.01943)) และ column exploration ของ ReFoRCE ก็ช่วยเพิ่ม (Table 3) [ReFoRCE](https://arxiv.org/html/2502.00675) วิธีที่เสนอมีสองส่วน
  - **(ก)** ก่อนเริ่ม loop ให้ดึง keyword และ entity จากคำถาม แล้วค้นด้วย hybrid/RRF ที่มีอยู่แล้วบนคอลัมน์ประเภทรหัส จากนั้นแนบรายการ "รหัสที่พบจริง" ไว้ใน context แบบ just-in-time [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  - **(ข)** ทำ tool guard แบบ blocking ที่ปฏิเสธค่า filter ที่ไม่มีอยู่จริงหรือไม่เคยปรากฏใน evidence ก่อนรัน และคืน error ที่มีรหัสใกล้เคียงที่ถูกต้องให้เลือก (หลัก linter ของ SWE-agent ซึ่งถอดออกแล้วเสีย 3 จุด [SWE-agent](https://arxiv.org/html/2405.15793), poka-yoke [BEA](https://www.anthropic.com/engineering/building-effective-agents), tool guardrail ที่ "skip the call" ได้ [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/guardrails/))
  - ถ้า server รองรับ ให้ผูก enum ของ argument เข้ากับผลจาก discover ด้วย แต่ห้ามพึ่งส่วนนี้อย่างเดียว (หัวข้อ 1.9)
- **ผลที่คาด (สมมติฐาน):** จำนวน feedback "unsourced code" ลดลงอย่างน้อยครึ่งหนึ่ง และเคสที่ติด tag เดารหัสใน heldout ผ่านเพิ่ม
- **ต้นทุน:**
  - ถ้าใช้ rule/regex ดึง keyword: 0 LLM call
  - ถ้าใช้ LLM: +1 call สั้นๆ ซึ่งรวมกับ #4 ได้
  - lookup ใน DB เป็นระดับมิลลิวินาทีต่อครั้ง
  - งานพัฒนาปานกลาง
- **วิธีทดสอบ:**
  - (1) component eval: วัด recall@5 ของรหัสที่ถูกต้องในคำตอบ gold ของ heldout จากขั้น value linking เพียงอย่างเดียว ไม่ใช้ LLM
  - (2) A/B บน heldout 2–3 รอบต่อแขน ดู grounded และจำนวน feedback unsourced code
  - (3) redteam: ตรวจว่าการแนบค่าจริงเข้า context ไม่ทำให้ PII รั่ว ค่าที่แนบต้องผ่าน masking ก่อนเสมอ

### #2 วินิจฉัยผลว่าง/error รายตัวกรอง + stuck detector เชิงความหมาย
- **เหตุผล:** paper ทุกฉบับในกลุ่มนี้นับ "ผลว่าง" เป็น error ที่ต้องแก้ ได้แก่ revise ของ CHESS (ถอดแล้ว −6.80 และจำกัด 1 รอบ −3.40 ใน Table 4) [CHESS](https://arxiv.org/html/2405.16755), Refiner ของ MAC-SQL (−4.63 ใน Table 3) [MAC-SQL](https://arxiv.org/html/2312.11242) และ self-refine ของ ReFoRCE [ReFoRCE](https://arxiv.org/html/2502.00675) ส่วน SWE-agent ชี้ว่า feedback ควร "informative but concise" [SWE-agent](https://arxiv.org/html/2405.15793) วิธีที่เสนอมีสามส่วน
  - **(ก)** เมื่อ query คืน 0 แถว ให้ tool คืนจำนวนแถวที่เหลือหลังใส่ filter ทีละตัว พร้อมค่าใกล้เคียงของ filter ตัวที่ทำให้ผลเป็นศูนย์ โมเดลจะรู้ว่าต้องแก้ตรงไหน แทนที่จะยอมแพ้หรือส่ง query เดิมซ้ำ
  - **(ข)** ขยาย detector การเรียกซ้ำให้จับรูปแบบตาม OpenHands ได้แก่ action เดิมได้ error เดิม ≥3 ครั้ง และสลับไปมา ≥6 รอบ [OpenHands docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) รวมถึง query ที่ normalize แล้วเหมือนเดิม (เช่นเปลี่ยนแค่ลำดับ filter) แล้วตอบด้วยคำสั่งที่บอกให้ "เปลี่ยนอะไร" อย่างเจาะจง
  - **(ค)** ถ้าเรียกซ้ำเกินงบ ให้ harness รันเวอร์ชันผ่อน filter แบบ deterministic เอง แนวเดียวกับ Spider-Agent ที่หยุดเมื่อได้ผลเดิม 3 ครั้ง [Spider 2.0](https://arxiv.org/html/2411.07763)
- **ผลที่คาด (สมมติฐาน):** จำนวน feedback "repeated call" ลดลง จำนวนเคส clarify/unsupported ที่จริงๆ มีคำตอบลดลง และ grounded ในกลุ่มยอมแพ้เร็วดีขึ้น
- **ต้นทุน:** 0 LLM call ใช้ DB query เพิ่ม 1–3 ครั้งแบบ COUNT ที่ถูก และเป็นงานในตัว tool ล้วน
- **วิธีทดสอบ:**
  - (1) replay trajectory เก่าที่ fail เพราะวนซ้ำ แล้วตรวจว่า detector จับได้ เป็น unit test แบบ deterministic
  - (2) A/B บน heldout ดู grounded, จำนวน read เฉลี่ย และ latency
  - (3) redteam: ตรวจว่าข้อความวินิจฉัยไม่เผยค่าที่ถูก mask

### #3 จัดตารางที่เกือบซ้ำเป็น family + การ์ดความต่างใน discover
- **เหตุผล:**
  - การเลือกตารางผิดเป็น error กลุ่มใหญ่ (27.6% ใน Fig. 5) [Spider 2.0](https://arxiv.org/html/2411.07763)
  - การถอด `select_tables` ของ CHESS ทำให้เสีย 6.12 จุด (Table 4) [CHESS](https://arxiv.org/html/2405.16755)
  - ReFoRCE ได้ผลมากที่สุดจากการรวมตารางที่ชื่อคล้ายกันเป็นกลุ่มแล้วโชว์ตัวแทนตัวเดียว (ถอดแล้ว −3.65 ใน Table 3) [ReFoRCE](https://arxiv.org/html/2502.00675)
  - Anthropic เตือนว่าถ้าคนยังเลือกไม่ถูก agent ก็เลือกไม่ถูกเหมือนกัน [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

  วิธีที่เสนอ: ในขั้น offline ให้จัดตารางจาก catalog ~120 ตารางที่ชื่อหรือคอลัมน์ซ้อนกันเป็น family แต่ละ family มีตารางหลัก 1 ตัว พร้อม "การ์ดความต่าง" สั้นๆ ระบุความสดของข้อมูล, grain, ช่วงเวลา และจำนวนแถว discover จะคืนผลระดับ family ก่อน และใช้ rule ตัดสินเมื่อเสมอกัน เช่นเลือกตารางที่สดกว่า วิธีนี้ทำให้ LLM rerank ทำงานบนตัวเลือกที่ไม่ซ้อนกัน
- **ผลที่คาด (สมมติฐาน):** source-ranking top-1 ดีขึ้นในเคสที่มีตารางคู่แฝด และเคสใน heldout ที่ติด tag ตารางซ้ำผ่านเพิ่ม
- **ต้นทุน:** 0 LLM call ตอน runtime งานหลักคือ curate catalog ครั้งเดียว (ใช้ LLM ช่วยร่างการ์ดได้ แต่คนต้องตรวจ) และต้องดูแลเมื่อ catalog เปลี่ยน
- **วิธีทดสอบ:**
  - (1) source-ranking set: วัด top-1 accuracy และ MRR ก่อนและหลัง แยกเฉพาะ query ที่มีตารางแฝด
  - (2) A/B บน heldout
  - (3) ตรวจ latency ของ discover ว่าไม่เพิ่ม

### #4 ขยายคำค้นข้ามภาษา (ไทย ↔ ชื่อย่ออังกฤษ) แล้วรวมด้วย RRF
- **เหตุผล:** ช่องว่างระหว่างคำถามภาษาไทยกับชื่อสินค้าภาษาอังกฤษแบบย่อเป็นปัญหา vocabulary mismatch โดยตรง แก้ได้สองฝั่ง
  - **ฝั่ง index (ไม่มีต้นทุนตอน query):** เติมชื่อเต็มภาษาอังกฤษและ alias ภาษาไทยลงในข้อความที่ index แบบ contextual retrieval ซึ่งเมื่อทำทั้ง embedding และ BM25 ลด failure ได้ 49% [Anthropic](https://www.anthropic.com/news/contextual-retrieval)
  - **ฝั่ง query:** ให้ LLM สร้าง variant ภาษาอังกฤษหรือชื่อย่อในคราวเดียวกับ keyword extraction ของ #1 ตามแนว Query2doc ที่ยก BM25 ได้ 3–15% [Query2doc](https://arxiv.org/abs/2303.07678) และ HyDE ที่ได้ผลแม้ในภาษาไม่ใช่อังกฤษแต่ยังแพ้ retriever ที่ fine-tune (Table 3) [HyDE](https://ar5iv.labs.arxiv.org/html/2212.10496)

  ทุก variant เป็น ranked list ที่ fuse ด้วย RRF ได้เลยโดยไม่ต้องจูน k (k=60 "not critical") [RRF](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) และถ่วงน้ำหนักได้แบบ Azure [Azure docs](https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking)
- **ผลที่คาด (สมมติฐาน):** เคสที่ near match ไม่เจอเพราะต่างภาษาลดลง และ recall ของ text search ดีขึ้น
- **ต้นทุน:** ฝั่ง index เป็นงาน offline 0 call ฝั่ง query คือ 0 call ถ้ารวมกับ #1 หรือ +1 call สั้นๆ ถ้าแยก
- **วิธีทดสอบ:**
  - (1) component eval: ทำชุดคำถามไทยที่มีสินค้าเป้าหมายจากเคสใน heldout และ source-ranking แล้ววัด recall@10 และ MRR ของ text search ก่อนและหลัง
  - (2) A/B บน heldout เน้นเคสที่ติด tag ไทย-อังกฤษ
  - (3) ตรวจว่า variant ไม่ทำให้ precision ตก โดยดูอัตรา "near match ผิดตัว"

### #5 Dynamic few-shot จาก trajectory ที่ผ่านการตรวจแล้ว
- **เหตุผล:** โมเดล open ได้ประโยชน์จากตัวอย่างที่ดีมากที่สุด
  - DSPy bootstrap ยก llama2-13b บน HotPotQA จาก 34.7 เป็น 42.0 (Table 2) [DSPy](https://ar5iv.labs.arxiv.org/html/2310.03714)
  - DAIL-SQL ที่เลือกตัวอย่างจากคำถามที่ซ่อนคำเฉพาะแล้วดีกว่าการสุ่ม 2.4 จุดบน GPT-3.5 และ 2.9 จุดบน GPT-4 ที่ 5-shot (Table 2) [DAIL-SQL](https://arxiv.org/html/2308.15363)
  - Anthropic แนะนำ canonical examples แทนการไล่ rule [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

  วิธีที่เสนอ: สร้างคลัง trajectory (คำถาม → ลำดับ tool call ที่ถูกต้อง) จากคำถามจริงหรือ dev set ที่ reviewer ผ่าน ห้ามใช้เคสจาก heldout หรือ redteam จากนั้นซ่อนชื่อเฉพาะและตัวเลขในคำถาม แล้ว retrieve 2–3 ตัวอย่างที่ใกล้ที่สุดมาใส่ใน prompt
- **ผลที่คาด (สมมติฐาน):** จำนวน feedback ลดลงทุกชนิด และโมเดลใช้ pattern discover → query ที่ถูกต้องบ่อยขึ้น
- **ต้นทุน:** 0 LLM call แต่ prompt ยาวขึ้นราว 1–2k token ซึ่งต้องวัด latency และต้องดูแลคลังตัวอย่าง (เป็น PII ด้วย ต้อง mask)
- **วิธีทดสอบ:**
  - (1) ต้องแยก dev set สำหรับสร้างคลังออกจาก heldout อย่างเด็ดขาด เพื่อกัน leakage
  - (2) A/B บน heldout 3 รอบต่อแขน เพราะผลของ few-shot แกว่งได้
  - (3) redteam: ตรวจว่าตัวอย่างไม่พา secret หรือ PII เข้า prompt
  - (4) ablation k = 0, 2, 3 ตัวอย่าง

**ตัวเลือกสำรอง (อันดับ 6):** sufficiency verifier 1 ครั้งก่อน finish แบบ DS-STAR (ถอด verifier แล้ว hard ลดจาก 45.24 เป็น 34.66 ใน Table 4 [DS-STAR](https://arxiv.org/html/2509.21825)) หรือป้อนเหตุผลที่ reviewer ปฏิเสธกลับเข้า loop 1 ครั้ง มีต้นทุน +1 call จึงควรทำหลัง #1–#2 แล้วดูว่ายังเหลือเคสยอมแพ้เร็วอยู่หรือไม่

---

## 6. ที่ไม่แนะนำตอนนี้

- **CodeAct:** โมเดล open ได้ success ต่ำในเชิง absolute (Llama-2-70B ได้ 11.0 บน M3ToolEval, Table 3) [CodeAct](https://arxiv.org/html/2402.01030) ต้องให้ LLM รันโค้ดบนข้อมูลที่มี PII และ harness แบบ coding-agent ก็เคยแพ้ v6 แล้ว (บันทึกภายใน)
- **Reflexion หลาย trial:** ต้องลองซ้ำทั้งงาน และ self-correction ที่ไม่มี feedback ภายนอกทำให้แย่ลงได้ [Huang et al.](https://arxiv.org/html/2310.01798) โมเดลเล็กอาจไม่ได้ประโยชน์เลย [Reflexion App. A](https://ar5iv.labs.arxiv.org/html/2303.11366)
- **Multi-candidate + selector (CHASE-SQL) หรือ majority vote:** ใช้ 21 candidate และ selector ที่ต้อง fine-tune [CHASE-SQL](https://arxiv.org/html/2410.01943) เกินงบ 30 วินาที
- **Self-RAG / RQ-RAG:** ต้อง fine-tune โมเดลหลัก [Self-RAG](https://ar5iv.labs.arxiv.org/html/2310.11511), [RQ-RAG](https://arxiv.org/abs/2404.00610)
- **DSPy/MIPRO แบบเต็ม:** paper ใช้ข้อมูล train/dev 200/300 [DSPy](https://ar5iv.labs.arxiv.org/html/2310.03714) แต่เรามี heldout 23 เคส ถ้า optimize บนชุดนี้จะ overfit ควรกลับมาพิจารณาเมื่อมี dev set ≥100–200 เคส
- **Listwise rerank ด้วย LLM open:** ได้ผลใกล้ BM25 เท่านั้น (Table 6) [RankGPT](https://arxiv.org/html/2304.09542)
- **ย้ายไปใช้ framework (LangGraph/OpenHands/smolagents):** v6 มี loop control ที่เทียบเท่าอยู่แล้ว สิ่งที่ควรยืมคือแนวคิด (stuck detector, tool guardrail, final-answer checks) ไม่ใช่ตัว framework

## 7. ข้อจำกัดของรายงาน
- ผลทุกตัวมาจาก benchmark ภาษาอังกฤษบน SQL/Python ไม่มี paper ใดในชุดนี้วัดบนโมเดล MoE 30B ภาษาไทยโดยตรง "ผลที่คาด" ในหัวข้อ 5 จึงเป็นสมมติฐานที่ต้องพิสูจน์ด้วย eval ของเราเอง
- ตัวเลข latency จาก paper (เช่น DS-STAR 176 วินาที และ RankGPT ราว 11–32 วินาทีต่อ query) วัดบน API ของโมเดลปิด ใช้เทียบได้แค่สัดส่วน
- บางรายละเอียดอ่านจาก abstract เท่านั้น ได้แก่ OpenHands ส่วน platform, Agentic RAG survey และ RQ-RAG
