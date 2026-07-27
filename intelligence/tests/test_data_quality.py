from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.data_quality import (
    expect_between,
    expect_foreign_key,
    expect_in_set,
    expect_matches_regex,
    expect_non_negative,
    expect_not_null,
    expect_row_count_between,
    expect_unique,
    run_suite,
)

ROWS = [
    {"material_id": "M-1", "district_id": "D-01", "qty": 10, "status": "locked"},
    {"material_id": "M-2", "district_id": "D-02", "qty": 0, "status": "locked"},
    {"material_id": "M-3", "district_id": "D-03", "qty": 5, "status": "draft"},
]


class ExpectationTests(unittest.TestCase):
    def test_not_null_passes_and_fails(self):
        self.assertTrue(expect_not_null("qty").check(ROWS).success)
        rows = ROWS + [{"material_id": "M-4", "district_id": None, "qty": 1, "status": "draft"}]
        self.assertFalse(expect_not_null("district_id").check(rows).success)

    def test_unique_detects_duplicates(self):
        self.assertTrue(expect_unique("material_id").check(ROWS).success)
        rows = ROWS + [{"material_id": "M-1", "district_id": "D-09", "qty": 2, "status": "draft"}]
        result = expect_unique("material_id").check(rows)
        self.assertFalse(result.success)
        self.assertEqual(result.observed, 1)

    def test_in_set_and_non_negative(self):
        self.assertTrue(expect_in_set("status", ["locked", "draft"]).check(ROWS).success)
        self.assertFalse(expect_in_set("status", ["locked"]).check(ROWS).success)
        self.assertTrue(expect_non_negative("qty").check(ROWS).success)
        self.assertFalse(expect_non_negative("qty").check(ROWS + [{"qty": -1}]).success)

    def test_between_counts_non_numeric_as_violation(self):
        rows = [{"qty": 5}, {"qty": "oops"}, {"qty": 50}]
        result = expect_between("qty", minimum=0, maximum=10).check(rows)
        self.assertFalse(result.success)
        self.assertEqual(result.observed, 2)  # "oops" and 50

    def test_regex(self):
        self.assertTrue(expect_matches_regex("district_id", r"D-\d{2}").check(ROWS).success)
        self.assertFalse(expect_matches_regex("district_id", r"X-\d{2}").check(ROWS).success)

    def test_foreign_key(self):
        reference = ["D-01", "D-02", "D-03"]
        self.assertTrue(expect_foreign_key("district_id", reference).check(ROWS).success)
        rows = ROWS + [{"district_id": "D-99"}]
        self.assertFalse(expect_foreign_key("district_id", reference).check(rows).success)

    def test_row_count(self):
        self.assertTrue(expect_row_count_between(minimum=1).check(ROWS).success)
        self.assertFalse(expect_row_count_between(maximum=2).check(ROWS).success)


class SuiteTests(unittest.TestCase):
    def test_run_suite_aggregates_and_serialises(self):
        suite = [
            expect_not_null("material_id"),
            expect_unique("material_id"),
            expect_non_negative("qty"),
            expect_in_set("status", ["locked"]),  # fails: one draft
        ]
        report = run_suite(ROWS, suite)
        self.assertEqual(report.total, 4)
        self.assertEqual(report.failed, 1)
        self.assertFalse(report.success)
        payload = report.to_dict()
        self.assertEqual(payload["total"], 4)
        self.assertEqual(len(payload["results"]), 4)

    def test_clean_dataset_passes(self):
        suite = [expect_not_null("material_id"), expect_unique("material_id"), expect_non_negative("qty")]
        self.assertTrue(run_suite(ROWS, suite).success)


if __name__ == "__main__":
    unittest.main()
