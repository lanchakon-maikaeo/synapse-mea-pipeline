import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))

from synapse_pipeline.relational_sources import (  # noqa: E402
    build_package_manifest,
    parse_actual_contract_source,
    parse_dummy_relational_sources,
)


class RelationalSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data_dir = ROOT / "data"
        required = (
            ROOT / "MEA_VMI_Dummy_Klongtoey.xlsx",
            data_dir / "รวมสัญญา.xlsx",
            data_dir / "MEA_Synapse_Supabase_Complete_Staging_20260724",
        )
        missing = [str(path.relative_to(ROOT)) for path in required if not path.exists()]
        if missing:
            raise unittest.SkipTest(
                "requires non-versioned governed source artifacts: "
                + ", ".join(missing)
            )
        cls.dummy_sources = {
            source.source_sheet: source
            for source in parse_dummy_relational_sources(
                ROOT / "MEA_VMI_Dummy_Klongtoey.xlsx"
            )
        }
        cls.contracts = parse_actual_contract_source(
            data_dir / "รวมสัญญา.xlsx"
        )
        cls.package = build_package_manifest(
            data_dir / "MEA_Synapse_Supabase_Complete_Staging_20260724"
        )

    def test_all_dummy_sheets_are_preserved_as_reference_fixture(self):
        self.assertEqual(len(self.dummy_sources), 12)
        self.assertEqual(len(self.dummy_sources["DB_Warehouse"].rows), 3)
        self.assertEqual(len(self.dummy_sources["DB_Material"].rows), 225)
        self.assertEqual(len(self.dummy_sources["DB_Stock"].rows), 4275)
        self.assertEqual(len(self.dummy_sources["DB_SAP_Monthly"].rows), 4050)
        self.assertEqual(
            sum(len(source.rows) for source in self.dummy_sources.values()),
            9160,
        )
        self.assertTrue(all(
            source.data_class == "reference_fixture"
            and not source.metadata["operational_promotion"]
            for source in self.dummy_sources.values()
        ))

    def test_reference_rows_have_relation_keys(self):
        stock = self.dummy_sources["DB_Stock"].rows[0]
        plan = self.dummy_sources["Trans_Replenishment_Plan"].rows[0]
        log = self.dummy_sources["Trans_Transport_Logs"].rows[0]
        self.assertIsNotNone(stock["material_id"])
        self.assertIsNotNone(plan["contract_ref"])
        self.assertIsNotNone(plan["plan_ref"])
        self.assertIsNotNone(log["vehicle_ref"])
        self.assertIsNotNone(log["trip_ref"])

    def test_actual_contract_workbook_is_canonicalized(self):
        self.assertEqual(len(self.contracts.rows), 6305)
        self.assertEqual(self.contracts.data_class, "actual")
        self.assertEqual(
            self.contracts.checksum,
            "8ea7b0e712726e6cc1990f33b0031be231a91cc01fb4f8d96e6146d83e3cf9dd",
        )
        first = self.contracts.rows[0]
        self.assertEqual(first["payload"]["material_code"], "612062400410")
        self.assertEqual(
            first["payload"]["source_material_code"],
            612062400410,
        )
        self.assertEqual(first["payload"]["purchase_order"], 130322071)
        self.assertEqual(
            self.contracts.metadata["material_codes_padded_to_12_digits"],
            38,
        )
        padded = next(
            row
            for row in self.contracts.rows
            if len(str(row["payload"]["source_material_code"])) == 11
        )
        self.assertEqual(len(padded["material_id"]), 12)
        self.assertTrue(padded["material_id"].startswith("0"))

    def test_staging_package_is_manifested_not_executed(self):
        self.assertEqual(len(self.package), 36)
        self.assertTrue(all(
            source.data_class == "design_reference"
            and not source.metadata["executed_as_migration"]
            and len(source.checksum) == 64
            for source in self.package
        ))


if __name__ == "__main__":
    unittest.main()
