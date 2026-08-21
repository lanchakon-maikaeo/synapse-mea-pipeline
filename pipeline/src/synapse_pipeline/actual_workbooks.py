from __future__ import annotations

import calendar
import hashlib
import json
from collections import Counter
from dataclasses import dataclass, replace
from datetime import date, datetime, time
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from openpyxl import load_workbook

from .legacy_actual import PLANT_TO_DISTRICT, chunked
from .relational_sources import RelationalSource, parse_actual_contract_source


STOCK_WORKBOOK = "Stock.xlsx"
USAGE_WORKBOOK = "อัตราการใช้งาน.xlsx"
WAREHOUSE_WORKBOOK = "คลังคลองเตย.xlsx"
CONTRACT_WORKBOOK = "รวมสัญญา.xlsx"
PRODUCTION_PACKAGE_GLOB = "MEA_Synapse_Supabase_Production_*"
PRODUCTION_PACKAGE_ENVIRONMENT = "PRODUCTION_APPROVED"
OWNER_ATTESTED_ZERO_POLICY = "exhaustive_source_omission_means_zero"

DISTRICT_NAMES_BY_PLANT = {
    "5501": "เขตนวลจันทร์",
    "5601": "เขตสามเสน",
    "5701": "เขตนนทบุรี",
    "5801": "เขตธนบุรี",
    "5901": "เขตบางใหญ่",
    "6001": "เขตลาดกระบัง",
    "6501": "เขตบางนา",
    "6601": "เขตวัดเลียบ",
    "6701": "เขตคลองเตย",
    "6801": "เขตราษฎร์บูรณะ",
    "6901": "เขตยานนาวา",
    "7001": "เขตบางขุนเทียน",
    "7501": "เขตบางบัวทอง",
    "7601": "เขตบางกะปิ",
    "7701": "เขตสมุทรปราการ",
    "7801": "เขตบางพลี",
    "7901": "เขตมีนบุรี",
    "8001": "เขตบางเขน",
}

DISTRICT_ID_BY_NAME = {
    name.removeprefix("เขต"): PLANT_TO_DISTRICT[plant]
    for plant, name in DISTRICT_NAMES_BY_PLANT.items()
}
DISTRICT_ID_BY_NAME.update({
    name: PLANT_TO_DISTRICT[plant]
    for plant, name in DISTRICT_NAMES_BY_PLANT.items()
})


def _json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    return value


def _clean_identifier(value: Any, width: int | None = None) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    cleaned = str(value).strip()
    if not cleaned:
        return None
    if cleaned.endswith(".0") and cleaned[:-2].isdigit():
        cleaned = cleaned[:-2]
    if width is not None and cleaned.isdigit() and len(cleaned) <= width:
        cleaned = cleaned.zfill(width)
    return cleaned


def _number(value: Any, *, dash_is_zero: bool = False) -> int | float | None:
    if value is None:
        return None
    cleaned = str(value).strip().replace(",", "")
    if not cleaned:
        return None
    if cleaned == "-":
        return 0 if dash_is_zero else None
    try:
        parsed = float(cleaned)
    except ValueError:
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _excel_round(value: int | float) -> int:
    return int(
        Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    )


def _ensure_dimensions(worksheet: Any) -> None:
    """Recover dimensions for workbooks whose cached sheet bounds are absent."""
    if worksheet.max_row is None or worksheet.max_column is None:
        worksheet.calculate_dimension(force=True)


def _pad_row(values: tuple[Any, ...], minimum_length: int) -> tuple[Any, ...]:
    if len(values) >= minimum_length:
        return values
    return values + (None,) * (minimum_length - len(values))


def _file_checksum(path: Path) -> tuple[bytes, str]:
    content = path.read_bytes()
    return content, hashlib.sha256(content).hexdigest()


def _source(
    *,
    path: Path,
    source_sheet: str,
    checksum: str,
    size_bytes: int,
    rows: list[dict[str, Any]],
    metadata: dict[str, Any],
) -> RelationalSource:
    return RelationalSource(
        source_path=path.name,
        source_sheet=source_sheet,
        checksum=checksum,
        size_bytes=size_bytes,
        data_class="actual",
        rows=rows,
        metadata={
            "workbook": path.name,
            "source_sheet": source_sheet,
            "total_rows": len(rows),
            "data_class": "actual",
            **metadata,
        },
    )


