import tempfile
import unittest
from datetime import datetime
from pathlib import Path
import sys
from unittest.mock import patch

from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))

from synapse_pipeline.actual_workbooks import (  # noqa: E402
    CONTRACT_WORKBOOK,
    STOCK_WORKBOOK,
    USAGE_WORKBOOK,
    WAREHOUSE_WORKBOOK,
    _rpc,
    import_actual_data_directory,
    parse_actual_data_directory,
    parse_actual_stock_workbook,
    parse_actual_usage_workbook,
)
from synapse_pipeline.relational_sources import RelationalSource  # noqa: E402


class ActualWorkbookParserTests(unittest.TestCase):
    @staticmethod
    def _production_sources():
        return [
            RelationalSource(
                source_path=source_path,
                source_sheet="source",
                checksum=f"{index:064x}",
                size_bytes=1,
                data_class="actual",
                rows=[],
                metadata={
                    "source_package_environment": "PRODUCTION_APPROVED",
                    "source_package_production_use_prohibited": False,
                    "source_package_owner_attested_complete": True,
                    "source_package_zero_completion_policy":
                        "exhaustive_source_omission_means_zero",
                },
            )
            for index, source_path in enumerate(
                (
                    STOCK_WORKBOOK,
                    USAGE_WORKBOOK,
                    WAREHOUSE_WORKBOOK,
                    CONTRACT_WORKBOOK,
                ),
                start=1,
            )
        ]

    def test_production_package_requires_explicit_attestation(self):
        sources = self._production_sources()
        with self.assertRaisesRegex(ValueError, "Production attestation"):
            import_actual_data_directory(
                sources,
                supabase_url="https://example.supabase.co",
                service_role_key="not-used",
                attested_by="test",
                attestation_text="test",
                change_ticket="test",
            )

    def test_failed_database_promotion_is_reported_to_the_caller(self):
        def fake_rpc(**kwargs):
            if kwargs["function_name"] == "m21_promote_actual_workbooks":
                return {
                    "actual_workbook_import_id": "test-import",
                    "status": "failed",
                    "error_message": "synthetic failure",
                }
            if kwargs["function_name"] == "m22_attest_production_completion":
                return {"status": "succeeded"}
            return {}

        with (
            patch(
                "synapse_pipeline.actual_workbooks._rpc",
                side_effect=fake_rpc,
            ),
            self.assertRaisesRegex(RuntimeError, "synthetic failure"),
        ):
            import_actual_data_directory(
                self._production_sources(),
                supabase_url="https://example.supabase.co",
                service_role_key="not-used",
                attested_by="test",
                attestation_text="test",
                change_ticket="test",
                confirm_production_attestation=True,
            )

    def test_secret_key_is_sent_only_as_apikey(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b"{}"

        with patch(
            "synapse_pipeline.actual_workbooks.urlopen",
            return_value=FakeResponse(),
        ) as mocked_urlopen:
            _rpc(
                supabase_url="https://example.supabase.co",
                service_role_key="sb_secret_example",
                function_name="test_rpc",
                body={},
            )

        request = mocked_urlopen.call_args.args[0]
        self.assertEqual(
            request.get_header("Apikey"),
            "sb_secret_example",
        )
        self.assertIsNone(request.get_header("Authorization"))

    def test_legacy_service_role_keeps_bearer_header(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b"{}"

        with patch(
            "synapse_pipeline.actual_workbooks.urlopen",
            return_value=FakeResponse(),
        ) as mocked_urlopen:
            _rpc(
                supabase_url="https://example.supabase.co",
                service_role_key="legacy-service-role-jwt",
                function_name="test_rpc",
                body={},
            )

        request = mocked_urlopen.call_args.args[0]
        self.assertEqual(
            request.get_header("Authorization"),
            "Bearer legacy-service-role-jwt",
        )

    def test_stock_parser_preserves_lineage_and_normalizes_identifiers(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "Stock.xlsx"
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "update-stock"
            sheet.append([
                "โรงงาน",
                "ที่เก็บสินค้า",
                "วัสดุ",
                "คำอธิบายวัสดุ",
                "ไม่จำกัด",
                "หน่วยนับพื้นฐาน",
                "ไม่จำกัดค่า",
                "การส่ง/การโอน",
                "วัสดุ + โรงงาน",
                "วัสดุ + โรงงาน + ที่เก็บ",
                datetime(2026, 7, 21),
            ])
            sheet.append([
                5501,
                1,
                21920522320,
                "TEST MATERIAL",
                12,
                "EA",
                120,
                3,
                None,
                None,
                None,
            ])
            workbook.save(path)

            source = parse_actual_stock_workbook(path)

        self.assertEqual(source.source_sheet, "update-stock")
        self.assertEqual(len(source.rows), 1)
        self.assertEqual(source.rows[0]["material_id"], "021920522320")
        self.assertEqual(source.rows[0]["district_id"], "5501")
        self.assertEqual(
            source.rows[0]["payload"]["storage_location_code"],
            "0001",
        )
        self.assertEqual(
            source.metadata["nonzero_stock_in_transfer_rows"],
            1,
        )

    def test_usage_parser_normalizes_dash_and_signed_adjustments(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "อัตราการใช้งาน.xlsx"
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "Check CMP"
            sheet.append([
                "พัสดุ", "โรงงาน", "พัสดุ&โรงงาน",
                "CMP", "LY", 12, 6, 4, None, None, "2025",
                "042026", "032026", "022026", "012026",
                "122025", "112025", "102025", "092025",
                "082025", "072025", "062025", "052025",
            ])
            sheet.append([
                471050004000, 5501, "4710500040005501",
                -2, -2, 4, 5, 6, None, None, 10,
                "-", -3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
            ])
            workbook.save(path)

            source = parse_actual_usage_workbook(path)

        self.assertEqual(len(source.rows), 1)
        payload = source.rows[0]["payload"]
        self.assertEqual(payload["source_cmp"], -2)
        self.assertEqual(payload["calculated_cmp_raw"], 3)
        self.assertEqual(payload["cmp_monthly"], 4)
        self.assertEqual(payload["avg_ly_raw"], -2)
        self.assertEqual(payload["avg_ly"], 0)
        self.assertEqual(payload["history"][0]["demand_quantity"], 0)
        self.assertTrue(payload["history"][0]["source_was_dash"])
        self.assertTrue(payload["history"][1]["negative_adjustment"])
        self.assertEqual(source.metadata["negative_cmp_rows_normalized_to_zero"], 1)
        self.assertEqual(
            source.metadata["negative_summary_fields_preserved_in_raw"],
            {"avg_ly_raw": 1},
        )


class ActualWorkbookIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data_dir = ROOT / "data"
        required = (
            data_dir / "Stock.xlsx",
            data_dir / "อัตราการใช้งาน.xlsx",
            data_dir / "คลังคลองเตย.xlsx",
            data_dir / "รวมสัญญา.xlsx",
        )
        missing = [
            str(path.relative_to(ROOT))
            for path in required
            if not path.is_file()
        ]
        if missing:
            raise unittest.SkipTest(
                "requires non-versioned Actual workbooks: "
                + ", ".join(missing)
            )
        cls.sources = parse_actual_data_directory(data_dir)
        cls.by_sheet = {
            (source.source_path, source.source_sheet): source
            for source in cls.sources
        }

    def test_governed_source_counts_and_checksums(self):
        contracts = self.by_sheet[("รวมสัญญา.xlsx", "รวมสัญญา")]
        stock = self.by_sheet[("Stock.xlsx", "update-stock")]
        usage = self.by_sheet[("อัตราการใช้งาน.xlsx", "Check CMP")]
        master = self.by_sheet[("คลังคลองเตย.xlsx", "MASTER")]
        districts = self.by_sheet[("คลังคลองเตย.xlsx", "M_Districts")]
        vmi = self.by_sheet[("คลังคลองเตย.xlsx", "VMI คลองเตย")]

        self.assertEqual(len(contracts.rows), 6305)
        self.assertEqual(len(stock.rows), 14661)
        self.assertEqual(len(usage.rows), 6164)
        self.assertEqual(len(master.rows), 2049)
        self.assertEqual(len(districts.rows), 18)
        self.assertEqual(len(vmi.rows), 223)
        self.assertEqual(
            stock.checksum,
            "3475f8b31f71e79932b9dc1f13e3ebdf68bed28abae3245e0eca93420cfda38c",
        )
        self.assertEqual(
            usage.checksum,
            "7c81fcfd2b17ebb113c9e96d793e00636bedbdf701309bdacfad28c8c88a3ba0",
        )
        self.assertEqual(
            vmi.checksum,
            "d6e2bb1d9fcd659a45a80a334102fcb4fe9920e1a16c97ea96b442e9c792084a",
        )
        self.assertEqual(vmi.metadata["source_date"], "2026-07-20T00:00:00")
        self.assertEqual(
            vmi.metadata["source_package_environment"],
            "PRODUCTION_APPROVED",
        )
        self.assertFalse(
            vmi.metadata["source_package_production_use_prohibited"]
        )
        self.assertTrue(
            vmi.metadata["source_package_owner_attested_complete"]
        )
        self.assertEqual(
            vmi.metadata["source_package_zero_completion_policy"],
            "exhaustive_source_omission_means_zero",
        )

    def test_vmi_matrix_has_complete_derived_grid_but_not_complete_observations(self):
        stock = self.by_sheet[("Stock.xlsx", "update-stock")]
        usage = self.by_sheet[("อัตราการใช้งาน.xlsx", "Check CMP")]
        vmi = self.by_sheet[("คลังคลองเตย.xlsx", "VMI คลองเตย")]
        vmi_materials = {row["material_id"] for row in vmi.rows}

        observed_stock_pairs = {
            (row["material_id"], row["district_id"])
            for row in stock.rows
            if row["material_id"] in vmi_materials
            and row["district_id"] is not None
        }
        observed_usage_pairs = {
            (row["material_id"], row["district_id"])
            for row in usage.rows
            if row["material_id"] in vmi_materials
            and row["district_id"] is not None
        }
        self.assertEqual(len(observed_stock_pairs), 1379)
        self.assertEqual(len(observed_usage_pairs), 1202)
        self.assertEqual(
            sum(
                len(row["payload"]["district_values"])
                for row in vmi.rows
            ),
            4014,
        )
        self.assertLess(len(observed_stock_pairs), 4014)
        self.assertLess(len(observed_usage_pairs), 4014)


if __name__ == "__main__":
    unittest.main()
