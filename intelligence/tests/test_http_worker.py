from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, patch

from synapse_intelligence.http_worker import (
    _database_url,
    _required_environment,
    _worker_id,
    publish_heartbeat,
)


ROUTING_DETAILS = {
    "routing_attestation_version": "valhalla-status-v1",
    "routing_ready": True,
    "routing_engine": "valhalla",
    "routing_profile": "truck",
    "routing_url_policy": "controlled_non_community_origin",
    "valhalla_url": "https://valhalla.example.mea",
    "tileset_version": "bmr-2026-07-26-sha256-" + "a" * 64,
    "engine_version": "3.5.1",
    "tileset_last_modified": 1_753_500_000,
    "osm_changeset": 0,
    "engine_status_response_sha256": "b" * 64,
    "status_validated_at": "2026-07-26T00:00:00+00:00",
    "status_validated_epoch": 1_753_500_000,
}


class HttpWorkerTests(unittest.TestCase):
    def test_required_environment_rejects_missing_and_newlines(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "WORKER_API_KEY is required"):
                _required_environment("WORKER_API_KEY")
        with patch.dict(os.environ, {"WORKER_API_KEY": "bad\nkey"}, clear=True):
            with self.assertRaisesRegex(ValueError, "WORKER_API_KEY is invalid"):
                _required_environment("WORKER_API_KEY")

    def test_worker_id_is_bounded(self):
        with patch.dict(os.environ, {"WORKER_ID": "vercel-worker-01"}, clear=True):
            self.assertEqual(_worker_id(), "vercel-worker-01")
        with patch.dict(os.environ, {"WORKER_ID": "bad/id"}, clear=True):
            with self.assertRaisesRegex(ValueError, "WORKER_ID is invalid"):
                _worker_id()

    def test_database_url_accepts_vercel_supabase_integration_names(self):
        with patch.dict(
            os.environ,
            {"POSTGRES_URL_NON_POOLING": "postgresql://integrated.example/db"},
            clear=True,
        ):
            self.assertEqual(
                _database_url(),
                "postgresql://integrated.example/db",
            )
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "Vercel Postgres URL"):
                _database_url()

    @patch("synapse_intelligence.http_worker._heartbeat")
    @patch("synapse_intelligence.http_worker._validated_routing_heartbeat_details")
    @patch("synapse_intelligence.http_worker.psycopg.connect")
    def test_publish_heartbeat_attests_valhalla_before_database_write(
        self,
        connect: MagicMock,
        validate_status: MagicMock,
        heartbeat: MagicMock,
    ):
        validate_status.return_value = ROUTING_DETAILS
        connection = connect.return_value.__enter__.return_value

        result = publish_heartbeat(
            "postgresql://database.example/postgres",
            worker_id="vercel-worker-01",
        )

        validate_status.assert_called_once_with()
        connect.assert_called_once_with(
            "postgresql://database.example/postgres",
            row_factory=unittest.mock.ANY,
        )
        heartbeat.assert_called_once_with(
            connection,
            "vercel-worker-01",
            "healthy",
            phase="http_preflight",
            **ROUTING_DETAILS,
        )
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["routing"]["engine"], "valhalla")


if __name__ == "__main__":
    unittest.main()
