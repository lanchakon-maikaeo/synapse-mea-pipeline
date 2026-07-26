#!/usr/bin/env bash
# Build the OSRM road-preview graph for `/v1/transport/optimize`.
#
# This prepares the multi-level Dijkstra (MLD) graph that the `osrm` Compose
# service (docker-compose.yml, profile `routing`) serves through its OSRM Table
# and Route APIs. It downloads a pinned OSM extract, records the extract digest,
# derives the canonical `ROUTING_ENGINE_DATA_VERSION`, and runs the
# extract -> partition -> customize pipeline into the `osrm-data` Docker volume.
#
# The graph is built entirely inside a Docker named volume so multi-gigabyte
# artifacts never land in the repository (or a synced Drive tree). Only the
# source `.osm.pbf` is cached on the host, outside the repository, so its digest
# can be verified before any processing runs.
#
# Governance: the public community OSRM host is development-only. Production must
# additionally front this engine with a controlled HTTPS origin and bind the
# printed data version into `ROUTING_ENGINE_DATA_VERSION`. A floating
# `*-latest.osm.pbf` is a convenience default for local development only; a
# production release must pin an immutable, checksummed extract (set
# `OSRM_PBF_URL` to a controlled snapshot and `OSRM_PBF_SHA256` to its reviewed
# digest). See docs/SMART_LOGISTICS_PRODUCTION.md.
#
# Usage:
#   scripts/prepare_osrm_graph.sh
#   OSRM_PBF_URL=https://store.example/osm/thailand-2026-07-25.osm.pbf \
#     OSRM_PBF_SHA256=<64-hex> OSRM_DATA_VERSION_LABEL=osm-thailand-2026-07-25 \
#     scripts/prepare_osrm_graph.sh
set -Eeuo pipefail
umask 077

OSRM_IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v6.0.0@sha256:729461bcc9ae9e6aafa92c0f93db9b060a32e85d5e72092c01ae4a4a9f1eb564}"
OSRM_GRAPH_NAME="${OSRM_GRAPH_NAME:-thailand}"
OSRM_PROFILE="${OSRM_PROFILE:-/opt/car.lua}"
OSRM_PBF_URL="${OSRM_PBF_URL:-https://download.geofabrik.de/asia/thailand-latest.osm.pbf}"
OSRM_PBF_SHA256="${OSRM_PBF_SHA256:-}"
OSRM_DATA_VERSION_LABEL="${OSRM_DATA_VERSION_LABEL:-osm-thailand-$(date -u +%Y-%m-%d)}"
OSRM_VOLUME="${OSRM_VOLUME:-synapse_osrm-data}"
OSRM_STAGE_DIR="${OSRM_STAGE_DIR:-${HOME}/.cache/synapse-osrm}"
# Optional bounding-box clip (left,bottom,right,top in decimal degrees). Off by
# default so the production path builds the full extract. Set it to build a
# regional graph on a memory-constrained Docker host — e.g. the Bangkok
# Metropolitan Region (MEA's service area): OSRM_CLIP_BBOX=100.2,13.4,101.0,14.1
OSRM_CLIP_BBOX="${OSRM_CLIP_BBOX:-}"
OSRM_OSMIUM_IMAGE="${OSRM_OSMIUM_IMAGE:-stefda/osmium-tool:latest@sha256:d2321d0e926f77ead7547b4b35f5cf98d9fd74043673cecc4fc2bb7cce06ff63}"

log() { printf '[prepare-osrm] %s\n' "$*" >&2; }
die() { printf '[prepare-osrm] error: %s\n' "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

sha256_of() {
  # Print the lowercase hex SHA-256 of a file (Linux/macOS).
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "no sha256sum or shasum available"
  fi
}

compute_data_version() {
  # Build and validate the canonical ROUTING_ENGINE_DATA_VERSION from a digest.
  data_version="${OSRM_DATA_VERSION_LABEL}-sha256-${1}"
  if ! printf '%s' "$data_version" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,127}-sha256-[0-9a-f]{64}$'; then
    die "computed data version is not canonical: ${data_version}
       (OSRM_DATA_VERSION_LABEL must be lowercase [a-z0-9._-])"
  fi
}

