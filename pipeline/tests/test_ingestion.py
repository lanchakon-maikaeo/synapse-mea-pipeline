from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))

from synapse_pipeline.connectors import CsvConnector
from synapse_pipeline.ingestion import IngestionRunner


class MemoryWriter:
    def __init__(self):
        self.batches = {}
        self.rows = {}

    def begin_batch(self, source, *, connector_name, source_entity, source_sheet):
        key = (source.checksum, source_sheet)
        if key in self.batches and self.batches[key]["status"] == "succeeded":
            return self.batches[key]["batch_id"], True
        batch_id = str(uuid4())
        self.batches[key] = {"batch_id": batch_id, "status": "running"}
        return batch_id, False

    def write_rows(self, batch_id, *, source_entity, source_sheet, rows):
        inserted = 0
        for row in rows:
            key = (batch_id, source_entity, row.row_number)
            if key not in self.rows:
                self.rows[key] = row
                inserted += 1
        return inserted

    def finish_batch(self, batch_id, *, row_count, status, error_message=None):
        for batch in self.batches.values():
            if batch["batch_id"] == batch_id:
                batch.update(status=status, row_count=row_count, error_message=error_message)


class IngestionTests(unittest.TestCase):
    def test_same_checksum_is_skipped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "data.csv"
            with source_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(["id", "value"])
                writer.writerow(["1", "A"])
                writer.writerow(["2", "B"])

            memory = MemoryWriter()
            runner = IngestionRunner(memory, work_dir=Path(temp_dir) / "cache")
            connector = CsvConnector(source_path, encoding="utf-8")
            first = runner.run(connector, source_entity="test", source_sheet="Sheet1")[0]
            second = runner.run(connector, source_entity="test", source_sheet="Sheet1")[0]

            self.assertEqual(first.inserted_rows, 2)
            self.assertFalse(first.skipped)
            self.assertTrue(second.skipped)
            self.assertEqual(second.inserted_rows, 0)
            self.assertEqual(len(memory.rows), 2)


if __name__ == "__main__":
    unittest.main()
