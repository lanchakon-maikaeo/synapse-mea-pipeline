# P05 — Quality, security, complete PoC handoff

Depends: P04 done. Outcome: reviewable evidence that the full PoC works on Supabase Test and the real Qwen endpoint.

Read: CONTEXT/STATE, module evidence, actual chat tests and existing `Makefile`/`dashboard/package.json`. Reuse development fixtures and built-in runners; no new evaluation framework unless existing tools cannot cover the required checks.

Work:
1. Maintain 20 development cases separately from 80 held-out functional paraphrases (four per intent, balanced across 20 intents). Include VMI aliases (e.g. คต./คลองเตย), Thai/Western digits, Buddhist year, ambiguous dates, meter-as-material-unit versus piece/set, CMP=0, observed/attested zero, locked plans, missing Lot/HU lineage and no-data/stale states. Include a requested material outside the first source page to prove filter-before-limit correctness. Expected tools/arguments/results must reference the versioned Test dataset.
2. Run held-out only after prompt/schema freeze; don't tune to it and reuse its score as independent evidence. Record model/prompt/schema/dataset/Git versions. Report overall and per-tool tool+argument accuracy; clarify/unsupported correctness counts for matching cases, not as a way to avoid supported questions.
3. Security cases are additional: all intended roles, two districts, no/expired/wrong-project JWT, forged profile/role, direct RPC/view/table reads, prompt/parameter injection, repeated enumeration/rate limit, user switching, provider/DB outage, result truncation and audit spoofing/redaction.
4. Recheck full browser → chat API → Qwen → fixed tool → Supabase Auth/DB → result → audit path. Verify no business mutations. Run required existing release gates and ensure new SQL/Node tests are wired in, not skipped by old file lists.
5. Produce short `LLM/poc/ACCEPTANCE.md`: environment/config references, exact commands/results, passed/failed/skipped counts, latency/token observations, unresolved limits, start/stop instructions and Test fixture cleanup. No Production cutover in this module.

Acceptance: targets (proposed until P00 confirms): tool+arguments >=95% over held-out with per-tool breakdown; all displayed values/units/time scopes equal reference results; zero unauthorized disclosures in security cases; all error boundaries and audit tests pass. Report observed cold/warm p50/p95 and cost per successful answer; don't invent an SLO or savings percentage without agreed budget/measurements.

Checks: focused chat/security/live evaluation, `make workspace-ci` once for final integration; also run new cases not already included. A green existing suite is insufficient if new tests aren't registered. Mark an unavailable check pending; don't relabel it passed. Rerun only failed/affected checks unless later changes invalidate broader evidence.

Done: all module acceptance including live Test and real model is proven, evidence is redacted, rollback/disable is documented and paid test resources are stopped or explicitly retained. STATE summarizes outcome and next optional work; don't auto-open RAG/forecast/Production work.
