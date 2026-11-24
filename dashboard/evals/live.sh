#!/usr/bin/env bash
# Runs the locked AI eval sets against the real provider before an AI change merges (docs/adr/0001).
# The key is typed hidden and lives only in this process: never printed, written or sent to GitHub.
#   bash evals/live.sh <baseline checkout> [<changed checkout>]   (default: only this checkout)
# With two checkouts the second is gated against the first ("no worse than baseline").
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${EVAL_OUT:-$(mktemp -d)}"
printf 'LLM API key for %s (hidden): ' "${LLM_PROVIDER:=typhoon}"; read -rs LLM_API_KEY; printf '\n'
export LLM_PROVIDER LLM_API_KEY
baseline="${1:-$here/../..}"
for set in chat-heldout-v1 chat-redteam-v1 alerts-replay-v1; do
  node "$here/run.mjs" --set "$set" --checkout "$baseline" --out "$out/baseline" --concurrency 3
  if [[ $# -ge 2 ]]; then
    node "$here/run.mjs" --set "$set" --checkout "$2" --out "$out/changed" --concurrency 3 \
      --baseline "$(ls "$out/baseline/$set--"*.json | head -1)"
  fi
done
echo "reports: $out"
