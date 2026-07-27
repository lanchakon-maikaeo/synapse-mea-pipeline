from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime, time
from pathlib import Path
from typing import Any

from openpyxl import load_workbook


DUMMY_WORKBOOK_NAME = "MEA_VMI_Dummy_Klongtoey.xlsx"
CONTRACT_WORKBOOK_NAME = "รวมสัญญา.xlsx"
PROJECT_SHEET_NAMES = (
    "DB_Material",
    "DB_Contract_Static",
    "DB_Contract_SAP",
    "DB_SAP_Monthly",
)

PROJECT_SHEET_REQUIRED_HEADERS = {
    "DB_Material": {"Material_ID", "Material_Name", "Unit"},
    "DB_Contract_Static": {
        "Contract_ID",
        "Material_ID",
        "Pkg_Qty_per_Box",
        "Pkg_Box_Width_m",
        "Pkg_Box_Length_m",
        "Pkg_Box_Height_m",
        "Pkg_Weight_per_Box_kg",
        "Pkg_Boxes_per_Pallet",
        "Pkg_Pallet_Width_m",
        "Pkg_Pallet_Length_m",
        "Pkg_Pallet_Height_m",
        "Pkg_Pallet_Weight_kg",
    },
    "DB_Contract_SAP": {
        "Contract_ID",
        "Material_ID",
        "SAP_Updated_Date",
    },
    "DB_SAP_Monthly": {
        "SAP_ID",
        "Material_ID",
        "District_ID",
        "Avg_Monthly",
        "Last_Import_Date",
    },
}

TYPED_KEYS = {
    "material_id": ("Material_ID", "วัสดุ"),
    "district_id": ("District_ID",),
    "warehouse_id": ("Warehouse_ID", "Origin_Warehouse", "Warehouse_Origin"),
    "contract_ref": ("Contract_ID", "สัญญา", "ใบสั่ง"),
    "plan_ref": ("Plan_ID",),
    "batch_ref": ("Batch_ID",),
    "vehicle_ref": ("Vehicle_ID",),
    "route_ref": ("Route_ID",),
    "trip_ref": ("Trip_ID",),
}

NATURAL_KEY_FIELDS = {
    "DB_Warehouse": ("Warehouse_ID",),
    "DB_Material": ("Material_ID",),
    "DB_Contract_Static": ("Contract_ID", "Material_ID"),
    "DB_Contract_SAP": ("Contract_ID", "Material_ID"),
    "DB_Route": ("Route_ID",),
    "Master_Vehicle": ("Vehicle_ID",),
    "DB_Stock": ("Stock_ID",),
    "DB_SAP_Monthly": ("SAP_ID",),
    "DB_PernalUse": ("Dispatch_ID",),
    "Trans_Replenishment_Plan": ("Plan_ID",),
    "Trans_Transport_Logs": ("Trip_ID",),
    "Data_Quality_Log": ("Rule", "Source"),
}

CONTRACT_HEADERS = {
    "วัสดุ": "material_code",
    "รายการ": "item_description",
    "หน่วยนับ": "unit",
    "รหัสจัดหา": "procurement_code",
    "ใบสั่ง": "purchase_order",
    "สัญญา": "contract_number",
    "รายการที่": "line_item",
    "ผู้ขาย": "vendor",
    "วันเริ่มต้น": "start_date",
    "จำนวน": "quantity",
    "วันที่บันทึก": "record_date",
    "วันเปิดซอง": "bid_open_date",
    "วันส่งมอบ": "delivery_date",
    "วันผ่านตรวจรับ": "acceptance_date",
    "วันที่เอกสาร": "document_date",
    "วันสิ้นสุด": "end_date",
}


@dataclass(frozen=True)
class RelationalSource:
    source_path: str
    source_sheet: str | None
    checksum: str
    size_bytes: int
    data_class: str
    rows: list[dict[str, Any]]
    metadata: dict[str, Any]


def _json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    return value


