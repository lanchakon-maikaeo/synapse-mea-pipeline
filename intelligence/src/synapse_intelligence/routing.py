from __future__ import annotations

from dataclasses import dataclass
import json
import math
from typing import Protocol, Sequence
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class Coordinate:
    latitude: float
    longitude: float


@dataclass(frozen=True)
class TravelMatrix:
    distances_m: tuple[tuple[int, ...], ...]
    durations_s: tuple[tuple[int, ...], ...]
    source: str


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


class HaversineMatrixAdapter:
    def __init__(self, average_speed_kph: float = 30.0):
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
    def __init__(self, base_url: str, timeout_seconds: int = 20):
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def build(self, coordinates: Sequence[Coordinate]) -> TravelMatrix:
        locations = [{"lat": point.latitude, "lon": point.longitude} for point in coordinates]
        payload = json.dumps(
            {"sources": locations, "targets": locations, "costing": "truck", "units": "kilometers", "verbose": False}
        ).encode()
        request = Request(
            f"{self.base_url}/sources_to_targets",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310 - configured service URL
            result = json.load(response)
        cells = result["sources_to_targets"]
        if isinstance(cells, dict):
            # Kept for compatibility with gateways that normalize matrix output.
            durations_raw = cells["durations"]
            distances_raw = cells["distances"]
            durations = tuple(tuple(round(value or 0) for value in row) for row in durations_raw)
            distances = tuple(tuple(round((value or 0) * 1000) for value in row) for row in distances_raw)
        else:
            # Native Valhalla response: a two-dimensional array of result cells.
            durations = tuple(tuple(round(cell.get("time") or 0) for cell in row) for row in cells)
            distances = tuple(tuple(round((cell.get("distance") or 0) * 1000) for cell in row) for row in cells)
        return TravelMatrix(distances, durations, "valhalla")


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
    def __init__(self, time_limit_seconds: int = 10):
        self.time_limit_seconds = time_limit_seconds

    def solve(
        self,
        depot: Coordinate,
        stops: Sequence[DeliveryStop],
        vehicles: Sequence[Vehicle],
        matrix: TravelMatrix,
    ) -> OptimizationResult:
        if not vehicles:
            raise ValueError("at least one vehicle is required")
        if len(matrix.durations_s) != len(stops) + 1:
            raise ValueError("matrix must include depot plus every stop")
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
        routing.AddDimension(transit_index, 24 * 3600, 24 * 3600, False, "Time")
        time_dimension = routing.GetDimensionOrDie("Time")
        for node, stop in enumerate(stops, start=1):
            index = manager.NodeToIndex(node)
            time_dimension.CumulVar(index).SetRange(stop.window_start_minute * 60, stop.window_end_minute * 60)
            routing.AddDisjunction([index], int(100_000 + max(1, stop.priority_score) * 100_000))
        for vehicle_index in range(len(vehicles)):
            time_dimension.CumulVar(routing.Start(vehicle_index)).SetRange(0, 24 * 3600)

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
            planned: list[PlannedStop] = []
            distance_m = 0
            duration_s = 0
            weight = volume = pallets = 0.0
            sequence = 0
            while not routing.IsEnd(index):
                node = manager.IndexToNode(index)
                next_index = solution.Value(routing.NextVar(index))
                next_node = manager.IndexToNode(next_index)
                distance_m += matrix.distances_m[node][next_node]
                duration_s += transit(index, next_index)
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
                routes.append(VehicleRoute(vehicle.vehicle_id, tuple(planned), distance_m, duration_s, weight, volume, pallets))
        unserved = tuple(stops[node - 1].stop_id for node in range(1, len(stops) + 1) if node not in served)
        return OptimizationResult(tuple(routes), unserved, "succeeded")

    @staticmethod
    def _add_capacity_dimension(routing, manager, stops, vehicles, name: str, scale: int, demand_attr: str, capacity_attr: str) -> None:
        def demand(index: int) -> int:
            node = manager.IndexToNode(index)
            return 0 if node == 0 else round(getattr(stops[node - 1], demand_attr) * scale)

        callback = routing.RegisterUnaryTransitCallback(demand)
        capacities = [round(getattr(vehicle, capacity_attr) * scale) for vehicle in vehicles]
        routing.AddDimensionWithVehicleCapacity(callback, 0, capacities, True, name)
