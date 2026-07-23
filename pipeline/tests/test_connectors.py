from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))

from synapse_pipeline.connectors import CsvConnector, ExcelConnector, GoogleSheetsCsvConnector


class ConnectorTests(unittest.TestCase):
    def test_contract_workbook_profile(self):
        connector = ExcelConnector(ROOT / "รวมสัญญา.xlsx", "รวมสัญญา")
        sources = connector.discover()
        self.assertEqual(len(sources), 1)
        rows = list(connector.iter_rows(sources[0]))
        self.assertEqual(len(rows), 6305)
        self.assertEqual(rows[0].row_number, 2)
        self.assertEqual(rows[-1].row_number, 6306)
        self.assertEqual(len(rows[0].payload), 16)
        self.assertEqual(len(rows[0].row_hash), 64)

    def test_csv_connector_skips_blank_rows(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "source.csv"
            with path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(["id", "name"])
                writer.writerow(["1", "alpha"])
                writer.writerow(["", ""])
            connector = CsvConnector(path, encoding="utf-8")
            rows = list(connector.iter_rows(connector.discover()[0]))
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].payload["name"], "alpha")

    def test_google_sheets_export_url(self):
        connector = GoogleSheetsCsvConnector("sheet-id", gid="123")
        self.assertEqual(
            connector.export_url,
            "https://docs.google.com/spreadsheets/d/sheet-id/export?format=csv&gid=123",
        )


if __name__ == "__main__":
    unittest.main()
