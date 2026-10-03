# Chat knowledge retrieval

Chat generation, tool selection, reranking and answer review use `openai/gpt-4o-mini` through `https://openrouter.ai/api/v1/chat/completions`. Set the OpenRouter key as `LLM_API_KEY`, a server-only Vercel Secret for Production and Preview. Google API keys are rejected for chat. The adapter retains the existing validated tool contract and passes tool call IDs back with their results. It rejects parallel calls, truncated results and malformed arguments.

Do not set `provider.require_parameters: true` for this request: GPT-4o-mini endpoint metadata does not list `parallel_tool_calls`, so that filter can exclude every endpoint and return HTTP 404. The request still sends `parallel_tool_calls: false`, and the adapter rejects multiple calls before executing any tool.

Document and question embeddings use OpenRouter `baai/bge-m3` (1024 dense dimensions) with the same server-only `LLM_API_KEY` as chat. No Gemini key is needed on dev. Requests use `/api/v1/embeddings`, `encoding_format: float` and no dimension reduction or query/document instruction prefix. The shared `embedText` validates and normalizes each vector.

OpenRouter may return a provider model name (`BAAI/bge-m3` or `parasail-bge-m3`) rather than the requested routing slug. The adapter accepts these BGE-M3 names while storing the canonical `baai/bge-m3` corpus label and still requiring 1024 finite values.

`search_knowledge` calls `public.vmi_chat_knowledge_bge_m3` under the user's JWT. This SECURITY INVOKER function searches only `rag.knowledge_chunks_bge_m3`. RLS preserves active profile, allowed roles and district restrictions; chat users can only read. The 768-dimensional Gemini table and RPC are retained for the existing main deployment. Never compare or copy vectors between these two embedding spaces.

The initial BGE-M3 corpus is empty. Import reviewed chunks by generating fresh vectors with `embedText({text: content, apiKey, taskType: 'RETRIEVAL_DOCUMENT'})`, then inserting content, source_id, title, chunk_index, embedding and explicit allowed_roles into `rag.knowledge_chunks_bge_m3` using a trusted database connection. The default role is admin. Copy the same role/district metadata when re-embedding an existing corpus, generate embeddings from its content, and preserve source_id/chunk_index. Do not copy old numeric vectors or insert changing stock balances into document knowledge; use live database tools for those values.

Deploy the additive BGE-M3 migration before the dev dashboard. Apply only this migration to the approved Supabase target; do not run unrelated pending migrations. Verify with `supabase/tests/p03_bge_m3_knowledge_verify.sql`. The initial similarity cutoff is 0.5; evaluate it against reviewed Thai queries when documents are imported.

Checks: `npm run test:agent`, `npm run build`, and `supabase/tests/p03_bge_m3_knowledge_verify.sql` (rollback-only SQL check requiring active admin and district profiles).
