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

deployment_profile="${DEPLOYMENT_PROFILE:-test}"
expected_database_environment="${EXPECTED_DATABASE_ENVIRONMENT:-$deployment_profile}"
target_project_ref="${TARGET_PROJECT_REF:-}"
target_region="${TARGET_REGION:-}"
change_ticket="${CHANGE_TICKET:-$RELEASE_VERSION}"

[[ "$DEPLOY_CONFIRM" == "APPLY_PENDING_MIGRATIONS" ]] || {
  echo "DEPLOY_CONFIRM must equal APPLY_PENDING_MIGRATIONS" >&2
  exit 2
}
[[ "$deployment_profile" == "test" || "$deployment_profile" == "production" ]] || {
  echo "DEPLOYMENT_PROFILE must be test or production" >&2
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
if [[ -n "$target_project_ref" && ! "$target_project_ref" =~ ^[a-z0-9]{20}$ ]]; then
  echo "TARGET_PROJECT_REF must be a 20-character lowercase Supabase project ref" >&2
  exit 2
fi
if [[ -n "$target_region" && ! "$target_region" =~ ^[a-z0-9-]+$ ]]; then
  echo "TARGET_REGION contains unsupported characters" >&2
  exit 2
fi
if [[ "$deployment_profile" == "production" ]]; then
  : "${PRODUCTION_DEPLOY_CONFIRM:?Set PRODUCTION_DEPLOY_CONFIRM=DEPLOY_GREENFIELD_PRODUCTION}"
  [[ "$PRODUCTION_DEPLOY_CONFIRM" == "DEPLOY_GREENFIELD_PRODUCTION" ]] || {
    echo "PRODUCTION_DEPLOY_CONFIRM must equal DEPLOY_GREENFIELD_PRODUCTION" >&2
    exit 2
  }
  [[ -n "$target_project_ref" && -n "$target_region" ]] || {
    echo "TARGET_PROJECT_REF and TARGET_REGION are required for Production" >&2
    exit 2
  }
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
schema_initialized="$(
  psql "$DATABASE_URL" --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    --command="select to_regclass('ops.schema_migrations') is not null"
)"

actual_database_environment="uninitialized"
actual_database_project_ref=""
if [[ "$schema_initialized" == "t" ]]; then
  actual_database_environment="$(
    psql "$DATABASE_URL" --tuples-only --no-align --set=ON_ERROR_STOP=1 \
      --command="select environment_name from ops.environment_registry order by updated_at desc limit 1"
  )"

  [[ "$actual_database_environment" == "$expected_database_environment" ]] || {
    echo "Refusing migration: expected environment '$expected_database_environment', found '$actual_database_environment'" >&2
    exit 3
  }

  actual_database_project_ref="$(
    psql "$DATABASE_URL" --tuples-only --no-align --set=ON_ERROR_STOP=1 \
      --command="select project_ref from ops.environment_registry order by updated_at desc limit 1"
  )"
  if [[ -n "$target_project_ref" && "$actual_database_project_ref" != "$target_project_ref" ]]; then
    echo "Refusing migration: TARGET_PROJECT_REF '$target_project_ref' does not match registered project '$actual_database_project_ref'" >&2
    exit 3
  fi

  echo "creating pre-migration backup for $actual_database_environment"
  DATABASE_URL="$DATABASE_URL" BACKUP_DIR="$BACKUP_DIR" \
    "$root/scripts/backup_database.sh"
else
  [[ "${GREENFIELD_BOOTSTRAP_CONFIRM:-}" == "INITIALIZE_EMPTY_DATABASE" ]] || {
    echo "Empty database requires GREENFIELD_BOOTSTRAP_CONFIRM=INITIALIZE_EMPTY_DATABASE" >&2
    exit 3
  }
  echo "greenfield database detected; no pre-existing application data to back up"
fi

pending_migrations=()
while IFS= read -r migration_file; do
  migration_name="$(basename "$migration_file")"
  migration_version="${migration_name%%_*}"
  [[ "$migration_version" =~ ^[0-9]{12}$ ]] || {
    echo "Invalid migration filename: $migration_name" >&2
    exit 4
  }
  if [[ "$schema_initialized" == "t" ]]; then
    is_registered="$(
      psql "$DATABASE_URL" --tuples-only --no-align --set=ON_ERROR_STOP=1 \
        --command="select exists(select 1 from ops.schema_migrations where version = '$migration_version')"
    )"
  else
    is_registered="f"
  fi
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

if [[ -n "$target_project_ref" ]]; then
  psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 \
    --set=target_environment="$deployment_profile" \
    --set=target_project_ref="$target_project_ref" \
    --set=target_region="$target_region" \
    --set=change_ticket="$change_ticket" <<'SQL'
select ops.configure_environment(
  :'target_environment',
  :'target_project_ref',
  :'target_region',
  :'change_ticket'
);
SQL
  actual_database_environment="$deployment_profile"
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
  --set=deployment_profile="$deployment_profile" \
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
  :'deployment_profile',
  :'release_notes'
)
on conflict (release_version) do update
set git_sha = excluded.git_sha,
    status = excluded.status,
    deployment_profile = excluded.deployment_profile,
    notes = excluded.notes,
    deployed_at = now();
SQL

echo "database migrations deployed to $actual_database_environment and release evidence recorded"
