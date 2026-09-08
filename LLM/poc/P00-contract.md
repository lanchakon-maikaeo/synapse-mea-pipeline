# P00 — ยืนยัน Supabase Test และ contract

Depends: none. Outcome: a small verified contract that prevents later modules from rediscovering the repository.

Read first: CONTEXT + STATE. Entry points: `README.md`, `dashboard/app/m09-openapi.ts`, `dashboard/app/api/[...path]/route.ts`, `dashboard/docs/BUSINESS_RULES_V1.md`. Follow only SQL dispatchers/read views and identity helpers used by the five tools; inspect latest overriding migrations, not only original definitions.

Work:
1. Inspect current Git/worktree and available Supabase projects read-only. Select an existing authorized Test target by verified identity; if none exists, record the missing target and prepare local work. Do not create a billed project or use Production implicitly.
2. Map all five tools to exact reads, arguments, output fields, business meaning, units, freshness and provenance. Identify actual gaps requiring a read RPC; freeze result shape in CONTEXT. Keep tool-specific role×district rules aligned with governed permissions, including global vs district-scoped reads.
3. Define 20 Thai intents, four per tool, with expected arguments and reference result/status against a versioned Test dataset. Put development cases in `LLM/poc/eval-dev.jsonl` when implementing; don't invent operational truth.
4. Record named Test fixture actors spanning permitted roles, two distinct districts and denied access. Fixtures must be explicitly Test-only; provision in P01.
5. Record branch/feature isolation, dataset classification and endpoint/spending prerequisites for P03. Choose no live inference until these are resolved.

VMI intent seeds (placeholders are bound to actual Test fixture IDs in this module):

| Tool | Four in-scope intents |
|---|---|
| stock | วัสดุ X คลองเตยเหลือเท่าไร; วัสดุ X เขต Y เหลือเท่าไร; ข้อมูลสต็อก X วันที่ใด; ค่า 0 ของ X มาจาก source หรือ owner attestation |
| replenishment | CMP ของ X เขต Y เท่าไร; ทำไม X เข้าเกณฑ์เติม; MIN/MAX fill ของ X เท่าไร; CMP=0 ทำไมจึงไม่มีคำแนะนำ |
| plan | แผน P สถานะใด; แผน P รอขั้นตอนใด; แผน P มีประวัติอนุมัติอะไร; แผน P ล็อกแล้วหรือยัง |
| contract | ค้นสัญญา C; ค้น PO P; สัญญา C แสดงสถานะใด; PO P มีรายการอ้างอิงใดในผลที่ได้รับสิทธิ์ |
| traceability | Issue I มาจาก PO ใด; HU H ถูกจ่ายไปเขตใด; PO P เชื่อมการจ่ายใด; วัสดุ X มีหลักฐานการจ่ายย้อนหลังอะไร |

Don't fabricate missing timestamps, vendor identities, approval actions or pre-go-live movements. A seed unsupported by data must explicitly expect no_data/clarify or identify a narrowly scoped read gap; don't replace it with an energy/billing question.

Deliver: update CONTEXT verified-contract section, development cases and STATE. No application/schema changes in this module.

Acceptance: every tool has a concrete source, arguments/projection, permission rule and example; Test identity is verified; missing data is explicit; no guessed API fields. If Test access is unavailable, record local progress and missing input, not `done`. No full CI for a documentation-only contract.

Handoff: exact relevant source/function names, decisions, remaining inputs; no large schema dumps or course PDFs.
