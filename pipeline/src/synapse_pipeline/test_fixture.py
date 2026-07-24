from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, time, timezone, timedelta
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from openpyxl import load_workbook
from openpyxl.utils.datetime import from_excel


BANGKOK = timezone(timedelta(hours=7))
WORKBOOK_NAME = "MEA_VMI_Dummy_Klongtoey.xlsx"
PROMOTED_SHEETS = {
    "materials": "DB_Material",
    "packaging": "DB_Contract_Static",
    "district_stock": "DB_Stock",
    "usage": "DB_SAP_Monthly",
}
RAW_ONLY_SHEETS = (
    "DB_Warehouse",
    "DB_Contract_SAP",
    "DB_Route",
    "Master_Vehicle",
    "DB_PernalUse",
    "Trans_Replenishment_Plan",
    "Trans_Transport_Logs",
    "Data_Quality_Log",
)


@dataclass(frozen=True)
class TestFixturePayload:
    source_key: str
    checksum: str
    rows: list[dict[str, Any]]
    metadata: dict[str, Any]


def _number(value: Any) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("boolean is not a numeric fixture value")
    cleaned = str(value).strip().replace(",", "")
    if cleaned in ("", "-"):
        return None
    parsed = float(cleaned)
    return int(parsed) if parsed.is_integer() else parsed


def _date_value(value: Any, *, epoch: datetime) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)):
        converted = from_excel(value, epoch=epoch)
        return converted.date() if isinstance(converted, datetime) else converted
    return datetime.fromisoformat(str(value).strip()).date()


def _timestamp_value(value: Any, *, epoch: datetime) -> str:
    observed = _date_value(value, epoch=epoch)
    return datetime.combine(observed, time.min, tzinfo=BANGKOK).isoformat()


def _sheet_rows(workbook: Any, sheet_name: str) -> list[dict[str, Any]]:
    worksheet = workbook[sheet_name]
    iterator = worksheet.iter_rows(values_only=True)
    headers = [str(value).strip() for value in next(iterator)]
    return [
        dict(zip(headers, values, strict=True))
        for values in iterator
        if any(value is not None and str(value).strip() for value in values)
    ]


def _validate_material_id(value: Any) -> str:
    material_id = str(value or "").strip()
    if len(material_id) != 12 or not material_id.isdigit():
        raise ValueError(f"invalid 12-digit Material_ID: {material_id!r}")
    return material_id