def parse_actual_stock_workbook(path: str | Path) -> RelationalSource:
    source_path = Path(path)
    content, checksum = _file_checksum(source_path)
    workbook = load_workbook(source_path, read_only=True, data_only=True)
    try:
        worksheet = workbook["update-stock"]
        _ensure_dimensions(worksheet)
        snapshot_value = worksheet.cell(1, 11).value
        if not isinstance(snapshot_value, (date, datetime)):
            raise ValueError("Stock.xlsx!update-stock K1 must contain the snapshot date")
        snapshot_at = _json_value(snapshot_value)

        rows: list[dict[str, Any]] = []
        natural_keys: Counter[tuple[str | None, str | None, str | None]] = Counter()
        padded_materials = 0
        missing_storage = 0
        nonzero_transfer = 0
        for row_number, values in enumerate(
            worksheet.iter_rows(min_row=2, values_only=True),
            start=2,
        ):
            values = _pad_row(values, 11)
            if values[2] is None:
                continue
            plant = _clean_identifier(values[0], 4)
            storage = _clean_identifier(values[1], 4)
            raw_material = _clean_identifier(values[2])
            material = _clean_identifier(values[2], 12)
            if raw_material is None or material is None:
                continue
            if raw_material != material:
                padded_materials += 1
            if storage is None:
                missing_storage += 1
            transfer_quantity = _number(values[7]) or 0
            if transfer_quantity != 0:
                nonzero_transfer += 1

            district_id = PLANT_TO_DISTRICT.get(plant or "")
            warehouse_id = (
                "WH-KT"
                if plant == "2401" and storage in {"0001", "1"}
                else None
            )
            natural_key = (plant, storage, material)
            natural_keys[natural_key] += 1
            payload = {
                "sap_plant_code": plant,
                "storage_location_code": storage,
                "material_id": material,
                "source_material_code": raw_material,
                "material_name": _json_value(values[3]),
                "unrestricted_qty": _number(values[4]) or 0,
                "base_unit": _json_value(values[5]),
                "unrestricted_value": _number(values[6]),
                "stock_in_transfer_qty": transfer_quantity,
                "snapshot_at": snapshot_at,
            }
            rows.append({
                "row_number": row_number,
                "natural_key": "|".join(
                    part or "<missing>" for part in natural_key
                ),
                "payload": payload,
                "material_id": material,
                "district_id": district_id,
                "warehouse_id": warehouse_id,
            })
    finally:
        workbook.close()

    return _source(
        path=source_path,
        source_sheet="update-stock",
        checksum=checksum,
        size_bytes=len(content),
        rows=rows,
        metadata={
            "source_kind": "SAP stock export",
            "snapshot_at": snapshot_at,
            "quantity_rule": "Unrestricted only; Stock in Transfer retained as evidence but excluded from Core stock.",
            "duplicate_natural_keys": sum(
                count - 1 for count in natural_keys.values() if count > 1
            ),
            "missing_storage_rows": missing_storage,
            "material_codes_padded_to_12_digits": padded_materials,
            "nonzero_stock_in_transfer_rows": nonzero_transfer,
            "operational_promotion": True,
        },
    )


def _month_period(label: Any) -> str | None:
    cleaned = str(label).strip()
    if len(cleaned) != 6 or not cleaned.isdigit():
        return None
    month = int(cleaned[:2])
    year = int(cleaned[2:])
    if month not in range(1, 13):
        return None
    return f"{year:04d}-{month:02d}"


