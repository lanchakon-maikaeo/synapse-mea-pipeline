from __future__ import annotations

from datetime import date
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.scheduler import previous_month_end
from synapse_intelligence.worker import _claim, _heartbeat


class FakeCursor:
    def __init__(self):
        self.calls = []
        self.next_row = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query, params):
        self.calls.append((query, params))

    def fetchone(self):
        return self.next_row


class FakeConnection:
    def __init__(self):
        self.cursor_instance = FakeCursor()
        self.commits = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1


class SchedulerTests(unittest.TestCase):
    def test_previous_month_end_across_year_boundary(self):
        self.assertEqual(previous_month_end(date(2026, 1, 15)), date(2025, 12, 31))

    def test_previous_month_end_in_leap_year(self):
        self.assertEqual(previous_month_end(date(2024, 3, 1)), date(2024, 2, 29))

    def test_worker_heartbeat_is_persisted_with_structured_details(self):
        connection = FakeConnection()
        _heartbeat(connection, "worker-test", "healthy", phase="idle")
        self.assertEqual(connection.commits, 1)
        query, params = connection.cursor_instance.calls[0]
        self.assertIn("record_service_heartbeat", query)
        self.assertEqual(params[:4], ("synapse-worker:worker-test", "worker-test", "1.0.0", "healthy"))
        self.assertIn('"phase": "idle"', params[4])

    def test_worker_claim_materializes_volatile_function_once(self):
        connection = FakeConnection()
        connection.cursor_instance.next_row = {"job_id": "job-1", "job_type": "forecast"}
        claimed = _claim(connection, "worker-test")
        query, params = connection.cursor_instance.calls[0]
        normalized_query = " ".join(query.split()).lower()
        self.assertIn("from ops.claim_background_job", normalized_query)
        self.assertNotIn("(ops.claim_background_job", normalized_query)
        self.assertEqual(params, ("worker-test", ["forecast", "route"]))
        self.assertEqual(claimed["job_id"], "job-1")
        self.assertEqual(connection.commits, 1)


if __name__ == "__main__":
    unittest.main()
