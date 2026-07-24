import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))
from synapse_pipeline.test_fixture import (
    RAW_ONLY_SHEETS,
    chunked,
    parse_test_fixture_workbook,
)


WORKBOOK = ROOT / "MEA_VMI_Dummy_Klongtoey.xlsx"


class TestFixtureWorkbookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not WORKBOOK.exists():
            raise unittest.SkipTest(
                "requires the non-versioned governed VMI source workbook"
            )
        cls.sources = {
            source.source_key: source
            for source in parse_test_fixture_workbook(WORKBOOK)
        }

    def test_promoted_source_counts_are_frozen(self):
        self.assertEqual(len(self.sources["materials"].rows), 225)
        self.assertEqual(len(self.sources["packaging"].rows), 225)
        self.assertEqual(len(self.sources["district_stock"].rows), 4050)
        self.assertEqual(len(self.sources["usage"].rows), 4050)

    def test_all_payloads_are_explicitly_test_fixture(self):
        for source in self.sources.values():
            self.assertEqual(source.metadata["data_class"], "TEST_FIXTURE")
            self.assertTrue(source.metadata["not_actual_sap"])
            self.assertEqual(
                source.metadata["raw_only_sheets_not_promoted"],
                list(RAW_ONLY_SHEETS),
            )

    def test_district_stock_has_complete_material_district_grid(self):
        rows = self.sources["district_stock"].rows
        pairs = {(row["material_id"], row["district_id"]) for row in rows}
        self.assertEqual(len(pairs), 225 * 18)
        self.assertTrue(all(row["snapshot_at"].startswith("2026-07-08") for row in rows))

    def test_usage_has_complete_grid_and_twelve_month_raw_history(self):
        rows = self.sources["usage"].rows
        pairs = {(row["material_id"], row["district_id"]) for row in rows}
        self.assertEqual(len(pairs), 225 * 18)
        self.assertTrue(all(row["as_of_date"] == "2026-07-08" for row in rows))
        self.assertTrue(all(len(row["history"]) == 12 for row in rows))
        self.assertEqual(
            sum("negative_adjustments" in row for row in rows),
            4,
        )
        self.assertTrue(
            all(
                row[field] is None or row[field] >= 0
                for row in rows
                for field in ("cmp_monthly", "avg_ly", "avg_12m", "avg_6m", "avg_4m")
            )
        )

    def test_packaging_derives_full_pallet_quantity(self):
        first = self.sources["packaging"].rows[0]
        self.assertGreater(first["inner_pack_qty"], 0)
        self.assertGreaterEqual(first["full_pallet_qty"], first["inner_pack_qty"])


class ChunkGuardTests(unittest.TestCase):
    def test_chunk_guard(self):
        self.assertEqual([len(part) for part in chunked(list(range(501)), 500)], [500, 1])
        with self.assertRaises(ValueError):
            list(chunked([1], 501))


if __name__ == "__main__":
    unittest.main()
