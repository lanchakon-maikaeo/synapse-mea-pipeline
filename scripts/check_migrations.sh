#!/usr/bin/env bash
# Migration file rules that the release script and reviewers rely on.
set -Eeuo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# Migrations up to M33 patched function text; M33 wrote those functions out.
last_text_patch_allowed="202611090004"
status=0

for file in "$root"/supabase/migrations/*.sql; do
  name="$(basename "$file")"
  version="${name%%_*}"
  # deploy_database_migrations.sh only accepts 12-digit versions
  if [[ ! "$name" =~ ^[0-9]{12}_[a-z0-9_]+\.sql$ ]]; then
    echo "$name: name must be <12-digit version>_<lowercase_name>.sql" >&2
    status=1
  fi
  if [[ "$version" > "$last_text_patch_allowed" ]] && grep -q 'pg_get_functiondef' "$file"; then
    echo "$name: write the whole function with create or replace instead of patching its text" >&2
    status=1
  fi
done

duplicates="$(
  for file in "$root"/supabase/migrations/*.sql; do
    name="$(basename "$file")"
    echo "${name%%_*}"
  done | sort | uniq -d
)"
if [[ -n "$duplicates" ]]; then
  echo "migration versions used more than once: $duplicates" >&2
  status=1
fi

exit "$status"
