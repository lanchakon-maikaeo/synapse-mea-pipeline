# Current POC 2 state

Updated: 2026-09-08. Branch `dev` uses main Supabase `synapse-01` (`fvdfduuanfrncrwuareb`) with explicit user authorization. Historical P00/P01 Test evidence remains valid for its original fixture scope.

Current extension: [Database Agent v3](../AGENT_PIPELINE.md) adds authorized source discovery, Gemini reranking/top-k, and structured read/aggregate queries across the business catalog. Build/lint and 65 tests pass; 17 new SQL checks pass on Test, with all 125 Test sources successfully queried. v2 details below record the preceding release.

- Harness v2: six read tools, bounded multi-step Gemini feedback, recent history, deterministic evidence answers, explicit partial/finish, safe execution traces.
- SPAI course and research mappings: [SPAI_APPLICATION.md](../SPAI_APPLICATION.md).
- Build and 60 dashboard tests pass; 11 overview SQL assertions pass on managed Test (rolled back).
- Main migrations: original read RPCs, admission and operations overview applied. Authenticated-role overview smoke: `ok`, 15 delivery rows, not truncated. This SQL smoke simulates DB JWT claims; it is not an end-to-end browser login test.
- Deployment and live Gemini smoke evidence will be recorded after verification. P05 held-out accuracy, repeated live trials and cost/latency benchmark remain unmeasured.

The historical five-tool, single-call design is extended by the user's operations-agent request. Tool results now go to Gemini for subsequent decisions; no business writes are executed by chat.