def parse_actual_usage_workbook(path: str | Path) -> RelationalSource:
    source_path = Path(path)
    content, checksum = _file_checksum(source_path)
    workbook = load_workbook(source_path, read_only=True, data_only=True)
    try:
        worksheet = workbook["Check CMP"]
        _ensure_dimensions(worksheet)
        headers = [cell.value for cell in worksheet[1]]
        month_columns = [
            (index, period)
            for index, label in enumerate(headers)
            if (period := _month_period(label)) is not None
        ]
        if len(month_columns) != 12:
            raise ValueError(
                "อัตราการใช้งาน.xlsx!Check CMP must contain 12 MMYYYY columns"
            )
        latest_period = max(period for _, period in month_columns)
        latest_year, latest_month = map(int, latest_period.split("-"))
        as_of_date = date(
            latest_year,
            latest_month,
            calendar.monthrange(latest_year, latest_month)[1],
        ).isoformat()

        rows: list[dict[str, Any]] = []
        dash_cells = 0
        negative_month_cells = 0
        negative_cmp_rows = 0
        negative_calculated_cmp_rows = 0
        source_cmp_rule_mismatches = 0
        negative_summary_fields: Counter[str] = Counter()
        unmapped_plant_rows = 0
        for row_number, values in enumerate(
            worksheet.iter_rows(min_row=2, values_only=True),
            start=2,
        ):
            values = _pad_row(values, len(headers))
            material = _clean_identifier(values[0], 12)
            plant = _clean_identifier(values[1], 4)
            if material is None or plant is None:
                continue
            district_id = PLANT_TO_DISTRICT.get(plant)
            if district_id is None:
                unmapped_plant_rows += 1

            history: list[dict[str, Any]] = []
            for index, period in month_columns:
                raw_value = values[index]
                source_was_dash = str(raw_value).strip() == "-"
                raw_quantity = _number(raw_value, dash_is_zero=True)
                negative_adjustment = (
                    raw_quantity is not None and raw_quantity < 0
                )
                if source_was_dash:
                    dash_cells += 1
                if negative_adjustment:
                    negative_month_cells += 1
                history.append({
                    "period": period,
                    "raw_value": _json_value(raw_value),
                    "demand_quantity": max(raw_quantity or 0, 0),
                    "source_was_dash": source_was_dash,
                    "negative_adjustment": negative_adjustment,
                })

            source_cmp = _number(values[3], dash_is_zero=True) or 0
            if source_cmp < 0:
                negative_cmp_rows += 1
            raw_summaries = {
                "avg_ly_raw": _number(values[4], dash_is_zero=True) or 0,
                "avg_12m_raw": _number(values[5], dash_is_zero=True) or 0,
                "avg_6m_raw": _number(values[6], dash_is_zero=True) or 0,
                "avg_4m_raw": _number(values[7], dash_is_zero=True) or 0,
            }
            for field_name, field_value in raw_summaries.items():
                if field_value < 0:
                    negative_summary_fields[field_name] += 1
            calculated_cmp_raw = _excel_round(
                sum(raw_summaries.values()) / len(raw_summaries)
            )
            normalized_summaries = {
                field_name.removesuffix("_raw"): max(field_value, 0)
                for field_name, field_value in raw_summaries.items()
            }
            calculated_cmp = _excel_round(
                sum(normalized_summaries.values())
                / len(normalized_summaries)
            )
            if calculated_cmp_raw < 0:
                negative_calculated_cmp_rows += 1
            if source_cmp != calculated_cmp_raw:
                source_cmp_rule_mismatches += 1
            payload = {
                "material_id": material,
                "sap_plant_code": plant,
                "district_id": district_id,
                "cmp_monthly_raw": source_cmp,
                "source_cmp": source_cmp,
                "calculated_cmp_raw": calculated_cmp_raw,
                "cmp_monthly": max(calculated_cmp, 0),
                **raw_summaries,
                **normalized_summaries,
                "source_total_2025": _number(values[10], dash_is_zero=True),
                "history": history,
                "as_of_date": as_of_date,
            }
            rows.append({
                "row_number": row_number,
                "natural_key": f"{material}|{plant}",
                "payload": payload,
                "material_id": material,
                "district_id": district_id,
            })
    finally:
        workbook.close()

    return _source(
        path=source_path,
        source_sheet="Check CMP",
        checksum=checksum,
        size_bytes=len(content),
        rows=rows,
        metadata={
            "source_kind": "SAP monthly usage/CMP export",
            "as_of_date": as_of_date,
            "monthly_periods": [period for _, period in month_columns],
            "dash_cells_normalized_to_zero": dash_cells,
            "negative_month_cells_preserved_in_raw": negative_month_cells,
            "negative_cmp_rows_normalized_to_zero": negative_cmp_rows,
            "negative_calculated_cmp_rows_normalized_to_zero":
                negative_calculated_cmp_rows,
            "negative_summary_fields_preserved_in_raw":
                dict(negative_summary_fields),
            "source_cmp_vs_rule_mismatches": source_cmp_rule_mismatches,
            "cmp_rule": (
                "ROUND(AVERAGE(non-negative LY, 12M, 6M, 4M), 0); "
                "signed source summaries remain in Raw"
            ),
            "unmapped_plant_rows": unmapped_plant_rows,
            "operational_promotion": True,
        },
    )


