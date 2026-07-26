#!/usr/bin/env python3
"""Verify the owner-designated transport coordinate source before release."""

from __future__ import annotations

import csv
import hashlib
import math
from pathlib import Path


EXPECTED_SHA256 = "fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a"
EXPECTED_DISTRICT_CODES = {
    "5501",
    "5601",
    "5701",
    "5801",
    "5901",
    "6001",
    "6501",
    "6601",
    "6701",
    "6801",
    "6901",
    "7001",
    "7501",
    "7601",
    "7701",
    "7801",
    "7901",
    "8001",
}
SOURCE_PATH = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "MEA_Synapse_Supabase_Production_20260724"
    / "data"
    / "districts.csv"
)
PACKAGE_ROOT = SOURCE_PATH.parents[1]
CHECKSUM_MANIFEST_PATH = PACKAGE_ROOT / "SHA256SUMS.txt"


def fail(message: str) -> None:
    raise SystemExit(f"transport geocode source verification failed: {message}")


def main() -> None:
    raw = SOURCE_PATH.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != EXPECTED_SHA256:
        fail(
            f"checksum changed ({digest}); review the source and create a new "
            "coordinate migration before release"
        )
    checksum_entries = CHECKSUM_MANIFEST_PATH.read_text(encoding="utf-8").splitlines()
    expected_manifest_entry = f"{EXPECTED_SHA256}  data/districts.csv"
    district_entries = [
        entry for entry in checksum_entries if entry.endswith("  data/districts.csv")
    ]
    if district_entries != [expected_manifest_entry]:
        fail("SHA256SUMS.txt does not contain the exact districts.csv checksum")

    with SOURCE_PATH.open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))

    expected_columns = {
        "district_code",
        "plant_code",
        "name_en",
        "name_th",
        "lat",
        "long",
    }
    if not rows or set(rows[0]) != expected_columns:
        fail("unexpected CSV columns")

    district_rows = [row for row in rows if row["district_code"].strip()]
    depot_rows = [row for row in rows if not row["district_code"].strip()]
    codes = [row["district_code"].strip() for row in district_rows]
    if len(rows) != 19 or len(district_rows) != 18 or len(depot_rows) != 1:
        fail("expected exactly 18 districts and one depot")
    if set(codes) != EXPECTED_DISTRICT_CODES or len(codes) != len(set(codes)):
        fail("district codes are missing, duplicated or unexpected")

    coordinate_keys: set[tuple[float, float]] = set()
    for row in rows:
        try:
            latitude = float(row["lat"])
            longitude = float(row["long"])
        except ValueError:
            fail(f"invalid coordinate for {row['name_en']!r}")
        if (
            not math.isfinite(latitude)
            or not math.isfinite(longitude)
            or not 13.0 <= latitude <= 15.0
            or not 100.0 <= longitude <= 102.0
        ):
            fail(f"coordinate outside the Bangkok operating area for {row['name_en']!r}")
        coordinate_keys.add((latitude, longitude))
    if len(coordinate_keys) != len(rows):
        fail("duplicate coordinates detected")

    depot = depot_rows[0]
    if (
        depot["plant_code"].strip()
        or "Mueang Mai Bang Phli" not in depot["name_en"]
        or "ฝ่ายพัสดุ เมืองใหม่บางพลี" not in depot["name_th"]
    ):
        fail("the uncoded row is not the expected Mueang Mai Bang Phli depot")

    print(
        "transport geocode source: passed "
        f"({len(district_rows)} districts, 1 depot, sha256={digest})"
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnicodeError, csv.Error) as error:
        fail(str(error))
