# Chat knowledge retrieval

Chat generation, tool selection, reranking and answer review use `openai/gpt-4o-mini` through `https://openrouter.ai/api/v1/chat/completions`. Set `OPENROUTER_API_KEY` as a server-only Vercel Secret for Production and Preview. The adapter retains the existing validated tool contract and passes tool call IDs back with their results. It rejects parallel calls, truncated results and malformed arguments.

Document embeddings are a separate workload. Set `GEMINI_API_KEY` for the existing Gemini corpus. An OpenRouter key must not be sent to Google. Changing the document embedding model requires re-embedding existing chunks; changing the chat model does not.

`search_knowledge` embeds a question with Gemini `gemini-embedding-001` (768 dimensions, RETRIEVAL_QUERY), then calls `public.vmi_chat_knowledge` under the user's JWT. The SQL function is SECURITY INVOKER; RLS on `rag.knowledge_chunks` enforces active profile, allowed role and district. Chat users can only read. The existing harness bounds the read loop and the writer/reviewer validates the returned text as evidence.

The migration creates an empty corpus. To import reviewed document chunks, generate normalized vectors with the same model, 768 dimensions and RETRIEVAL_DOCUMENT (the shared `embedText` function supports this task type). Insert content, source_id, title, chunk_index, embedding and explicit allowed_roles using a trusted database connection. The default role is admin. Never copy changing stock balances into document knowledge; use the existing live database tools for those values. Changing the embedding model requires regenerating document embeddings and updating the schema/model constraint together.

Answers omit source footers and internal retrieval metadata by default. Asking for sources enables the footer; evidence IDs remain available internally for validation. Business dates and incomplete-data qualifications remain part of the answer.

Checks: `npm run test:agent`, `npm run build`, and `supabase/tests/p02_chat_knowledge_verify.sql` (rollback-only SQL check requiring active admin and district profiles).
