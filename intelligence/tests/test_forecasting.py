from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.forecasting import (
    MODEL_VERSIONS,
    calculate_metrics,
    classify_demand,
    croston_rate,
    forecast_best_available,
    forecast_best_baseline,
    forecast_intermittent,
    moving_average,
    seasonal_naive,
    tsb_rate,
)

try:  # AutoETS is an optional engine; the baseline path never requires it.
    import statsforecast  # noqa: F401

    STATSFORECAST_AVAILABLE = True
except ImportError:
    STATSFORECAST_AVAILABLE = False


class ForecastTests(unittest.TestCase):
    def test_seasonal_naive_repeats_last_season(self):
        history = list(range(1, 25))
        self.assertEqual(seasonal_naive(history, 3), [13.0, 14.0, 15.0])

    def test_moving_average_is_recursive(self):
        predicted = moving_average([10, 20, 30], 2, window=3)
        self.assertEqual(predicted[0], 20)
        self.assertAlmostEqual(predicted[1], 70 / 3)

    def test_metrics(self):
        metrics = calculate_metrics([10, 20], [12, 18])
        self.assertAlmostEqual(metrics.wape, 4 / 30)
        self.assertEqual(metrics.mae, 2)
        self.assertEqual(metrics.bias, 0)

    def test_best_baseline_returns_intervals(self):
        history = [10, 11, 12, 10, 11, 12, 10, 11, 12, 10, 11, 12, 10, 11, 12]
        evaluation, forecast = forecast_best_baseline(history, 3)
        self.assertIn(evaluation.model_name, {"seasonal_naive", "moving_average"})
        self.assertEqual(len(forecast), 3)
        self.assertTrue(all(point.lower_80 <= point.predicted <= point.upper_80 for point in forecast))

    @unittest.skipUnless(STATSFORECAST_AVAILABLE, "statsforecast engine not installed")
    def test_statsforecast_autoets_is_compared_when_history_is_long_enough(self):
        history = [10, 12, 13, 15, 16, 18, 20, 18, 16, 14, 12, 11] * 2
        evaluations, selected, forecast = forecast_best_available(history, 3)
        self.assertIn("autoets", {evaluation.model_name for evaluation in evaluations})
        self.assertIn(selected.model_name, {evaluation.model_name for evaluation in evaluations})
        self.assertEqual(len(forecast), 3)


class DemandClassificationTests(unittest.TestCase):
    def test_smooth_series(self):
        profile = classify_demand([10, 11, 9, 10, 12, 10, 11, 9, 10, 11])
        self.assertEqual(profile.category, "smooth")

    def test_intermittent_series(self):
        # Many zero months, steady size when present -> high ADI, low CV^2.
        profile = classify_demand([0, 0, 5, 0, 0, 0, 5, 0, 0, 5, 0, 0])
        self.assertGreaterEqual(profile.adi, 1.32)
        self.assertEqual(profile.category, "intermittent")

    def test_lumpy_series(self):
        # Sparse and highly variable sizes -> high ADI and high CV^2.
        profile = classify_demand([0, 0, 1, 0, 0, 0, 40, 0, 0, 3, 0, 0])
        self.assertEqual(profile.category, "lumpy")

    def test_all_zero_history_is_intermittent(self):
        self.assertEqual(classify_demand([0, 0, 0, 0]).category, "intermittent")


class IntermittentForecastTests(unittest.TestCase):
    def test_croston_rate_matches_size_over_interval(self):
        # Demand of 4 every third period -> long-run rate ~ 4/3.
        rate = croston_rate([0, 0, 4, 0, 0, 4, 0, 0, 4, 0, 0, 4])
        self.assertAlmostEqual(rate, 4 / 3, delta=0.2)

    def test_tsb_decays_toward_zero_after_obsolescence(self):
        # Demand stops after period 3; TSB probability decays so the rate drops.
        active = tsb_rate([5, 5, 5, 5, 5, 5])
        obsolete = tsb_rate([5, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        self.assertLess(obsolete, active)

    def test_intermittent_selection_returns_bounded_intervals(self):
        history = [0, 0, 4, 0, 0, 3, 0, 0, 5, 0, 0, 4, 0, 0, 4, 0]
        evaluations, selected, forecast = forecast_intermittent(history, 3)
        self.assertTrue(any(evaluation.model_name.startswith("croston") or evaluation.model_name == "tsb" for evaluation in evaluations))
        self.assertTrue(all(evaluation.metrics.mase is not None for evaluation in evaluations))
        self.assertEqual(len(forecast), 3)
        self.assertTrue(all(point.lower_80 <= point.predicted <= point.upper_80 for point in forecast))

    def test_gate_default_off_keeps_baseline_only(self):
        history = [0, 0, 4, 0, 0, 3, 0, 0, 5, 0, 0, 4, 0, 0, 4, 0]
        evaluations, _, _ = forecast_best_available(history, 3)
        model_names = {evaluation.model_name for evaluation in evaluations}
        self.assertFalse(model_names & {"croston", "croston_sba", "tsb"})

    def test_gate_on_selects_intermittent_for_sparse_series(self):
        history = [0, 0, 4, 0, 0, 3, 0, 0, 5, 0, 0, 4, 0, 0, 4, 0]
        evaluations, _, forecast = forecast_best_available(history, 3, allow_intermittent=True)
        model_names = {evaluation.model_name for evaluation in evaluations}
        self.assertTrue(model_names & {"croston", "croston_sba", "tsb"})
        self.assertEqual(len(forecast), 3)

    def test_every_selectable_model_has_a_registered_version(self):
        history = [0, 0, 4, 0, 0, 3, 0, 0, 5, 0, 0, 4, 0, 0, 4, 0]
        evaluations, _, _ = forecast_best_available(history, 3, allow_intermittent=True)
        for evaluation in evaluations:
            self.assertIn(evaluation.model_name, MODEL_VERSIONS)


if __name__ == "__main__":
    unittest.main()
