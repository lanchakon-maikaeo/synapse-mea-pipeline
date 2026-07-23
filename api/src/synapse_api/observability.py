from __future__ import annotations

from collections import defaultdict, deque
import json
import logging
from threading import Lock
import time


logger = logging.getLogger("synapse.api")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)


def log_event(event: str, **fields) -> None:
    logger.info(json.dumps({"event": event, **fields}, default=str, ensure_ascii=False, separators=(",", ":")))


class SlidingWindowRateLimiter:
    def __init__(self, requests_per_minute: int):
        self.limit = requests_per_minute
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        current = now if now is not None else time.monotonic()
        cutoff = current - 60
        with self._lock:
            bucket = self._requests[key]
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= self.limit:
                return False
            bucket.append(current)
            return True


class ApiMetrics:
    def __init__(self):
        self._requests: dict[tuple[str, str, int], int] = defaultdict(int)
        self._duration_seconds: dict[tuple[str, str], float] = defaultdict(float)
        self._lock = Lock()

    def observe(self, method: str, path: str, status_code: int, duration_seconds: float) -> None:
        normalized_path = self._normalize_path(path)
        with self._lock:
            self._requests[(method, normalized_path, status_code)] += 1
            self._duration_seconds[(method, normalized_path)] += duration_seconds

    @staticmethod
    def _normalize_path(path: str) -> str:
        parts = path.strip("/").split("/")
        normalized = ["{id}" if len(part) >= 32 and "-" in part else part for part in parts]
        return "/" + "/".join(normalized) if normalized != [""] else "/"

    def render(self) -> str:
        lines = [
            "# HELP synapse_api_requests_total Total API requests.",
            "# TYPE synapse_api_requests_total counter",
        ]
        with self._lock:
            for (method, path, status_code), value in sorted(self._requests.items()):
                lines.append(
                    f'synapse_api_requests_total{{method="{method}",path="{path}",status="{status_code}"}} {value}'
                )
            lines.extend([
                "# HELP synapse_api_request_duration_seconds_sum Accumulated request duration.",
                "# TYPE synapse_api_request_duration_seconds_sum counter",
            ])
            for (method, path), value in sorted(self._duration_seconds.items()):
                lines.append(
                    f'synapse_api_request_duration_seconds_sum{{method="{method}",path="{path}"}} {value:.6f}'
                )
        return "\n".join(lines) + "\n"
