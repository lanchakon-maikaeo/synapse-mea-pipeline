from __future__ import annotations

import csv
import json
import shutil
from datetime import date, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterable

from openpyxl import load_workbook

from .base import SourceConnector, SourceObject, SourceRow, local_source


def _json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def _row_hash(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return sha256(canonical.encode("utf-8")).hexdigest()


def _copy_source(source: SourceObject, destination: Path) -> SourceObject:
    if source.local_path is None:
        raise ValueError("local_path is required for a local source")
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / source.name
    if source.local_path != target:
        shutil.copy2(source.local_path, target)
    return local_source(target, source_id=source.source_id, metadata=source.metadata)


class ExcelConnector(SourceConnector):
    connector_name = "excel"

    def __init__(self, path: str | Path, sheet_name: str):
        self.path = Path(path)
        self.sheet_name = sheet_name

    def discover(self) -> list[SourceObject]:
        if not self.path.exists():
            return []
        return [local_source(self.path, metadata={"sheet_name": self.sheet_name})]

    def download(self, source: SourceObject, destination: Path) -> SourceObject:
        return _copy_source(source, destination)

    def iter_rows(self, source: SourceObject) -> Iterable[SourceRow]:
        if source.local_path is None:
            raise ValueError("Excel source has not been materialized")
        workbook = load_workbook(source.local_path, read_only=True, data_only=True)
        try:
            if self.sheet_name not in workbook.sheetnames:
                raise ValueError(f"sheet not found: {self.sheet_name}")
            sheet = workbook[self.sheet_name]
            iterator = sheet.iter_rows(values_only=True)
            raw_headers = list(next(iterator))
            while raw_headers and (raw_headers[-1] is None or str(raw_headers[-1]).strip() == ""):
                raw_headers.pop()
            headers = [str(value).strip() if value is not None else "" for value in raw_headers]
            if any(not header for header in headers):
                raise ValueError("blank headers are not allowed")
            if len(set(headers)) != len(headers):
                raise ValueError("duplicate headers are not allowed")

            for row_number, values in enumerate(iterator, start=2):
                payload = {header: _json_value(value) for header, value in zip(headers, values)}
                if all(value is None or value == "" for value in payload.values()):
                    continue
                yield SourceRow(row_number=row_number, payload=payload, row_hash=_row_hash(payload))
        finally:
            workbook.close()


class CsvConnector(SourceConnector):
    connector_name = "csv"

    def __init__(self, path: str | Path, *, encoding: str = "utf-8-sig"):
        self.path = Path(path)
        self.encoding = encoding

    def discover(self) -> list[SourceObject]:
        if not self.path.exists():
            return []
        return [local_source(self.path, metadata={"encoding": self.encoding})]

    def download(self, source: SourceObject, destination: Path) -> SourceObject:
        return _copy_source(source, destination)

    def iter_rows(self, source: SourceObject) -> Iterable[SourceRow]:
        if source.local_path is None:
            raise ValueError("CSV source has not been materialized")
        with source.local_path.open("r", encoding=self.encoding, newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames or any(not header for header in reader.fieldnames):
                raise ValueError("CSV requires non-blank headers")
            if len(set(reader.fieldnames)) != len(reader.fieldnames):
                raise ValueError("duplicate headers are not allowed")
            for row_number, row in enumerate(reader, start=2):
                payload = dict(row)
                if all(value is None or value == "" for value in payload.values()):
                    continue
                yield SourceRow(row_number=row_number, payload=payload, row_hash=_row_hash(payload))


class DocumentConnector(SourceConnector):
    connector_name = "document"
    supported_extensions = {".pdf", ".docx", ".doc", ".txt"}

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def discover(self) -> list[SourceObject]:
        if self.path.is_file():
            paths = [self.path] if self.path.suffix.lower() in self.supported_extensions else []
        elif self.path.is_dir():
            paths = sorted(path for path in self.path.iterdir() if path.suffix.lower() in self.supported_extensions)
        else:
            paths = []
        return [local_source(path, metadata={"extension": path.suffix.lower()}) for path in paths]

    def download(self, source: SourceObject, destination: Path) -> SourceObject:
        return _copy_source(source, destination)
