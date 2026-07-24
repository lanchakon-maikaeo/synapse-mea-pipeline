#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))

from synapse_pipeline.relational_sources import (  # noqa: E402
    build_package_manifest,
    parse_actual_contract_source,
    parse_dummy_relational_sources,
)


def _serialized(source):
    return {
        "source_path": source.source_path,
        "source_sheet": source.source_sheet,
        "checksum": source.checksum,
        "size_bytes": source.size_bytes,
        "data_class": source.data_class,
        "metadata": source.metadata,
        "rows": source.rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build governed M18 payloads from Actual, fixture and design sources"
    )
    parser.add_argument("--dummy", type=Path, required=True)
    parser.add_argument("--contracts", type=Path, required=True)
    parser.add_argument("--staging-package", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    actual_contracts = parse_actual_contract_source(args.contracts)
    fixture_sources = parse_dummy_relational_sources(args.dummy)
    package_sources = build_package_manifest(args.staging_package)
    output = {
        "format": "synapse-relational-sources-v1",
        "actual_contracts": _serialized(actual_contracts),
        "reference_fixture": [_serialized(source) for source in fixture_sources],
        "design_reference": [_serialized(source) for source in package_sources],
    }
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(json.dumps({
        "output": str(args.output),
        "actual_contract_rows": len(actual_contracts.rows),
        "fixture_rows": {
            source.source_sheet: len(source.rows)
            for source in fixture_sources
        },
        "package_files": len(package_sources),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
