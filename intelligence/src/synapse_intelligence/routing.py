from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import re
from typing import Protocol, Sequence
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


CANONICAL_TILESET_VERSION_PATTERN = re.compile(
    r"^[a-z0-9][a-z0-9._-]{0,127}-sha256-[0-9a-f]{64}$"
)
MAX_TILESET_VERSION_LENGTH = 200


def is_canonical_tileset_version(value: object) -> bool:
    """Return whether a label carries a canonical immutable tileset digest."""

    return (
        isinstance(value, str)
        and 1 <= len(value) <= MAX_TILESET_VERSION_LENGTH
        and CANONICAL_TILESET_VERSION_PATTERN.fullmatch(value) is not None
    )


@dataclass(frozen=True)
class Coordinate:
    latitude: float
    longitude: float


@dataclass(frozen=True)
class TravelMatrix:
    distances_m: tuple[tuple[int, ...], ...]
    durations_s: tuple[tuple[int, ...], ...]
    source: str
    request_hash: str | None = None
    response_hash: str | None = None


@dataclass(frozen=True)
class RoutingEngineStatus:
    version: str
    tileset_last_modified: int
    osm_changeset: int | None
    has_tiles: bool | None
    response_hash: str


@dataclass(frozen=True)
class RoadRouteEvidence:
    geometry_geojson: dict[str, object]
    distance_m: int
    duration_s: int
    has_toll: bool | None
    engine_name: str
    engine_version: str
    routing_profile: str
    tileset_version: str
    tileset_last_modified: int
    osm_changeset: int | None
    engine_status_response_hash: str
    ordered_waypoint_count: int
    request_hash: str
    response_hash: str


@dataclass(frozen=True)
class Vehicle:
    vehicle_id: str
    max_weight_kg: float
    max_volume_m3: float
    max_pallets: float


@dataclass(frozen=True)
class DeliveryStop:
    stop_id: str
    coordinate: Coordinate
    weight_kg: float
    volume_m3: float
    pallets: float
    service_minutes: int
    window_start_minute: int
    window_end_minute: int
    priority_score: float


@dataclass(frozen=True)
class PlannedStop:
    stop_id: str
    sequence: int
    arrival_minute: int


@dataclass(frozen=True)
class VehicleRoute:
    vehicle_id: str
    stops: tuple[PlannedStop, ...]
    distance_m: int
    duration_s: int
    weight_kg: float
    volume_m3: float
    pallets: float


@dataclass(frozen=True)
class OptimizationResult:
    routes: tuple[VehicleRoute, ...]
    unserved_stop_ids: tuple[str, ...]
    solver_status: str


@dataclass(frozen=True)
class LegacyRouteBaseline:
    """Deterministic nearest-neighbour baseline used for route comparisons."""

    stop_indices: tuple[int, ...]
    distance_m: int
    duration_s: int


class MatrixAdapter(Protocol):
    def build(self, coordinates: Sequence[Coordinate]) -> TravelMatrix: ...


class MatrixResponseError(ValueError):
    """Raised when a routing service returns an unusable travel matrix."""


class HaversineMatrixAdapter:
    def __init__(self, average_speed_kph: float = 30.0):
        if (
            isinstance(average_speed_kph, bool)
            or not isinstance(average_speed_kph, (int, float))
            or not math.isfinite(average_speed_kph)
            or average_speed_kph <= 0
        ):
            raise ValueError("average speed must be a positive finite number")
        self.average_speed_kph = average_speed_kph

    def build(self, coordinates: Sequence[Coordinate]) -> TravelMatrix:
        distances: list[tuple[int, ...]] = []
        durations: list[tuple[int, ...]] = []
        for origin in coordinates:
            distance_row: list[int] = []
            duration_row: list[int] = []
            for target in coordinates:
                distance = _haversine_m(origin, target)
                distance_row.append(round(distance))
                duration_row.append(round(distance / (self.average_speed_kph * 1000 / 3600)))
            distances.append(tuple(distance_row))
            durations.append(tuple(duration_row))
        return TravelMatrix(tuple(distances), tuple(durations), "haversine")


