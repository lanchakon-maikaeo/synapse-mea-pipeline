from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import logging
import os
import re
import threading
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .worker import (
    SERVICE_VERSION,
    _heartbeat,
    _validated_routing_heartbeat_details,
    run_once,
)


MAX_REQUEST_BYTES = 1_024
WORKER_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_execution_lock = threading.Lock()


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    if "\r" in value or "\n" in value:
        raise ValueError(f"{name} is invalid")
    return value


def _worker_id() -> str:
    value = os.environ.get("WORKER_ID", "vercel-worker-01").strip()
    if not WORKER_ID_PATTERN.fullmatch(value):
        raise ValueError("WORKER_ID is invalid")
    return value


def _database_url() -> str:
    for name in ("DATABASE_URL", "POSTGRES_URL_NON_POOLING", "POSTGRES_URL"):
        value = os.environ.get(name, "").strip()
        if value:
            if "\r" in value or "\n" in value:
                raise ValueError(f"{name} is invalid")
            return value
    raise ValueError("DATABASE_URL or a Vercel Postgres URL is required")


def publish_heartbeat(database_url: str, *, worker_id: str) -> dict[str, Any]:
    """Validate the controlled Valhalla identity before publishing readiness."""

    routing_details = _validated_routing_heartbeat_details()
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        _heartbeat(
            connection,
            worker_id,
            "healthy",
            phase="http_preflight",
            **routing_details,
        )
    return {
        "status": "healthy",
        "service": "synapse-optimization-worker",
        "version": SERVICE_VERSION,
        "worker_id": worker_id,
        "routing": {
            "engine": routing_details["routing_engine"],
            "profile": routing_details["routing_profile"],
            "tileset_version": routing_details["tileset_version"],
        },
    }


class WorkerRequestHandler(BaseHTTPRequestHandler):
    server_version = "synapse-worker"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        logging.info("worker_http " + format, *args)

    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":"), default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        expected = _required_environment("WORKER_API_KEY")
        supplied = self.headers.get("Authorization", "")
        prefix = "Bearer "
        return supplied.startswith(prefix) and hmac.compare_digest(
            supplied[len(prefix) :], expected
        )

    def _read_empty_json_body(self) -> bool:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError:
            return False
        if length < 0 or length > MAX_REQUEST_BYTES:
            return False
        body = self.rfile.read(length) if length else b""
        if not body:
            return True
        try:
            return json.loads(body) == {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path == "/health":
            self._json(
                200,
                {
                    "status": "ok",
                    "service": "synapse-optimization-worker",
                    "version": SERVICE_VERSION,
                },
            )
            return
        self._json(404, {"error": {"code": "not_found"}})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        try:
            authorized = self._authorized()
        except ValueError:
            self._json(503, {"error": {"code": "worker_not_configured"}})
            return
        if not authorized:
            self._json(401, {"error": {"code": "unauthorized"}})
            return
        if self.path not in {"/v1/heartbeat", "/v1/run-once"}:
            self._json(404, {"error": {"code": "not_found"}})
            return
        if not self._read_empty_json_body():
            self._json(422, {"error": {"code": "invalid_request"}})
            return
        if not _execution_lock.acquire(blocking=False):
            self._json(409, {"error": {"code": "worker_busy"}})
            return
        try:
            database_url = _database_url()
            worker_id = _worker_id()
            if self.path == "/v1/heartbeat":
                result = publish_heartbeat(database_url, worker_id=worker_id)
            else:
                result = run_once(database_url, worker_id=worker_id)
            self._json(200, result)
        except Exception:
            logging.exception("optimization worker request failed")
            self._json(503, {"error": {"code": "worker_execution_failed"}})
        finally:
            _execution_lock.release()


def serve() -> None:
    raw_port = os.environ.get("PORT", "8080")
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ValueError("PORT is invalid") from exc
    if not 1 <= port <= 65_535:
        raise ValueError("PORT is invalid")
    server = ThreadingHTTPServer(("0.0.0.0", port), WorkerRequestHandler)
    logging.info("synapse optimization worker listening on port %s", port)
    server.serve_forever()


if __name__ == "__main__":
    serve()
