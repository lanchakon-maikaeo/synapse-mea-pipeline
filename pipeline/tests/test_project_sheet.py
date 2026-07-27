from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))

from synapse_pipeline.project_sheet import import_project_sheet  # noqa: E402
from synapse_pipeline.relational_sources import (  # noqa: E402
    parse_project_sheet_sources,
)


class ProjectSheetTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workbook_path = Path(self.temp_dir.name) / "source.xlsx"
        workbook = Workbook()
        workbook.remove(workbook.active)

        material = workbook.create_sheet("DB_Material")
        material.append(["Material_ID", "Material_Name", "Unit"])
        material.append([21910823600, "Transformer", "อัน"])

        packaging = workbook.create_sheet("DB_Contract_Static")
        packaging.append([
            "Contract_ID", "Material_ID", "Supplier_Name",
            "Pkg_Qty_per_Box", "Pkg_Box_Width_m", "Pkg_Box_Length_m",
            "Pkg_Box_Height_m", "Pkg_Weight_per_Box_kg",
            "Pkg_Boxes_per_Pallet", "Pkg_Pallet_Width_m",
            "Pkg_Pallet_Length_m", "Pkg_Pallet_Height_m",
            "Pkg_Pallet_Weight_kg",
        ])
        packaging.append([
            "CONTRACT-1", 21910823600, "Supplier", 1, 0.3, 0.3, 0.3,
            5, 20, 1, 1.2, 1.2, 100,
        ])

        contract = workbook.create_sheet("DB_Contract_SAP")
        contract.append(["Contract_ID", "Material_ID", "SAP_Updated_Date"])
        contract.append(["CONTRACT-1", 21910823600, "2026-07-03T00:00:00"])

        usage = workbook.create_sheet("DB_SAP_Monthly")
        usage.append([
            "SAP_ID", "Material_ID", "District_ID", "Avg_Monthly",
            "Last_Import_Date",
        ])
        usage.append([
            "VMI-021910823600-5501", 21910823600, 5501, 48,
            "2026-07-03T00:00:00",
        ])
        workbook.save(self.workbook_path)

        self.sources = parse_project_sheet_sources(
            self.workbook_path,
            source_spreadsheet_id="sheet-id_1",
            source_downloaded_at="2026-07-27T08:57:35+07:00",
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_parser_preserves_four_actual_sources_and_row_identity(self):
        self.assertEqual(
            [source.source_sheet for source in self.sources],
            [
                "DB_Material",
                "DB_Contract_Static",
                "DB_Contract_SAP",
                "DB_SAP_Monthly",
            ],
        )
        self.assertTrue(all(source.data_class == "actual" for source in self.sources))
        self.assertEqual(len({source.checksum for source in self.sources}), 1)
        self.assertEqual(self.sources[0].rows[0]["row_number"], 2)
        self.assertEqual(self.sources[0].rows[0]["material_id"], "021910823600")
        self.assertEqual(self.sources[3].rows[0]["district_id"], "5501")
        self.assertEqual(
            self.sources[0].source_path,
            "google-sheets:sheet-id_1/MEA_VMI_Database_Template.xlsx",
        )
        self.assertTrue(self.sources[0].metadata["project_shared_source"])
        self.assertFalse(self.sources[0].metadata["complete_snapshot"])

    def test_importer_chunks_then_promotes_the_exact_checksum(self):
        responses = [
            {"complete": True},
            {"complete": True},
            {"complete": True},
            {"complete": True},
            {
                "status": "succeeded",
                "project_sheet_import_id": "import-1",
            },
        ]
        with patch(
            "synapse_pipeline.project_sheet._rpc",
            side_effect=responses,
        ) as rpc:
            result = import_project_sheet(
                self.sources,
                supabase_url="https://project.supabase.co",
                service_role_key="sb_secret_test",
                source_spreadsheet_id="sheet-id_1",
                source_downloaded_at="2026-07-27T08:57:35+07:00",
                verified_by="admin-id",
                attestation_text="Authorized current project source.",
                change_ticket="SYNAPSE-PROD-1",
                chunk_size=1,
            )

        self.assertEqual(rpc.call_count, 5)
        self.assertEqual(len(result.artifacts), 4)
        self.assertEqual(result.promotion["status"], "succeeded")
        promotion_call = rpc.call_args_list[-1].kwargs
        self.assertEqual(
            promotion_call["body"]["p_source_checksum"],
            self.sources[0].checksum,
        )


if __name__ == "__main__":
    unittest.main()
