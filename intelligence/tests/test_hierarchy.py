from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.hierarchy import (
    build_hierarchy,
    reconcile_bottom_up,
    reconcile_min_trace,
    summing_matrix,
)


class HierarchyStructureTests(unittest.TestCase):
    def test_build_orders_nodes_aggregates_first(self):
        hierarchy = build_hierarchy({"TOTAL": ["d3", "d1", "d2"]})
        self.assertEqual(hierarchy.leaves, ("d1", "d2", "d3"))
        self.assertEqual(hierarchy.nodes, ("TOTAL", "d1", "d2", "d3"))

    def test_summing_matrix_shape_and_top_row(self):
        hierarchy = build_hierarchy({"TOTAL": ["d1", "d2"]})
        matrix = summing_matrix(hierarchy)
        self.assertEqual(matrix[0], [1.0, 1.0])          # TOTAL sums both leaves
        self.assertEqual(matrix[1], [1.0, 0.0])          # d1 identity row
        self.assertEqual(matrix[2], [0.0, 1.0])          # d2 identity row

    def test_empty_group_rejected(self):
        with self.assertRaises(ValueError):
            build_hierarchy({"TOTAL": []})

    def test_grouped_leaf_union_is_supported(self):
        # A leaf under REGION but not TOTAL is still a valid leaf (union).
        hierarchy = build_hierarchy({"TOTAL": ["d1"], "REGION": ["d1", "d2"]})
        self.assertEqual(hierarchy.leaves, ("d1", "d2"))

    def test_aggregate_leaf_name_collision_rejected(self):
        with self.assertRaises(ValueError):
            build_hierarchy({"d1": ["d1", "d2"]})


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.hierarchy = build_hierarchy({"TOTAL": ["d1", "d2", "d3"]})

    def test_bottom_up_sums_leaves(self):
        result = reconcile_bottom_up(self.hierarchy, {"d1": 10, "d2": 20, "d3": 30})
        self.assertEqual(result["TOTAL"], 60)

    def test_min_trace_is_coherent(self):
        base = {"TOTAL": 100.0, "d1": 20.0, "d2": 30.0, "d3": 40.0}  # leaves sum to 90, not 100
        for method in ("ols", "wls_struct"):
            reconciled = reconcile_min_trace(self.hierarchy, base, method=method)
            leaf_sum = reconciled["d1"] + reconciled["d2"] + reconciled["d3"]
            self.assertAlmostEqual(reconciled["TOTAL"], leaf_sum, places=9)

    def test_ols_spreads_the_gap_evenly(self):
        # Base leaves 20/30/40 (sum 90) with a total of 100: OLS spreads the +10
        # discrepancy across the three leaves and the top, giving +2.5 per leaf.
        base = {"TOTAL": 100.0, "d1": 20.0, "d2": 30.0, "d3": 40.0}
        reconciled = reconcile_min_trace(self.hierarchy, base, method="ols")
        self.assertAlmostEqual(reconciled["d1"], 22.5, places=6)
        self.assertAlmostEqual(reconciled["d2"], 32.5, places=6)
        self.assertAlmostEqual(reconciled["d3"], 42.5, places=6)
        self.assertAlmostEqual(reconciled["TOTAL"], 97.5, places=6)

    def test_min_trace_reduces_total_error_versus_base(self):
        # The aggregate forecast is accurate but the leaf forecasts are
        # systematically low; borrowing strength from the coherent total pulls
        # the leaves back up, so MinT lands closer to the truth than the base.
        truth = {"TOTAL": 90.0, "d1": 30.0, "d2": 30.0, "d3": 30.0}
        base = {"TOTAL": 90.0, "d1": 27.0, "d2": 27.0, "d3": 27.0}  # leaves sum to 81
        reconciled = reconcile_min_trace(self.hierarchy, base, method="ols")
        base_error = sum(abs(base[node] - truth[node]) for node in self.hierarchy.nodes)
        recon_error = sum(abs(reconciled[node] - truth[node]) for node in self.hierarchy.nodes)
        self.assertLess(recon_error, base_error)

    def test_non_negative_clamps_and_stays_coherent(self):
        base = {"TOTAL": 5.0, "d1": -10.0, "d2": 8.0, "d3": 9.0}
        reconciled = reconcile_min_trace(self.hierarchy, base, method="ols", non_negative=True)
        self.assertTrue(all(reconciled[leaf] >= 0.0 for leaf in self.hierarchy.leaves))
        leaf_sum = sum(reconciled[leaf] for leaf in self.hierarchy.leaves)
        self.assertAlmostEqual(reconciled["TOTAL"], leaf_sum, places=9)


if __name__ == "__main__":
    unittest.main()
