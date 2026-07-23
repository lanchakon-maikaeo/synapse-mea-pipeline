from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

from .base import SourceConnector, SourceObject, local_source
from .local import CsvConnector


class GoogleSheetsCsvConnector(SourceConnector):
    connector_name = "google-sheets-csv"

    def __init__(self, spreadsheet_id: str, *, gid: str = "0", timeout_seconds: int = 60):
        self.spreadsheet_id = spreadsheet_id
        self.gid = gid
        self.timeout_seconds = timeout_seconds

    @property
    def export_url(self) -> str:
        return (
            f"https://docs.google.com/spreadsheets/d/{self.spreadsheet_id}/export"
            f"?format=csv&gid={self.gid}"
        )

    def discover(self) -> list[SourceObject]:
        name = f"google-sheet-{self.spreadsheet_id}-{self.gid}.csv"
        return [
            SourceObject(
                source_id=f"google-sheets:{self.spreadsheet_id}:{self.gid}",
                name=name,
                uri=self.export_url,
                local_path=None,
                size_bytes=None,
                modified_at=None,
                checksum=None,
                metadata={"spreadsheet_id": self.spreadsheet_id, "gid": self.gid},
            )
        ]

    def download(self, source: SourceObject, destination: Path) -> SourceObject:
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / source.name
        request = Request(source.uri, headers={"User-Agent": "synapse-pipeline/0.1"})
        with urlopen(request, timeout=self.timeout_seconds) as response, target.open("wb") as handle:
            handle.write(response.read())
        return local_source(
            target,
            source_id=source.source_id,
            metadata={**source.metadata, "downloaded_at": datetime.now(timezone.utc).isoformat()},
        )

    def iter_rows(self, source: SourceObject):
        if source.local_path is None:
            raise ValueError("Google Sheets source must be downloaded before reading")
        yield from CsvConnector(source.local_path).iter_rows(source)
