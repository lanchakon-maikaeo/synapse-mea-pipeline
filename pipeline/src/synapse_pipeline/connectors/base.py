from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterable


def file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class SourceObject:
    source_id: str
    name: str
    uri: str
    local_path: Path | None
    size_bytes: int | None
    modified_at: datetime | None
    checksum: str | None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SourceRow:
    row_number: int
    payload: dict[str, Any]
    row_hash: str


class SourceConnector(ABC):
    connector_name = "base"

    @abstractmethod
    def discover(self) -> list[SourceObject]:
        """Return source objects available to this connector."""

    @abstractmethod
    def download(self, source: SourceObject, destination: Path) -> SourceObject:
        """Materialize a source object locally and return its complete metadata."""

    def get_metadata(self, source: SourceObject) -> dict[str, Any]:
        return {
            "connector": self.connector_name,
            "source_id": source.source_id,
            "name": source.name,
            "uri": source.uri,
            "size_bytes": source.size_bytes,
            "modified_at": source.modified_at.isoformat() if source.modified_at else None,
            "checksum": source.checksum,
            **source.metadata,
        }

    def iter_rows(self, source: SourceObject) -> Iterable[SourceRow]:
        raise TypeError(f"{self.connector_name} does not expose tabular rows")


def local_source(path: Path, *, source_id: str | None = None, metadata: dict[str, Any] | None = None) -> SourceObject:
    resolved = path.expanduser().resolve()
    stat = resolved.stat()
    return SourceObject(
        source_id=source_id or resolved.as_posix(),
        name=resolved.name,
        uri=resolved.as_uri(),
        local_path=resolved,
        size_bytes=stat.st_size,
        modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
        checksum=file_sha256(resolved),
        metadata=metadata or {},
    )
