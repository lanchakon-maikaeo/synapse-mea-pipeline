"""Clarke-Wright savings CVRP solver (candidate, dependency-light).

A second, fully in-house solver so the deployed OR-Tools CVRPTW plan has
something to be benchmarked against via ``route_benchmark`` -- with no external
dependency to install. It is the classic parallel savings heuristic with
capacity (weight / volume / pallets) constraints and a heterogeneous-fleet
assignment step, emitting the same ``OptimizationResult`` shape the OR-Tools
optimiser produces, so it is a drop-in comparison solver.

Scope: it optimises distance under vehicle capacity. It does not enforce delivery
time windows (the OR-Tools operational solve does), so treat it as a
distance-focused capacity benchmark, not a dispatch plan. Arrival minutes are
reported from cumulative travel + service time for reference only.

Candidate analytics; see ``docs/RESEARCH_DRIVEN_IMPROVEMENTS.md``.

Reference: Clarke & Wright, "Scheduling of vehicles from a central depot to a
number of delivery points" (1964).
"""

from __future__ import annotations

from typing import Sequence

from .routing import (
    Coordinate,
    DeliveryStop,
    OptimizationResult,
    PlannedStop,
    TravelMatrix,
    Vehicle,
)


def _fits(load: tuple[float, float, float], capacity: tuple[float, float, float]) -> bool:
    return all(l <= c + 1e-9 for l, c in zip(load, capacity))


class SavingsOptimizer:
    """Parallel Clarke-Wright savings solver with capacity constraints."""

    def __init__(self, *, solver_name: str = "clarke-wright-savings-v1") -> None:
        self.solver_name = solver_name

    def solve(
        self,
        depot: Coordinate,
        stops: Sequence[DeliveryStop],
        vehicles: Sequence[Vehicle],
        matrix: TravelMatrix,
    ) -> OptimizationResult:
        if not stops:
            return OptimizationResult(routes=(), unserved_stop_ids=(), solver_status="empty")
        if not vehicles:
            return OptimizationResult(
                routes=(), unserved_stop_ids=tuple(stop.stop_id for stop in stops), solver_status="no_vehicles"
            )

        distances = matrix.distances_m
        # Matrix index 0 is the depot; customer c (0-based stop) is index c + 1.
        max_capacity = (
            max(vehicle.max_weight_kg for vehicle in vehicles),
            max(vehicle.max_volume_m3 for vehicle in vehicles),
            max(vehicle.max_pallets for vehicle in vehicles),
        )
        loads = [(stop.weight_kg, stop.volume_m3, stop.pallets) for stop in stops]

        # Each customer starts on its own route; drop any that no vehicle can carry.
        routes: list[list[int]] = []
        route_of: dict[int, int] = {}
        unfit: list[int] = []
        for customer in range(len(stops)):
            if _fits(loads[customer], max_capacity):
                route_of[customer] = len(routes)
                routes.append([customer])
            else:
                unfit.append(customer)

        savings = []
        for i in range(len(stops)):
            if i in unfit:
                continue
            for j in range(i + 1, len(stops)):
                if j in unfit:
                    continue
                saving = distances[0][i + 1] + distances[0][j + 1] - distances[i + 1][j + 1]
                savings.append((saving, i, j))
        savings.sort(key=lambda item: (-item[0], item[1], item[2]))

        for _, i, j in savings:
            ri, rj = route_of.get(i), route_of.get(j)
            if ri is None or rj is None or ri == rj:
                continue
            route_i, route_j = routes[ri], routes[rj]
            # i and j must each be an endpoint of their route to be joined.
            if i not in (route_i[0], route_i[-1]) or j not in (route_j[0], route_j[-1]):
                continue
            combined_load = tuple(a + b for a, b in zip(_route_load(route_i, loads), _route_load(route_j, loads)))
            if not _fits(combined_load, max_capacity):
                continue
            oriented_i = route_i if route_i[-1] == i else list(reversed(route_i))
            oriented_j = route_j if route_j[0] == j else list(reversed(route_j))
            merged = oriented_i + oriented_j
            routes[ri] = merged
            for customer in oriented_j:
                route_of[customer] = ri
            routes[rj] = []

        active_routes = [route for route in routes if route]
        # Assign routes to vehicles: heaviest routes to largest vehicles first.
        active_routes.sort(key=lambda route: _route_load(route, loads)[0], reverse=True)
        available = sorted(vehicles, key=lambda vehicle: vehicle.max_weight_kg, reverse=True)

        vehicle_routes = []
        unserved: list[str] = [stops[customer].stop_id for customer in unfit]
        used_vehicles: set[str] = set()
        for route in active_routes:
            load = _route_load(route, loads)
            assigned = None
            for vehicle in available:
                if vehicle.vehicle_id in used_vehicles:
                    continue
                cap = (vehicle.max_weight_kg, vehicle.max_volume_m3, vehicle.max_pallets)
                if _fits(load, cap):
                    assigned = vehicle
                    break
            if assigned is None:
                unserved.extend(stops[customer].stop_id for customer in route)
                continue
            used_vehicles.add(assigned.vehicle_id)
            vehicle_routes.append(_build_vehicle_route(assigned, route, stops, matrix))

        status = "optimal" if not unserved else "partial"
        return OptimizationResult(
            routes=tuple(vehicle_routes),
            unserved_stop_ids=tuple(unserved),
            solver_status=status,
        )


def _route_load(route: Sequence[int], loads: Sequence[tuple[float, float, float]]) -> tuple[float, float, float]:
    weight = sum(loads[customer][0] for customer in route)
    volume = sum(loads[customer][1] for customer in route)
    pallets = sum(loads[customer][2] for customer in route)
    return weight, volume, pallets


def _build_vehicle_route(
    vehicle: Vehicle,
    route: Sequence[int],
    stops: Sequence[DeliveryStop],
    matrix: TravelMatrix,
):
    from .routing import VehicleRoute  # local import keeps the module import graph flat

    distance = 0
    duration = 0
    planned: list[PlannedStop] = []
    previous_index = 0  # depot
    cumulative_seconds = 0
    for sequence, customer in enumerate(route, start=1):
        node = customer + 1
        distance += matrix.distances_m[previous_index][node]
        cumulative_seconds += matrix.durations_s[previous_index][node]
        planned.append(PlannedStop(stops[customer].stop_id, sequence, round(cumulative_seconds / 60)))
        cumulative_seconds += stops[customer].service_minutes * 60
        previous_index = node
    distance += matrix.distances_m[previous_index][0]
    cumulative_seconds += matrix.durations_s[previous_index][0]
    duration = cumulative_seconds

    load = _route_load(route, [(s.weight_kg, s.volume_m3, s.pallets) for s in stops])
    return VehicleRoute(
        vehicle_id=vehicle.vehicle_id,
        stops=tuple(planned),
        distance_m=distance,
        duration_s=duration,
        weight_kg=load[0],
        volume_m3=load[1],
        pallets=load[2],
    )