def _material_master_source(
    path: Path,
    checksum: str,
    size_bytes: int,
    workbook: Any,
) -> RelationalSource:
    worksheet = workbook["MASTER"]
    _ensure_dimensions(worksheet)
    rows: list[dict[str, Any]] = []
    material_counts: Counter[str] = Counter()
    for row_number, values in enumerate(
        worksheet.iter_rows(min_row=2, values_only=True),
        start=2,
    ):
        values = _pad_row(values, 12)
        material = _clean_identifier(values[0], 12)
        if material is None:
            continue
        material_counts[material] += 1
        payload = {
            "Material_ID": material,
            "SAP_Material_ID": material,
            "Material_Name": _json_value(values[1]),
            "Unit": _json_value(values[2]),
            "Category": _json_value(values[5] or values[3]),
            "legacy_group": _json_value(values[3]),
            "mp_ma": _json_value(values[4]),
            "active_use": _json_value(values[6]),
            "use_case": _json_value(values[7]),
            "owner": _json_value(values[8]),
            "trend_group": _json_value(values[9]),
            "reference_price_owner": _json_value(values[10]),
            "group_65": _json_value(values[11]),
        }
        rows.append({
            "row_number": row_number,
            "natural_key": material,
            "payload": payload,
            "material_id": material,
        })
    return _source(
        path=path,
        source_sheet="MASTER",
        checksum=checksum,
        size_bytes=size_bytes,
        rows=rows,
        metadata={
            "source_kind": "warehouse material master",
            "duplicate_material_rows": sum(
                count - 1 for count in material_counts.values() if count > 1
            ),
            "operational_promotion": True,
        },
    )


def _district_source(
    path: Path,
    checksum: str,
    size_bytes: int,
    workbook: Any,
) -> RelationalSource:
    worksheet = workbook["M_Districts"]
    _ensure_dimensions(worksheet)
    rows: list[dict[str, Any]] = []
    for row_number, values in enumerate(
        worksheet.iter_rows(min_row=2, values_only=True),
        start=2,
    ):
        values = _pad_row(values, 2)
        plant = _clean_identifier(values[0], 4)
        if plant is None:
            continue
        district_id = PLANT_TO_DISTRICT.get(plant)
        rows.append({
            "row_number": row_number,
            "natural_key": plant,
            "payload": {
                "sap_plant_code": plant,
                "district_id": district_id,
                "district_name_th": _json_value(values[1]),
            },
            "district_id": district_id,
        })
    return _source(
        path=path,
        source_sheet="M_Districts",
        checksum=checksum,
        size_bytes=size_bytes,
        rows=rows,
        metadata={
            "source_kind": "district mapping",
            "operational_promotion": True,
        },
    )


def _vmi_matrix_source(
    path: Path,
    checksum: str,
    size_bytes: int,
    workbook: Any,
) -> RelationalSource:
    worksheet = workbook["VMI คลองเตย"]
    _ensure_dimensions(worksheet)
    source_date = _json_value(worksheet.cell(1, 1).value)
    district_groups: list[tuple[int, str, str]] = []
    for column in range(4, worksheet.max_column + 1, 7):
        plant = _clean_identifier(worksheet.cell(1, column).value, 4)
        if plant is None:
            continue
        district_id = PLANT_TO_DISTRICT.get(plant)
        if district_id is None:
            continue
        district_groups.append((column - 1, plant, district_id))
    if len(district_groups) != 18:
        raise ValueError("คลังคลองเตย.xlsx!VMI คลองเตย must contain 18 district groups")

    rows: list[dict[str, Any]] = []
    for row_number, values in enumerate(
        worksheet.iter_rows(min_row=3, values_only=True),
        start=3,
    ):
        values = _pad_row(values, worksheet.max_column)
        material = _clean_identifier(values[0], 12)
        if material is None:
            continue
        district_values = []
        for start, plant, district_id in district_groups:
            district_values.append({
                "sap_plant_code": plant,
                "district_id": district_id,
                "district_name_th": DISTRICT_NAMES_BY_PLANT[plant],
                "stock_qty": _number(values[start]) or 0,
                "cmp_monthly": _number(values[start + 1], dash_is_zero=True) or 0,
                "max_target_qty": _number(values[start + 2]),
                "max_fill_qty": _number(values[start + 3]),
                "reference_3m_qty": _number(values[start + 4]),
                "min_fill_qty": _number(values[start + 5]),
                "months_available": _number(values[start + 6]),
            })
        rows.append({
            "row_number": row_number,
            "natural_key": material,
            "payload": {
                "Material_ID": material,
                "Material_Name": _json_value(values[1]),
                "Unit": None,
                "material_id": material,
                "material_name": _json_value(values[1]),
                "warehouse_stock_qty": _number(values[2]) or 0,
                "source_date": source_date,
                "district_values": district_values,
            },
            "material_id": material,
            "warehouse_id": "WH-KT",
        })
    return _source(
        path=path,
        source_sheet="VMI คลองเตย",
        checksum=checksum,
        size_bytes=size_bytes,
        rows=rows,
        metadata={
            "source_kind": "VMI material scope and derived district matrix",
            "source_date": source_date,
            "district_groups": len(district_groups),
            "derived_values_are_not_source_observations": True,
            "operational_promotion": True,
        },
    )