class ValhallaMatrixAdapter:
    _MAX_NODES = 100
    _MAX_RESPONSE_BYTES = 16 * 1024 * 1024
    _MAX_GEOMETRY_POSITIONS = 500_000
    _MAX_SNAP_DISTANCE_M = 1_000
    _MAX_GEOMETRY_WAYPOINT_DISTANCE_M = 100
    _PUBLIC_COMMUNITY_HOST = re.compile(
        r"^valhalla\d*\.openstreetmap\.de$",
        re.IGNORECASE,
    )

    def __init__(
        self,
        base_url: str,
        timeout_seconds: int = 20,
        auth_token: str | None = None,
        tileset_version: str | None = None,
        expected_osm_changeset: int | None = None,
    ):
        parsed = urlsplit(base_url)
        try:
            parsed_port = parsed.port
        except ValueError as exc:
            raise ValueError("Valhalla URL has an invalid port") from exc
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "Valhalla URL must be an HTTP(S) base URL without credentials, query or fragment"
            )
        if self._PUBLIC_COMMUNITY_HOST.fullmatch(parsed.hostname):
            raise ValueError(
                "Production route evidence cannot use a public community Valhalla host"
            )
        if parsed.scheme == "http" and parsed.hostname not in {
            "localhost",
            "127.0.0.1",
            "::1",
            "valhalla",
        }:
            raise ValueError(
                "Valhalla URL must use HTTPS except for the local development service"
            )
        if not 1 <= timeout_seconds <= 120:
            raise ValueError("Valhalla timeout must be between 1 and 120 seconds")
        raw_token = auth_token or ""
        normalized_token = raw_token.strip() or None
        if normalized_token and (
            len(normalized_token) > 4096
            or "\r" in raw_token
            or "\n" in raw_token
        ):
            raise ValueError("Valhalla auth token is invalid")
        normalized_tileset_version = tileset_version or None
        if normalized_tileset_version is not None and not (
            is_canonical_tileset_version(normalized_tileset_version)
        ):
            raise ValueError("Valhalla tileset version is invalid")
        if expected_osm_changeset is not None and (
            isinstance(expected_osm_changeset, bool)
            or not isinstance(expected_osm_changeset, int)
            or expected_osm_changeset < 0
        ):
            raise ValueError("Valhalla expected OSM changeset is invalid")
        self.base_url = base_url.rstrip("/")
        self._origin = (
            parsed.scheme.lower(),
            parsed.hostname.lower(),
            parsed_port or (443 if parsed.scheme.lower() == "https" else 80),
        )
        self.timeout_seconds = timeout_seconds
        self.auth_token = normalized_token
        self.tileset_version = normalized_tileset_version
        self.expected_osm_changeset = expected_osm_changeset

    def status(self) -> RoutingEngineStatus:
        result, raw_response = self._request_json("/status")
        if not isinstance(result, dict):
            raise MatrixResponseError("Valhalla status response must be an object")
        version = result.get("version")
        tileset_last_modified = result.get("tileset_last_modified")
        osm_changeset = result.get("osm_changeset")
        has_tiles = result.get("has_tiles")
        if (
            not isinstance(version, str)
            or not version.strip()
            or len(version) > 128
        ):
            raise MatrixResponseError("Valhalla status is missing a valid version")
        if (
            isinstance(tileset_last_modified, bool)
            or not isinstance(tileset_last_modified, int)
            or tileset_last_modified <= 0
        ):
            raise MatrixResponseError(
                "Valhalla status is missing tileset_last_modified"
            )
        if osm_changeset is not None and (
            isinstance(osm_changeset, bool)
            or not isinstance(osm_changeset, int)
            or osm_changeset < 0
        ):
            raise MatrixResponseError("Valhalla status has an invalid osm_changeset")
        if (
            osm_changeset is not None
            and self.expected_osm_changeset is not None
            and osm_changeset != self.expected_osm_changeset
        ):
            raise MatrixResponseError(
                "Valhalla status OSM changeset does not match the controlled dataset id"
            )
        effective_osm_changeset = (
            osm_changeset
            if osm_changeset is not None
            else self.expected_osm_changeset
        )
        if has_tiles is not None and not isinstance(has_tiles, bool):
            raise MatrixResponseError("Valhalla status has an invalid has_tiles flag")
        if has_tiles is False:
            raise MatrixResponseError("Valhalla status reports no routing tiles")
        return RoutingEngineStatus(
            version.strip(),
            tileset_last_modified,
            effective_osm_changeset,
            has_tiles,
            hashlib.sha256(raw_response).hexdigest(),
        )

    def build(self, coordinates: Sequence[Coordinate]) -> TravelMatrix:
        if not 1 <= len(coordinates) <= self._MAX_NODES:
            raise ValueError(
                f"Valhalla matrix requires between 1 and {self._MAX_NODES} coordinates"
            )
        coordinate_keys: set[tuple[float, float]] = set()
        for point in coordinates:
            if (
                not math.isfinite(point.latitude)
                or not math.isfinite(point.longitude)
                or not -90 <= point.latitude <= 90
                or not -180 <= point.longitude <= 180
            ):
                raise ValueError("Valhalla coordinates must be finite WGS84 values")
            coordinate_keys.add((round(point.latitude, 7), round(point.longitude, 7)))
        if len(coordinate_keys) != len(coordinates):
            raise ValueError("Valhalla coordinates must be unique")
        locations = [{"lat": point.latitude, "lon": point.longitude} for point in coordinates]
        payload = json.dumps(
            {"sources": locations, "targets": locations, "costing": "truck", "units": "kilometers", "verbose": False}
        ).encode()
        result, raw_response = self._request_json(
            "/sources_to_targets",
            payload,
        )
        try:
            cells = result["sources_to_targets"]
        except (KeyError, TypeError) as exc:
            raise MatrixResponseError("Valhalla response is missing sources_to_targets") from exc

        expected_size = len(coordinates)
        if isinstance(cells, dict):
            # Kept for compatibility with gateways that normalize matrix output.
            try:
                durations_raw = cells["durations"]
                distances_raw = cells["distances"]
            except KeyError as exc:
                raise MatrixResponseError("Valhalla matrix is missing distances or durations") from exc
            _validate_square_matrix(durations_raw, expected_size, "durations")
            _validate_square_matrix(distances_raw, expected_size, "distances")
            durations = tuple(
                tuple(_matrix_number(value, "time", row_index, column_index) for column_index, value in enumerate(row))
                for row_index, row in enumerate(durations_raw)
            )
            distances = tuple(
                tuple(
                    _matrix_number(value, "distance", row_index, column_index, scale=1000)
                    for column_index, value in enumerate(row)
                )
                for row_index, row in enumerate(distances_raw)
            )
        else:
            # Native Valhalla response: a two-dimensional array of result cells.
            _validate_square_matrix(cells, expected_size, "sources_to_targets")
            for row_index, row in enumerate(cells):
                for column_index, cell in enumerate(row):
                    if not isinstance(cell, dict):
                        raise MatrixResponseError(
                            f"Valhalla matrix cell [{row_index}][{column_index}] must be an object"
                        )
            durations = tuple(
                tuple(
                    _matrix_number(cell.get("time"), "time", row_index, column_index)
                    for column_index, cell in enumerate(row)
                )
                for row_index, row in enumerate(cells)
            )
            distances = tuple(
                tuple(
                    _matrix_number(cell.get("distance"), "distance", row_index, column_index, scale=1000)
                    for column_index, cell in enumerate(row)
                )
                for row_index, row in enumerate(cells)
            )
        return TravelMatrix(
            distances,
            durations,
            "valhalla",
            hashlib.sha256(payload).hexdigest(),
            hashlib.sha256(raw_response).hexdigest(),
        )

    def build_route(
        self,
        coordinates: Sequence[Coordinate],
    ) -> RoadRouteEvidence:
        if not self.tileset_version:
            raise ValueError(
                "Valhalla tileset version is required for road-route evidence"
            )
        if self.expected_osm_changeset is None:
            raise ValueError(
                "A controlled Valhalla OSM changeset is required for road-route evidence"
            )
        if not 2 <= len(coordinates) <= self._MAX_NODES + 1:
            raise ValueError(
                f"Valhalla route requires between 2 and {self._MAX_NODES + 1} coordinates"
            )
        coordinate_keys: set[tuple[float, float]] = set()
        for point in coordinates:
            self._validate_coordinate(point)
        for index, point in enumerate(coordinates):
            key = (round(point.latitude, 7), round(point.longitude, 7))
            is_round_trip_depot = (
                index == len(coordinates) - 1
                and key
                == (
                    round(coordinates[0].latitude, 7),
                    round(coordinates[0].longitude, 7),
                )
            )
            if key in coordinate_keys and not is_round_trip_depot:
                raise ValueError(
                    "Valhalla route waypoints must be unique except for a final depot return"
                )
            coordinate_keys.add(key)
        status_before = self.status()
        payload = json.dumps(
            {
                "locations": [
                    {"lat": point.latitude, "lon": point.longitude}
                    for point in coordinates
                ],
                "costing": "truck",
                "units": "kilometers",
                "directions_type": "none",
                "format": "osrm",
                "shape_format": "geojson",
                "overview": "full",
            }
        ).encode()
        result, raw_response = self._request_json("/route", payload)
        status_after = self.status()
        if (
            status_before.version,
            status_before.tileset_last_modified,
            status_before.osm_changeset,
            status_before.has_tiles,
        ) != (
            status_after.version,
            status_after.tileset_last_modified,
            status_after.osm_changeset,
            status_after.has_tiles,
        ):
            raise MatrixResponseError(
                "Valhalla engine or tileset changed while building route evidence"
            )
        if not isinstance(result, dict):
            raise MatrixResponseError("Valhalla route response must be an object")
        if result.get("code") not in (None, "Ok"):
            raise MatrixResponseError("Valhalla route response is not successful")
        route_osm_changeset = result.get("osm_changeset")
        if route_osm_changeset is None and isinstance(result.get("trip"), dict):
            route_osm_changeset = result["trip"].get("osm_changeset")
        if route_osm_changeset is None:
            raise MatrixResponseError(
                "Valhalla route response is missing osm_changeset provenance"
            )
        if (
            isinstance(route_osm_changeset, bool)
            or not isinstance(route_osm_changeset, int)
            or route_osm_changeset < 0
        ):
            raise MatrixResponseError(
                "Valhalla route response has an invalid osm_changeset"
            )
        if (
            route_osm_changeset != self.expected_osm_changeset
        ):
            raise MatrixResponseError(
                "Valhalla route OSM changeset does not match the controlled dataset id"
            )
        snapped_waypoints = self._validated_ordered_waypoints(
            result.get("waypoints"),
            coordinates,
        )
        routes = result.get("routes")
        if not isinstance(routes, list) or len(routes) != 1:
            raise MatrixResponseError(
                "Valhalla route response must contain exactly one route"
            )
        route = routes[0]
        if not isinstance(route, dict):
            raise MatrixResponseError("Valhalla route result must be an object")
        legs = route.get("legs")
        if not isinstance(legs, list) or len(legs) != len(coordinates) - 1:
            raise MatrixResponseError(
                "Valhalla route leg count does not match ordered waypoints"
            )
        geometry = route.get("geometry")
        canonical_geometry = self._validated_linestring(geometry)
        self._validate_ordered_geometry(canonical_geometry, snapped_waypoints)
        distance_m = self._positive_route_metric(route.get("distance"), "distance")
        duration_s = self._positive_route_metric(route.get("duration"), "duration")
        has_toll = route.get("has_toll")
        if has_toll is not None and not isinstance(has_toll, bool):
            raise MatrixResponseError("Valhalla route has an invalid has_toll flag")
        return RoadRouteEvidence(
            canonical_geometry,
            distance_m,
            duration_s,
            has_toll,
            "valhalla",
            status_after.version,
            "truck",
            self.tileset_version,
            status_after.tileset_last_modified,
            route_osm_changeset,
            status_after.response_hash,
            len(snapped_waypoints),
            hashlib.sha256(payload).hexdigest(),
            hashlib.sha256(raw_response).hexdigest(),
        )

    def _request_json(
        self,
        endpoint: str,
        payload: bytes | None = None,
    ) -> tuple[object, bytes]:
        headers = {"Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        request = Request(
            f"{self.base_url}{endpoint}",
            data=payload,
            headers=headers,
            method="POST" if payload is not None else "GET",
        )
        with urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310 - configured service URL
            if hasattr(response, "geturl"):
                final_url = urlsplit(response.geturl())
                try:
                    final_port = final_url.port
                except ValueError as exc:
                    raise MatrixResponseError(
                        "Valhalla redirect target has an invalid port"
                    ) from exc
                final_origin = (
                    final_url.scheme.lower(),
                    (final_url.hostname or "").lower(),
                    final_port
                    or (
                        443
                        if final_url.scheme.lower() == "https"
                        else 80
                    ),
                )
                if final_origin != self._origin:
                    raise MatrixResponseError(
                        "Valhalla response crossed the configured routing origin"
                    )
            declared_length = (
                response.headers.get("Content-Length")
                if hasattr(response, "headers")
                else None
            )
            if (
                declared_length
                and int(declared_length) > self._MAX_RESPONSE_BYTES
            ):
                raise MatrixResponseError(
                    "Valhalla response exceeds the configured size limit"
                )
            raw_response = response.read(self._MAX_RESPONSE_BYTES + 1)
        if len(raw_response) > self._MAX_RESPONSE_BYTES:
            raise MatrixResponseError(
                "Valhalla response exceeds the configured size limit"
            )
        try:
            return json.loads(raw_response), raw_response
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as exc:
            raise MatrixResponseError("Valhalla returned invalid JSON") from exc

    @staticmethod
    def _validate_coordinate(point: Coordinate) -> None:
        if (
            isinstance(point.latitude, bool)
            or isinstance(point.longitude, bool)
            or not isinstance(point.latitude, (int, float))
            or not isinstance(point.longitude, (int, float))
            or not math.isfinite(point.latitude)
            or not math.isfinite(point.longitude)
            or not -90 <= point.latitude <= 90
            or not -180 <= point.longitude <= 180
        ):
            raise ValueError("Valhalla coordinates must be finite WGS84 values")

    @classmethod
    def _validated_linestring(cls, geometry: object) -> dict[str, object]:
        if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
            raise MatrixResponseError(
                "Valhalla route geometry must be a GeoJSON LineString"
            )
        positions = geometry.get("coordinates")
        if (
            not isinstance(positions, list)
            or not 2 <= len(positions) <= cls._MAX_GEOMETRY_POSITIONS
        ):
            raise MatrixResponseError(
                "Valhalla route geometry has an invalid coordinate count"
            )
        canonical_positions: list[list[float]] = []
        for position in positions:
            if not isinstance(position, list) or len(position) < 2:
                raise MatrixResponseError(
                    "Valhalla route geometry contains an invalid position"
                )
            longitude, latitude = position[0], position[1]
            if (
                isinstance(longitude, bool)
                or isinstance(latitude, bool)
                or not isinstance(longitude, (int, float))
                or not isinstance(latitude, (int, float))
                or not math.isfinite(longitude)
                or not math.isfinite(latitude)
                or not -180 <= longitude <= 180
                or not -90 <= latitude <= 90
            ):
                raise MatrixResponseError(
                    "Valhalla route geometry contains a non-WGS84 position"
                )
            canonical_positions.append(
                [round(float(longitude), 8), round(float(latitude), 8)]
            )
        return {"type": "LineString", "coordinates": canonical_positions}

    def _validated_ordered_waypoints(
        self,
        waypoints: object,
        requested: Sequence[Coordinate],
    ) -> tuple[Coordinate, ...]:
        if not isinstance(waypoints, list) or len(waypoints) != len(requested):
            raise MatrixResponseError(
                "Valhalla route waypoints do not match requested waypoint count"
            )
        snapped: list[Coordinate] = []
        for index, (waypoint, requested_point) in enumerate(
            zip(waypoints, requested, strict=True)
        ):
            if not isinstance(waypoint, dict):
                raise MatrixResponseError(
                    f"Valhalla route waypoint [{index}] must be an object"
                )
            location = waypoint.get("location")
            if not isinstance(location, list) or len(location) < 2:
                raise MatrixResponseError(
                    f"Valhalla route waypoint [{index}] has an invalid location"
                )
            longitude, latitude = location[0], location[1]
            snapped_point = Coordinate(latitude, longitude)
            try:
                self._validate_coordinate(snapped_point)
            except ValueError as exc:
                raise MatrixResponseError(
                    f"Valhalla route waypoint [{index}] has a non-WGS84 location"
                ) from exc
            if _haversine_m(requested_point, snapped_point) > self._MAX_SNAP_DISTANCE_M:
                raise MatrixResponseError(
                    f"Valhalla route waypoint [{index}] snapped too far from requested coordinate"
                )
            snapped.append(snapped_point)
        return tuple(snapped)

    @classmethod
    def _validate_ordered_geometry(
        cls,
        geometry: dict[str, object],
        waypoints: Sequence[Coordinate],
    ) -> None:
        positions = geometry["coordinates"]
        assert isinstance(positions, list)
        geometry_points = tuple(
            Coordinate(float(position[1]), float(position[0]))
            for position in positions
        )
        previous_index = 0
        for waypoint_index, waypoint in enumerate(waypoints):
            search_start = previous_index if waypoint_index == 0 else previous_index + 1
            if search_start >= len(geometry_points):
                raise MatrixResponseError(
                    f"Valhalla route geometry ends before ordered waypoint [{waypoint_index}]"
                )
            remaining = range(search_start, len(geometry_points))
            nearest_index = min(
                remaining,
                key=lambda index: _haversine_m(
                    waypoint,
                    geometry_points[index],
                ),
            )
            distance_m = _haversine_m(
                waypoint,
                geometry_points[nearest_index],
            )
            if distance_m > cls._MAX_GEOMETRY_WAYPOINT_DISTANCE_M:
                raise MatrixResponseError(
                    f"Valhalla route geometry does not traverse ordered waypoint [{waypoint_index}]"
                )
            previous_index = nearest_index

    @staticmethod
    def _positive_route_metric(value: object, field: str) -> int:
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value <= 0
        ):
            raise MatrixResponseError(
                f"Valhalla route has an invalid {field}"
            )
        return round(value)


