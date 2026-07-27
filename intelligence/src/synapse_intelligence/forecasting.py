from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
import math
from statistics import fmean
from typing import Iterable, Sequence


@dataclass(frozen=True)
class DemandPoint:
    period_start: date
    quantity: float
    stockout_days: int = 0
    lead_time_days: float | None = None


@dataclass(frozen=True)
class ForecastMetrics:
    wape: float
    mae: float
    bias: float
    observations: int
    # Mean Absolute Scaled Error, scaled by the in-sample naive one-step error.
    # It is the scale-free metric recommended for intermittent series where WAPE
    # can be dominated by zero-demand months. ``None`` for models (e.g. AutoETS)
    # whose evaluation does not expose an aligned in-sample scale.
    mase: float | None = None


# Registry-aligned model versions. The keys are the internal model names used by
# the selectors below; the values are the ``analytics.forecast_model_versions``
# rows the worker persists. Intermittent-demand versions are activation-gated:
# see ``docs/RESEARCH_DRIVEN_IMPROVEMENTS.md`` and the prepared registration in
# ``supabase/candidate/``.
MODEL_VERSIONS = {
    "seasonal_naive": "seasonal-naive-v1",
    "moving_average": "moving-average-v1",
    "autoets": "autoets-v1",
    "croston": "croston-v1",
    "croston_sba": "croston-sba-v1",
    "tsb": "tsb-v1",
    "adida": "adida-v1",
}


# Syntetos-Boylan-Croston demand-classification cutoffs.
ADI_CUTOFF = 1.32
CV_SQUARED_CUTOFF = 0.49


@dataclass(frozen=True)
class DemandProfile:
    """Average inter-demand interval / squared coefficient of variation profile.

    Categories follow the Syntetos-Boylan-Croston scheme used to route each
    material x district series to an appropriate forecaster:

    - ``smooth``       ADI < 1.32 and CV^2 < 0.49
    - ``erratic``      ADI < 1.32 and CV^2 >= 0.49
    - ``intermittent`` ADI >= 1.32 and CV^2 < 0.49
    - ``lumpy``        ADI >= 1.32 and CV^2 >= 0.49
    """

    adi: float
    cv_squared: float
    category: str
    nonzero_periods: int
    total_periods: int


def classify_demand(history: Sequence[float]) -> DemandProfile:
    values = _clean(history)
    total = len(values)
    nonzero = [value for value in values if value > 0]
    if total == 0 or not nonzero:
        return DemandProfile(
            adi=float("inf"),
            cv_squared=0.0,
            category="intermittent",
            nonzero_periods=len(nonzero),
            total_periods=total,
        )
    adi = total / len(nonzero)
    mean_size = fmean(nonzero)
    if len(nonzero) >= 2 and mean_size > 0:
        variance = fmean([(value - mean_size) ** 2 for value in nonzero])
        cv_squared = variance / (mean_size ** 2)
    else:
        cv_squared = 0.0
    intermittent = adi >= ADI_CUTOFF
    erratic = cv_squared >= CV_SQUARED_CUTOFF
    if intermittent and erratic:
        category = "lumpy"
    elif intermittent:
        category = "intermittent"
    elif erratic:
        category = "erratic"
    else:
        category = "smooth"
    return DemandProfile(
        adi=adi,
        cv_squared=cv_squared,
        category=category,
        nonzero_periods=len(nonzero),
        total_periods=total,
    )


@dataclass(frozen=True)
class ForecastPoint:
    horizon: int
    predicted: float
    lower_80: float
    upper_80: float


@dataclass(frozen=True)
class ModelEvaluation:
    model_name: str
    metrics: ForecastMetrics
    errors: tuple[float, ...]