def parse_test_fixture_workbook(path: str | Path) -> list[TestFixturePayload]:
    source_path = Path(path)
    content = source_path.read_bytes()
    checksum = hashlib.sha256(content).hexdigest()
    workbook = load_workbook(source_path, read_only=True, data_only=True)
    try:
        missing = sorted(set(PROMOTED_SHEETS.values()) - set(workbook.sheetnames))
        if missing:
            raise ValueError(f"workbook is missing required sheets: {', '.join(missing)}")

        material_rows = _sheet_rows(workbook, PROMOTED_SHEETS["materials"])
        material_units = {
            _validate_material_id(row["Material_ID"]): str(row.get("Unit") or "").strip() or None
            for row in material_rows
        }
        materials = [
            {
                "row_number": index,
                "material_id": _validate_material_id(row["Material_ID"]),
                "sap_material_id": str(row.get("SAP_Material_ID") or "").strip() or None,
                "material_name": str(row.get("Material_Name") or "").strip() or None,
                "category": str(row.get("Category") or "").strip() or None,
                "unit": str(row.get("Unit") or "").strip() or None,
                "weight_per_unit_kg": _number(row.get("Weight_per_Unit_kg")),
                "lot_size": _number(row.get("Lot_Size")),
                "moq": _number(row.get("MOQ")),
            }
            for index, row in enumerate(material_rows, start=1)
        ]

        packaging_rows = _sheet_rows(workbook, PROMOTED_SHEETS["packaging"])
        packaging = []
        for index, row in enumerate(packaging_rows, start=1):
            material_id = _validate_material_id(row["Material_ID"])
            box_qty = _number(row.get("Pkg_Qty_per_Box"))
            boxes_per_pallet = _number(row.get("Pkg_Boxes_per_Pallet"))
            full_pallet_qty = (
                box_qty * boxes_per_pallet
                if box_qty is not None and boxes_per_pallet is not None
                else None
            )
            packaging.append({
                "row_number": index,
                "material_id": material_id,
                "inner_pack_qty": box_qty,
                "full_pallet_qty": full_pallet_qty,
                "base_uom": material_units.get(material_id),
            })

        stock_rows = _sheet_rows(workbook, PROMOTED_SHEETS["district_stock"])
        district_rows = [
            row for row in stock_rows
            if str(row.get("Location_Type") or "").strip().upper() == "DISTRICT"
        ]
        district_stock = [
            {
                "row_number": index,
                "material_id": _validate_material_id(row["Material_ID"]),
                "district_id": str(row.get("Location_ID") or "").strip(),
                "quantity_on_hand": _number(row.get("Current_Stock_Qty")) or 0,
                "snapshot_at": _timestamp_value(
                    row.get("Last_Updated") or row.get("SAP_Updated_Date"),
                    epoch=workbook.epoch,
                ),
            }
            for index, row in enumerate(district_rows, start=1)
        ]

        usage_rows = _sheet_rows(workbook, PROMOTED_SHEETS["usage"])
        usage = []
        for index, row in enumerate(usage_rows, start=1):
            raw_rates = {
                "cmp_monthly": _number(row.get("Avg_Monthly")) or 0,
                "avg_ly": _number(row.get("Avg_LY")),
                "avg_12m": _number(row.get("Avg_12M")),
                "avg_6m": _number(row.get("Avg_6M")),
                "avg_4m": _number(row.get("Avg_4M")),
            }
            normalized_rates = {
                key: max(value, 0) if value is not None else None
                for key, value in raw_rates.items()
            }
            normalized_row = {
                "row_number": index,
                "material_id": _validate_material_id(row["Material_ID"]),
                "district_id": str(row.get("District_ID") or "").strip(),
                "as_of_date": _date_value(
                    row.get("Last_Import_Date"),
                    epoch=workbook.epoch,
                ).isoformat(),
                **normalized_rates,
                "history": [
                    {
                        "period": f"{int(row['Year']):04d}-{month:02d}",
                        "demand_quantity": _number(row.get(month_name)) or 0,
                    }
                    for month, month_name in enumerate(
                        ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"),
                        start=1,
                    )
                ],
            }
            negative_adjustments = {
                key: value for key, value in raw_rates.items()
                if value is not None and value < 0
            }
            if negative_adjustments:
                normalized_row["negative_adjustments"] = negative_adjustments
            usage.append(normalized_row)
    finally:
        workbook.close()

    common = {
        "source_file": source_path.name,
        "source_file_size_bytes": len(content),
        "data_class": "TEST_FIXTURE",
        "not_actual_sap": True,
        "purpose": "UAT gap-fill only",
        "raw_only_sheets_not_promoted": list(RAW_ONLY_SHEETS),
    }
    return [
        TestFixturePayload(
            source_key,
            checksum,
            rows,
            {
                **common,
                "source_sheet": PROMOTED_SHEETS[source_key],
                "total_rows": len(rows),
            },
        )
        for source_key, rows in (
            ("materials", materials),
            ("packaging", packaging),
            ("district_stock", district_stock),
            ("usage", usage),
        )
    ]


def chunked(rows: list[dict[str, Any]], size: int) -> Iterable[list[dict[str, Any]]]:
    if size < 1 or size > 500:
        raise ValueError("chunk size must be between 1 and 500")
    for offset in range(0, len(rows), size):
        yield rows[offset:offset + size]


def import_test_fixture(
    sources: Iterable[TestFixturePayload], *, supabase_url: str,
    publishable_key: str, access_token: str, chunk_size: int = 200,
) -> list[dict[str, Any]]:
    endpoint = supabase_url.rstrip("/") + "/rest/v1/rpc/m16_import_test_fixture"
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
                    f"TEST_FIXTURE import failed for {source.source_key} "
                    f"chunk {chunk_number}: HTTP {exc.code}: {detail}"
                ) from exc
    return results
