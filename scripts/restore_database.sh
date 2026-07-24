#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" == "--check" ]]; then
  command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }
  command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
  echo "restore prerequisites: ok"
  exit 0
fi

: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${RESTORE_CONFIRM:?Set RESTORE_CONFIRM=YES after verifying the target}"
[[ "$RESTORE_CONFIRM" == "YES" ]] || { echo "RESTORE_CONFIRM must equal YES" >&2; exit 2; }
[[ -f "$BACKUP_FILE" ]] || { echo "Backup file not found: $BACKUP_FILE" >&2; exit 2; }

if [[ (
        "$RESTORE_DATABASE_URL" == *"fvdfduuanfrncrwuareb"* ||
        "$RESTORE_DATABASE_URL" == *"jbwbmrizawxcrtliozqt"*
      ) && "${ALLOW_PRODUCTION_RESTORE:-false}" != "true" ]]; then
  echo "Refusing to restore into the managed project without ALLOW_PRODUCTION_RESTORE=true" >&2
  exit 2
fi

checksum_file="${BACKUP_FILE}.sha256"
if [[ -f "$checksum_file" ]]; then
  expected="$(awk '{print $1}' "$checksum_file")"
  if command -v shasum >/dev/null; then
    actual="$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')"
  else
    actual="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
  fi
  [[ "$actual" == "$expected" ]] || { echo "Backup checksum mismatch" >&2; exit 3; }
fi

# pg_dump emits temporary analytics view stubs before its SCHEMA entries when
# resolving circular view dependencies. Bootstrap that schema for an empty
# recovery target; --clean will replace it from the archive immediately after.
# Supabase RLS policies also reference the authenticated role, which does not
# exist in a vanilla PostgreSQL recovery container.
psql "$RESTORE_DATABASE_URL" --set=ON_ERROR_STOP=1 <<'SQL'
select 'create role authenticated nologin'
where not exists (
  select 1 from pg_roles where rolname = 'authenticated'
)
\gexec
create schema if not exists analytics;
SQL

restore_list="$(mktemp)"
trap 'rm -f "$restore_list"' EXIT
pg_restore --list "$BACKUP_FILE" \
  | awk '
      !/supabase_vault/ &&
      !/(^|[[:space:]])vault([[:space:]]|$)/
    ' >"$restore_list"

# supabase_vault is installed and managed by Supabase but is not distributed
# with vanilla PostgreSQL. Its extension-owned objects and vault.secrets data
# are not application data, so exclude the managed vault schema from the
# portable drill while preserving it in the original backup artifact.
pg_restore --dbname="$RESTORE_DATABASE_URL" --clean --if-exists \
  --no-owner --no-acl --exit-on-error \
  --use-list="$restore_list" "$BACKUP_FILE"
psql "$RESTORE_DATABASE_URL" --set=ON_ERROR_STOP=1 --tuples-only --command="select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema');" >/dev/null
echo "restore validation: ok"
