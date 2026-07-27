"""Two-echelon (warehouse -> district) base-stock simulation and sizing.

SYNAPSE is physically two-echelon: the central warehouse replenishes the
districts, and the districts serve end demand. Sizing each district's buffer in
isolation ignores that a district stockout can be caused *upstream* -- the
warehouse being unable to fill the district's order. This module makes that
coupling explicit so safety stock can be reasoned about across both levels
instead of node by node.

- ``simulate_two_echelon`` replays district demand under order-up-to policies at
  both levels, propagating warehouse shortfalls into district service, and
  reports per-district and system fill rate plus average on-hand at each level.
- ``size_two_echelon_policy`` sizes each district order-up-to level from its own
  demand (reusing ``periodic_policy``) and the warehouse level from the
  aggregated demand over the supplier lead time -- the practical guaranteed-service
  starting point before a full optimisation.

Deterministic, dependency-light, no database coupling. Candidate analytics; see
``docs/RESEARCH_DRIVEN_IMPROVEMENTS.md``.

Reference: guaranteed-service model for multi-echelon inventory optimisation
(Graves & Willems; Achkar et al., EJOR 2023).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

from .replenishment import demand_stats, periodic_policy, safety_stock


@dataclass(frozen=True)
class DistrictResult:
    district_id: str
    fill_rate: float
    stockout_periods: int
    average_on_hand: float
    total_demand: float
    total_unmet: float


@dataclass(frozen=True)
class TwoEchelonResult:
    system_fill_rate: float
    warehouse_fill_rate: float          # fraction of district requests the warehouse filled
    average_warehouse_on_hand: float
    average_district_on_hand: float
    total_periods: int
    districts: dict[str, DistrictResult] = field(default_factory=dict)


def simulate_two_echelon(
    district_demand: Mapping[str, Sequence[float]],
    *,
    warehouse_order_up_to: float,
    district_order_up_to: Mapping[str, float],
    review_period: int = 1,
    warehouse_lead_time: int = 1,
    district_lead_time: int = 1,
    initial_warehouse_on_hand: float | None = None,
) -> TwoEchelonResult:
    if review_period < 1:
        raise ValueError("review_period must be positive")
    if warehouse_lead_time < 0 or district_lead_time < 0:
        raise ValueError("lead times must be non-negative")
    districts = list(district_demand)
    if not districts:
        raise ValueError("at least one district is required")
    missing = [key for key in districts if key not in district_order_up_to]
    if missing:
        raise ValueError(f"missing district order-up-to levels for {missing}")

    horizon = max(len(list(values)) for values in district_demand.values())
    demand = {key: [max(0.0, float(v)) for v in district_demand[key]] for key in districts}
    for key in districts:
        demand[key] += [0.0] * (horizon - len(demand[key]))
    if horizon == 0:
        raise ValueError("demand history is empty")

    warehouse_on_hand = (
        warehouse_order_up_to if initial_warehouse_on_hand is None else initial_warehouse_on_hand
    )
    warehouse_pipeline = [0.0] * (horizon + warehouse_lead_time + 1)
    warehouse_on_order = 0.0

    dist_on_hand = {key: district_order_up_to[key] for key in districts}
    dist_pipeline = {key: [0.0] * (horizon + district_lead_time + 1) for key in districts}
    dist_on_order = {key: 0.0 for key in districts}

    dist_demand_total = {key: 0.0 for key in districts}
    dist_unmet_total = {key: 0.0 for key in districts}
    dist_stockouts = {key: 0 for key in districts}
    dist_on_hand_sum = {key: 0.0 for key in districts}
    warehouse_on_hand_sum = 0.0
    requested_total = 0.0
    shipped_total = 0.0

    for period in range(horizon):
        # 1. Receive scheduled arrivals.
        warehouse_receipt = warehouse_pipeline[period]
        warehouse_on_hand += warehouse_receipt
        warehouse_on_order -= warehouse_receipt
        for key in districts:
            receipt = dist_pipeline[key][period]
            dist_on_hand[key] += receipt
            dist_on_order[key] -= receipt

        # 2. Warehouse replenishes itself from the external supplier.
        if period % review_period == 0:
            position = warehouse_on_hand + warehouse_on_order
            order = warehouse_order_up_to - position
            if order > 0:
                warehouse_pipeline[period + warehouse_lead_time] += order
                warehouse_on_order += order

        # 3. Districts request up to their order-up-to level; the warehouse fills
        #    from stock on hand, allocating proportionally under a shortfall.
        if period % review_period == 0:
            requests = {}
            for key in districts:
                position = dist_on_hand[key] + dist_on_order[key]
                requests[key] = max(0.0, district_order_up_to[key] - position)
            total_request = sum(requests.values())
            requested_total += total_request
            if total_request > 0:
                fillable = min(warehouse_on_hand, total_request)
                shipped_total += fillable
                ratio = fillable / total_request
                for key in districts:
                    shipment = requests[key] * ratio
                    if shipment > 0:
                        dist_pipeline[key][period + district_lead_time] += shipment
                        dist_on_order[key] += shipment
                warehouse_on_hand -= fillable

        # 4. End demand at each district; unmet demand is lost.
        for key in districts:
            period_demand = demand[key][period]
            dist_demand_total[key] += period_demand
            served = min(dist_on_hand[key], period_demand)
            unmet = period_demand - served
            dist_on_hand[key] -= served
            dist_unmet_total[key] += unmet
            if unmet > 0:
                dist_stockouts[key] += 1
            dist_on_hand_sum[key] += dist_on_hand[key]
        warehouse_on_hand_sum += warehouse_on_hand

    district_results: dict[str, DistrictResult] = {}
    for key in districts:
        total = dist_demand_total[key]
        unmet = dist_unmet_total[key]
        district_results[key] = DistrictResult(
            district_id=key,
            fill_rate=1.0 if total == 0 else (total - unmet) / total,
            stockout_periods=dist_stockouts[key],
            average_on_hand=dist_on_hand_sum[key] / horizon,
            total_demand=total,
            total_unmet=unmet,
        )

    system_demand = sum(dist_demand_total.values())
    system_unmet = sum(dist_unmet_total.values())
    return TwoEchelonResult(
        system_fill_rate=1.0 if system_demand == 0 else (system_demand - system_unmet) / system_demand,
        warehouse_fill_rate=1.0 if requested_total == 0 else shipped_total / requested_total,
        average_warehouse_on_hand=warehouse_on_hand_sum / horizon,
        average_district_on_hand=sum(dist_on_hand_sum.values()) / horizon,
        total_periods=horizon,
        districts=district_results,
    )


@dataclass(frozen=True)
class TwoEchelonPolicy:
    warehouse_order_up_to: float
    district_order_up_to: dict[str, float]
    service_level: float


def size_two_echelon_policy(
    district_demand: Mapping[str, Sequence[float]],
    *,
    service_level: float,
    review_period: int = 1,
    warehouse_lead_time: int = 1,
    district_lead_time: int = 1,
) -> TwoEchelonPolicy:
    """Guaranteed-service starting point: size districts from their own demand and
    the warehouse from the aggregated demand over its protection interval.

    Districts use ``periodic_policy`` on the review+district-lead interval. The
    warehouse holds a cycle stock for the aggregate demand over its own
    review+supplier-lead interval plus a pooled safety stock; risk pooling means
    the aggregate standard deviation (with cross-district independence) is smaller
    than the sum of district standard deviations.
    """
    district_levels: dict[str, float] = {}
    aggregate_mean = 0.0
    aggregate_variance = 0.0
    for key, history in district_demand.items():
        stats = demand_stats(history)
        policy = periodic_policy(
            stats.mean,
            stats.std,
            review_period=review_period,
            lead_time=district_lead_time,
            service_level=service_level,
        )
        district_levels[key] = policy.order_up_to_level
        aggregate_mean += stats.mean
        aggregate_variance += stats.std ** 2  # independence: variances add

    warehouse_protection = review_period + warehouse_lead_time
    aggregate_std = aggregate_variance ** 0.5
    warehouse_cycle = aggregate_mean * warehouse_protection
    warehouse_safety = safety_stock(aggregate_std, service_level, warehouse_protection)
    return TwoEchelonPolicy(
        warehouse_order_up_to=warehouse_cycle + warehouse_safety,
        district_order_up_to=district_levels,
        service_level=service_level,
    )
