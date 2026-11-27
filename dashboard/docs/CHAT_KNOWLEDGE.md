# Chat assistant

The chat widget (`app/chat-widget.tsx`) shows for signed-in users outside demo mode and posts to `/api/chat`. The route uses the caller's Supabase JWT. Every database read goes through SECURITY DEFINER or RLS-checked functions that take identity from `auth.uid()`, never from model output.

## Configuration

Server-only Vercel variables on `mea-synapse-web`, Production:

- `LLM_API_KEY`: OpenRouter key (`sk-or-...`). It is used for chat and for embeddings. Never prefix it with `NEXT_PUBLIC_`.
- `LLM_MODEL`: an OpenRouter `provider/model` ID that supports tool calling. Default: `openai/gpt-4o-mini`.
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers AI): BGE-M3 embeddings for any chat provider. With them, a search that finds no exact row asks the database again by meaning (ADR 0002, RRF), and the daily job embeds material names. Without them, near matches rank by text only.
- `CHAT_DOCUMENTS=on`: shows `search_knowledge` to the model. Leave it unset while `rag.knowledge_chunks_bge_m3` is empty.
- `LLM_TEMPERATURE` (default `0.4`): choosing tools and writing chat answers. Reviewing answers, ranking sources and agentic alerts stay at `0`. `LLM_TIMEOUT_MS` (default `30000`).

Redeploy after changing a value. Every question is a paid OpenRouter call. `public.vmi_chat_admit` allows 10 questions per user per minute before any model call.

Do not set `provider.require_parameters: true`. GPT-4o-mini endpoint metadata does not list `parallel_tool_calls`, so that filter can exclude every endpoint. The request still sends `parallel_tool_calls: false`, and the adapter rejects multiple calls before running any tool.

## Database (migration `202611100001_chat_assistant.sql`)

| Function | Tool |
| --- | --- |
| `vmi_chat_admit` | per-user admission before a model call |
| `vmi_chat_read` | stock, replenishment, plan, contract and traceability reads |
| `vmi_chat_overview` | stock risk and delivery overview |
| `vmi_chat_database` | `discover_database` / `query_database` over the reviewed `ops.chat_sources` catalog |
| `vmi_chat_knowledge_bge_m3` | `search_knowledge` over `rag.knowledge_chunks_bge_m3` |

`ops.chat_sources` is seeded once from the tables that exist when the migration first runs. New tables are not readable by chat until a reviewed change adds them.

## Document knowledge

Embeddings use BGE-M3 (1024 dimensions) on Cloudflare Workers AI (`/ai/run/@cf/baai/bge-m3`, at most 100 texts per call, no data retention) when the Cloudflare keys are set; otherwise OpenRouter `baai/bge-m3` through `/api/v1/embeddings` with `encoding_format: float`. OpenRouter may answer with a provider model name (`BAAI/bge-m3`, `parasail-bge-m3`). The adapter accepts these names, stores the canonical `baai/bge-m3` label, and still requires 1024 finite values.

The corpus starts empty. To import reviewed documents:
- Generate each vector with `embedText({ text: content, apiKey, taskType: 'RETRIEVAL_DOCUMENT' })`.
- Insert `source_id`, `title`, `chunk_index`, `content`, `embedding`, `allowed_roles` and an optional `district_id` into `rag.knowledge_chunks_bge_m3` over a trusted connection. The default role is admin.
- Do not store changing stock balances as documents; chat reads those live.

`vmi_chat_knowledge_bge_m3(p_embedding, p_limit, p_query)` ranks chunks in two lists, by text (`word_similarity` of the question, at least 0.4) and by meaning (cosine, at least 0.5), and fuses them with Reciprocal Rank Fusion (k = 60). `match_score` is the fused score over its maximum, so first in both lists is 1 and first in one of two lists is 0.5. Tune both cutoffs against reviewed Thai questions once documents exist.

## Material names by meaning (migration `202611260001_hybrid_rrf_search.sql`)

- `rag.material_name_embeddings` holds one BGE-M3 vector per material name, with the md5 of the name it came from. Service role only.
- `GET /api/internal/material-embeddings` embeds names that have no vector or were renamed: `material_embedding_queue` → Cloudflare → `material_embedding_save` (which skips a name that changed meanwhile). It uses `AGENTIC_ALERT_CRON_SECRET` and the service key, like agentic alerts.
- pg_cron calls it daily through `ops.invoke_material_embeddings()`. The job is scheduled in production after deploy; a fresh database never calls out.
- One run starts batches of 100 names for 60 seconds (about 1,000 names) and answers `partial` when names are left; the next run continues from there. To backfill a whole catalog, call `select ops.invoke_material_embeddings();` again until it answers `done`.
- `vmi_chat_database(..., p_embedding)`: when nothing matches the text, a source with `material_id` gets a second list ranked by the meaning of the material name, fused with the text list by RRF. The chat shows each near match's `match_score` as small text, e.g. "(ความมั่นใจ 0.87)".

## SAP terms and import rows (migration `202611270001_sap_terms_near_text.sql`)

- Most material names are SAP English ("TRANS 3P4W 12/24KV D416Y240V 250KVA(SL)"). `app/api/chat/sap-terms.mjs` turns Thai material words, phases and units into SAP terms (`หม้อแปลงไฟฟ้า 3 เฟส 250kVA` → `trans 3p 250kva`). Add a word there, with a test in `tests/chat-sap-terms.test.mjs`, when a Thai search misses an English name.
- The second read of a material search sends them as `p_args.near_text` and adds them to the embedded text. The database scores each row's text list by the larger of `word_similarity` and the share of terms the name holds, so it works without Cloudflare keys too. `near_text` never filters rows, and the model sees its own query.
- `staging.*` and `raw.*` sources hold import rows. Discovery leaves them out unless the question is about imports, files, validation or plants (`retrieval.mjs`, `IMPORT_QUESTION`).

## Checks

- `npm run test:agent`: route, tools, retrieval, SAP terms, answer review and OpenRouter adapter.
- `supabase/tests/sap_terms_verify.sql`: SAP-term near matches and `near_text` validation, inside the local workflow contract.
- `supabase/tests/chat_assistant_verify.sql`: runs inside the local workflow contract (`make database-contract-local`). It checks reads, admission and rate limits, overview, the catalog, knowledge search and anon denial.
