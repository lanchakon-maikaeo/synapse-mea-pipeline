#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline" / "src"))
from synapse_pipeline.test_fixture import parse_test_fixture_workbook


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prepare deterministic M16 RPC payloads from the governed UAT workbook"
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    sources = parse_test_fixture_workbook(args.source)
    output = {
        "data_class": "TEST_FIXTURE",
        "sources": [
            {
                "source_key": source.source_key,
                "checksum": source.checksum,
                "metadata": source.metadata,
                "rows": source.rows,
            }
            for source in sources
        ],
    }
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(json.dumps({
        "output": str(args.output),
        "checksum": sources[0].checksum,
        "sources": {
            source.source_key: len(source.rows)
            for source in sources
        },
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
