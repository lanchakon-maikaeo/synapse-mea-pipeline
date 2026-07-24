#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${DRILL_DATABASE_URL:?DRILL_DATABASE_URL is required}"

if [[ "$DRILL_DATABASE_URL" == *"mklnbumfwojxhqscthjd"* ||
      "$DRILL_DATABASE_URL" == *"jbwbmrizawxcrtliozqt"* ]]; then
  echo "Restore drills must target an isolated database" >&2
  exit 2
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

DATABASE_URL="$SOURCE_DATABASE_URL" BACKUP_DIR="$workdir" "$(dirname "$0")/backup_database.sh" >/dev/null
backup_file="$(find "$workdir" -name '*.dump' -type f | head -n 1)"
BACKUP_FILE="$backup_file" RESTORE_DATABASE_URL="$DRILL_DATABASE_URL" RESTORE_CONFIRM=YES \
  "$(dirname "$0")/restore_database.sh" >/dev/null

schema_count="$(psql "$DRILL_DATABASE_URL" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="select count(*) from information_schema.schemata where schema_name in ('raw','staging','core','analytics','ops','audit');")"
[[ "$schema_count" -ge 6 ]] || { echo "Restore drill failed: expected SYNAPSE schemas" >&2; exit 4; }

psql "$SOURCE_DATABASE_URL" --set=ON_ERROR_STOP=1 \
  --set=schema_count="$schema_count" <<'SQL'
insert into ops.backup_runs (backup_type,status,validation_details,finished_at)
values ('restore_drill','succeeded',jsonb_build_object('isolated_target',true,'schema_count',:'schema_count'::integer),now());
SQL

echo "restore drill: passed (${schema_count} SYNAPSE schemas)"