def _dispatch_history_source(
    path: Path,
    checksum: str,
    size_bytes: int,
    workbook: Any,
    sheet_name: str,
) -> RelationalSource:
    worksheet = workbook[sheet_name]
    _ensure_dimensions(worksheet)
    rows: list[dict[str, Any]] = []
    for row_number, values in enumerate(
        worksheet.iter_rows(min_row=2, values_only=True),
        start=2,
    ):
        values = _pad_row(values, 16)
        material = _clean_identifier(values[3], 12)
        if material is None:
            continue
        district_name = str(values[1]).strip() if values[1] is not None else ""
        district_id = DISTRICT_ID_BY_NAME.get(district_name)
        natural_parts = (
            _json_value(values[0]),
            district_name,
            _json_value(values[2]),
            material,
            _json_value(values[8]),
        )
        rows.append({
            "row_number": row_number,
            "natural_key": "|".join(str(value or "") for value in natural_parts),
            "payload": {
                "recorded_at": _json_value(values[0]),
                "district_name": district_name or None,
                "district_id": district_id,
                "sequence_no": _json_value(values[2]),
                "material_id": material,
                "material_name": _json_value(values[4]),
                "planned_qty": _number(values[5]),
                "unit": _json_value(values[6]),
                "lot_size_text": _json_value(values[7]),
                "planned_delivery_date": _json_value(values[8]),
                "delivery_status": _json_value(values[9]),
                "actual_delivery_date": _json_value(values[10]),
                "actual_qty": _number(values[11]),
                "actual_unit": _json_value(values[12]),
                "replenishment_type": _json_value(values[13]),
                "note": _json_value(values[14]),
                "confirmed_by": _json_value(values[15]),
            },
            "material_id": material,
            "district_id": district_id,
        })
    return _source(
        path=path,
        source_sheet=sheet_name,
        checksum=checksum,
        size_bytes=size_bytes,
        rows=rows,
        metadata={
            "source_kind": "historical VMI dispatch decision",
            "contains_personal_data": True,
            "operational_promotion": False,
        },
    )


def _route_source(
    path: Path,
    checksum: str,
    size_bytes: int,
    workbook: Any,
) -> RelationalSource:
    worksheet = workbook["Route Library"]
    _ensure_dimensions(worksheet)
    rows: list[dict[str, Any]] = []
    for row_number, values in enumerate(
        worksheet.iter_rows(min_row=4, values_only=True),
        start=4,
    ):
        values = _pad_row(values, 15)
        route_ref = _clean_identifier(values[0])
        if route_ref is None:
            continue
        route_text = str(values[2] or "")
        district_ids = sorted({
            district_id
            for district_name, district_id in DISTRICT_ID_BY_NAME.items()
            if district_name in route_text
        })
        payload = {
            "route_code": route_ref,
            "zone": _json_value(values[1]),
            "route_text": route_text,
            "district_ids": district_ids,
            "district_count": _json_value(values[3]),
            "outbound_distance_time": _json_value(values[4]),
            "between_distance_time": _json_value(values[5]),
            "return_distance_time": _json_value(values[6]),
            "total_distance_km": _number(values[7]),
            "total_travel_minutes": _number(values[8]),
            "travel_buffer_minutes": _number(values[9]),
            "service_time_range": _json_value(values[10]),
            "total_time_range": _json_value(values[11]),
            "standard_return_time": _json_value(values[12]),
            "passes_cutoff": _json_value(values[13]),
            "data_quality": _json_value(values[14]),
        }
        rows.append({
            "row_number": row_number,
            "natural_key": route_ref,
            "payload": payload,
            "route_ref": route_ref,
        })
    return _source(
        path=path,
        source_sheet="Route Library",
        checksum=checksum,
        size_bytes=size_bytes,
        rows=rows,
        metadata={
            "source_kind": "route planning reference",
            "operational_promotion": False,
            "release_scope": "reference_only",
        },
    )


