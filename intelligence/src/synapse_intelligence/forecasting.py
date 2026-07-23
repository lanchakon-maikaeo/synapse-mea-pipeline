from __future__ import annotations

from dataclasses import dataclass
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


def calculate_metrics(actual: Sequence[float], predicted: Sequence[float]) -> ForecastMetrics:
    if len(actual) != len(predicted) or not actual:
        raise ValueError("actual and predicted must be non-empty and have equal length")
    errors = [float(p) - float(a) for a, p in zip(actual, predicted, strict=True)]
    absolute = [abs(error) for error in errors]
    denominator = sum(abs(float(value)) for value in actual)
    wape = sum(absolute) / denominator if denominator else 0.0
    return ForecastMetrics(wape=wape, mae=fmean(absolute), bias=fmean(errors), observations=len(actual))


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
        if model_name == "seasonal_naive":
            estimate = seasonal_naive(train, 1, season_length)[0]
        elif model_name == "moving_average":
            estimate = moving_average(train, 1, moving_average_window)[0]
        else:
            raise ValueError(f"unsupported model: {model_name}")
        actual.append(values[cutoff])
        predicted.append(estimate)
    metrics = calculate_metrics(actual, predicted)
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


def forecast_best_available(history: Sequence[float], horizon: int) -> tuple[list[ModelEvaluation], ModelEvaluation, list[ForecastPoint]]:
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