def statsforecast_autoets(history: Sequence[float], horizon: int, *, season_length: int = 12) -> tuple[ModelEvaluation, list[ForecastPoint]]:
    """Run Nixtla AutoETS with temporal cross-validation and an 80% interval."""
    import pandas as pd
    from statsforecast import StatsForecast
    from statsforecast.models import AutoETS

    values = _clean(history)
    if len(values) < max(8, season_length + 2):
        raise ValueError("AutoETS requires more history")
    dates = pd.date_range("2000-01-01", periods=len(values), freq="MS")
    frame = pd.DataFrame({"unique_id": "series", "ds": dates, "y": values})
    model = AutoETS(season_length=season_length)
    engine = StatsForecast(models=[model], freq="MS", n_jobs=1)
    windows = min(3, max(1, len(values) - max(7, season_length)))
    cross_validation = engine.cross_validation(df=frame, h=1, n_windows=windows, step_size=1)
    evaluation = ModelEvaluation(
        model_name="autoets",
        metrics=calculate_metrics(cross_validation["y"].tolist(), cross_validation["AutoETS"].tolist()),
        errors=tuple((cross_validation["AutoETS"] - cross_validation["y"]).tolist()),
    )
    forecast = engine.forecast(df=frame, h=horizon, level=[80])
    points = [
        ForecastPoint(
            horizon=index + 1,
            predicted=max(0.0, float(row["AutoETS"])),
            lower_80=max(0.0, float(row["AutoETS-lo-80"])),
            upper_80=max(0.0, float(row["AutoETS-hi-80"])),
        )
        for index, (_, row) in enumerate(forecast.iterrows())
    ]
    return evaluation, points


def _clean(values: Iterable[float]) -> list[float]:
    return [max(0.0, float(value)) for value in values if math.isfinite(float(value))]


def seasonal_naive(history: Sequence[float], horizon: int, season_length: int = 12) -> list[float]:
    values = _clean(history)
    if not values:
        return [0.0] * horizon
    season = values[-season_length:] if len(values) >= season_length else values
    return [season[index % len(season)] for index in range(horizon)]


def moving_average(history: Sequence[float], horizon: int, window: int = 3) -> list[float]:
    values = _clean(history)
    if not values:
        return [0.0] * horizon
    predicted: list[float] = []
    working = list(values)
    for _ in range(horizon):
        value = fmean(working[-window:])
        predicted.append(value)
        working.append(value)
    return predicted


# --- Intermittent-demand estimators -----------------------------------------
# Croston, SBA and TSB estimate a per-period demand *rate* (expected demand per
# month) rather than a shaped time series, so their forecast is flat across the
# horizon. They are the standard family for spare-parts / slow-moving inventory
# where seasonal and moving-average models are biased by the zero months.


def croston_rate(history: Sequence[float], *, alpha: float = 0.1) -> float:
    """Classic Croston rate: smoothed nonzero size / smoothed inter-demand interval."""
    values = _clean(history)
    nonzero_indices = [index for index, value in enumerate(values) if value > 0]
    if not nonzero_indices:
        return 0.0
    demand = values[nonzero_indices[0]]
    interval = float(nonzero_indices[0] + 1)
    previous = nonzero_indices[0]
    for index in nonzero_indices[1:]:
        gap = index - previous
        demand += alpha * (values[index] - demand)
        interval += alpha * (gap - interval)
        previous = index
    return demand / interval if interval > 0 else 0.0


def croston_sba_rate(history: Sequence[float], *, alpha: float = 0.1) -> float:
    """Syntetos-Boylan Approximation: Croston with the (1 - alpha/2) bias correction."""
    return (1.0 - alpha / 2.0) * croston_rate(history, alpha=alpha)


def tsb_components(
    history: Sequence[float], *, alpha: float = 0.1, beta: float = 0.05
) -> tuple[float, float]:
    """Return the TSB (smoothed demand probability, smoothed demand size).

    Probability is updated every period, so it decays toward zero for obsolete
    items even without new demand -- the property Croston lacks and the signal
    the obsolescence score consumes.
    """
    values = _clean(history)
    nonzero = [value for value in values if value > 0]
    if not nonzero:
        return 0.0, 0.0
    demand = nonzero[0]
    probability = len(nonzero) / len(values)
    for value in values:
        if value > 0:
            demand += alpha * (value - demand)
            probability += beta * (1.0 - probability)
        else:
            probability += beta * (0.0 - probability)
    return probability, demand


def tsb_rate(history: Sequence[float], *, alpha: float = 0.1, beta: float = 0.05) -> float:
    """Teunter-Syntetos-Babai rate: smoothed size x smoothed demand probability."""
    probability, demand = tsb_components(history, alpha=alpha, beta=beta)
    return probability * demand


def adida_rate(history: Sequence[float], *, aggregation: int | None = None) -> float:
    """ADIDA temporal aggregation: bucket demand, average, then disaggregate.

    Aggregating over ~mean inter-demand interval periods reduces the proportion
    of zeros before averaging, then the aggregate mean is divided back to a
    per-period rate for equal-weight disaggregation.
    """
    values = _clean(history)
    if not values:
        return 0.0
    if aggregation is None:
        nonzero = [index for index, value in enumerate(values) if value > 0]
        aggregation = max(1, round(len(values) / len(nonzero))) if nonzero else 1
    buckets: list[float] = []
    end = len(values)
    while end > 0:
        start = max(0, end - aggregation)
        buckets.append(sum(values[start:end]))
        end -= aggregation
    return fmean(buckets) / aggregation


