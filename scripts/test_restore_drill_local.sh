#!/usr/bin/env bash
set -Eeuo pipefail

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
suffix="${RANDOM}${RANDOM}"
network="synapse-restore-${suffix}"
source_container="synapse-source-${suffix}"
target_container="synapse-target-${suffix}"

cleanup() {
  docker rm -f "$source_container" "$target_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network" >/dev/null
for container in "$source_container" "$target_container"; do
  docker run -d --name "$container" --network "$network" \
    -e POSTGRES_PASSWORD=synapse-test -e POSTGRES_DB=synapse \
    postgres:17-bookworm >/dev/null
done

for container in "$source_container" "$target_container"; do
  for _ in {1..60}; do
    docker exec "$container" pg_isready -U postgres -d synapse >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$container" pg_isready -U postgres -d synapse >/dev/null
done

docker exec -i "$source_container" psql -U postgres -d synapse --set=ON_ERROR_STOP=1 <<'SQL' >/dev/null
create schema raw; create schema staging; create schema core;
create schema analytics; create schema ops; create schema audit;
create table core.restore_fixture (id integer primary key, value text not null);
insert into core.restore_fixture values (1,'verified-fixture');
create table ops.backup_runs (
  backup_run_id uuid primary key default gen_random_uuid(),
  backup_type text not null,
  status text not null,
  artifact_reference text,
  checksum_sha256 text,
  size_bytes bigint,
  validation_details jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
SQL

docker run --rm --network "$network" -v "$root:/work" -w /work \
  -e SOURCE_DATABASE_URL="postgresql://postgres:synapse-test@${source_container}:5432/synapse" \
  -e DRILL_DATABASE_URL="postgresql://postgres:synapse-test@${target_container}:5432/synapse" \
  postgres:17-bookworm bash scripts/restore_drill.sh

fixture="$(docker exec "$target_container" psql -U postgres -d synapse --tuples-only --no-align --command='select value from core.restore_fixture where id=1;')"
[[ "$fixture" == "verified-fixture" ]] || { echo "restored fixture mismatch" >&2; exit 5; }
echo "local PostgreSQL backup/restore drill: passed"
