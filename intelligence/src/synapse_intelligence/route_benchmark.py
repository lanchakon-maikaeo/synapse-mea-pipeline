"""Solver-agnostic route-solution benchmark (candidate, dependency-light).

M08's acceptance criterion asks each route plan to be compared against an
alternative. This module scores any route solution on a common, reproducible set
of metrics and compares two of them, so the deployed OR-Tools CVRPTW result can
be benchmarked against a second solver (e.g. a future PyVRP adapter) behind the
same ``matrix_source`` contract, or against the previous plan.

It is intentionally structural: it consumes anything shaped like the routing
``OptimizationResult`` (``.routes`` with ``vehicle_id`` / ``stops`` /
``distance_m`` / ``duration_s`` / ``weight_kg`` / ``volume_m3`` / ``pallets``,
plus ``.unserved_stop_ids`` and ``.solver_status``). No dependency on OR-Tools or
any solver, so a solver can be evaluated without being installed here.

Candidate analytics; see ``docs/RESEARCH_DRIVEN_IMPROVEMENTS.md``. It scores and
compares -- it does not choose or dispatch a plan.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Protocol, Sequence

_UTILIZATION_TOLERANCE = 1e-9


@dataclass(frozen=True)
class VehicleCapacity:
    max_weight_kg: float
    max_volume_m3: float
    max_pallets: float


class _Route(Protocol):
    vehicle_id: str
    stops: Sequence[object]
    distance_m: int
    duration_s: int
    weight_kg: float
    volume_m3: float
    pallets: float


class _Solution(Protocol):
    routes: Sequence[_Route]
    unserved_stop_ids: Sequence[str]
    solver_status: str


@dataclass(frozen=True)
class RouteSolutionSummary:
    label: str
    solver_status: str
    served_stops: int
    unserved_stops: int
    vehicles_used: int
    total_distance_m: int
    total_duration_s: int
    mean_weight_utilization: float
    mean_volume_utilization: float
    mean_pallet_utilization: float
    max_weight_utilization: float
    feasible: bool


def summarize_solution(
    label: str,
    solution: _Solution,
    capacities: Mapping[str, VehicleCapacity],
) -> RouteSolutionSummary:
    used = [route for route in solution.routes if len(route.stops) > 0]
    served = sum(len(route.stops) for route in used)
    total_distance = sum(int(route.distance_m) for route in used)
    total_duration = sum(int(route.duration_s) for route in used)

    weight_utilizations: list[float] = []
    volume_utilizations: list[float] = []
    pallet_utilizations: list[float] = []
    feasible = True
    for route in used:
        capacity = capacities.get(route.vehicle_id)
        if capacity is None:
            raise ValueError(f"missing capacity for vehicle {route.vehicle_id!r}")
        weight = route.weight_kg / capacity.max_weight_kg if capacity.max_weight_kg else 0.0
        volume = route.volume_m3 / capacity.max_volume_m3 if capacity.max_volume_m3 else 0.0
        pallet = route.pallets / capacity.max_pallets if capacity.max_pallets else 0.0
        weight_utilizations.append(weight)
        volume_utilizations.append(volume)
        pallet_utilizations.append(pallet)
        if max(weight, volume, pallet) > 1.0 + _UTILIZATION_TOLERANCE:
            feasible = False

    def _mean(values: list[float]) -> float:
        return sum(values) / len(values) if values else 0.0

    return RouteSolutionSummary(
        label=label,
        solver_status=solution.solver_status,
        served_stops=served,
        unserved_stops=len(list(solution.unserved_stop_ids)),
        vehicles_used=len(used),
        total_distance_m=total_distance,
        total_duration_s=total_duration,
        mean_weight_utilization=_mean(weight_utilizations),
        mean_volume_utilization=_mean(volume_utilizations),
        mean_pallet_utilization=_mean(pallet_utilizations),
        max_weight_utilization=max(weight_utilizations, default=0.0),
        feasible=feasible,
    )


@dataclass(frozen=True)
class RouteBenchmark:
    a: RouteSolutionSummary
    b: RouteSolutionSummary
    served_delta: int            # b.served - a.served
    distance_delta_m: int        # b.distance - a.distance
    winner: str                  # label of the better solution, or "tie"
    rationale: str


def _ranking_key(summary: RouteSolutionSummary) -> tuple[int, int, int, float]:
    # Prefer feasible plans, then fewer unserved stops, then shorter distance,
    # then higher mean weight utilisation. Lower tuple compares as better.
    return (
        0 if summary.feasible else 1,
        summary.unserved_stops,
        summary.total_distance_m,
        -summary.mean_weight_utilization,
    )


def compare_solutions(a: RouteSolutionSummary, b: RouteSolutionSummary) -> RouteBenchmark:
    key_a = _ranking_key(a)
    key_b = _ranking_key(b)
    if key_a < key_b:
        winner, rationale = a.label, _explain(a, b)
    elif key_b < key_a:
        winner, rationale = b.label, _explain(b, a)
    else:
        winner, rationale = "tie", "solutions are equivalent on feasibility, unserved, distance and utilisation"
    return RouteBenchmark(
        a=a,
        b=b,
        served_delta=b.served_stops - a.served_stops,
        distance_delta_m=b.total_distance_m - a.total_distance_m,
        winner=winner,
        rationale=rationale,
    )


def _explain(better: RouteSolutionSummary, worse: RouteSolutionSummary) -> str:
    if better.feasible != worse.feasible:
        return f"{better.label} is capacity-feasible while {worse.label} is not"
    if better.unserved_stops != worse.unserved_stops:
        return f"{better.label} leaves fewer stops unserved ({better.unserved_stops} vs {worse.unserved_stops})"
    if better.total_distance_m != worse.total_distance_m:
        return f"{better.label} is shorter ({better.total_distance_m} m vs {worse.total_distance_m} m)"
    return f"{better.label} uses vehicles more fully"