def parse_khlong_toei_workbook(path: str | Path) -> list[RelationalSource]:
    source_path = Path(path)
    content, checksum = _file_checksum(source_path)
    workbook = load_workbook(source_path, read_only=True, data_only=True)
    try:
        sheet_inventory = [
            {
                "sheet": worksheet.title,
                "max_row": worksheet.max_row,
                "max_column": worksheet.max_column,
            }
            for worksheet in workbook.worksheets
        ]
        sources = [
            _source(
                path=source_path,
                source_sheet="__workbook__",
                checksum=checksum,
                size_bytes=len(content),
                rows=[],
                metadata={
                    "source_kind": "workbook inventory",
                    "sheet_inventory": sheet_inventory,
                    "operational_promotion": False,
                },
            ),
        ]
        optional_sources = (
            ("MASTER", _material_master_source),
            ("M_Districts", _district_source),
            ("VMI คลองเตย", _vmi_matrix_source),
            (
                "History จ่ายได้ตามแผน",
                lambda *args: _dispatch_history_source(
                    *args, "History จ่ายได้ตามแผน"
                ),
            ),
            (
                "History ไม่รับของ",
                lambda *args: _dispatch_history_source(
                    *args, "History ไม่รับของ"
                ),
            ),
            ("Route Library", _route_source),
        )
        for sheet_name, parser in optional_sources:
            if sheet_name in workbook.sheetnames:
                sources.append(
                    parser(source_path, checksum, len(content), workbook)
                )

        history_sheets = {
            "History จ่ายได้ตามแผน",
            "History ไม่รับของ",
        }
        missing_history = history_sheets.difference(workbook.sheetnames)
        if missing_history:
            raise ValueError(
                "Historical Distribution Data must contain both sheets: "
                + ", ".join(sorted(history_sheets))
            )
    finally:
        workbook.close()
    return sources


def _verify_package_source_files(
    source_package: Path,
    manifest: dict[str, Any],
    required: dict[str, Path],
) -> None:
    manifest_files = {
        entry.get("path"): entry
        for entry in manifest.get("files", [])
        if isinstance(entry, dict) and entry.get("path")
    }
    for logical_name, source_path in required.items():
        relative_path = source_path.relative_to(source_package).as_posix()
        entry = manifest_files.get(relative_path)
        if entry is None:
            raise ValueError(
                f"{logical_name} is not declared in "
                f"{source_package.name}/PACKAGE_MANIFEST.json"
            )
        content, checksum = _file_checksum(source_path)
        if checksum != entry.get("sha256") or len(content) != entry.get("bytes"):
            raise ValueError(
                f"Checksum or size mismatch for {relative_path}; "
                "the Production package may have changed after generation"
            )


