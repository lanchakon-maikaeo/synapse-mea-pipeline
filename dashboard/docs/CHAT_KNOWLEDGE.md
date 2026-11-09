# Chat assistant

The chat widget (`app/chat-widget.tsx`) shows for signed-in users outside demo mode and posts to `/api/chat`. The route uses the caller's Supabase JWT. Every database read goes through SECURITY DEFINER or RLS-checked functions that take identity from `auth.uid()`, never from model output.

## Configuration

Server-only Vercel variables on `mea-synapse-web`, Production:

- `LLM_API_KEY`: OpenRouter key (`sk-or-...`). It is used for chat and for embeddings. Never prefix it with `NEXT_PUBLIC_`.
- `LLM_MODEL`: an OpenRouter `provider/model` ID that supports tool calling. Default: `openai/gpt-4o-mini`.
- `LLM_TEMPERATURE` (default `0`), `LLM_TIMEOUT_MS` (default `30000`).

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

Embeddings use OpenRouter `baai/bge-m3` (1024 dimensions) through `/api/v1/embeddings` with `encoding_format: float`. OpenRouter may answer with a provider model name (`BAAI/bge-m3`, `parasail-bge-m3`). The adapter accepts these names, stores the canonical `baai/bge-m3` label, and still requires 1024 finite values.

The corpus starts empty. To import reviewed documents:
- Generate each vector with `embedText({ text: content, apiKey, taskType: 'RETRIEVAL_DOCUMENT' })`.
- Insert `source_id`, `title`, `chunk_index`, `content`, `embedding`, `allowed_roles` and an optional `district_id` into `rag.knowledge_chunks_bge_m3` over a trusted connection. The default role is admin.
- Do not store changing stock balances as documents; chat reads those live.

The similarity cutoff starts at 0.5. Tune it against reviewed Thai questions once documents exist.

## Checks

- `npm run test:agent`: route, tools, retrieval, answer review and OpenRouter adapter.
- `supabase/tests/chat_assistant_verify.sql`: runs inside the local workflow contract (`make database-contract-local`). It checks reads, admission and rate limits, overview, the catalog, knowledge search and anon denial.
