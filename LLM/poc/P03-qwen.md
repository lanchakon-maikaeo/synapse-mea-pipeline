# P03 — Qwen3-8B intent selection

Depends: P02 done. Outcome: Thai question → validated tool decision → existing gateway on Supabase Test.

Read: CONTEXT/STATE, P02 tool schema/gateway/tests. Consult official Qwen/vLLM/RunPod docs only for the pinned integration being implemented; don't reread course PDFs.

Work:
1. Use an authorized existing Qwen3-8B/vLLM endpoint if available. Before provisioning/spending, require the endpoint/region/data classification and resource ceiling recorded in P00. Without access, finish adapter and mocked tests but keep live acceptance pending.
2. Use one small server-only fetch/client adapter and a constrained JSON Schema matching the five tools plus clarify/unsupported. Validate again in backend. Begin with non-thinking mode; pin model revision, image/vLLM version and decoding settings tested on actual worker. Prompt-only JSON is insufficient.
3. Add proposed `dashboard/app/api/chat/route.ts`: verify JWT and current scope before inference, minimize/redact question, call model once, validate decision, invoke P02 and return deterministic answer. No summarizer/agent loop/automatic retry. Model cannot author final numeric facts.
4. Secrets only server-side. Provider outage/invalid JSON/truncated answer/oversized input must produce a safe status. Enforce overall/provider/DB deadlines, cancellation and budgets. No silent hosted-provider fallback or full question logging.
5. Run development intents against real endpoint/Test DB. Benchmark cold/warm latency and concurrency 1/2/4; 24GB VRAM + 8K context is a starting experiment, not a guarantee. Lower resource settings only with quality checks; stop paid resources when the test window ends unless user specified otherwise.

Acceptance: actual endpoint demonstrably honors schema/template options; 20 development intents have reference tool/argument results and recorded failures; unauthorized questions cannot exceed DB/tool scope; provider failures do not bypass controls; tokens/latency/config are recorded without sensitive prompts. P05 owns held-out quality gate.

Checks: focused adapter/route tests, TypeScript, bounded live smoke. Keep `local_verified` if only mocks ran. Handoff endpoint secret reference, image/model version and exact reproducible smoke command; no key values.
