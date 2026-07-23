from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/postgres")
os.environ.setdefault("SUPABASE_JWT_SECRET", "openapi-generation-placeholder")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from synapse_api.main import create_app  # noqa: E402


def render() -> str:
    return json.dumps(create_app().openapi(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    destination = Path(__file__).resolve().parents[1] / "openapi.json"
    generated = render()
    if args.check:
        if not destination.exists() or destination.read_text() != generated:
            print("api/openapi.json is out of date", file=sys.stderr)
            return 1
        return 0
    destination.write_text(generated)
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