def parse_actual_data_directory(path: str | Path) -> list[RelationalSource]:
    data_dir = Path(path)
    source_package = next(
        (
            package
            for package in sorted(
                data_dir.glob(PRODUCTION_PACKAGE_GLOB),
                reverse=True,
            )
            if package.is_dir()
            and (package / "PACKAGE_MANIFEST.json").is_file()
            and (package / "source_files").is_dir()
        ),
        None,
    )
    package_metadata: dict[str, Any] = {}
    if source_package is not None:
        manifest_path = source_package / "PACKAGE_MANIFEST.json"
        manifest_content = manifest_path.read_bytes()
        manifest = json.loads(manifest_content.decode("utf-8"))
        source_files = source_package / "source_files"
        warehouse_candidates = sorted(
            source_files.glob("คลังคลองเตย*.xlsx")
        )
        if len(warehouse_candidates) != 1:
            raise ValueError(
                f"{source_package.name} must contain exactly one "
                "คลังคลองเตย*.xlsx source workbook"
            )
        required = {
            STOCK_WORKBOOK: source_files / STOCK_WORKBOOK,
            USAGE_WORKBOOK: source_files / USAGE_WORKBOOK,
            WAREHOUSE_WORKBOOK: warehouse_candidates[0],
            CONTRACT_WORKBOOK: source_files / CONTRACT_WORKBOOK,
        }
        package_metadata = {
            "source_package": source_package.name,
            "source_package_environment": manifest.get("environment"),
            "source_package_generated_at": manifest.get("generated_at"),
            "source_package_manifest_checksum": hashlib.sha256(
                manifest_content
            ).hexdigest(),
            "source_package_production_use_prohibited": bool(
                manifest.get("production_use_prohibited")
            ),
            "source_package_owner_attested_complete": bool(
                manifest.get("owner_attested_complete")
            ),
            "source_package_zero_completion_policy": manifest.get(
                "zero_completion_policy"
            ),
            "source_package_target_project_ref": manifest.get(
                "target_project_ref"
            ),
        }
    else:
        required = {
            STOCK_WORKBOOK: data_dir / STOCK_WORKBOOK,
            USAGE_WORKBOOK: data_dir / USAGE_WORKBOOK,
            WAREHOUSE_WORKBOOK: data_dir / WAREHOUSE_WORKBOOK,
            CONTRACT_WORKBOOK: data_dir / CONTRACT_WORKBOOK,
        }
    missing = [name for name, source_path in required.items() if not source_path.is_file()]
    if missing:
        raise FileNotFoundError(
            "Missing required Actual workbook(s): " + ", ".join(sorted(missing))
        )
    if source_package is not None:
        _verify_package_source_files(source_package, manifest, required)
    parsed = [
        parse_actual_contract_source(required[CONTRACT_WORKBOOK]),
        parse_actual_stock_workbook(required[STOCK_WORKBOOK]),
        parse_actual_usage_workbook(required[USAGE_WORKBOOK]),
        *parse_khlong_toei_workbook(required[WAREHOUSE_WORKBOOK]),
    ]
    physical_paths = {
        source_path.name: source_path
        for source_path in required.values()
    }
    canonicalized: list[RelationalSource] = []
    for source in parsed:
        physical_path = physical_paths[source.source_path]
        logical_path = (
            WAREHOUSE_WORKBOOK
            if physical_path == required[WAREHOUSE_WORKBOOK]
            else source.source_path
        )
        canonicalized.append(replace(
            source,
            source_path=logical_path,
            metadata={
                **source.metadata,
                **package_metadata,
                "physical_source_path": str(physical_path),
            },
        ))
    return canonicalized


