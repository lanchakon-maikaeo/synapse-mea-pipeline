from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Protocol
from uuid import UUID

from .connectors import SourceConnector, SourceObject, SourceRow


@dataclass(frozen=True)
class IngestionResult:
    batch_id: str
    source_entity: str
    discovered_rows: int
    inserted_rows: int
    skipped: bool
    checksum: str


class BatchWriter(Protocol):
    def begin_batch(
        self,
        source: SourceObject,
        *,
        connector_name: str,
        source_entity: str,
        source_sheet: str | None,
    ) -> tuple[str, bool]: ...

    def write_rows(
        self,
        batch_id: str,
        *,
        source_entity: str,
        source_sheet: str | None,
        rows: Iterable[SourceRow],
    ) -> int: ...

    def finish_batch(self, batch_id: str, *, row_count: int, status: str, error_message: str | None = None) -> None: ...


class IngestionRunner:
    def __init__(self, writer: BatchWriter, *, work_dir: str | Path):
        self.writer = writer
        self.work_dir = Path(work_dir)

    def run(
        self,
        connector: SourceConnector,
        *,
        source_entity: str,
        source_sheet: str | None = None,
    ) -> list[IngestionResult]:
        results: list[IngestionResult] = []
        for discovered in connector.discover():
            source = connector.download(discovered, self.work_dir)
            if not source.checksum:
                raise ValueError("connector did not provide a checksum")

            batch_id, already_succeeded = self.writer.begin_batch(
                source,
                connector_name=connector.connector_name,
                source_entity=source_entity,
                source_sheet=source_sheet,
            )
            if already_succeeded:
                results.append(
                    IngestionResult(batch_id, source_entity, 0, 0, True, source.checksum)
                )
                continue

            discovered_rows = 0
            try:
                materialized_rows = list(connector.iter_rows(source))
                discovered_rows = len(materialized_rows)
                inserted_rows = self.writer.write_rows(
                    batch_id,
                    source_entity=source_entity,
                    source_sheet=source_sheet,
                    rows=materialized_rows,
                )
                self.writer.finish_batch(batch_id, row_count=discovered_rows, status="succeeded")
                results.append(
                    IngestionResult(
                        batch_id,
                        source_entity,
                        discovered_rows,
                        inserted_rows,
                        False,
                        source.checksum,
                    )
                )
            except Exception as exc:
                self.writer.finish_batch(
                    batch_id,
                    row_count=discovered_rows,
                    status="failed",
                    error_message=str(exc),
                )
                raise
        return results


class PostgresWriter:
    def __init__(self, database_url: str):
        try:
            import psycopg
        except ImportError as exc:
            raise RuntimeError("Install pipeline dependencies with: pip install -e pipeline") from exc
        self._psycopg = psycopg
        self.connection = psycopg.connect(database_url)

    def close(self) -> None:
        self.connection.close()

    def begin_batch(
        self,
        source: SourceObject,
        *,
        connector_name: str,
        source_entity: str,
        source_sheet: str | None,
    ) -> tuple[str, bool]:
        with self.connection.transaction(), self.connection.cursor() as cursor:
            cursor.execute(
                """
                select batch_id::text, status
                from raw.import_batches
                where source_checksum = %s and source_sheet is not distinct from %s
                """,
                (source.checksum, source_sheet),
            )
            existing = cursor.fetchone()
            if existing and existing[1] == "succeeded":
                return existing[0], True

            if existing:
                cursor.execute(
                    """
                    update raw.import_batches
                    set status = 'running', connector_name = %s, source_entity = %s,
                        started_at = now(), finished_at = null, error_message = null,
                        updated_at = now()
                    where batch_id = %s::uuid
                    returning batch_id::text
                    """,
                    (connector_name, source_entity, existing[0]),
                )
            else:
                cursor.execute(
                    """
                    insert into raw.import_batches (
                      source_system, source_file, source_sheet, source_checksum,
                      source_file_size_bytes, status, connector_name, source_entity,
                      started_at, metadata
                    ) values (%s, %s, %s, %s, %s, 'running', %s, %s, now(), %s::jsonb)
                    returning batch_id::text
                    """,
                    (
                        connector_name,
                        source.name,
                        source_sheet,
                        source.checksum,
                        source.size_bytes,
                        connector_name,
                        source_entity,
                        self._psycopg.types.json.Jsonb(source.metadata),
                    ),
                )
            return cursor.fetchone()[0], False

    def write_rows(
        self,
        batch_id: str,
        *,
        source_entity: str,
        source_sheet: str | None,
        rows: Iterable[SourceRow],
    ) -> int:
        materialized = list(rows)
        with self.connection.transaction(), self.connection.cursor() as cursor:
            cursor.executemany(
                """
                insert into raw.source_rows (
                  batch_id, source_entity, source_sheet, source_row_number, row_hash, payload
                ) values (%s::uuid, %s, %s, %s, %s, %s::jsonb)
                on conflict (batch_id, source_entity, source_row_number) do nothing
                """,
                [
                    (
                        batch_id,
                        source_entity,
                        source_sheet,
                        row.row_number,
                        row.row_hash,
                        self._psycopg.types.json.Jsonb(row.payload),
                    )
                    for row in materialized
                ],
            )
            return cursor.rowcount

    def finish_batch(self, batch_id: str, *, row_count: int, status: str, error_message: str | None = None) -> None:
        with self.connection.transaction(), self.connection.cursor() as cursor:
            cursor.execute(
                """
                update raw.import_batches
                set row_count = %s, status = %s, error_message = %s,
                    imported_at = case when %s = 'succeeded' then now() else imported_at end,
                    finished_at = now(), updated_at = now()
                where batch_id = %s::uuid
                """,
                (row_count, status, error_message, status, batch_id),
            )
