#!/usr/bin/env bash
# PROTOTYPE, wipe me. Reads the Typhoon key hidden and starts proxy.mjs, the only process that holds it.
set -euo pipefail
cd "$(dirname "$0")"
printf 'Typhoon API key for the dsh trial (hidden): '; read -rs LLM_API_KEY; printf '\n'
export LLM_API_KEY
exec node proxy.mjs