def croston(history: Sequence[float], horizon: int, *, alpha: float = 0.1) -> list[float]:
    return [croston_rate(history, alpha=alpha)] * horizon


def croston_sba(history: Sequence[float], horizon: int, *, alpha: float = 0.1) -> list[float]:
    return [croston_sba_rate(history, alpha=alpha)] * horizon


def tsb(history: Sequence[float], horizon: int, *, alpha: float = 0.1, beta: float = 0.05) -> list[float]:
    return [tsb_rate(history, alpha=alpha, beta=beta)] * horizon


def adida(history: Sequence[float], horizon: int, *, aggregation: int | None = None) -> list[float]:
    return [adida_rate(history, aggregation=aggregation)] * horizon


def calculate_metrics(actual: Sequence[float], predicted: Sequence[float]) -> ForecastMetrics:
    if len(actual) != len(predicted) or not actual:
        raise ValueError("actual and predicted must be non-empty and have equal length")
    errors = [float(p) - float(a) for a, p in zip(actual, predicted, strict=True)]
    absolute = [abs(error) for error in errors]
    denominator = sum(abs(float(value)) for value in actual)
    wape = sum(absolute) / denominator if denominator else 0.0
    return ForecastMetrics(wape=wape, mae=fmean(absolute), bias=fmean(errors), observations=len(actual))


def _naive_scale(values: Sequence[float]) -> float:
    """In-sample mean absolute one-step naive error, the MASE denominator."""
    differences = [abs(values[index] - values[index - 1]) for index in range(1, len(values))]
    return fmean(differences) if differences else 0.0


def mean_absolute_scaled_error(actual: Sequence[float], predicted: Sequence[float], scale: float) -> float:
    if scale <= 0:
        return 0.0
    errors = [abs(float(p) - float(a)) for a, p in zip(actual, predicted, strict=True)]
    return fmean(errors) / scale if errors else 0.0


def _one_step_estimate(
    model_name: str,
    train: Sequence[float],
    *,
    season_length: int,
    moving_average_window: int,
) -> float:
    if model_name == "seasonal_naive":
        return seasonal_naive(train, 1, season_length)[0]
    if model_name == "moving_average":
        return moving_average(train, 1, moving_average_window)[0]
    if model_name == "croston":
        return croston_rate(train)
    if model_name == "croston_sba":
        return croston_sba_rate(train)
    if model_name == "tsb":
        return tsb_rate(train)
    if model_name == "adida":
        return adida_rate(train)
    raise ValueError(f"unsupported model: {model_name}")


def rolling_backtest(
    history: Sequence[float],
    model_name: str,
    *,
    minimum_train_size: int = 6,
    season_length: int = 12,
    moving_average_window: int = 3,
) -> ModelEvaluation:
    values = _clean(history)
    if len(values) <= minimum_train_size:
        raise ValueError("history is too short for rolling backtest")
    actual: list[float] = []
    predicted: list[float] = []
    for cutoff in range(minimum_train_size, len(values)):
        train = values[:cutoff]
        estimate = _one_step_estimate(
            model_name,
            train,
            season_length=season_length,
            moving_average_window=moving_average_window,
        )
        actual.append(values[cutoff])
        predicted.append(estimate)
    metrics = calculate_metrics(actual, predicted)
    metrics = replace(metrics, mase=mean_absolute_scaled_error(actual, predicted, _naive_scale(values)))
    return ModelEvaluation(model_name=model_name, metrics=metrics, errors=tuple(p - a for a, p in zip(actual, predicted, strict=True)))


def choose_baseline(history: Sequence[float], *, minimum_train_size: int = 6) -> ModelEvaluation:
    evaluations = [
        rolling_backtest(history, "seasonal_naive", minimum_train_size=minimum_train_size),
        rolling_backtest(history, "moving_average", minimum_train_size=minimum_train_size),
    ]
    return min(evaluations, key=lambda evaluation: (evaluation.metrics.wape, evaluation.metrics.mae, abs(evaluation.metrics.bias)))


