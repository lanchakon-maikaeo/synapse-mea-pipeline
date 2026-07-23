from __future__ import annotations

import csv
import hashlib
import io
import json
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Iterable
from urllib.request import Request, urlopen
from urllib.error import HTTPError


MATERIALS_URL = (
    "https://script.google.com/macros/s/"
    "AKfycbxD7CJ6Iq-pggWSPuRZs3xHBm1JKTRJ7Ho2VY-JuCHVEQ19ZMp5H9MVLaf0WTDqxg3UAw/exec"
    "?type=materials"
)
WAREHOUSE_STOCK_URL = MATERIALS_URL.replace("type=materials", "type=cw_stock")
CMP_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1l8xjUPYK7koE8hgssM5wKXKctQBY0fl5GtuZn5WRxh8/export?format=csv&gid=0"
)

PLANT_TO_DISTRICT = {
    "5501": "5501", "5601": "5502", "5701": "5503", "5801": "5504",
    "5901": "5505", "6001": "5506", "6501": "5507", "6601": "5508",
    "6701": "5509", "6801": "5510", "6901": "5511", "7001": "5512",
    "7501": "5513", "7601": "5514", "7701": "5515", "7801": "5516",
    "7901": "5517", "8001": "5518",
}


@dataclass(frozen=True)
class LegacySourcePayload:
    source_key: str
    checksum: str
    rows: list[dict[str, Any]]
    metadata: dict[str, Any]


def _number(value: str | int | float | None) -> int | float | None:
    if value is None:
        return None
    cleaned = str(value).strip().replace(",", "")
    if cleaned in ("", "-"):
        return None
    parsed = float(cleaned)
    return int(parsed) if parsed.is_integer() else parsed


def _checksum(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def parse_materials(content: bytes) -> LegacySourcePayload:
    source_rows = json.loads(content.decode("utf-8-sig"))
    rows = [
        {
            "row_number": index,
            "material_id": str(row["id"]).strip(),
            "material_name": str(row.get("name") or "").strip() or None,
            "unit": str(row.get("unit") or "").strip() or None,
        }
        for index, row in enumerate(source_rows, start=1)
        if str(row.get("id") or "").strip()
    ]
    return LegacySourcePayload(
        "materials", _checksum(content), rows,
        {"total_rows": len(rows), "source_url": MATERIALS_URL, "source_kind": "Apps Script DB_Material"},
    )


def _legacy_stock_timestamp(value: str) -> str:
    english = value.split(" GMT", 1)[0]
    parsed = datetime.strptime(english, "%a %b %d %Y %H:%M:%S")
    return parsed.replace(tzinfo=timezone(timedelta(hours=7))).isoformat()


def parse_warehouse_stock(content: bytes) -> LegacySourcePayload:
    payload = json.loads(content.decode("utf-8-sig"))
    snapshot_at = _legacy_stock_timestamp(payload["date"])
    rows: list[dict[str, Any]] = []
    for index, material_id in enumerate(sorted(payload["stock"]), start=1):
        locations = payload["stock"][material_id]
        warehouse = locations.get("คลองเตย") or next(iter(locations.values()))
        rows.append({
            "row_number": index,
            "material_id": str(material_id).strip(),
            "quantity_on_hand": _number(warehouse.get("qty")) or 0,
            "snapshot_at": snapshot_at,
        })
    return LegacySourcePayload(
        "warehouse_stock", _checksum(content), rows,
        {
            "total_rows": len(rows), "source_url": WAREHOUSE_STOCK_URL,
            "source_kind": "Apps Script DB_Stock WAREHOUSE", "source_observed_at": snapshot_at,
            "location_id": "WH-KT",
        },
    )


def parse_cmp(content: bytes) -> LegacySourcePayload:
    text = content.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text, newline=""))
    header = next(reader)
    monthly_columns: list[tuple[int, str]] = []
    for index in range(11, min(23, len(header))):
        label = header[index].strip()
        if len(label) == 6 and label.isdigit():
            monthly_columns.append((index, f"{label[2:]}-{label[:2]}"))

    normalized: list[dict[str, Any]] = []
    negative_observations = 0
    for source_row in reader:
        if len(source_row) < 23 or not source_row[0].strip():
            continue
        material_id = source_row[0].strip()
        sap_plant = source_row[1].strip()
        district_id = PLANT_TO_DISTRICT.get(sap_plant)
        if not district_id:
            continue
        observed_history = [
            {"period": period, "demand_quantity": quantity}
            for index, period in monthly_columns
            if (quantity := _number(source_row[index])) is not None
        ]
        history = [row for row in observed_history if row["demand_quantity"] >= 0]
        negative_history = [row for row in observed_history if row["demand_quantity"] < 0]
        negative_observations += len(negative_history)
        raw_cmp_monthly = _number(source_row[3]) or 0
        normalized_row = {
            "row_number": len(normalized) + 1,
            "material_id": material_id,
            "sap_plant_code": sap_plant,
            "district_id": district_id,
            "as_of_date": "2026-04-30",
            # CMP is an operational consumption rate in Core and therefore cannot
            # be negative. Signed SAP adjustments stay in the Raw payload while
            # the normalized Staging/Core value is clamped to zero.
            "cmp_monthly": max(raw_cmp_monthly, 0),
            "avg_ly": _number(source_row[4]),
            "avg_12m": _number(source_row[5]),
            "avg_6m": _number(source_row[6]),
            "avg_4m": _number(source_row[7]),
            "history": history,
        }
        if negative_history:
            # Preserve SAP return/adjustment values in Raw while excluding them from the
            # non-negative demand feature contract used by forecasting.
            normalized_row["negative_history"] = negative_history
        if raw_cmp_monthly < 0:
            normalized_row["negative_cmp_monthly_adjustment"] = raw_cmp_monthly
        normalized.append(normalized_row)
    return LegacySourcePayload(
        "cmp_usage", _checksum(content), normalized,
        {
            "total_rows": len(normalized), "source_url": CMP_URL,
            "source_kind": "Google Sheets CMP actual export", "as_of_date": "2026-04-30",
            "mapped_districts": len(PLANT_TO_DISTRICT),
            "unmapped_rows_excluded": True,
            "negative_demand_observations_preserved_in_raw_and_excluded_from_features": negative_observations,
        },
    )


