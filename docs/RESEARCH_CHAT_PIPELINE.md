# Research: data-chat pipeline (เลือกแหล่งข้อมูล, error feedback, ranking)

จัดทำ: 2026-11-26 · อ่านแหล่งข้อมูลทั้งหมดเมื่อ 2026-11-26

เอกสารนี้รวบรวมหลักฐานจากงานวิจัย text-to-SQL, LLM reranking, agent self-correction และซอร์สโค้ดของ data agent
โอเพนซอร์ส แล้ว map เข้ากับ data-chat pipeline ของ SYNAPSE (Typhoon 2.5 `typhoon-v2.5-30b-a3b-instruct`,
`discover_database` → lexical → LLM ranker → `query_database`, harness corrections, writer + reviewer)
ทุกข้อแยก **วัดแล้ว** (benchmark, ตัวเลข, setting) ออกจาก **แนะนำ** (ไม่มีตัวเลข) และจบด้วย "ใช้กับ Synapse"

> **หลักการวัดผล:** ทุกข้อที่ "ทำเลย" ต้องวัดด้วย `dashboard/evals/source-ranking-v1.json` (15 เคส, hit@6 / top1)
> และ `chat-heldout-v1.json` (23 เคส) อย่างน้อย 2 รอบ เพราะผล Typhoon แกว่ง ±1–2 เคสต่อรอบ ตัวเลขจากงานวิจัยด้านล่าง
> มาจากโมเดลและ benchmark อื่น (GPT-3.5/4/4o, Gemini, Codex; BIRD, Spider) ใช้บอกทิศทาง ไม่ได้รับประกันผลกับ Typhoon

> **สถานะโค้ดขณะเขียน:** commit `8106e41` (harness v6, branch `codex/schema-aware-sources`) ทำบางข้อแล้ว: ranker เห็น
> คอลัมน์หลักของแต่ละแหล่ง (ตัด lineage, คอลัมน์ชื่อ/รหัสก่อน, ≤16), error คอลัมน์ที่ไม่มีชี้ไปยังแหล่งที่มีคอลัมน์นั้น,
> `no_data` มี hints, `invalid_input` ไม่กินงบ read และคำตอบ fallback แสดงแต่ละบรรทัดครั้งเดียว ตารางด้านล่างระบุว่าข้อไหน v6 ครอบแล้ว
>
> **ทำต่อหลังเขียนเอกสาร (26 พ.ย.):** `5ddd723` ค้นคำค้นในคอลัมน์ชื่อของทะเบียนก่อนจัดอันดับ ผ่าน RPC เดิม ไม่ต้อง migration
> (ข้อ 3 ข แบบจำกัดเฉพาะทะเบียน ดู ADR 0002) และแก้ข้อความล้มเหลวไม่ให้โทษผู้ใช้ (ข้อ 9); `3e706a3` อธิบายเหตุที่ DB ปฏิเสธ
> ได้ครบขึ้น และไม่คืน `problems` ว่าง (ข้อ 6 ฝั่ง JS) และนับ `invalid_input` กับย่อหน้าซ้ำในรายงาน eval (ข้อ 10; นับย่อหน้าเพราะรายการสินค้ามีบรรทัด "ข้อมูลสต็อก …" ซ้ำทุกรายการโดยตั้งใจ).
> ข้อ 5 (tie-break, สองลำดับ) ยังไม่ทำ

## สรุปสถานะ

