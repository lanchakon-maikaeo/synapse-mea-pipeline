#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "${1:-}" == "--check" ]]; then
  for required_command in psql pg_dump; do
    command -v "$required_command" >/dev/null || {
      echo "$required_command is required" >&2
      exit 1
    }
  done
  echo "database deployment prerequisites: ok"
  exit 0
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR must be an absolute protected directory}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${RELEASE_GIT_SHA:?RELEASE_GIT_SHA is required}"
: "${DEPLOY_CONFIRM:?Set DEPLOY_CONFIRM=APPLY_PENDING_MIGRATIONS after change approval}"

[[ "$DEPLOY_CONFIRM" == "APPLY_PENDING_MIGRATIONS" ]] || {
  echo "DEPLOY_CONFIRM must equal APPLY_PENDING_MIGRATIONS" >&2
  exit 2
}
[[ "$BACKUP_DIR" = /* && "$BACKUP_DIR" != "/" ]] || {
  echo "BACKUP_DIR must be an absolute directory other than /" >&2
  exit 2
}
[[ "$RELEASE_GIT_SHA" =~ ^[0-9a-f]{7,64}$ ]] || {
  echo "RELEASE_GIT_SHA must be a 7-64 character lowercase hexadecimal Git SHA" >&2
  exit 2
}

root="$(cd "$(dirname "$0")/.." && pwd)"
expected_database_environment="${EXPECTED_DATABASE_ENVIRONMENT:-test}"
actual_database_environment="$(
  psql "$DATABASE_URL" --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    --command="select environment_name from ops.environment_registry order by environment_name"
)"

[[ "$actual_database_environment" == "$expected_database_environment" ]] || {
  echo "Refusing migration: expected environment '$expected_database_environment', found '$actual_database_environment'" >&2
  exit 3
}

echo "creating pre-migration backup for $actual_database_environment"
DATABASE_URL="$DATABASE_URL" BACKUP_DIR="$BACKUP_DIR" \
  "$root/scripts/backup_database.sh"

pending_migrations=()
while IFS= read -r migration_file; do
  migration_name="$(basename "$migration_file")"
  migration_version="${migration_name%%_*}"
  [[ "$migration_version" =~ ^[0-9]{12}$ ]] || {
    echo "Invalid migration filename: $migration_name" >&2
    exit 4
  }
  is_registered="$(
    psql "$DATABASE_URL" --tuples-only --no-align --set=ON_ERROR_STOP=1 \
      --command="select exists(select 1 from ops.schema_migrations where version = '$migration_version')"
  )"
  if [[ "$is_registered" != "t" ]]; then
    pending_migrations+=("$migration_file")
  fi
done < <(find "$root/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | sort)

if ((${#pending_migrations[@]} > 0)); then
  migration_batch="$(mktemp "${TMPDIR:-/tmp}/synapse-migrations.XXXXXX.sql")"
  cleanup() {
    rm -f "$migration_batch"
  }
  trap cleanup EXIT

  {
    printf '%s\n' '\set ON_ERROR_STOP on'
    printf '%s\n' "select pg_advisory_lock(hashtextextended('synapse-database-migrations', 0));"
    for migration_file in "${pending_migrations[@]}"; do
      printf "\\echo applying %s\n" "$(basename "$migration_file")"
      printf "\\i '%s'\n" "$migration_file"
    done
    printf '%s\n' "select pg_advisory_unlock(hashtextextended('synapse-database-migrations', 0));"
  } >"$migration_batch"

  psql "$DATABASE_URL" --file="$migration_batch"
else
  echo "no pending migrations"
fi

psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 \
  --file="$root/supabase/tests/local_schema_contract_verify.sql"

if [[ "${RUN_DATA_ACCEPTANCE:-false}" == "true" ]]; then
  psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 \
    --file="$root/supabase/tests/non_ai_completion_verify.sql"
fi

psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 \
  --set=release_version="$RELEASE_VERSION" \
  --set=release_git_sha="$RELEASE_GIT_SHA" \
  --set=release_notes="${RELEASE_NOTES:-Ordered migrations and schema contract verified.}" <<'SQL'
insert into ops.release_versions (
  release_version,
  git_sha,
  status,
  deployment_profile,
  notes
)
values (
  :'release_version',
  :'release_git_sha',
  'deployed',
  'test',
  :'release_notes'
)
on conflict (release_version) do update
set git_sha = excluded.git_sha,
    status = excluded.status,
    deployment_profile = excluded.deployment_profile,
    notes = excluded.notes,
    deployed_at = now();
SQL

echo "database migrations deployed and release evidence recorded"
