# Database Agent v3

User objective: answer questions across the project's database, including district names, with retrieval, reranking and top-k. Business permissions still apply. This replaces the former five/six-tool-only scope.

Pipeline: user session → admission → Gemini plans → discover authorized source catalog → lexical candidate retrieval → Gemini reranks → top-k schemas → validated database query → optional record reranking → bounded evidence feedback → finish → server renders database values and source/time.

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
- Limits: six reads, twelve paid model calls including reranking, 90-second overall timeout, 50 rows per read, 40,000-character model tool context, six recent messages. Source/row limits and incomplete answers are disclosed.

## Verification

`npm --prefix dashboard run test:agent` checks retrieval, reranker output validation, exact evidence preservation, aggregate handling, query trust boundaries and discovered-source execution. Full build/test currently passes 65 tests. Managed Test `supabase/tests/p02_chat_database_verify.sql` passes 17 checks; Test security advisors report no error-level findings.

Deployment/live model tests are a separate gate. Scripted tests do not prove Gemini's selection accuracy over all possible questions. Cross-source calculations without a suitable existing view may require several reads and can return partial results at the budget limit. Historical queries depend on stored historical rows; missing history must not be invented.

Research/course mapping remains in [SPAI_APPLICATION.md](SPAI_APPLICATION.md). The retrieval design follows staged retrieval/ranking; it does not claim a benchmark score or implemented dense-vector retrieval.