def _validate_square_matrix(rows: object, expected_size: int, field: str) -> None:
    if not isinstance(rows, list) or len(rows) != expected_size:
        raise MatrixResponseError(f"Valhalla {field} matrix must be {expected_size}x{expected_size}")
    if any(not isinstance(row, list) or len(row) != expected_size for row in rows):
        raise MatrixResponseError(f"Valhalla {field} matrix must be {expected_size}x{expected_size}")


def _matrix_number(
    value: object,
    field: str,
    row_index: int,
    column_index: int,
    *,
    scale: int = 1,
) -> int:
    if value is None:
        raise MatrixResponseError(
            f"Valhalla returned an unreachable matrix cell [{row_index}][{column_index}]: {field} is null"
        )
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MatrixResponseError(
            f"Valhalla matrix cell [{row_index}][{column_index}] has a non-numeric {field}"
        )
    numeric = float(value)
    if not math.isfinite(numeric) or numeric < 0:
        raise MatrixResponseError(
            f"Valhalla matrix cell [{row_index}][{column_index}] has an invalid {field}"
        )
    return round(numeric * scale)


def _haversine_m(a: Coordinate, b: Coordinate) -> float:
    radius_m = 6_371_000
    lat1, lat2 = math.radians(a.latitude), math.radians(b.latitude)
    delta_lat = lat2 - lat1
    delta_lon = math.radians(b.longitude - a.longitude)
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 2 * radius_m * math.asin(math.sqrt(value))