def _clean_key(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    cleaned = str(value).strip()
    return cleaned or None


def _clean_material_key(value: Any) -> str | None:
    cleaned = _clean_key(value)
    if cleaned is None:
        return None
    if cleaned.endswith(".0") and cleaned[:-2].isdigit():
        cleaned = cleaned[:-2]
    if cleaned.isdigit() and len(cleaned) <= 12:
        return cleaned.zfill(12)
    return cleaned


def _sheet_dict_rows(worksheet: Any) -> list[tuple[int, dict[str, Any]]]:
    iterator = worksheet.iter_rows(values_only=True)
    raw_headers = next(iterator)
    headers = [
        str(value).strip() if value is not None else f"_column_{index}"
        for index, value in enumerate(raw_headers, start=1)
    ]
    rows: list[tuple[int, dict[str, Any]]] = []
    for row_number, values in enumerate(iterator, start=2):
        if not any(value is not None and str(value).strip() for value in values):
            continue
        if len(values) < len(headers):
            values = values + (None,) * (len(headers) - len(values))
        payload = {
            header: _json_value(value)
            for header, value in zip(headers, values[:len(headers)], strict=True)
            if not header.startswith("_column_") and value is not None
        }
        rows.append((row_number, payload))
    return rows


def _typed_keys(payload: dict[str, Any]) -> dict[str, str | None]:
    keys: dict[str, str | None] = {}
    for key, candidates in TYPED_KEYS.items():
        keys[key] = next(
            (
                cleaned
                for candidate in candidates
                if (cleaned := _clean_key(payload.get(candidate))) is not None
            ),
            None,
        )
    return keys


def parse_project_sheet_sources(
    path: str | Path,
    *,
    source_spreadsheet_id: str,
    source_downloaded_at: str,
) -> list[RelationalSource]:
    """Parse the four operational tabs from the project-shared Google Sheet.

    The downloaded XLSX bytes are the immutable evidence boundary. The logical
    source path and metadata retain the Google Sheet identity while every row
    remains tied to the downloaded file checksum and its original row number.
    """
    if not source_spreadsheet_id or not all(
        character.isalnum() or character in "-_"
        for character in source_spreadsheet_id
    ):
        raise ValueError("source_spreadsheet_id is invalid")
    try:
        downloaded_at = datetime.fromisoformat(
            source_downloaded_at.replace("Z", "+00:00")
        )
    except ValueError as exc:
        raise ValueError("source_downloaded_at must be an ISO-8601 timestamp") from exc
    if downloaded_at.tzinfo is None:
        raise ValueError("source_downloaded_at must include a UTC offset")

    source_file = Path(path)
    content = source_file.read_bytes()
    checksum = hashlib.sha256(content).hexdigest()
    workbook = load_workbook(source_file, read_only=True, data_only=True)
    logical_path = (
        f"google-sheets:{source_spreadsheet_id}/"
        "MEA_VMI_Database_Template.xlsx"
    )
    source_url = (
        "https://docs.google.com/spreadsheets/d/"
        f"{source_spreadsheet_id}/edit"
    )
    sources: list[RelationalSource] = []
    try:
        missing_sheets = sorted(set(PROJECT_SHEET_NAMES) - set(workbook.sheetnames))
        if missing_sheets:
            raise ValueError(
                "project sheet is missing required tabs: "
                + ", ".join(missing_sheets)
            )
        for sheet_name in PROJECT_SHEET_NAMES:
            worksheet = workbook[sheet_name]
            headers = {
                str(value).strip()
                for value in next(worksheet.iter_rows(values_only=True))
                if value is not None and str(value).strip()
            }
            missing_headers = sorted(
                PROJECT_SHEET_REQUIRED_HEADERS[sheet_name] - headers
            )
            if missing_headers:
                raise ValueError(
                    f"{sheet_name} is missing required columns: "
                    + ", ".join(missing_headers)
                )

            rows: list[dict[str, Any]] = []
            key_fields = NATURAL_KEY_FIELDS.get(sheet_name, ())
            for row_number, payload in _sheet_dict_rows(worksheet):
                typed = _typed_keys(payload)
                typed["material_id"] = _clean_material_key(
                    payload.get("Material_ID")
                )
                natural_parts = [
                    value
                    for field in key_fields
                    if (
                        value := (
                            typed["material_id"]
                            if field == "Material_ID"
                            else _clean_key(payload.get(field))
                        )
                    ) is not None
                ]
                rows.append({
                    "row_number": row_number,
                    "natural_key": "|".join(natural_parts) or str(row_number),
                    "payload": payload,
                    **typed,
                })
            if not rows:
                raise ValueError(f"{sheet_name} contains no source rows")
            sources.append(RelationalSource(
                source_path=logical_path,
                source_sheet=sheet_name,
                checksum=checksum,
                size_bytes=len(content),
                data_class="actual",
                rows=rows,
                metadata={
                    "workbook": "MEA_VMI_Database_Template.xlsx",
                    "physical_source_name": source_file.name,
                    "source_sheet": sheet_name,
                    "source_spreadsheet_id": source_spreadsheet_id,
                    "source_url": source_url,
                    "source_downloaded_at": downloaded_at.isoformat(),
                    "project_shared_source": True,
                    "total_rows": len(rows),
                    "data_class": "actual",
                    "incremental_operational_promotion": True,
                    "complete_snapshot": False,
                },
            ))
    finally:
        workbook.close()
    return sources


def parse_dummy_relational_sources(path: str | Path) -> list[RelationalSource]:
    source_path = Path(path)
    content = source_path.read_bytes()
    checksum = hashlib.sha256(content).hexdigest()
    workbook = load_workbook(source_path, read_only=True, data_only=True)
    sources: list[RelationalSource] = []
    try:
        for worksheet in workbook.worksheets:
            if worksheet.title == "INDEX":
                continue
            rows: list[dict[str, Any]] = []
            key_fields = NATURAL_KEY_FIELDS.get(worksheet.title, ())
            for row_number, payload in _sheet_dict_rows(worksheet):
                natural_parts = [
                    value
                    for field in key_fields
                    if (value := _clean_key(payload.get(field))) is not None
                ]
                rows.append({
                    "row_number": row_number,
                    "natural_key": "|".join(natural_parts) or str(row_number),
                    "payload": payload,
                    **_typed_keys(payload),
                })
            sources.append(RelationalSource(
                source_path=source_path.name,
                source_sheet=worksheet.title,
                checksum=checksum,
                size_bytes=len(content),
                data_class="reference_fixture",
                rows=rows,
                metadata={
                    "workbook": DUMMY_WORKBOOK_NAME,
                    "source_sheet": worksheet.title,
                    "total_rows": len(rows),
                    "data_class": "reference_fixture",
                    "not_actual_sap": True,
                    "operational_promotion": False,
                },
            ))
    finally:
        workbook.close()
    return sources


def parse_actual_contract_source(path: str | Path) -> RelationalSource:
    source_path = Path(path)
    content = source_path.read_bytes()
    checksum = hashlib.sha256(content).hexdigest()
    workbook = load_workbook(source_path, read_only=True, data_only=True)
    try:
        worksheet = workbook["รวมสัญญา"]
        source_rows = _sheet_dict_rows(worksheet)
        rows: list[dict[str, Any]] = []
        padded_material_rows = 0
        for row_number, raw_payload in source_rows:
            payload = {
                canonical: _json_value(raw_payload.get(header))
                for header, canonical in CONTRACT_HEADERS.items()
            }
            source_material_code = payload.get("material_code")
            material_id = _clean_material_key(source_material_code)
            if (
                material_id is not None
                and material_id != _clean_key(source_material_code)
            ):
                padded_material_rows += 1
            payload["source_material_code"] = source_material_code
            payload["material_code"] = material_id
            rows.append({
                "row_number": row_number,
                "natural_key": "|".join(
                    filter(None, (
                        _clean_key(payload.get("purchase_order")),
                        _clean_key(payload.get("line_item")),
                    ))
                ) or str(row_number),
                "payload": payload,
                "material_id": material_id,
                "contract_ref": (
                    _clean_key(payload.get("contract_number"))
                    or _clean_key(payload.get("purchase_order"))
                ),
            })
    finally:
        workbook.close()
    return RelationalSource(
        source_path=source_path.name,
        source_sheet="รวมสัญญา",
        checksum=checksum,
        size_bytes=len(content),
        data_class="actual",
        rows=rows,
        metadata={
            "source_sheet": "รวมสัญญา",
            "source_range": "A1:P6306",
            "header_rows": 1,
            "total_rows": len(rows),
            "data_class": "actual",
            "material_codes_padded_to_12_digits": padded_material_rows,
            "operational_promotion": True,
        },
    )


def build_package_manifest(path: str | Path) -> list[RelationalSource]:
    package_path = Path(path)
    sources: list[RelationalSource] = []
    for file_path in sorted(
        item
        for item in package_path.rglob("*")
        if item.is_file()
        and not any(part.startswith(".") for part in item.relative_to(package_path).parts)
    ):
        content = file_path.read_bytes()
        relative_path = file_path.relative_to(package_path).as_posix()
        sources.append(RelationalSource(
            source_path=f"{package_path.name}/{relative_path}",
            source_sheet=None,
            checksum=hashlib.sha256(content).hexdigest(),
            size_bytes=len(content),
            data_class="design_reference",
            rows=[],
            metadata={
                "package": package_path.name,
                "relative_path": relative_path,
                "suffix": file_path.suffix.lower(),
                "total_rows": 0,
                "data_class": "design_reference",
                "executed_as_migration": False,
            },
        ))
    return sources
