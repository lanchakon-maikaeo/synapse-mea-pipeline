from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
import json
import os
import unittest
from unittest.mock import patch

from synapse_intelligence.cli import main


class WorkerCliTests(unittest.TestCase):
    def test_worker_daemon_uses_validated_interval_without_a_shell_loop(self):
        output = StringIO()
        with (
            patch.dict(os.environ, {"DATABASE_URL": "postgresql://test"}),
            patch(
                "synapse_intelligence.cli.run_once",
                return_value={"status": "idle"},
            ) as run_once,
            patch(
                "synapse_intelligence.cli.time.sleep",
                side_effect=KeyboardInterrupt,
            ) as sleep,
            redirect_stdout(output),
        ):
            self.assertEqual(
                main(
                    [
                        "worker",
                        "--worker-id",
                        "worker-01",
                        "--poll-seconds",
                        "2.5",
                    ]
                ),
                0,
            )

        run_once.assert_called_once_with(
            "postgresql://test", worker_id="worker-01"
        )
        sleep.assert_called_once_with(2.5)
        event = json.loads(output.getvalue())
        self.assertEqual(event["command"], "worker")
        self.assertEqual(event["status"], "idle")

    def test_worker_daemon_rejects_unsafe_poll_interval(self):
        with self.assertRaises(SystemExit):
            main(["worker", "--poll-seconds", "0"])


if __name__ == "__main__":
    unittest.main()
