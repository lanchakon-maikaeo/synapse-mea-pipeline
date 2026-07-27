from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .actual_workbooks import _rpc
from .legacy_actual import chunked
from .relational_sources import RelationalSource


@dataclass(frozen=True)
class ProjectSheetImportResult:
    artifacts: list[dict[str, Any]]
    promotion: dict[str, Any]


def import_project_sheet(
    sources: Iterable[RelationalSource],
    *,
    supabase_url: str,
    service_role_key: str,
    source_spreadsheet_id: str,
    source_downloaded_at: str,
    verified_by: str,
    attestation_text: str,
    change_ticket: str,
    chunk_size: int = 200,
) -> ProjectSheetImportResult:
    source_list = list(sources)
    expected_sheets = {
        "DB_Material",
        "DB_Contract_Static",
        "DB_Contract_SAP",
        "DB_SAP_Monthly",
    }
    if {source.source_sheet for source in source_list} != expected_sheets:
        raise ValueError("exactly four project-sheet operational sources are required")
    if len({source.checksum for source in source_list}) != 1:
        raise ValueError("all project-sheet tabs must share one workbook checksum")
    if len({source.source_path for source in source_list}) != 1:
        raise ValueError("all project-sheet tabs must share one logical source path")
    if any(source.data_class != "actual" for source in source_list):
        raise ValueError("project-sheet operational sources must be actual")

    artifact_results: list[dict[str, Any]] = []
    for source in source_list:
        for rows in chunked(source.rows, chunk_size):
            artifact_results.append(_rpc(
                supabase_url=supabase_url,
                service_role_key=service_role_key,
                function_name="m18_import_source_rows",
                body={
                    "p_source_path": source.source_path,
                    "p_source_sheet": source.source_sheet,
                    "p_source_checksum": source.checksum,
                    "p_source_file_size_bytes": source.size_bytes,
                    "p_data_class": "actual",
                    "p_rows": rows,
                    "p_metadata": source.metadata,
                },
            ))

    source = source_list[0]
    promotion = _rpc(
        supabase_url=supabase_url,
        service_role_key=service_role_key,
        function_name="m14_promote_project_sheet_incremental",
        body={
            "p_source_path": source.source_path,
            "p_source_checksum": source.checksum,
            "p_source_spreadsheet_id": source_spreadsheet_id,
            "p_source_downloaded_at": source_downloaded_at,
            "p_verified_by": verified_by,
            "p_attestation_text": attestation_text,
            "p_change_ticket": change_ticket,
        },
    )
    if promotion.get("status") != "succeeded":
        raise RuntimeError("project-sheet promotion did not report success")
    return ProjectSheetImportResult(artifact_results, promotion)
