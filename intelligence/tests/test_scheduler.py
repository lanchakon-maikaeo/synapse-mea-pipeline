from __future__ import annotations

from datetime import date
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from synapse_intelligence.scheduler import previous_month_end
from synapse_intelligence.worker import (
    ROUTING_ATTESTATION_VERSION,
    SERVICE_VERSION,
    _claim,
    _heartbeat,
)


TILESET_VERSION = (
    "osm-thailand-2026-07-25-sha256-"
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)


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
        _heartbeat(
            connection,
            "worker-test",
            "healthy",
            phase="idle",
            routing_attestation_version=ROUTING_ATTESTATION_VERSION,
            routing_ready=True,
            routing_engine="valhalla",
            routing_profile="truck",
            routing_url_policy="controlled_non_community_origin",
            valhalla_url="https://valhalla.internal",
            tileset_version=TILESET_VERSION,
            engine_version="3.5.1",
            tileset_last_modified=1_721_865_600,
            osm_changeset=123456,
            engine_status_response_sha256="a" * 64,
            status_validated_at="2026-07-26T00:00:00+00:00",
            status_validated_epoch=1_753_488_000,
        )
        self.assertEqual(connection.commits, 1)
        query, params = connection.cursor_instance.calls[0]
        self.assertIn("record_service_heartbeat", query)
        self.assertEqual(
            params[:4],
            (
                "synapse-worker:worker-test",
                "worker-test",
                SERVICE_VERSION,
                "healthy",
            ),
        )
        self.assertIn('"phase": "idle"', params[4])
        self.assertIn('"routing_ready": true', params[4])

    def test_worker_cannot_publish_unattested_healthy_heartbeat(self):
        connection = FakeConnection()
        with self.assertRaisesRegex(
            ValueError,
            "requires validated Valhalla status attestation",
        ):
            _heartbeat(
                connection,
                "worker-test",
                "healthy",
                phase="idle",
            )
        self.assertEqual(connection.commits, 0)
        self.assertEqual(connection.cursor_instance.calls, [])

    def test_worker_cannot_attest_noncanonical_tileset_identity(self):
        connection = FakeConnection()
        with self.assertRaisesRegex(
            ValueError,
            "requires validated Valhalla status attestation",
        ):
            _heartbeat(
                connection,
                "worker-test",
                "healthy",
                routing_attestation_version=ROUTING_ATTESTATION_VERSION,
                routing_ready=True,
                routing_engine="valhalla",
                routing_profile="truck",
                routing_url_policy="controlled_non_community_origin",
                valhalla_url="https://valhalla.internal",
                tileset_version="osm-thailand-2026-07-25",
                engine_version="3.5.1",
                tileset_last_modified=1_721_865_600,
                osm_changeset=123456,
                engine_status_response_sha256="a" * 64,
                status_validated_at="2026-07-26T00:00:00+00:00",
                status_validated_epoch=1_753_488_000,
            )
        self.assertEqual(connection.commits, 0)
        self.assertEqual(connection.cursor_instance.calls, [])

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
