"""Statistical replenishment-policy helpers (candidate, activation-gated).

Business Rules v1 sizes district targets with a fixed months-of-cover heuristic
(``MIN = CMP x 4``, ``MAX = CMP x 6``). That ignores demand and lead-time
variability, so a steady district and a spiky district of equal mean carry the
same buffer. This module implements the field-standard periodic-review policy so
the buffer is derived from a *service level* and the demand uncertainty the M07
forecaster already estimates:

- ``safety_stock`` -- ``z(service level) x sigma`` of protection-interval demand.
- ``periodic_policy`` -- an ``(R, s, S)`` order-up-to policy on the weekly review
  cadence, matching how the replenishment plan is actually recomputed.
- ``simulate_periodic_review`` -- an inventory-aware backtest that replays a
  demand series under a policy and reports achieved fill rate and holding, so a
  forecast can be scored by realised service, not only forecast error. This is
  also the building block for a multi-echelon (warehouse + district) rollout.

Everything here is deterministic, dependency-light and does not read or write the
database. It is not wired into the frozen Business Rules v1 production path; see
``docs/RESEARCH_DRIVEN_IMPROVEMENTS.md`` for the activation gate.

References:
- Silver, Pyke & Thomas, *Inventory and Production Management in Supply Chains*
  (periodic review, order-up-to, safety stock from service level).
- Syntetos & Boylan, spare-parts service-level sizing for intermittent demand.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from statistics import fmean
from typing import Sequence


def normal_ppf(probability: float) -> float:
    """Inverse standard-normal CDF (Acklam's rational approximation).

    Returns the safety factor ``z`` for a cycle service level. ``z(0.5) = 0``,
    ``z(0.95) ~= 1.6449``, ``z(0.99) ~= 2.3263``. Kept local so the worker needs
    no SciPy dependency.
    """
    if not 0.0 < probability < 1.0:
        if probability <= 0.0:
            return float("-inf")
        if probability >= 1.0:
            return float("inf")
        raise ValueError("probability must be in (0, 1)")

    a = (
        -3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
        1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00,
    )
    b = (
        -5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
        6.680131188771972e01, -1.328068155288572e01,
    )
    c = (
        -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
        -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00,
    )
    d = (
        7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
        3.754408661907416e00,
    )
    low = 0.02425
    high = 1.0 - low
    if probability < low:
        q = math.sqrt(-2.0 * math.log(probability))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    if probability <= high:
        q = probability - 0.5
        r = q * q
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (
            ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0
        )
    q = math.sqrt(-2.0 * math.log(1.0 - probability))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
        (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
    )


@dataclass(frozen=True)
class DemandStats:
    mean: float
    std: float
    periods: int


def demand_stats(history: Sequence[float]) -> DemandStats:
    """Per-period mean and (sample) standard deviation over the full history.

    Zeros are retained on purpose: for intermittent items the variability of the
    all-period series is what the safety stock must cover.
    """
    values = [max(0.0, float(value)) for value in history if math.isfinite(float(value))]
    if not values:
        return DemandStats(mean=0.0, std=0.0, periods=0)
    mean = fmean(values)
    if len(values) >= 2:
        variance = sum((value - mean) ** 2 for value in values) / (len(values) - 1)
        std = math.sqrt(variance)
    else:
        std = 0.0
    return DemandStats(mean=mean, std=std, periods=len(values))


def safety_stock(std_per_period: float, service_level: float, protection_periods: float) -> float:
    """Safety stock covering demand variability over the protection interval.

    Assumes per-period demand is (approximately) independent, so the protection
    standard deviation scales with ``sqrt(protection)``.
    """
    if std_per_period < 0 or protection_periods < 0:
        raise ValueError("std and protection must be non-negative")
    protection_std = std_per_period * math.sqrt(protection_periods)
    return max(0.0, normal_ppf(service_level) * protection_std)


@dataclass(frozen=True)
class ReplenishmentPolicy:
    review_period: int
    lead_time: float
    service_level: float
    mean_per_period: float
    std_per_period: float
    protection_periods: float
    safety_stock: float
    reorder_point: float          # s: order when inventory position falls to/below this
    order_up_to_level: float      # S: raise the inventory position to this


def periodic_policy(
    mean_per_period: float,
    std_per_period: float,
    *,
    review_period: int,
    lead_time: float,
    service_level: float,
) -> ReplenishmentPolicy:
    """Build an ``(R, s, S)`` order-up-to policy for a weekly review cadence.

    The order-up-to level ``S`` protects the review-plus-lead-time interval; the
    reorder point ``s`` protects the lead time alone. Both include a
    service-level safety stock.
    """
    if review_period < 1:
        raise ValueError("review_period must be a positive number of periods")
    if lead_time < 0:
        raise ValueError("lead_time must be non-negative")
    protection = review_period + lead_time
    protection_ss = safety_stock(std_per_period, service_level, protection)
    order_up_to = mean_per_period * protection + protection_ss
    lead_ss = safety_stock(std_per_period, service_level, lead_time)
    reorder = mean_per_period * lead_time + lead_ss
    return ReplenishmentPolicy(
        review_period=review_period,
        lead_time=lead_time,
        service_level=service_level,
        mean_per_period=mean_per_period,
        std_per_period=std_per_period,
        protection_periods=protection,
        safety_stock=protection_ss,
        reorder_point=reorder,
        order_up_to_level=order_up_to,
    )


@dataclass(frozen=True)
class SimulationResult:
    fill_rate: float                 # beta: fraction of demand met immediately
    cycle_service_level: float       # alpha: fraction of periods without a stockout
    average_on_hand: float
    stockout_periods: int
    total_periods: int
    total_demand: float
    total_unmet: float
    order_count: int


def simulate_periodic_review(
    demand: Sequence[float],
    *,
    order_up_to_level: float,
    review_period: int,
    lead_time: int,
    reorder_point: float | None = None,
    initial_on_hand: float | None = None,
) -> SimulationResult:
    """Replay a demand series under an ``(R, s, S)`` policy and score service.

    Every ``review_period`` periods the inventory position is compared to
    ``reorder_point`` (defaults to always order, i.e. an ``(R, S)`` policy) and,
    if at or below it, an order raising the position to ``order_up_to_level`` is
    placed; the order arrives after ``lead_time`` periods. Unmet demand is lost
    for the fill-rate measure. Use it as an inventory-aware backtest: score a
    forecast/policy by achieved fill rate and average holding, not just WAPE.
    """
    if review_period < 1:
        raise ValueError("review_period must be positive")
    if lead_time < 0:
        raise ValueError("lead_time must be non-negative")
    demand_values = [max(0.0, float(value)) for value in demand]
    horizon = len(demand_values)
    if horizon == 0:
        return SimulationResult(1.0, 1.0, 0.0, 0, 0, 0.0, 0.0, 0)

    on_hand = order_up_to_level if initial_on_hand is None else initial_on_hand
    arrivals = [0.0] * (horizon + lead_time + 1)
    on_order = 0.0
    total_demand = 0.0
    total_unmet = 0.0
    on_hand_sum = 0.0
    stockout_periods = 0
    order_count = 0

    for period in range(horizon):
        receipt = arrivals[period]
        on_hand += receipt
        on_order -= receipt

        if period % review_period == 0:
            position = on_hand + on_order
            if reorder_point is None or position <= reorder_point:
                order_quantity = order_up_to_level - position
                if order_quantity > 0:
                    arrivals[period + lead_time] += order_quantity
                    on_order += order_quantity
                    order_count += 1

        period_demand = demand_values[period]
        total_demand += period_demand
        served = min(on_hand, period_demand)
        unmet = period_demand - served
        on_hand -= served
        total_unmet += unmet
        if unmet > 0:
            stockout_periods += 1
        on_hand_sum += on_hand

    fill_rate = 1.0 if total_demand == 0 else (total_demand - total_unmet) / total_demand
    cycle_service_level = (horizon - stockout_periods) / horizon
    return SimulationResult(
        fill_rate=fill_rate,
        cycle_service_level=cycle_service_level,
        average_on_hand=on_hand_sum / horizon,
        stockout_periods=stockout_periods,
        total_periods=horizon,
        total_demand=total_demand,
        total_unmet=total_unmet,
        order_count=order_count,
    )