def _rpc(
    *,
    supabase_url: str,
    service_role_key: str,
    function_name: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    endpoint = (
        supabase_url.rstrip("/")
        + "/rest/v1/rpc/"
        + function_name
    )
    headers = {
        "apikey": service_role_key,
        "Content-Type": "application/json",
    }
    if not service_role_key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {service_role_key}"
    request = Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urlopen(request, timeout=180) as response:
            payload = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(
            f"Supabase RPC {function_name} failed: HTTP {exc.code}: {detail}"
        ) from exc
    return json.loads(payload) if payload else {}


@dataclass(frozen=True)
class ActualWorkbookImportResult:
    artifacts: list[dict[str, Any]]
    promotion: dict[str, Any]
    production_completion: dict[str, Any]


def import_actual_data_directory(
    sources: Iterable[RelationalSource],
    *,
    supabase_url: str,
    service_role_key: str,
    attested_by: str,
    attestation_text: str,
    change_ticket: str,
    chunk_size: int = 200,
    confirm_production_attestation: bool = False,
) -> ActualWorkbookImportResult:
    source_list = list(sources)
    by_workbook = {
        source.source_path: source.checksum
        for source in source_list
    }
    required_workbooks = {
        STOCK_WORKBOOK,
        USAGE_WORKBOOK,
        WAREHOUSE_WORKBOOK,
        CONTRACT_WORKBOOK,
    }
    if set(by_workbook) != required_workbooks:
        raise ValueError("Actual source set is incomplete or contains an unknown workbook")

    package_environments = {
        source.metadata.get("source_package_environment")
        for source in source_list
        if source.metadata.get("source_package_environment")
    }
    package_production_prohibited = any(
        source.metadata.get("source_package_production_use_prohibited") is True
        for source in source_list
    )
    package_owner_attested_complete = all(
        source.metadata.get("source_package_owner_attested_complete") is True
        for source in source_list
    )
    package_zero_policies = {
        source.metadata.get("source_package_zero_completion_policy")
        for source in source_list
    }
    if len(package_environments) > 1:
        raise ValueError("Actual sources contain conflicting package environments")
    package_environment = next(iter(package_environments), None)
    if package_production_prohibited:
        raise ValueError(
            "The selected source package prohibits Production use"
        )
    if (
        package_environment != PRODUCTION_PACKAGE_ENVIRONMENT
        or not package_owner_attested_complete
        or package_zero_policies != {OWNER_ATTESTED_ZERO_POLICY}
    ):
        raise ValueError(
            "The selected source package is not a governed Production package"
        )
    if not confirm_production_attestation:
        raise ValueError(
            "Explicit Production attestation confirmation is required"
        )

    _rpc(
        supabase_url=supabase_url,
        service_role_key=service_role_key,
        function_name="m21_assert_actual_import_environment",
        body={
            "p_source_package_environment": package_environment,
            "p_production_use_prohibited": package_production_prohibited,
        },
    )

    artifact_results: list[dict[str, Any]] = []
    for source in source_list:
        chunks = list(chunked(source.rows, chunk_size)) or [[]]
        for rows in chunks:
            metadata = {
                **source.metadata,
                "total_rows": len(source.rows),
            }
            if (
                source.source_path == CONTRACT_WORKBOOK
                and source.source_sheet == "รวมสัญญา"
            ):
                if not rows:
                    continue
                result = _rpc(
                    supabase_url=supabase_url,
                    service_role_key=service_role_key,
                    function_name="m18_import_contract_chunk",
                    body={
                        "p_source_checksum": source.checksum,
                        "p_source_file_size_bytes": source.size_bytes,
                        "p_rows": rows,
                        "p_metadata": metadata,
                    },
                )
            else:
                result = _rpc(
                    supabase_url=supabase_url,
                    service_role_key=service_role_key,
                    function_name="m18_import_source_rows",
                    body={
                        "p_source_path": source.source_path,
                        "p_source_sheet": source.source_sheet or "",
                        "p_source_checksum": source.checksum,
                        "p_source_file_size_bytes": source.size_bytes,
                        "p_data_class": "actual",
                        "p_rows": rows,
                        "p_metadata": metadata,
                    },
                )
            artifact_results.append(result)

    promotion = _rpc(
        supabase_url=supabase_url,
        service_role_key=service_role_key,
        function_name="m21_promote_actual_workbooks",
        body={
            "p_contract_checksum": by_workbook[CONTRACT_WORKBOOK],
            "p_stock_checksum": by_workbook[STOCK_WORKBOOK],
            "p_usage_checksum": by_workbook[USAGE_WORKBOOK],
            "p_warehouse_checksum": by_workbook[WAREHOUSE_WORKBOOK],
            "p_attested_by": attested_by,
            "p_attestation_text": attestation_text,
            "p_change_ticket": change_ticket,
        },
    )
    if promotion.get("status") != "succeeded":
        import_id = promotion.get("actual_workbook_import_id", "unknown")
        error_message = promotion.get(
            "error_message",
            "database promotion did not report success",
        )
        raise RuntimeError(
            f"Actual workbook import {import_id} failed: {error_message}"
        )
    completion = _rpc(
        supabase_url=supabase_url,
        service_role_key=service_role_key,
        function_name="m22_attest_production_completion",
        body={
            "p_actual_workbook_import_id": promotion[
                "actual_workbook_import_id"
            ],
            "p_attested_by": attested_by,
            "p_attestation_text": attestation_text,
            "p_change_ticket": change_ticket,
            "p_zero_completion_policy": OWNER_ATTESTED_ZERO_POLICY,
        },
    )
    if completion.get("status") != "succeeded":
        error_message = completion.get(
            "error_message",
            "database Production attestation did not report success",
        )
        raise RuntimeError(
            "Production completion attestation failed: "
            f"{error_message}"
        )
    return ActualWorkbookImportResult(
        artifact_results,
        promotion,
        completion,
    )
