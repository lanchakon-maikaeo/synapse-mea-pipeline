from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .actual_workbooks import (
    import_actual_data_directory,
    parse_actual_data_directory,
)
from .connectors import CsvConnector, DocumentConnector, ExcelConnector, GoogleSheetsCsvConnector
from .ingestion import IngestionRunner, PostgresWriter
from .legacy_actual import download_sources, import_sources
from .test_fixture import import_test_fixture, parse_test_fixture_workbook


def _local_connector(path: str, sheet: str | None):
    suffix = Path(path).suffix.lower()
    if suffix == ".xlsx":
        if not sheet:
            raise SystemExit("--sheet is required for Excel sources")
        return ExcelConnector(path, sheet)
    if suffix == ".csv":
        return CsvConnector(path)
    return DocumentConnector(path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="synapse-pipeline")
    subparsers = parser.add_subparsers(dest="command", required=True)

    profile = subparsers.add_parser("profile", help="Profile a local tabular source")
    profile.add_argument("--source", required=True)
    profile.add_argument("--sheet")

    ingest = subparsers.add_parser("ingest", help="Load a source into raw.source_rows")
    ingest.add_argument("--source", required=True)
    ingest.add_argument("--sheet")
    ingest.add_argument("--entity", required=True)
    ingest.add_argument("--work-dir", default=".synapse-cache")

    google = subparsers.add_parser("ingest-google-sheet", help="Download and ingest a Google Sheet CSV export")
    google.add_argument("--spreadsheet-id", required=True)
    google.add_argument("--gid", default="0")
    google.add_argument("--entity", required=True)
    google.add_argument("--work-dir", default=".synapse-cache")

    legacy = subparsers.add_parser("import-legacy-actual", help="Import verified real sources documented by the legacy SYNAPSE project")
    legacy.add_argument("--work-dir", default=".synapse-cache/legacy-actual")
    legacy.add_argument("--chunk-size", type=int, default=200)

    fixture = subparsers.add_parser(
        "import-test-fixture",
        help="Import the governed Dummy workbook into the registered Test environment",
    )
    fixture.add_argument("--source", default="MEA_VMI_Dummy_Klongtoey.xlsx")
    fixture.add_argument("--chunk-size", type=int, default=200)
    fixture.add_argument(
        "--confirm-test-environment",
        action="store_true",
        help="Required safety acknowledgement; the database RPC also enforces Test-only use",
    )

    actual = subparsers.add_parser(
        "import-actual-workbooks",
        help=(
            "Import the governed data/ workbook set into Supabase "
            "Raw, Staging, Core and relational lineage"
        ),
    )
    actual.add_argument("--data-dir", default="data")
    actual.add_argument("--chunk-size", type=int, default=200)
    actual.add_argument("--attested-by", required=True)
    actual.add_argument("--attestation-text", required=True)
    actual.add_argument("--change-ticket", required=True)
    actual.add_argument(
        "--confirm-actual-data",
        action="store_true",
        help=(
            "Required acknowledgement that the four checksummed workbooks "
            "are approved Actual source evidence"
        ),
    )
    actual.add_argument(
        "--confirm-production-attestation",
        action="store_true",
        help=(
            "Required acknowledgement of the owner-approved exhaustive "
            "source omission = zero Production policy"
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "profile":
        connector = _local_connector(args.source, args.sheet)
        discovered = connector.discover()
        if not discovered:
            raise SystemExit("source not found")
        source = discovered[0]
        rows = list(connector.iter_rows(source))
        print(json.dumps({
            "source": connector.get_metadata(source),
            "row_count": len(rows),
            "first_row_number": rows[0].row_number if rows else None,
            "last_row_number": rows[-1].row_number if rows else None,
            "headers": list(rows[0].payload) if rows else [],
        }, ensure_ascii=False, indent=2))
        return 0

    if args.command == "import-legacy-actual":
        required = {
            "SUPABASE_URL": os.environ.get("SUPABASE_URL"),
            "SUPABASE_ANON_KEY": os.environ.get("SUPABASE_ANON_KEY"),
            "SUPABASE_ACCESS_TOKEN": os.environ.get("SUPABASE_ACCESS_TOKEN"),
        }
        missing = [key for key, value in required.items() if not value]
        if missing:
            raise SystemExit(f"Missing environment variables: {', '.join(missing)}")
        sources = download_sources(args.work_dir)
        results = import_sources(
            sources,
            supabase_url=required["SUPABASE_URL"],
            publishable_key=required["SUPABASE_ANON_KEY"],
            access_token=required["SUPABASE_ACCESS_TOKEN"],
            chunk_size=args.chunk_size,
        )
        print(json.dumps({
            "sources": [
                {"source_key": source.source_key, "rows": len(source.rows), "checksum": source.checksum}
                for source in sources
            ],
            "final_results": results[-3:] if results else [],
        }, ensure_ascii=False, indent=2))
        return 0

    if args.command == "import-test-fixture":
        if not args.confirm_test_environment:
            raise SystemExit(
                "--confirm-test-environment is required because this command writes TEST_FIXTURE data"
            )
        required = {
            "SUPABASE_URL": os.environ.get("SUPABASE_URL"),
            "SUPABASE_ANON_KEY": os.environ.get("SUPABASE_ANON_KEY"),
            "SUPABASE_ACCESS_TOKEN": os.environ.get("SUPABASE_ACCESS_TOKEN"),
        }
        missing = [key for key, value in required.items() if not value]
        if missing:
            raise SystemExit(f"Missing environment variables: {', '.join(missing)}")
        sources = parse_test_fixture_workbook(args.source)
        results = import_test_fixture(
            sources,
            supabase_url=required["SUPABASE_URL"],
            publishable_key=required["SUPABASE_ANON_KEY"],
            access_token=required["SUPABASE_ACCESS_TOKEN"],
            chunk_size=args.chunk_size,
        )
        print(json.dumps({
            "data_class": "TEST_FIXTURE",
            "sources": [
                {"source_key": source.source_key, "rows": len(source.rows), "checksum": source.checksum}
                for source in sources
            ],
            "final_results": results[-4:] if results else [],
        }, ensure_ascii=False, indent=2))
        return 0

    if args.command == "import-actual-workbooks":
        if not args.confirm_actual_data:
            raise SystemExit(
                "--confirm-actual-data is required because this command "
                "promotes checksummed source evidence"
            )
        supabase_url = os.environ.get("SUPABASE_URL")
        backend_key = (
            os.environ.get("SUPABASE_SECRET_KEY")
            or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        )
        if not supabase_url:
            raise SystemExit("Missing environment variable: SUPABASE_URL")
        if not backend_key:
            raise SystemExit(
                "Missing backend credential: set SUPABASE_SECRET_KEY "
                "(preferred) or SUPABASE_SERVICE_ROLE_KEY"
            )
        sources = parse_actual_data_directory(args.data_dir)
        result = import_actual_data_directory(
            sources,
            supabase_url=supabase_url,
            service_role_key=backend_key,
            attested_by=args.attested_by,
            attestation_text=args.attestation_text,
            change_ticket=args.change_ticket,
            chunk_size=args.chunk_size,
            confirm_production_attestation=(
                args.confirm_production_attestation
            ),
        )
        print(json.dumps({
            "data_class": "actual",
            "sources": [
                {
                    "source_path": source.source_path,
                    "source_sheet": source.source_sheet,
                    "rows": len(source.rows),
                    "checksum": source.checksum,
                }
                for source in sources
            ],
            "artifact_rpc_calls": len(result.artifacts),
            "promotion": result.promotion,
            "production_completion": result.production_completion,
        }, ensure_ascii=False, indent=2))
        return 0

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required for ingestion")
    writer = PostgresWriter(database_url)
    try:
        if args.command == "ingest":
            connector = _local_connector(args.source, args.sheet)
            source_sheet = args.sheet
        else:
            connector = GoogleSheetsCsvConnector(args.spreadsheet_id, gid=args.gid)
            source_sheet = f"gid:{args.gid}"
        results = IngestionRunner(writer, work_dir=args.work_dir).run(
            connector,
            source_entity=args.entity,
            source_sheet=source_sheet,
        )
        print(json.dumps([result.__dict__ for result in results], ensure_ascii=False, indent=2))
        return 0
    finally:
        writer.close()
