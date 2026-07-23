#!/usr/bin/env bash
set -Eeuo pipefail

patterns='sb_secret_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'

if rg -n --hidden \
  --glob '!**/.git/**' \
  --glob '!**/.venv/**' \
  --glob '!**/node_modules/**' \
  --glob '!dashboard/dist/**' \
  --glob '!dashboard/.vinext/**' \
  --glob '!scripts/scan_secrets.sh' \
  "$patterns" .; then
  echo "Potential committed secret detected" >&2
  exit 1
fi

echo "high-confidence secret scan: passed"
