#!/usr/bin/env bash
set -Eeuo pipefail

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="synapse-migrations-${suffix}"
container="synapse-migrations-${suffix}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run -d --name "$container" --network "$network" \
  -e POSTGRES_PASSWORD=synapse-test \
  -e POSTGRES_DB=synapse \
  -v "$root:/work:ro" \
  postgres:17-bookworm >/dev/null

for _ in {1..60}; do
  docker exec "$container" psql -U postgres -d synapse --tuples-only --no-align \
    --command='select 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" psql -U postgres -d synapse --tuples-only --no-align \
  --command='select 1' >/dev/null

docker exec -i "$container" psql -U postgres -d synapse --set=ON_ERROR_STOP=1 <<'SQL' >/dev/null
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema extensions;
create schema auth;

create table auth.users (
  id uuid primary key,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.contracts (
  id bigint generated always as identity primary key,
  source_row_number integer not null unique,
  material_code text,
  item_description text,
  unit text,
  procurement_code text,
  purchase_order bigint,
  contract_number text,
  line_item integer,
  vendor text,
  start_date date,
  quantity numeric,
  record_date date,
  bid_open_date date,
  delivery_date date,
  acceptance_date date,
  document_date date,
  end_date date,
  created_at timestamptz not null default now()
);
SQL

while IFS= read -r migration; do
  echo "applying ${migration#"$root/"}"
  docker exec "$container" psql -U postgres -d synapse \
    --set=ON_ERROR_STOP=1 \
    --file="/work/${migration#"$root/"}" >/dev/null
done < <(find "$root/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | sort)

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/local_schema_contract_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/local_pipeline_workflow_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m16_test_fixture_governance_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m17_production_rebuild_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m18_relational_source_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m21_actual_workbook_observation_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m22_production_completion_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m23_active_scope_readiness_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m24_single_admin_identity_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m13_transport_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m13e_route_evidence_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/source_file_import_verify.sql

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/m17_planner_selection_verify.sql

contract_database_url="postgresql://postgres:synapse-test@${container}:5432/synapse"
echo "forecasting and routing worker execution intentionally excluded"

echo "validating pending migration batch"
docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --command="delete from ops.schema_migrations where version='202607240024'" >/dev/null
docker run --rm --network "$network" \
  -v "$root:/work:ro" \
  -w /work \
  -e DATABASE_URL="$contract_database_url" \
  -e BACKUP_DIR=/tmp/synapse-contract-backups \
  -e RELEASE_VERSION=pending-migration-batch \
  -e RELEASE_GIT_SHA=1111111111111111111111111111111111111111 \
  -e DEPLOY_CONFIRM=APPLY_PENDING_MIGRATIONS \
  postgres:17-bookworm \
  bash scripts/deploy_database_migrations.sh >/dev/null
pending_batch_registered="$(
  docker exec "$container" psql -U postgres -d synapse \
    --tuples-only --no-align \
    --command="select count(*) from ops.schema_migrations where version='202607240024'"
)"
[[ "$pending_batch_registered" == "1" ]] || {
  echo "pending migration batch did not restore M24 registration" >&2
  exit 5
}

echo "validating project-ref mismatch guard"
project_ref_guard_output=""
if project_ref_guard_output="$(
  docker run --rm --network "$network" \
    -v "$root:/work:ro" \
    -w /work \
    -e DATABASE_URL="$contract_database_url" \
    -e BACKUP_DIR=/tmp/synapse-contract-backups \
    -e RELEASE_VERSION=project-ref-guard \
    -e RELEASE_GIT_SHA=1111111111111111111111111111111111111111 \
    -e DEPLOY_CONFIRM=APPLY_PENDING_MIGRATIONS \
    -e TARGET_PROJECT_REF=bbbbbbbbbbbbbbbbbbbb \
    postgres:17-bookworm \
    bash scripts/deploy_database_migrations.sh 2>&1
)"; then
  echo "project-ref mismatch unexpectedly passed" >&2
  exit 5
fi
[[ "$project_ref_guard_output" == *"does not match registered project"* ]] || {
  echo "project-ref mismatch failed for an unexpected reason" >&2
  exit 5
}

deployment_evidence_before="$(
  docker exec "$container" psql -U postgres -d synapse \
    --tuples-only --no-align \
    --command="select count(*) from ops.schema_migrations where version='202607230015'"
)"
[[ "$deployment_evidence_before" == "1" ]] || {
  echo "dashboard read-resilience migration registration mismatch" >&2
  exit 6
}

echo "validating guarded database deployment command"
docker run --rm --network "$network" \
  -v "$root:/work:ro" \
  -w /work \
  -e DATABASE_URL="$contract_database_url" \
  -e BACKUP_DIR=/tmp/synapse-contract-backups \
  -e RELEASE_VERSION=local-contract \
  -e RELEASE_GIT_SHA=1111111111111111111111111111111111111111 \
  -e DEPLOY_CONFIRM=APPLY_PENDING_MIGRATIONS \
  postgres:17-bookworm \
  bash scripts/deploy_database_migrations.sh

deployment_evidence="$(
  docker exec "$container" psql -U postgres -d synapse \
    --tuples-only --no-align \
    --command="select
      (select count(*) from ops.backup_runs where status='succeeded') || ':' ||
      (select count(*) from ops.release_versions where release_version='local-contract' and status='deployed')"
)"
[[ "$deployment_evidence" == "2:1" ]] || {
  echo "guarded deployment evidence mismatch: $deployment_evidence" >&2
  exit 7
}

echo "local Supabase migration/schema/workflow contract: passed"