def legacy_nearest_neighbor(matrix: TravelMatrix) -> LegacyRouteBaseline:
    """Return a depot-to-depot nearest-neighbour route for one legacy vehicle.

    Matrix node 0 is the depot. The result is a transparent comparison baseline,
    not the production optimizer: it intentionally ignores capacity and time
    windows, matching the limitations that Wave 3 is intended to improve.
    """
    node_count = len(matrix.distances_m)
    if node_count == 0 or any(len(row) != node_count for row in matrix.distances_m):
        raise ValueError("distance matrix must be non-empty and square")
    if len(matrix.durations_s) != node_count or any(len(row) != node_count for row in matrix.durations_s):
        raise ValueError("duration matrix must match the distance matrix")

    current = 0
    remaining = set(range(1, node_count))
    ordered: list[int] = []
    distance_m = 0
    duration_s = 0
    while remaining:
        next_node = min(remaining, key=lambda node: (matrix.distances_m[current][node], node))
        distance_m += matrix.distances_m[current][next_node]
        duration_s += matrix.durations_s[current][next_node]
        ordered.append(next_node)
        remaining.remove(next_node)
        current = next_node
    distance_m += matrix.distances_m[current][0]
    duration_s += matrix.durations_s[current][0]
    return LegacyRouteBaseline(tuple(ordered), distance_m, duration_s)


