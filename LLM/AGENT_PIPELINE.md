# Database Agent v4

Updated 2026-09-09. v4 is a local production-code change, **not pushed or deployed**. Notebook mapping, detailed behavior and release gates are in [P06](poc/P06-notebook-production.md). v3 database coverage/tests below are historical evidence for the unchanged database boundary.

User objective: answer questions across the project's database, including district names, with retrieval, reranking and top-k. Business permissions still apply. This replaces the former five/six-tool-only scope.

Pipeline: user session → admission → Gemini plans → conversation/clarify/unsupported or discover authorized source catalog → lexical candidate retrieval → Gemini reranks → top-k schemas → validated database query → optional record reranking → bounded evidence feedback → finish → evidence-based answer writer → separate reviewer → natural-language answer with server-owned provenance, or deterministic evidence fallback.

## Data coverage

The migration snapshots existing relations and columns in `core`, `analytics`, `ops`, `raw`, `staging`, `reference_data`, plus `public.contracts`, `public.user_profiles` and `audit.change_log`. It excludes authentication/vault/platform internals, backup copies, worker capabilities and rate-limit storage. New tables/columns require catalog review; they do not become accessible automatically.

The Test catalog contains 125 sources. Each source was queried with a bounded projection: 57 returned data, 68 were empty, zero failed. Production also passed all 125 source reads: 97 returned data and 28 were empty. Empty sources are not evidence that business events exist.

Master registers (including names of districts) are available to active users. District facts are filtered to the caller's district; location stock permits that district and central warehouse evidence. Contracts and other reporting sources retain reporting-role restrictions. Raw/import/administration sources are admin-only. The source predicate is applied again inside every query, independently of the model and client arguments. Public schema identity tables are admin-only.

## Retrieval and query contract

- Source candidate retrieval tokenizes Thai with `Intl.Segmenter`, expands domain terms, and scores names/descriptions/columns. Gemini reranks candidates by semantic relevance before returning up to `LLM_RETRIEVAL_TOP_K` schemas (default 6, allowed 1–12).
- `query_database` accepts source, selected columns, typed filters, date ranges, ordering, pagination, text search and grouped count/sum/avg/min/max. Values are SQL literals and identifiers must belong to the frozen catalog. Arbitrary SQL/functions are rejected.
- Text-search records can be reranked by Gemini to top-k, preserving the actual database objects. Explicit database sort requests retain SQL order. Counts and aggregates execute over **all matching permitted rows before output limits** and are never computed from reranked samples.
- The model must discover a source before reading it. Catalog metadata alone cannot satisfy `finish`. Source schemas and query errors can be used for a bounded correction.
- No embedding corpus is copied from the database in this version. This is lexical retrieval plus model reranking, not vector hybrid search. Structured facts remain live SQL reads.
- Limits: six reads, twelve planning/retrieval model calls plus at most two writing/review calls (14 total), 90-second overall timeout, 50 rows per read, 40,000-character model tool context, six recent messages. Source/row limits and incomplete answers are disclosed.
- If optional reranking fails, returns invalid indices or discards all nonempty candidates, retain a bounded subset of the authorized original candidates and report `fallback_original_order`; do not report that data does not exist. Explicit SQL order and aggregates still bypass record ranking.
- Writer/reviewer cannot call DB tools. Citation IDs must refer to current tool evidence; discovery metadata and conversation history are not factual proof. Rejected/failed/oversized synthesis retains the deterministic answer. Partial/denied/conversation responses bypass synthesis.
- Safe telemetry adds `answer_mode`, `answer_validation`, model calls, provider-reported total tokens and request duration. No prompts/drafts or business rows are logged.

## Verification

`npm --prefix dashboard run test:agent` passes 27 tests covering retrieval, reranker fallback, evidence preservation, aggregates, query boundaries, source discovery and writer/reviewer rejection/fallback. v4 local production build/full test passes 71 tests; lint and TypeScript pass. Historical v3 managed Test `supabase/tests/p02_chat_database_verify.sql` passed 17 checks; its security advisors reported no error-level findings. No SQL changed or new live DB verification is claimed in v4.

Deployment/live model tests are a separate gate. Scripted tests do not prove Gemini's selection accuracy over all possible questions. Cross-source calculations without a suitable existing view may require several reads and can return partial results at the budget limit. Historical queries depend on stored historical rows; missing history must not be invented.

Research/course mapping remains in [SPAI_APPLICATION.md](SPAI_APPLICATION.md). The retrieval design follows staged retrieval/ranking; it does not claim a benchmark score or implemented dense-vector retrieval.