def chunked(rows: list[dict[str, Any]], size: int) -> Iterable[list[dict[str, Any]]]:
    if size < 1 or size > 500:
        raise ValueError("chunk size must be between 1 and 500")
    for offset in range(0, len(rows), size):
        yield rows[offset:offset + size]


def download_sources(work_dir: str | Path) -> list[LegacySourcePayload]:
    destination = Path(work_dir)
    destination.mkdir(parents=True, exist_ok=True)
    results: list[LegacySourcePayload] = []
    for name, url, parser in (
        ("materials.json", MATERIALS_URL, parse_materials),
        ("warehouse-stock.json", WAREHOUSE_STOCK_URL, parse_warehouse_stock),
        ("cmp.csv", CMP_URL, parse_cmp),
    ):
        request = Request(url, headers={"User-Agent": "SYNAPSE-Open-Source-Pipeline/1.0"})
        with urlopen(request, timeout=90) as response:
            content = response.read()
        (destination / name).write_bytes(content)
        results.append(parser(content))
    return results


def import_sources(
    sources: Iterable[LegacySourcePayload], *, supabase_url: str,
    publishable_key: str, access_token: str, chunk_size: int = 200,
) -> list[dict[str, Any]]:
    endpoint = supabase_url.rstrip("/") + "/rest/v1/rpc/m11_import_legacy_actual"
    results: list[dict[str, Any]] = []
    for source in sources:
        for chunk_number, rows in enumerate(chunked(source.rows, chunk_size), start=1):
            body = json.dumps({
                "p_source_key": source.source_key,
                "p_source_checksum": source.checksum,
                "p_rows": rows,
                "p_metadata": source.metadata,
            }, ensure_ascii=False).encode("utf-8")
            request = Request(endpoint, data=body, method="POST", headers={
                "apikey": publishable_key,
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            })
            try:
                with urlopen(request, timeout=120) as response:
                    results.append(json.loads(response.read().decode("utf-8")))
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:2000]
                raise RuntimeError(
                    f"Legacy import failed for {source.source_key} chunk {chunk_number}: "
                    f"HTTP {exc.code}: {detail}"
                ) from exc
    return results
