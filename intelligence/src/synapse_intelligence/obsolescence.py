"""Obsolescence / slow-mover risk scoring (candidate, dependency-light).

Business Rules v1 already flags overstock by months of cover (>6 warning,
>9 academic approval). This module turns that single signal into a transparent
per-material risk score by combining it with the demand-pattern signals the
forecasting layer produces:

- the TSB smoothed demand probability, which decays toward zero as an item stops
  moving (obsolescence);
- the Syntetos-Boylan-Croston demand category (lumpy / intermittent carry more
  obsolescence risk than smooth);
- the trailing run of zero-demand months;
- months of cover from on-hand stock, reusing the existing >6 / >9 thresholds.

The score is a documented, deterministic weighting -- not a learned model -- so a
planner can see exactly why an item was flagged. It is candidate analytics and
does not change any replenishment decision on its own.

Reference: Teunter, Syntetos & Babai on demand-probability decay for obsolescent
items; SYNAPSE Business Rules v1 overstock thresholds.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from statistics import fmean
from typing import Sequence

from .forecasting import classify_demand, tsb_components


@dataclass(frozen=True)
class ObsolescenceSignal:
    risk_score: float           # 0.0 (moving) .. 1.0 (very likely obsolete)
    risk_level: str             # none | watch | warning | critical
    demand_probability: float   # TSB smoothed probability of demand in a period
    category: str               # smooth | erratic | intermittent | lumpy
    zero_streak: int            # trailing months with zero demand
    months_of_cover: float | None
    reasons: tuple[str, ...]


def zero_demand_streak(history: Sequence[float]) -> int:
    streak = 0
    for value in reversed(list(history)):
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            break
        if numeric > 0:
            break
        streak += 1
    return streak


def months_of_cover(on_hand: float, mean_demand: float) -> float | None:
    if mean_demand <= 0:
        return None
    return on_hand / mean_demand


def obsolescence_signal(
    history: Sequence[float],
    *,
    on_hand: float | None = None,
    warn_months: float = 6.0,
    critical_months: float = 9.0,
) -> ObsolescenceSignal:
    values = [max(0.0, float(value)) for value in history if math.isfinite(float(value))]
    probability, _ = tsb_components(values)
    category = classify_demand(values).category
    streak = zero_demand_streak(values)
    mean_demand = fmean(values) if values else 0.0
    cover = months_of_cover(on_hand, mean_demand) if on_hand is not None else None

    reasons: list[str] = []
    score = 0.0

    if category in ("intermittent", "lumpy"):
        score += 0.10
        reasons.append(f"{category} demand pattern")

    # Low smoothed demand probability is the primary obsolescence signal.
    if probability < 0.25:
        contribution = 0.40 * (0.25 - probability) / 0.25
        score += contribution
        reasons.append(f"low demand probability ({probability:.2f})")

    # A long run of zero months compounds the risk, scaled against the critical
    # overstock threshold: a streak as long as `critical_months` saturates it.
    if streak >= 3:
        score += 0.35 * min(1.0, streak / max(1.0, critical_months))
        reasons.append(f"{streak} consecutive zero-demand months")

    # Overstock relative to the existing months-of-cover thresholds.
    if cover is not None:
        if cover > critical_months:
            score += 0.40
            reasons.append(f"months of cover {cover:.1f} > {critical_months:g}")
        elif cover > warn_months:
            score += 0.20
            reasons.append(f"months of cover {cover:.1f} > {warn_months:g}")

    score = min(1.0, score)

    if score >= 0.70:
        level = "critical"
    elif score >= 0.40:
        level = "warning"
    elif score >= 0.20:
        level = "watch"
    else:
        level = "none"

    return ObsolescenceSignal(
        risk_score=score,
        risk_level=level,
        demand_probability=probability,
        category=category,
        zero_streak=streak,
        months_of_cover=cover,
        reasons=tuple(reasons),
    )