class OrToolsOptimizer:
    _MAX_TIME_LIMIT_SECONDS = 300
    _MAX_INT64 = (1 << 63) - 1

    def __init__(self, time_limit_seconds: int = 10):
        if (
            isinstance(time_limit_seconds, bool)
            or not isinstance(time_limit_seconds, int)
            or not 1 <= time_limit_seconds <= self._MAX_TIME_LIMIT_SECONDS
        ):
            raise ValueError(
                f"solver time limit must be an integer between 1 and {self._MAX_TIME_LIMIT_SECONDS} seconds"
            )
        self.time_limit_seconds = time_limit_seconds

    def solve(
        self,
        depot: Coordinate,
        stops: Sequence[DeliveryStop],
        vehicles: Sequence[Vehicle],
        matrix: TravelMatrix,
        *,
        max_route_duration_minutes: int = 24 * 60,
    ) -> OptimizationResult:
        if not vehicles:
            raise ValueError("at least one vehicle is required")
        if (
            isinstance(max_route_duration_minutes, bool)
            or not isinstance(max_route_duration_minutes, int)
            or not 1 <= max_route_duration_minutes <= 24 * 60
        ):
            raise ValueError(
                "maximum route duration must be an integer between 1 and 1440 minutes"
            )
        self._validate_problem_inputs(depot, stops, vehicles)
        node_count = len(stops) + 1
        if (
            len(matrix.durations_s) != node_count
            or any(len(row) != node_count for row in matrix.durations_s)
            or len(matrix.distances_m) != node_count
            or any(len(row) != node_count for row in matrix.distances_m)
        ):
            raise ValueError("matrix must include depot plus every stop")
        self._validate_matrix_values(matrix)
        from ortools.constraint_solver import pywrapcp, routing_enums_pb2

        manager = pywrapcp.RoutingIndexManager(len(stops) + 1, len(vehicles), 0)
        routing = pywrapcp.RoutingModel(manager)

        def transit(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            service_seconds = 0 if from_node == 0 else stops[from_node - 1].service_minutes * 60
            return matrix.durations_s[from_node][to_node] + service_seconds

        transit_index = routing.RegisterTransitCallback(transit)
        routing.SetArcCostEvaluatorOfAllVehicles(transit_index)
        route_horizon_seconds = max_route_duration_minutes * 60
        routing.AddDimension(
            transit_index,
            route_horizon_seconds,
            route_horizon_seconds,
            True,
            "Time",
        )
        time_dimension = routing.GetDimensionOrDie("Time")
        for node, stop in enumerate(stops, start=1):
            index = manager.NodeToIndex(node)
            time_dimension.CumulVar(index).SetRange(stop.window_start_minute * 60, stop.window_end_minute * 60)
            routing.AddDisjunction([index], int(100_000 + max(1, stop.priority_score) * 100_000))
        for vehicle_index in range(len(vehicles)):
            routing.AddVariableMinimizedByFinalizer(
                time_dimension.CumulVar(routing.End(vehicle_index))
            )

        self._add_capacity_dimension(routing, manager, stops, vehicles, "Weight", 1000, "weight_kg", "max_weight_kg")
        self._add_capacity_dimension(routing, manager, stops, vehicles, "Volume", 1000, "volume_m3", "max_volume_m3")
        self._add_capacity_dimension(routing, manager, stops, vehicles, "Pallets", 100, "pallets", "max_pallets")

        search = pywrapcp.DefaultRoutingSearchParameters()
        search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
        search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        search.time_limit.seconds = self.time_limit_seconds
        solution = routing.SolveWithParameters(search)
        if solution is None:
            return OptimizationResult((), tuple(stop.stop_id for stop in stops), "infeasible")

        routes: list[VehicleRoute] = []
        served: set[int] = set()
        for vehicle_index, vehicle in enumerate(vehicles):
            index = routing.Start(vehicle_index)
            route_start_s = solution.Value(time_dimension.CumulVar(index))
            planned: list[PlannedStop] = []
            distance_m = 0
            weight = volume = pallets = 0.0
            sequence = 0
            while not routing.IsEnd(index):
                node = manager.IndexToNode(index)
                next_index = solution.Value(routing.NextVar(index))
                next_node = manager.IndexToNode(next_index)
                distance_m += matrix.distances_m[node][next_node]
                if node > 0:
                    stop = stops[node - 1]
                    sequence += 1
                    served.add(node)
                    planned.append(PlannedStop(stop.stop_id, sequence, solution.Value(time_dimension.CumulVar(index)) // 60))
                    weight += stop.weight_kg
                    volume += stop.volume_m3
                    pallets += stop.pallets
                index = next_index
            if planned:
                route_end_s = solution.Value(time_dimension.CumulVar(index))
                duration_s = route_end_s - route_start_s
                routes.append(VehicleRoute(vehicle.vehicle_id, tuple(planned), distance_m, duration_s, weight, volume, pallets))
        unserved = tuple(stops[node - 1].stop_id for node in range(1, len(stops) + 1) if node not in served)
        return OptimizationResult(tuple(routes), unserved, "succeeded")

    @staticmethod
    def _add_capacity_dimension(routing, manager, stops, vehicles, name: str, scale: int, demand_attr: str, capacity_attr: str) -> None:
        def demand(index: int) -> int:
            node = manager.IndexToNode(index)
            return 0 if node == 0 else math.ceil(getattr(stops[node - 1], demand_attr) * scale)

        callback = routing.RegisterUnaryTransitCallback(demand)
        capacities = [math.floor(getattr(vehicle, capacity_attr) * scale) for vehicle in vehicles]
        routing.AddDimensionWithVehicleCapacity(callback, 0, capacities, True, name)

    @classmethod
    def _validate_problem_inputs(
        cls,
        depot: Coordinate,
        stops: Sequence[DeliveryStop],
        vehicles: Sequence[Vehicle],
    ) -> None:
        cls._validate_coordinate(depot, "depot")

        vehicle_ids: set[str] = set()
        capacity_fields = (
            ("max_weight_kg", 1000),
            ("max_volume_m3", 1000),
            ("max_pallets", 100),
        )
        for vehicle in vehicles:
            if not isinstance(vehicle.vehicle_id, str) or not vehicle.vehicle_id.strip():
                raise ValueError("vehicle_id must be non-empty")
            if vehicle.vehicle_id in vehicle_ids:
                raise ValueError("vehicle_id values must be unique")
            vehicle_ids.add(vehicle.vehicle_id)
            for field, scale in capacity_fields:
                value = cls._finite_number(getattr(vehicle, field), f"vehicle {vehicle.vehicle_id} {field}")
                scaled_value = value * scale
                if value <= 0:
                    raise ValueError(f"vehicle {vehicle.vehicle_id} {field} must be positive")
                if not math.isfinite(scaled_value) or scaled_value > cls._MAX_INT64:
                    raise ValueError(
                        f"vehicle {vehicle.vehicle_id} {field} is outside the supported range"
                    )
                if math.floor(scaled_value) <= 0:
                    raise ValueError(f"vehicle {vehicle.vehicle_id} {field} must be positive")

        stop_ids: set[str] = set()
        for stop in stops:
            if not isinstance(stop.stop_id, str) or not stop.stop_id.strip():
                raise ValueError("stop_id must be non-empty")
            if stop.stop_id in stop_ids:
                raise ValueError("stop_id values must be unique")
            stop_ids.add(stop.stop_id)
            cls._validate_coordinate(stop.coordinate, f"stop {stop.stop_id}")

            demands = []
            for field, scale in (
                ("weight_kg", 1000),
                ("volume_m3", 1000),
                ("pallets", 100),
            ):
                value = cls._finite_number(
                    getattr(stop, field),
                    f"stop {stop.stop_id} {field}",
                )
                scaled_value = value * scale
                if not math.isfinite(scaled_value) or scaled_value > cls._MAX_INT64:
                    raise ValueError(f"stop {stop.stop_id} {field} is outside the supported range")
                demands.append(value)
            if any(value < 0 for value in demands):
                raise ValueError(f"stop {stop.stop_id} capacity demands must be non-negative")
            if not any(value > 0 for value in demands):
                raise ValueError(f"stop {stop.stop_id} must have positive capacity demand")

            if (
                isinstance(stop.service_minutes, bool)
                or not isinstance(stop.service_minutes, int)
                or not 0 <= stop.service_minutes < 24 * 60
            ):
                raise ValueError(f"stop {stop.stop_id} service_minutes must be between 0 and 1439")
            for field in ("window_start_minute", "window_end_minute"):
                value = getattr(stop, field)
                if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < 24 * 60:
                    raise ValueError(f"stop {stop.stop_id} {field} must be between 0 and 1439")
            if stop.window_end_minute < stop.window_start_minute:
                raise ValueError(f"stop {stop.stop_id} time window is invalid")
            priority = cls._finite_number(stop.priority_score, f"stop {stop.stop_id} priority_score")
            if not 1 <= priority <= 10:
                raise ValueError(f"stop {stop.stop_id} priority_score must be between 1 and 10")

    @staticmethod
    def _validate_coordinate(coordinate: Coordinate, label: str) -> None:
        if (
            not isinstance(coordinate, Coordinate)
            or isinstance(coordinate.latitude, bool)
            or isinstance(coordinate.longitude, bool)
            or not isinstance(coordinate.latitude, (int, float))
            or not isinstance(coordinate.longitude, (int, float))
            or not math.isfinite(coordinate.latitude)
            or not math.isfinite(coordinate.longitude)
            or not -90 <= coordinate.latitude <= 90
            or not -180 <= coordinate.longitude <= 180
        ):
            raise ValueError(f"{label} coordinate must contain finite WGS84 values")

    @staticmethod
    def _finite_number(value: object, label: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{label} must be a finite number")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ValueError(f"{label} must be a finite number")
        return numeric

    @classmethod
    def _validate_matrix_values(cls, matrix: TravelMatrix) -> None:
        for field in ("distances_m", "durations_s"):
            for row_index, row in enumerate(getattr(matrix, field)):
                for column_index, value in enumerate(row):
                    if (
                        isinstance(value, bool)
                        or not isinstance(value, int)
                        or not 0 <= value <= cls._MAX_INT64
                    ):
                        raise ValueError(
                            f"matrix {field} cell [{row_index}][{column_index}] must be a non-negative integer"
                        )
