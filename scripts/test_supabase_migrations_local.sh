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
  docker exec "$container" pg_isready -U postgres -d synapse >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d synapse >/dev/null

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

worker_database_url="postgresql://postgres:synapse-test@${container}:5432/synapse"
echo "queued worker jobs"
docker exec "$container" psql -U postgres -d synapse \
  --tuples-only --no-align \
  --command="select job_type || ':' || status || ':' || payload::text from ops.background_jobs order by created_at, job_type"
for worker_number in 1 2; do
  docker run --rm --network "$network" \
    -e DATABASE_URL="$worker_database_url" \
    -e ALLOW_HAVERSINE_FALLBACK=true \
    synapse-worker:1.0.0 \
    synapse-intelligence worker-once \
      --worker-id "local-contract-worker-${worker_number}"
done
echo "worker jobs after execution"
docker exec "$container" psql -U postgres -d synapse \
  --tuples-only --no-align \
  --command="select job_type || ':' || status || ':' || coalesce(error_message, '') from ops.background_jobs order by created_at, job_type"

docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/local_worker_execution_verify.sql

echo "validating M09 district-scope migration rollback/reapply"
docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/rollbacks/202607160013_m09_district_scope_status_rollback.sql \
  >/dev/null
docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/migrations/202607160013_m09_district_scope_status.sql \
  >/dev/null
docker exec "$container" psql -U postgres -d synapse \
  --set=ON_ERROR_STOP=1 \
  --file=/work/supabase/tests/local_schema_contract_verify.sql \
  >/dev/null

echo "validating guarded database deployment command"
docker run --rm --network "$network" \
  -v "$root:/work:ro" \
  -w /work \
  -e DATABASE_URL="$worker_database_url" \
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
[[ "$deployment_evidence" == "1:1" ]] || {
  echo "guarded deployment evidence mismatch: $deployment_evidence" >&2
  exit 6
}

echo "local Supabase migration/schema/workflow contract: passed"