| # | ไอเดีย | หลักฐานหลัก | จุดในโค้ด | คำตัดสิน |
|---|---|---|---|---|
| 1 | Selector ต้องเห็นคอลัมน์ ไม่ใช่แค่ชื่อ + คำอธิบาย | CHESS, RESDSQL, MAC-SQL, DIN-SQL, RSL-SQL | `rerank` ใน `retrieval.mjs` | **ทำแล้วใน v6**; adaptive cap **ทำเลย** |
| 2 | Recall ของแหล่งที่จำเป็นสำคัญกว่า precision | Death of Schema Linking, Long-context (PVLDB'25), CRUSH4SQL, Spider 2.0 | `retrieveSources`, top-6 | **คงไว้** + วัด hit@6 |
| 3 | คำอธิบายที่แยกแหล่งกันได้จริง + value hints | OpenAI data agent, ReFoRCE, CHASE-SQL, CHESS | `ops.chat_sources` | **ทีหลัง** (migration / semantic search) |
| 4 | Data agent โอเพนซอร์ส: index อะไร คืนอะไรเมื่อพัง | LangChain, LlamaIndex, Vanna, WrenAI, Dataherald, DB-GPT | ทั้ง pipeline | อ้างอิงให้ข้อ 1, 6, 9 |
| 5 | ลำดับและ tie ใน listwise ranker | RankGPT, Lost in the Middle, PSC, PRP, Wang et al. | sort ใน `retrieveSources` | tie-break **ทำเลย**; two-order merge **ทีหลัง** |
| 6 | Tool error บอก argument + เหตุผล + ทางเลือก | Anthropic, MCP spec, SWE-agent, PostgreSQL style guide | `queryProblems`, `vmi_chat_database` | **v6 บางส่วน**; JS **ทำเลย**; reason code จาก RPC **ทีหลัง** (migration) |
| 7 | Self-correction ต้องมี feedback ภายนอก และจำกัดรอบ | Huang et al., CRITIC, Self-Debugging, DIN-SQL, MAGIC | harness corrections | **คงไว้** (2 รอบ) |
| 8 | Execution-guided repair (error / ผลว่าง) | CHESS, CHASE-SQL, MAC-SQL, Long-context | `emptyHints`, `near_matches` | **v6 บางส่วน** — วัดก่อนเพิ่ม |
| 9 | ข้อความล้มเหลวถึงผู้ใช้: ครั้งเดียว ไม่โทษผู้ใช้ มีทางไปต่อ | Microsoft UX, NN/g, Google PAIR, WrenAI | `runAgent`, `renderRecordedResult` | **v6 dedupe แล้ว**; reword **ทำเลย** |
| 10 | Eval ที่นับ tool error และจำนวน call | Anthropic (2025) | `evals/run.mjs` | **ทำเลย** |

---

## 1. Selector ต้องเห็นคอลัมน์ — **ทำแล้วใน v6; adaptive cap ทำเลย**

**วัดแล้ว**
- CHESS (Talaei et al., 2024, [arXiv 2405.16755](https://arxiv.org/abs/2405.16755)): ขั้น filter_column ให้ LLM ดูทีละคอลัมน์ (ชื่อตาราง, ชื่อคอลัมน์, type, คำอธิบายและค่าตัวอย่างที่ค้นด้วย LSH + embedding); select_tables / select_columns เห็น sub-schema พร้อมค่าตัวอย่าง และคง PK/FK ไว้เสมอ. Ablation บน BIRD dev subsample 147 ข้อ: ครบ 64.62 EX; ตัด select_tables 58.50 (−6.12), ตัด select_columns 59.18 (−5.44), ตัด filter_column 61.90 (−2.72), ตัดการดึงค่า + คำอธิบาย 59.86 (−4.76). หลังเลือกตาราง table recall 0.97 ขณะ precision ขึ้นจาก 0.33 เป็น 0.89 (ตัวอย่างเล็ก ตีความระวัง)
- RESDSQL (Li et al., AAAI 2023, [arXiv 2302.05965](https://arxiv.org/abs/2302.05965)): cross-encoder จัดอันดับตารางโดยป้อนชื่อตารางต่อด้วยคอลัมน์ทั้งหมดของมัน และเพิ่ม column-enhanced layer เพราะคำถามมักเอ่ยถึงคอลัมน์โดยไม่เอ่ยชื่อตาราง (แบบเดียวกับ "…มีรหัสอะไร"). ผลวัดของ layer นี้เล็ก (total AUC 1.9930 vs 1.9904, Spider) แต่การส่ง schema ที่เรียงตามความเกี่ยวข้องแทนลำดับเดิมให้ EX 77.9 vs 70.1 (Spider dev)
- MAC-SQL (Wang et al., COLING 2025, [arXiv 2312.11242](https://arxiv.org/abs/2312.11242)): Selector เห็นชื่อตาราง/คอลัมน์ คำอธิบายคอลัมน์ ค่าตัวอย่าง และ FK; ทำงานเฉพาะเมื่อ schema เกิน ~0.8 ของ context. BIRD dev 59.39 → 57.28 เมื่อตัด Selector; ถ้าให้ oracle schema ได้ 70.28
- DIN-SQL (Pourreza & Rafiei, NeurIPS 2023, [arXiv 2304.11015](https://arxiv.org/abs/2304.11015)): schema linking เป็นหมวด failure ใหญ่สุดของ few-shot prompting; ตัด module นี้ EX 69.9 → 65.9 (Spider dev, CodeX); สำหรับ BIRD ใส่ sample rows ต่อตารางเพื่อช่วย linking
- RSL-SQL (Cao et al., 2024, [arXiv 2411.00073](https://arxiv.org/abs/2411.00073)): ตัดคำอธิบายคอลัมน์ออกจาก schema ที่ย่อแล้ว EX ลด 1.17 (GPT-4o) / 1.37 (DeepSeek) บน BIRD dev
- DAIL-SQL (Gao et al., 2023, [arXiv 2308.15363](https://arxiv.org/abs/2308.15363)): แสดง schema เป็น `CREATE TABLE` พร้อม PK/FK; ใส่ foreign key เพิ่ม EX 0.6–2.9% กับโมเดล OpenAI ส่วนใหญ่บน Spider dev (มี 2 คู่ที่ลดลงเล็กน้อย)

**ใช้กับ Synapse:** v6 ส่ง `columns` (ตัด lineage, naming ก่อน, ≤16) ให้ ranker แล้ว ตรงกับหลักฐาน. คำนวณจาก catalog snapshot ใน `source-ranking-v1.json` (122 แหล่ง) ด้วย regex เดียวกับ v6: payload มีคอลัมน์ ≈ 32.9k ตัวอักษร (name + description อย่างเดียว ≈ 14.3k) จึงยังอยู่ใต้ 40k. **ทำเลย (เล็ก):** เมื่อเกิน 40k ให้ลดคอลัมน์ต่อแหล่ง (16→10→6) แทนการ fallback ไปส่งแค่ name + description ซึ่งคือสภาพที่เลือกผิดตั้งแต่แรก; วัดด้วย top1 / hit@6

## 2. Recall มาก่อน precision — **คงไว้ + วัด**

**วัดแล้ว**
- The Death of Schema Linking? (Maamari et al., 2024, [arXiv 2408.07702](https://arxiv.org/abs/2408.07702)): บน BIRD dev (10% ต่อ DB) สัดส่วนคำถามที่ได้คอลัมน์จำเป็นครบ (SLR) ของวิธีตัด schema: table-then-column 77.4%, single-column 88.8%, hybrid 90.4% (full schema 100%); pipeline ft:GPT-4o ที่ไม่ตัด schema ได้ 67.35 EX แต่ใส่ linking แล้วเหลือ 62.58 / 55.78. ผู้เขียนแนะนำให้ใช้ context ให้เต็มเพื่อเก็บ top-K คอลัมน์ และยอมรับว่าโมเดลเล็กหรือรุ่นเก่ายังได้ประโยชน์จาก linking
- Long-context NL2SQL (Chung et al., Google, PVLDB 18(8) 2025, [arXiv 2501.12372](https://arxiv.org/abs/2501.12372)): Gemini-1.5-pro บน BIRD dev — top-1 ตาราง 38.01 EX (recall 45%), top-7 54.69 (82%), ทุกตารางใน DB 62.32 (100%), ทุกตารางทั้ง dataset 62.58; ผู้เขียนรายงานตารางไม่เกี่ยวข้องเฉลี่ย 68 ตารางต่อคำขอและสรุปว่าโมเดลไม่สับสนมาก; ค่าตัวอย่างคอลัมน์ +1.76 (ข้อยาก +5.52)
- CRUSH4SQL (Kothyari et al., EMNLP 2023, [arXiv 2311.01173](https://arxiv.org/abs/2311.01173)): embedding ของคำถามก้อนเดียวมักดึงได้แค่บางส่วนของ schema ที่ต้องใช้; ให้ LLM เดา schema ขั้นต่ำก่อนแล้วค้นรวม → recall@10 BirdUnion 0.56 → 0.71, SpiderUnion 0.77 → 0.83
- Spider 2.0 (Lei et al., ICLR 2025, [arXiv 2411.07763](https://arxiv.org/abs/2411.07763)): ~800 คอลัมน์ต่อ DB; agent ดีสุด 21.36% (o1-preview); จาก 300 failure ที่สุ่ม 27.6% คือ schema linking ผิด; ในชุด lite ทุกวิธีได้ค่าตัวอย่างแบบ markdown เพราะ type อย่างเดียวไม่พอ (ไม่มีตัวเลข ablation)

**ใช้กับ Synapse:** โครง "lexical → LLM rank → top-6 พร้อม columns ให้ agent" สอดคล้องกับหลักฐาน **คงไว้** และอย่ากลับไปตัด candidate ด้วยเกณฑ์ที่ลด recall (commit `18b3cf6` เลิกตัดตามตัวอักษรแล้ว). ไม่แนะนำให้ข้าม ranker แล้วส่ง catalog ทั้งหมดให้ agent ทุก turn: หลักฐาน "ไม่ต้อง linking" มาจาก GPT-4o / Gemini ส่วน Typhoon 30B-A3B น่าจะอยู่ฝั่งโมเดลเล็ก (ยังไม่ได้วัด). ทดลองเพิ่ม top-K 6→8 **เฉพาะ** เมื่อ source-ranking-v1 พบแหล่งที่ถูกที่อันดับ 7–8

## 3. คำอธิบายที่แยกแหล่งกันได้ + value hints — **ทีหลัง (migration / semantic search)**

**สภาพปัจจุบัน (นับจาก snapshot):** คำอธิบายใน `ops.chat_sources` = ชื่อตาราง + keyword set ต่อหมวด (มีเพียง 2 จาก 122 แหล่งที่มี table comment); 9 แหล่งใช้ชุด "พัสดุ วัสดุ …" ร่วมกัน (`core.materials` ต่างจาก `core.material_packaging` แค่คำ "materials" กับ "material packaging"), 36 แหล่งใช้ชุด "ข้อมูลระบบ นำเข้า …", 21 แหล่งใช้ชุดขนส่ง

**แนะนำ (ไม่มีตัวเลข)**
- OpenAI in-house data agent (engineering post, 29 Jan 2026, [openai.com](https://openai.com/index/inside-our-in-house-data-agent/)): ใช้ schema metadata, lineage, query ย้อนหลัง, annotation จากคน และนิยามตารางที่ Codex ดึงจากโค้ดที่สร้างตาราง เพื่อแยกตารางที่ดูคล้ายกันแต่ต่างกันในจุดสำคัญ; บทเรียนคือความหมายจริงของตารางอยู่ในโค้ด ไม่ใช่ใน schema

**วัดแล้ว**
- ReFoRCE (Deng et al., 2025, [arXiv 2502.00675](https://arxiv.org/abs/2502.00675)): รวมตารางชื่อคล้าย (prefix/suffix เดียวกัน) ให้เหลือตัวแทนแสดงเต็ม 1 ตาราง; ตัดการบีบนี้ EX −3.65 (Spider 2.0-Snow) / −3.48 (Lite)
- ค่าในคอลัมน์ช่วยเลือก: CHASE-SQL ([arXiv 2410.01943](https://arxiv.org/abs/2410.01943)) ตัด LSH value retrieval 73.01 → 70.09 (BIRD dev); CHESS −4.76 (ข้อ 1); Dataherald มี tool หาค่าใกล้เคียงในคอลัมน์ด้วย difflib ≥0.4 + ILIKE ([code](https://github.com/Dataherald/dataherald/blob/main/services/engine/dataherald/sql_generator/dataherald_sqlagent.py))

**ใช้กับ Synapse:** (ก) เขียนคำอธิบายต่อแหล่งจากนิยามจริง (view SQL, migration, `COMMENT ON`) เช่น "หนึ่งแถวต่อ SKU × บรรจุภัณฑ์ ไม่มีชื่อวัสดุ ใช้ `core.materials` หาชื่อ" — ต้องแก้ snapshot ใน `ops.chat_sources` = **database migration** → ทีหลัง หลังวัด v6. (ข) ค้น "ค่า" ชื่อสินค้าข้ามหลายแหล่งเพื่อเลือกตาราง ต้องมี RPC ใหม่ (migration) หรือ semantic search (BGE-M3 ยังติด credentials) → ทีหลัง. ไม่ใช้การรวมตารางแบบ ReFoRCE เพราะแหล่งชื่อคล้ายของเราโครงสร้างต่างกัน (ไม่ใช่ sharded tables แบบ Spider 2.0)

## 4. Data agent โอเพนซอร์ส: index อะไร คืนอะไรเมื่อ query พัง — **อ้างอิง**

| ระบบ | ข้อความที่ใช้เลือกตาราง | เมื่อ query ล้มเหลว |
|---|---|---|
| LangChain SQL toolkit ([tool.py](https://github.com/langchain-ai/langchain-community/blob/main/libs/community/langchain_community/tools/sql_database/tool.py), [sql_database.py](https://github.com/langchain-ai/langchain-community/blob/main/libs/community/langchain_community/utilities/sql_database.py), [toolkit.py](https://github.com/langchain-ai/langchain-community/blob/main/libs/community/langchain_community/agent_toolkits/sql/toolkit.py)) | `sql_db_list_tables` คืนแค่ชื่อ; `sql_db_schema` คืน `CREATE TABLE` + 3 sample rows (column comment ปิดเป็น default, ไม่มี table comment); `sql_db_query_checker` ให้ LLM ตรวจ query ก่อนรัน | คืนข้อความ error ดิบของ DB; คำอธิบาย tool สั่งให้เขียน query ใหม่ และถ้าเจอ unknown column ให้เรียก schema tool |
| LlamaIndex ([table_node_mapping.py](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/objects/table_node_mapping.py), [sql_wrapper.py](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/utilities/sql_wrapper.py), [sql_retriever.py](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/indices/struct_store/sql_retriever.py)) | node ต่อตาราง = ชื่อ + คอลัมน์ (type, comment) + FK + `context_str` ที่คนเขียน แล้ว embed | `NLSQLRetriever` คืน error ดิบเป็น node; ไม่มี retry loop |
| Vanna ([legacy base.py](https://github.com/vanna-ai/vanna/blob/main/src/vanna/legacy/base/base.py), [run_sql.py](https://github.com/vanna-ai/vanna/blob/main/src/vanna/tools/run_sql.py)) | DDL, documentation, คู่ question–SQL ใน vector store (งบ DDL + docs ~14k tokens) | legacy: print แล้วจบ ไม่ส่งกลับ LLM; v2 `RunSqlTool` คืน error ดิบ ไม่มีคำแนะนำ |
| WrenAI ai-service tag `release/ai-service/0.29.3` ([table_description.py](https://github.com/Canner/WrenAI/blob/release/ai-service/0.29.3/wren-ai-service/src/pipelines/indexing/table_description.py), [db_schema.py](https://github.com/Canner/WrenAI/blob/release/ai-service/0.29.3/wren-ai-service/src/pipelines/indexing/db_schema.py), [db_schema_retrieval.py](https://github.com/Canner/WrenAI/blob/release/ai-service/0.29.3/wren-ai-service/src/pipelines/retrieval/db_schema_retrieval.py), [sql_correction.py](https://github.com/Canner/WrenAI/blob/release/ai-service/0.29.3/wren-ai-service/src/pipelines/generation/sql_correction.py), [ask.py](https://github.com/Canner/WrenAI/blob/release/ai-service/0.29.3/wren-ai-service/src/web/v1/services/ask.py)) | doc ต่อตาราง = {ชื่อ, description, ชื่อคอลัมน์} ค้น top-10; DDL ใส่ alias/description/สูตร calculated field; LLM ตัดคอลัมน์เฉพาะเมื่อ DDL เกิน context หรือเปิด option | dry-run → แก้ได้ ≤3 รอบ โดยส่ง SQL ที่ผิด + error (หรือคำวินิจฉัยจาก LLM) → ล้มหมดคืนสถานะล้มเหลวเดียว `NO_RELEVANT_SQL` |
| Dataherald ([dataherald_sqlagent.py](https://github.com/Dataherald/dataherald/blob/main/services/engine/dataherald/sql_generator/dataherald_sqlagent.py), push ล่าสุด 2024-07) | embed "ชื่อตาราง + คอลัมน์พร้อมคำอธิบาย + คำอธิบายตาราง" เลือก top-20; tool ดูค่า/หมวดในคอลัมน์ | คืน error ดิบ; คำอธิบาย tool ให้เขียนใหม่แล้วลองอีก |
| DB-GPT ([rdbms_db_summary.py](https://github.com/eosphoros-ai/DB-GPT/blob/main/packages/dbgpt-ext/src/dbgpt_ext/rag/summary/rdbms_db_summary.py), [db_schema.py](https://github.com/eosphoros-ai/DB-GPT/blob/main/packages/dbgpt-ext/src/dbgpt_ext/rag/retriever/db_schema.py), [out_parser.py](https://github.com/eosphoros-ai/DB-GPT/blob/main/packages/dbgpt-app/src/dbgpt_app/scene/chat_db/auto_execute/out_parser.py)) | summary "ตาราง(คอลัมน์ (comment), …) + index + table comment" ใน vector store; ตารางกว้างแยก field chunk | chat_db แสดง "ERROR!" + error ดิบต่อผู้ใช้ ไม่ retry |

**ข้อสังเกตจากโค้ด (ไม่มีตัวเลขวัด):** 5 ใน 6 ระบบใส่ชื่อคอลัมน์ไว้ในข้อความที่ใช้เลือกตาราง (LangChain ให้ agent ขอ schema เองหลังเห็นชื่อ); ทุกระบบที่ส่ง error กลับ LLM ส่ง **ข้อความ error ดิบ** ของ DB ซึ่งมักระบุคอลัมน์หรือค่าที่ผิดมาด้วย. WrenAI main ปัจจุบันเปลี่ยนเป็น semantic/context layer ให้ agent ภายนอก จึงอ่านจาก tag ล่าสุดที่ยังมี ai-service

**ใช้กับ Synapse:** `vmi_chat_database` ตั้งใจกลืน exception เหลือ `invalid_input` เปล่า (security definer; ไม่ควรส่ง SQL หรือรายละเอียดภายในให้โมเดล) จึงเสียข้อมูลที่ระบบอื่นได้ฟรี ต้องชดเชยด้วย validator ที่บอกเหตุผลเอง (ข้อ 6). รูปแบบ WrenAI (ตรวจก่อนรัน, แก้ ≤3 รอบ, ล้มแล้วรายงานครั้งเดียว) ใกล้ harness ของเราที่สุด ใช้เป็นต้นแบบข้อ 6 และ 9

## 5. ลำดับและ tie ใน listwise ranker — **tie-break ทำเลย; two-order merge ทีหลัง**

**วัดแล้ว**
- RankGPT (Sun et al., EMNLP 2023, [ACL Anthology](https://aclanthology.org/2023.emnlp-main.923/)): gpt-3.5-turbo บน TREC-DL19 nDCG@10 = 65.80 เมื่อเริ่มจากลำดับ BM25, 25.17 เมื่อสุ่มลำดับ, 32.77 เมื่อกลับลำดับ (มี sliding window ร่วมด้วย จึงไม่ใช่ position bias ล้วน)
- Lost in the Middle (Liu et al., TACL 2024, [ACL Anthology](https://aclanthology.org/2024.tacl-1.9/)): ความแม่นเป็นรูป U ตามตำแหน่งข้อมูลที่เกี่ยวข้อง; GPT-3.5-Turbo กับ 20–30 เอกสาร ถ้าคำตอบอยู่กลางอาจต่ำกว่าการไม่ใส่เอกสารเลย (56.1%); การวางคำถามทั้งก่อนและหลังเอกสารช่วยงาน key-value สังเคราะห์ได้เกือบเต็ม แต่แทบไม่ช่วย multi-document QA
- Wang et al. 2023 ([arXiv 2305.17926](https://arxiv.org/abs/2305.17926)): สลับลำดับสองคำตอบแล้ว GPT-4 เปลี่ยนคำตัดสิน 46.3% สำหรับคู่ที่คุณภาพใกล้กัน แต่ 5.0% สำหรับคู่ที่ห่างกัน; อัตราขัดแย้งแปรผกผันกับช่องว่างคะแนน → **ยิ่ง candidate คล้ายกัน ตำแหน่งยิ่งเป็นตัวตัดสิน**; ให้คะแนนทั้งสองลำดับแล้วเฉลี่ย (BPC) + ให้เหตุผลก่อนให้คะแนน (MEC) เพิ่มความตรงกับคน 9.8% (GPT-4) / 14.3% (ChatGPT)
- Permutation self-consistency (Tang et al., NAACL 2024, [ACL Anthology](https://aclanthology.org/2024.naacl-long.129/)): สลับลำดับ list หลายรอบแล้วรวมด้วย Kemeny ranking ดีขึ้นสูงสุด 7–18% (GPT-3.5), 8–16% (LLaMA-2-70B); 5 รอบได้ ~67% ของประโยชน์จาก 20 รอบ; temperature sampling ไม่ช่วย; GPT-3.5 จัดรายการหลังตำแหน่งที่ ~15 ได้แย่
- PRP (Qin et al., NAACL 2024, [arXiv 2306.17563](https://arxiv.org/abs/2306.17563)): ถามแต่ละคู่สองลำดับ ถ้าขัดกันนับเสมอ (0.5); คะแนนรวมเสมอให้ใช้ **ลำดับขั้นแรก** ตัดสิน
- Hou et al. ([arXiv 2305.08845](https://arxiv.org/abs/2305.08845)): candidate ที่ถูกอยู่ท้าย list ได้อันดับแย่ลงชัด; สุ่มลำดับ 3 รอบแล้วรวมช่วยได้ (มีแต่กราฟ ไม่มีตัวเลขในเนื้อความ)

**ข้อสรุป (อนุมาน ไม่มีแหล่งวัดตรง):** ถ้าข้อความที่ ranker เห็นของสอง candidate เหมือนกัน ไม่มีวิธีจัดอันดับไหนกู้ข้อมูลที่ไม่มีได้ การรวมหลายลำดับแค่ลบความชอบตำแหน่ง และตาม PRP ผลเสมอจะตกไปที่ลำดับขั้นแรก ตัว tie-break จริงจึงเป็น (1) ข้อมูลที่แยกได้ (ข้อ 1, 3) และ (2) ลำดับขั้นแรกที่มีเหตุผล

**ใช้กับ Synapse:** `retrieveSources` ยังตัด tie ด้วย `source_id` ตามตัวอักษร (`core.material_packaging` มาก่อน `core.materials`) และส่งถึง 122 แหล่งเมื่อ match < 30. **ทำเลย:** เปลี่ยน comparator เป็นกฎที่กำหนดเอง เช่น คะแนน lexical → จำนวน token ที่ตรงชื่อคอลัมน์ → ลำดับ schema (`core` > `analytics` > `ops`/`reference_data` > `staging` > `raw`) → `source_id`; แก้โค้ดจุดเดียว ไม่เปลี่ยน payload 40k. ยังไม่ตัดความยาว list (แลก recall) ให้ eval ตัดสินจากตำแหน่งของแหล่งที่ถูกใน input (ข้อ 10). **ทดลองฟรี:** ใส่ `question` ซ้ำหลังรายการ candidates (หลักฐานอ่อน). **ทีหลัง:** เรียก ranker สองลำดับ (ปกติ + กลับด้าน) ขนานกันแล้วรวมแบบ Borda — 2× call ต่อ discover, payload เท่าเดิม; ทำเมื่อ eval ชี้ว่าพลาดเพราะตำแหน่ง

## 6. Tool error บอก argument, เหตุผล และทางเลือก — **v6 บางส่วน; JS ทำเลย; RPC ทีหลัง**

**แนะนำ (ไม่มีตัวเลข)**
- Anthropic, Writing effective tools for agents (11 Sep 2025, [anthropic.com](https://www.anthropic.com/engineering/writing-tools-for-agents)): ทำ error ให้บอกสิ่งที่ต้องแก้แบบเจาะจงและทำได้จริง แทน error code หรือ traceback; แสดงตัวอย่าง input ที่ถูก; invalid-parameter บ่อยแปลว่าคำอธิบาย tool ต้องแก้; เลี่ยง tool ที่หน้าที่ซ้อนกัน
- Anthropic, Building effective agents (19 Dec 2024, [anthropic.com](https://www.anthropic.com/engineering/building-effective-agents)): ออกแบบ argument แบบ poka-yoke ให้ผิดยาก, ให้ agent ได้ ground truth จาก environment ทุก step, มี stopping condition
- MCP spec 2025-11-25 ([Tools › Error Handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)): input validation error เป็น tool execution error (`isError: true`) ที่มี feedback ให้โมเดลแก้แล้วลองใหม่ และ client SHOULD ส่งให้โมเดล; ตัวอย่างในสเปกระบุ argument, กฎที่ผิด และค่าอ้างอิง
- PostgreSQL error style guide ([docs](https://www.postgresql.org/docs/current/error-style-guide.html)): แยก primary (ผิดอะไร หนึ่งบรรทัด) / detail (ข้อเท็จจริง) / hint (ควรทำอะไร), ใส่ค่าที่ผิดเสมอ และบอกชนิด object
- Microsoft Windows UX ([Error messages](https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-error)): error ที่ดี = ปัญหา + สาเหตุ + ทางแก้; โค้ดจัดการ error ต้องเก็บสาเหตุและพารามิเตอร์ตั้งแต่ชั้นล่าง จะมาเติมที่ UI ทีหลังไม่ได้

**วัดแล้ว**
- SWE-agent (Yang et al., 2024, [arXiv 2405.15793](https://arxiv.org/abs/2405.15793)): linter ปฏิเสธ edit ที่ทำ syntax พัง พร้อมแสดง error, ผลที่ edit จะได้ และโค้ดเดิม → resolve 18.0% vs 15.0% เมื่อไม่มี (SWE-bench Lite, GPT-4 Turbo); search ที่สรุปผลและจำกัด 50 รายการ (เกินให้ขอ query ที่แคบลง) 18.0% vs แสดงทีละรายการ 12.0% vs ไม่มี search 15.7%; โอกาส edit สำเร็จในที่สุด 90.5% เหลือ 57.2% หลัง edit พังหนึ่งครั้ง

**ใช้กับ Synapse:** v6 แล้ว: คอลัมน์ที่ไม่มีในแหล่ง → ชี้แหล่งที่ค้นได้ซึ่งมีคอลัมน์นั้น หรือให้ discover ใหม่. ที่ยังขาด: RPC ปฏิเสธด้วยเหตุที่ `queryProblems` ไม่ mirror — ค่าใน `eq/ne/gt/…` cast เข้า type คอลัมน์ไม่ได้ (`invalid_text_representation`), คอลัมน์ซ้ำใน `columns`/`group_by`, ใช้ `*` กับ metric ที่ไม่ใช่ `count`, ชื่อผล metric ซ้ำ, `search` > 200 หรือ value > 1000 ตัวอักษร (operator, จำนวน filter, `limit`/`offset` กันไว้แล้วด้วย JSON schema ของ tool) → `problems: []` → โมเดลไม่รู้ว่าผิดตรงไหน = สภาพเดียวกับลูป 4 ครั้ง. **ทำเลย (ไม่ต้อง migration):** mirror ทุก check ข้างต้นใน `queryProblems` และรันเป็น pre-flight ก่อนยิง DB แบบ linter ของ SWE-agent / dry-run ของ WrenAI (เฉพาะ check ที่ DB ปฏิเสธจริง) ถ้าไม่มี rule ใดตรงให้บอกตรง ๆ ว่าระบุสาเหตุไม่ได้ พร้อมขั้นต่อไปที่ปลอดภัย. **ทีหลัง (database migration):** ให้ `vmi_chat_database` คืน `{reason, argument, value, allowed}` ตามรูป primary/detail/hint โดยไม่ส่ง SQL ดิบ

## 7. Self-correction ต้องมี feedback ภายนอก และจำกัดรอบ — **คงไว้**

**วัดแล้ว**
- Huang et al. (ICLR 2024, [arXiv 2310.01798](https://arxiv.org/abs/2310.01798)): self-correction ที่ไม่มี feedback ภายนอกทำให้แย่ลง — GPT-3.5 GSM8K 75.9 → 74.7, CommonSenseQA 75.8 → 41.8; GPT-4 GSM8K 95.5 → 89.0 (2 รอบ); โมเดลเปลี่ยนคำตอบถูกเป็นผิดบ่อยกว่าผิดเป็นถูก; ตัวเลขที่ "ดีขึ้น" ในงานก่อนหน้าพึ่ง oracle label
- Self-Debugging (Chen et al., 2023, [arXiv 2304.05128](https://arxiv.org/abs/2304.05128)): feedback ยิ่งมีผลการรันยิ่งช่วย — TransCoder GPT-4 77.3 → 80.9 (บอกแค่ว่าผิด) → 88.8 (ผล unit test) → 90.4 (+อธิบายโค้ด); ไม่รันโค้ดได้สูงสุด 78.4; บน Spider (ไม่มี unit test) GPT-4 73.2 → 73.6 เท่านั้น เพราะแยก SQL ถูก/ผิดเองไม่ได้; ส่วนใหญ่แก้รอบเดียวพอ
- CRITIC (Gou et al., ICLR 2024, [arXiv 2305.11738](https://arxiv.org/abs/2305.11738)): ตัด tool เหลือ critique ตัวเองได้แค่ −0.03 / +2.33 F1 (QA) และแก้โปรแกรมโดยไม่มี interpreter ลดลงได้ (−1.8); 2–3 รอบให้ประโยชน์เกือบทั้งหมด
- DIN-SQL: prompt แก้แบบบอกว่า "SQL นี้มีบั๊ก" กับ GPT-4 ทำให้ 73.3 → 70.0 (แบบ gentle ได้ 74.2)
- MAGIC (Askari et al., 2024, [arXiv 2406.12692](https://arxiv.org/abs/2406.12692)): ใช้ guideline แก้ของ DIN-SQL กับทุก SQL ได้ 55.80 ต่ำกว่าไม่แก้ (56.52); guideline ที่สร้างจาก failure จริงได้ 58.55

**ใช้กับ Synapse:** harness ส่ง correction เฉพาะเมื่อ check ที่ตรวจได้จริงล้ม (`unsourced_code`, `repeated_call`, `SEARCH_FIRST`, argument ไม่ผ่าน schema) จำกัด 2 ครั้ง และ `invalid_input` กลับไปเป็นผล tool พร้อม `problems` ภายใต้งบ step — ตรงกับหลักฐาน (CRITIC 2–3 รอบ, SWE-agent โอกาสกู้ลดหลังพลาด) **คงไว้**; อย่าเพิ่ม turn "ตรวจคำตอบตัวเองอีกรอบ" ที่ไม่มีหลักฐานใหม่. Reviewer ตรวจกับ evidence จึงไม่ใช่ intrinsic self-correction

## 8. Execution-guided repair (error / ผลว่าง) — **v6 บางส่วน, วัดก่อนเพิ่ม**

**วัดแล้ว (text-to-SQL)**
- CHESS: ตัด revise (แก้เมื่อ syntax error หรือผลว่าง) 64.62 → 57.82; แก้ 1 รอบได้ 61.22
- CHASE-SQL: ตัด query fixer (syntax error / ผลว่าง, ≤3 รอบ) 73.01 → 69.23
- MAC-SQL: ตัด Refiner (error message + ผลว่าง, ≤3 รอบ) 59.39 → 54.76
- Long-context (Chung et al.): แก้เมื่อ syntax error / ผลว่าง +2.81 EX, ขยายค่าตัวอย่างเมื่อผลว่าง +0.71; ผู้เขียนระบุว่าวิธีนี้จับ semantic error ไม่ได้

**ใช้กับ Synapse:** `near_matches` (pg_trgm) + `emptyHints` ของ v6 (filter `is_null`, `eq` บนข้อความ) คือ execution feedback แบบเดียวกัน **วัดก่อนเพิ่ม**: นับใน heldout ว่ากี่ run ที่ได้ `no_data` แล้วกู้ได้ใน step ถัดไป

## 9. ข้อความล้มเหลวถึงผู้ใช้ — **v6 dedupe แล้ว; reword ทำเลย**

**แนะนำ (ไม่มีตัวเลข)**
- Microsoft Windows UX ([Error messages](https://learn.microsoft.com/en-us/windows/win32/uxguide/mess-error)): บอกปัญหา สาเหตุ ทางแก้; ถ้าผู้ใช้จะปิดข้อความโดยไม่ทำอะไร ไม่ต้องแสดง; อย่าให้ผู้ใช้ต้อง troubleshoot เอง
- NN/g, Error-Message Guidelines (Neusesser & Sunwall, 14 May 2023, [nngroup.com](https://www.nngroup.com/articles/error-message-guidelines/)): บอกปัญหาเจาะจง ให้คำแนะนำที่ทำได้ น้ำเสียงไม่โทษผู้ใช้ เลี่ยงศัพท์เทคนิค (บทความไม่ได้พูดเรื่อง error ซ้ำหลายอัน)
- Google PAIR, Errors + Graceful Failure ([pair.withgoogle.com](https://pair.withgoogle.com/chapter/errors-failing/)): บอกว่าระบบทำอะไรไม่ได้ และเน้นทางไปต่อของผู้ใช้
- WrenAI ([ask.py](https://github.com/Canner/WrenAI/blob/release/ai-service/0.29.3/wren-ai-service/src/web/v1/services/ask.py)): แก้ได้หลายรอบแต่รายงานผู้ใช้เป็นสถานะล้มเหลวเดียวพร้อม error ล่าสุด
- ไม่พบแหล่งปฐมภูมิที่สั่งตรง ๆ ว่า "รวม error ซ้ำเป็นข้อความเดียว"; ข้อเสนอนี้อนุมานจากหลัก "ข้อความที่ไม่นำไปสู่การกระทำไม่ควรแสดง"

**ใช้กับ Synapse:** v6 แสดงแต่ละบรรทัดครั้งเดียวและซ่อน `invalid_input` เมื่อมีผลอ่านอื่น. **ทำเลย:** เมื่อมีแต่ `invalid_input` บรรทัดที่แสดงยังบอกผู้ใช้ให้ "ตรวจรหัส" ทั้งที่ query ที่ผิดเป็นของโมเดล → เปลี่ยนเป็นบอกสิ่งที่เกิดและทางไปต่อ (เช่น "ยังหาแหล่งข้อมูลที่ตอบคำถามนี้ไม่ได้ ลองระบุ SKU หรือชื่อเต็มของวัสดุ") และไม่ซ้อนกับบรรทัด "ตรวจสอบได้บางส่วน…" ที่ความหมายซ้ำ; วัดแบบ deterministic: บรรทัดซ้ำในคำตอบ = 0 และไม่มีคำตอบที่โทษ input ผู้ใช้เมื่อสาเหตุมาจาก query ของโมเดล

## 10. Eval ที่นับ tool error และจำนวน call — **ทำเลย**

**แนะนำ (ไม่มีตัวเลขในเนื้อความ):** Anthropic (2025, ข้อ 6) ให้ใช้ held-out test set และติดตามนอกจาก accuracy: เวลา, จำนวน tool call, tokens และ tool errors เพื่อหา call ซ้ำซ้อนและคำอธิบาย tool ที่ต้องแก้ (ผลที่บทความรายงานเป็นกราฟ ไม่มีตัวเลข)

**ใช้กับ Synapse:** เพิ่มในรายงานของ `evals/run.mjs` ต่อเคส: จำนวน `invalid_input`, `problems` ว่างหรือไม่, corrections ที่ใช้, `retrieval.status` (model_reranked vs fallback), ตำแหน่งของแหล่งที่ถูกทั้งใน input และ output ของ ranker, บรรทัดซ้ำในคำตอบ — ไม่ต้องมี infra ใหม่ และทำให้ข้อ 1, 5, 6, 9 ตัดสินด้วยตัวเลขบน 15 + 23 เคส

---

## Top 5 ที่ควรทำก่อน

1. **ปิดช่อง `invalid_input` ที่ไม่มีเหตุผล (ข้อ 6):** mirror ทุก check ของ `vmi_chat_database` ใน `queryProblems` (โดยเฉพาะ type cast ของค่าใน filter), รันเป็น pre-flight ก่อนยิง DB และไม่ปล่อย `problems` ว่าง — ไม่ต้อง migration; ปิดช่องที่ทำให้ `invalid_input` ไม่มีรายละเอียด (อาการเดียวกับลูป 4 ครั้งที่พบ)
2. **Tie-break ที่กำหนดเองแทนตัวอักษร + adaptive column cap (ข้อ 5, 1):** แก้ comparator ใน `retrieveSources` และลดคอลัมน์ต่อแหล่งแทนการทิ้งทั้งหมดเมื่อเกิน 40k; วัด top1 / hit@6 บน source-ranking-v1
3. **นับ tool error ใน eval (ข้อ 10):** `invalid_input`, problems ว่าง, corrections, ranker fallback, ตำแหน่งแหล่งที่ถูก, บรรทัดซ้ำ — ใช้ตัดสินข้ออื่นบน 15 + 23 เคส ≥2 รอบ
4. **ข้อความล้มเหลวที่ไม่โทษผู้ใช้และมีทางไปต่อ (ข้อ 9):** แก้ข้อความ `invalid_input` ใน `renderRecordedResult` และไม่ซ้อนบรรทัด partial
5. **ทดลอง ranking ที่ทนต่อลำดับ (ข้อ 5):** ใส่ question ซ้ำหลังรายการ (ฟรี) และถ้า eval ชี้ว่าพลาดเพราะตำแหน่ง ค่อยเพิ่มรอบกลับลำดับ + Borda (2× ranker call, payload เดิม)

**ถัดไปที่ต้อง migration หรือ infra ใหม่:** reason code จาก RPC (ข้อ 6), คำอธิบายแหล่งจากนิยามจริงใน `ops.chat_sources` (ข้อ 3), value-based table selection / BGE-M3 (ข้อ 3)

## ข้อจำกัดของเอกสารนี้

- ยืนยัน venue จากหน้า arXiv ไม่ได้สำหรับ CHESS, CHASE-SQL, Death of Schema Linking, SWE-agent, Self-Debugging, Wang et al., Hou et al. จึงอ้างเป็น arXiv + ปี
- CHESS ablation มาจาก subsample 147 ข้อ; ผลของ Hou et al. และ Anthropic (2025) มีแต่ในกราฟ; OpenAI data agent ไม่มีตัวเลข
- ทุกตัวเลขวัดบนโมเดลอื่น ยังไม่มีหลักฐานเฉพาะ Typhoon 2.5 — ต้องวัดเองตามข้อ 10
- โค้ดโอเพนซอร์สอ่านจาก `main` วันที่ 2026-11-26 ยกเว้น WrenAI ที่อ่านจาก tag `release/ai-service/0.29.3`; ขนาด payload และจำนวนแหล่งต่อ keyword set คำนวณเองจาก snapshot ใน `source-ranking-v1.json`