require docker
require curl
require awk

if ! [[ "$OSRM_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  die "OSRM_IMAGE must be pinned by sha256 digest"
fi

if [[ "$OSRM_GRAPH_NAME" == */* || "$OSRM_GRAPH_NAME" == *".."* || -z "$OSRM_GRAPH_NAME" ]]; then
  die "OSRM_GRAPH_NAME must be a simple name without path separators"
fi

if ! [[ "$OSRM_DATA_VERSION_LABEL" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]]; then
  die "OSRM_DATA_VERSION_LABEL must be lowercase [a-z0-9._-]"
fi

if [[ -n "$OSRM_PBF_SHA256" ]] && ! [[ "$OSRM_PBF_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  die "OSRM_PBF_SHA256 must be 64 lowercase hexadecimal characters"
fi

if [[ -n "$OSRM_CLIP_BBOX" ]] && ! printf '%s' "$OSRM_CLIP_BBOX" | grep -Eq \
  '^-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?$'; then
  die "OSRM_CLIP_BBOX must be left,bottom,right,top decimal degrees"
fi

if [[ -n "$OSRM_CLIP_BBOX" ]] && ! [[ "$OSRM_OSMIUM_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  die "OSRM_OSMIUM_IMAGE must be pinned by sha256 digest when clipping"
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker daemon is not reachable; start Docker and retry"
fi

pbf_path="${OSRM_STAGE_DIR}/${OSRM_GRAPH_NAME}.osm.pbf"
mkdir -p "$OSRM_STAGE_DIR"

log "source extract: ${OSRM_PBF_URL}"
if [[ "$OSRM_PBF_URL" != https://* ]]; then
  die "OSRM_PBF_URL must use HTTPS"
fi

# Reuse a cached extract only when a pinned digest is supplied and matches;
# otherwise always re-fetch so a floating '-latest' extract is never stale.
need_download=1
if [[ -f "$pbf_path" && -n "$OSRM_PBF_SHA256" ]]; then
  if [[ "$(sha256_of "$pbf_path")" == "$OSRM_PBF_SHA256" ]]; then
    need_download=0
    log "cached extract matches the pinned digest; skipping download"
  fi
fi

if [[ "$need_download" -eq 1 ]]; then
  # Never resume from a completed extract with a different or floating digest;
  # range-resuming that file can silently combine bytes from two snapshots.
  if [[ -f "$pbf_path" ]]; then
    log "removing stale or floating cached extract before download"
    rm -f -- "$pbf_path"
  fi
  log "downloading extract (this can be several hundred MB)..."
  curl -fL --retry 3 --retry-delay 5 -C - -o "$pbf_path" "$OSRM_PBF_URL" \
    || die "download failed"
fi

pbf_sha="$(sha256_of "$pbf_path")"
log "extract sha256: ${pbf_sha}"

if [[ -n "$OSRM_PBF_SHA256" && "$pbf_sha" != "$OSRM_PBF_SHA256" ]]; then
  die "extract digest ${pbf_sha} does not match the pinned OSRM_PBF_SHA256"
fi

# graph_sha binds the data version to the exact bytes fed to osrm-extract. It
# equals the source digest for a full build, or the clipped digest when
# OSRM_CLIP_BBOX narrows the graph (set below, after clipping).
graph_sha="$pbf_sha"
compute_data_version "$graph_sha"
log "data version: ${data_version}"

# Ensure the target volume exists.
if ! docker volume inspect "$OSRM_VOLUME" >/dev/null 2>&1; then
  log "creating Docker volume ${OSRM_VOLUME}"
  docker volume create "$OSRM_VOLUME" >/dev/null
fi

run_in_volume() {
  # Run an OSRM tool with the graph volume mounted read-write at /data.
  docker run --rm \
    -v "${OSRM_VOLUME}:/data" \
    "$OSRM_IMAGE" "$@"
}

log "loading extract into volume ${OSRM_VOLUME}"
docker run --rm \
  -v "${OSRM_VOLUME}:/data" \
  -v "${OSRM_STAGE_DIR}:/stage:ro" \
  --entrypoint cp \
  "$OSRM_IMAGE" \
  "/stage/${OSRM_GRAPH_NAME}.osm.pbf" "/data/${OSRM_GRAPH_NAME}.osm.pbf"

if [[ -n "$OSRM_CLIP_BBOX" ]]; then
  log "clipping to bbox ${OSRM_CLIP_BBOX} using ${OSRM_OSMIUM_IMAGE}"
  docker run --rm -v "${OSRM_VOLUME}:/data" "$OSRM_OSMIUM_IMAGE" \
    osmium extract --bbox "$OSRM_CLIP_BBOX" --set-bounds --overwrite \
    -o "/data/${OSRM_GRAPH_NAME}.clipped.osm.pbf" \
    "/data/${OSRM_GRAPH_NAME}.osm.pbf"
  graph_sha="$(docker run --rm -v "${OSRM_VOLUME}:/data" --entrypoint sha256sum \
    "$OSRM_IMAGE" "/data/${OSRM_GRAPH_NAME}.clipped.osm.pbf" | awk '{print $1}')"
  compute_data_version "$graph_sha"
  log "clipped graph sha256: ${graph_sha}"
  log "data version (clipped): ${data_version}"
  # Serve the clipped graph under the canonical name.
  docker run --rm -v "${OSRM_VOLUME}:/data" --entrypoint sh "$OSRM_IMAGE" \
    -c "mv -f /data/${OSRM_GRAPH_NAME}.clipped.osm.pbf /data/${OSRM_GRAPH_NAME}.osm.pbf"
fi

log "osrm-extract (car profile: ${OSRM_PROFILE})"
run_in_volume osrm-extract -p "$OSRM_PROFILE" "/data/${OSRM_GRAPH_NAME}.osm.pbf"

log "osrm-partition"
run_in_volume osrm-partition "/data/${OSRM_GRAPH_NAME}.osrm"

log "osrm-customize"
run_in_volume osrm-customize "/data/${OSRM_GRAPH_NAME}.osrm"

# Drop the source extract from the serving volume; the .osrm* graph is enough.
run_in_volume rm -f "/data/${OSRM_GRAPH_NAME}.osm.pbf" || true

# Record provenance next to the graph for operators (osrm-routed ignores it).
manifest="$(printf 'data_version=%s\nsource_url=%s\nsource_sha256=%s\ngraph_sha256=%s\nclip_bbox=%s\nprofile=%s\nimage=%s\ngraph_name=%s\nbuilt_at=%s\n' \
  "$data_version" "$OSRM_PBF_URL" "$pbf_sha" "$graph_sha" "${OSRM_CLIP_BBOX:-none}" "$OSRM_PROFILE" "$OSRM_IMAGE" "$OSRM_GRAPH_NAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
docker run --rm -i \
  -v "${OSRM_VOLUME}:/data" \
  --entrypoint sh \
  "$OSRM_IMAGE" \
  -c 'cat > /data/BUILD_MANIFEST.txt' <<<"$manifest"

log "graph ready in volume ${OSRM_VOLUME}"
cat >&2 <<EOF

Next steps:
  1) Start the engine:
       docker compose --profile routing up -d osrm
  2) Point the dashboard at it (local development):
       ROUTING_ENGINE_URL=http://localhost:${OSRM_PORT:-5000}
       ROUTING_ENGINE_PROFILE=driving
  3) For a production release, front this engine with a controlled HTTPS origin
     and set the reviewed, immutable data version:
       ROUTING_ENGINE_DATA_VERSION=${data_version}
EOF

# Emit the canonical data version on stdout for scripting/capture.
printf 'ROUTING_ENGINE_DATA_VERSION=%s\n' "$data_version"