def _quantile(values: Sequence[float], probability: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = (len(ordered) - 1) * probability
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def forecast_best_baseline(history: Sequence[float], horizon: int) -> tuple[ModelEvaluation, list[ForecastPoint]]:
    evaluation = choose_baseline(history)
    if evaluation.model_name == "seasonal_naive":
        predictions = seasonal_naive(history, horizon)
    else:
        predictions = moving_average(history, horizon)
    error_radius = _quantile([abs(error) for error in evaluation.errors], 0.8)
    points = [
        ForecastPoint(
            horizon=index + 1,
            predicted=prediction,
            lower_80=max(0.0, prediction - error_radius),
            upper_80=prediction + error_radius,
        )
        for index, prediction in enumerate(predictions)
    ]
    return evaluation, points


INTERMITTENT_MODELS = ("seasonal_naive", "moving_average", "croston", "croston_sba", "tsb")


def _rate_forecast(model_name: str, history: Sequence[float], horizon: int) -> list[float]:
    if model_name == "seasonal_naive":
        return seasonal_naive(history, horizon)
    if model_name == "moving_average":
        return moving_average(history, horizon)
    if model_name == "croston":
        return croston(history, horizon)
    if model_name == "croston_sba":
        return croston_sba(history, horizon)
    if model_name == "tsb":
        return tsb(history, horizon)
    if model_name == "adida":
        return adida(history, horizon)
    raise ValueError(f"unsupported model: {model_name}")


def _intermittent_selection_key(evaluation: ModelEvaluation) -> tuple[float, float, float]:
    metrics = evaluation.metrics
    primary = metrics.mase if metrics.mase is not None else metrics.wape
    return (primary, metrics.wape, abs(metrics.bias))


def forecast_intermittent(
    history: Sequence[float],
    horizon: int,
    *,
    minimum_train_size: int = 6,
) -> tuple[list[ModelEvaluation], ModelEvaluation, list[ForecastPoint]]:
    """Select and forecast among intermittent-aware models, ranked by MASE.

    Baselines stay in the candidate pool so a smooth-but-misclassified series is
    never forced onto Croston; the winner is whichever minimises MASE.
    """
    evaluations: list[ModelEvaluation] = []
    for model_name in INTERMITTENT_MODELS:
        try:
            evaluations.append(rolling_backtest(history, model_name, minimum_train_size=minimum_train_size))
        except ValueError:
            continue
    if not evaluations:
        raise ValueError("history is too short for an intermittent backtest")
    selected = min(evaluations, key=_intermittent_selection_key)
    predictions = _rate_forecast(selected.model_name, history, horizon)
    error_radius = _quantile([abs(error) for error in selected.errors], 0.8)
    points = [
        ForecastPoint(
            horizon=index + 1,
            predicted=max(0.0, prediction),
            lower_80=max(0.0, prediction - error_radius),
            upper_80=max(0.0, prediction) + error_radius,
        )
        for index, prediction in enumerate(predictions)
    ]
    return evaluations, selected, points


def forecast_best_available(
    history: Sequence[float],
    horizon: int,
    *,
    allow_intermittent: bool = False,
) -> tuple[list[ModelEvaluation], ModelEvaluation, list[ForecastPoint]]:
    """Backtest candidate models and return (evaluations, selected, forecast).

    ``allow_intermittent`` is activation-gated. When enabled and the series is
    classified ``intermittent`` or ``lumpy``, Croston/SBA/TSB join the candidate
    pool and selection is by MASE. Left at the default ``False`` the behaviour is
    identical to the registered baseline+AutoETS selector, so the deployed worker
    contract is unchanged until the model versions are registered in the database.
    """
    if allow_intermittent:
        profile = classify_demand(history)
        if profile.category in ("intermittent", "lumpy"):
            try:
                return forecast_intermittent(history, horizon)
            except ValueError:
                pass
    baseline_evaluations = [
        rolling_backtest(history, "seasonal_naive"),
        rolling_backtest(history, "moving_average"),
    ]
    baseline_selected, baseline_points = forecast_best_baseline(history, horizon)
    evaluations = list(baseline_evaluations)
    forecasts = {baseline_selected.model_name: baseline_points}
    try:
        autoets_evaluation, autoets_points = statsforecast_autoets(history, horizon)
        evaluations.append(autoets_evaluation)
        forecasts["autoets"] = autoets_points
    except (ImportError, ValueError, RuntimeError):
        pass
    selected = min(evaluations, key=lambda evaluation: (evaluation.metrics.wape, evaluation.metrics.mae, abs(evaluation.metrics.bias)))
    return evaluations, selected, forecasts.get(selected.model_name, baseline_points)
