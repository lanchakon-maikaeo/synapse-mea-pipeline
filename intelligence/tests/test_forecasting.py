from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.forecasting import calculate_metrics, forecast_best_available, forecast_best_baseline, moving_average, seasonal_naive


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

    def test_statsforecast_autoets_is_compared_when_history_is_long_enough(self):
        history = [10, 12, 13, 15, 16, 18, 20, 18, 16, 14, 12, 11] * 2
        evaluations, selected, forecast = forecast_best_available(history, 3)
        self.assertIn("autoets", {evaluation.model_name for evaluation in evaluations})
        self.assertIn(selected.model_name, {evaluation.model_name for evaluation in evaluations})
        self.assertEqual(len(forecast), 3)


if __name__ == "__main__":
    unittest.main()
