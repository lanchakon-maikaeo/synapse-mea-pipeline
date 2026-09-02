"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

type Sheet = { name: string; headers: string[]; rows: string[][] };
type RecordRow = Record<string, unknown>;
type MaterialReference = { description: string; baseUnit: string };

const storageKey = "mea-synapse.local-fifo-opening-snapshot";
const wantedSheets = ["PACKAGING_PROFILE", "OPENING_HANDLING_UNITS"];
const calculationSheetName = "PACKAGING_CALCULATION";
const setupTemplateUrl = "/templates/MEA_Synapse_FIFO_Packaging_Opening_Template_v1.xlsx";
const packageTypes = ["FULL_PALLET", "BOX", "CRATE", "BUNDLE", "LOOSE", "LONG_MATERIAL"];
const packagingDetailHeaders = [
  "ASSUMPTION_STATUS",
  "ITEM_LENGTH_CM", "ITEM_WIDTH_CM", "ITEM_HEIGHT_CM", "ITEM_WEIGHT_KG",
  "BOX_LENGTH_CM", "BOX_WIDTH_CM", "BOX_HEIGHT_CM", "BOX_TARE_WEIGHT_KG",
  "BOX_GROSS_WEIGHT_KG", "BOXES_PER_LAYER", "LAYERS", "BOXES_PER_PALLET",
  "UNITS_PER_PALLET", "PALLET_LENGTH_M", "PALLET_WIDTH_M", "LOAD_HEIGHT_M",
  "PALLET_TARE_KG", "MAX_PALLET_GROSS_KG", "CALC_PALLET_GROSS_KG",
] as const;
const packagingHeaders = [
  "MATERIAL", "MATERIAL_DESCRIPTION", "VENDOR_ALIAS", "CONTRACT_NO", "PURCHASE_ORDER",
  "PLANT", "STORAGE_LOCATION", "PACKAGE_TYPE", "UNITS_PER_PACKAGE", "BASE_UNIT",
  "VALID_FROM", "VERIFIED", ...packagingDetailHeaders,
];
const openingHeaders = ["HU_ID", "CONTRACT_ITEM_ID", "MATERIAL", "MATERIAL_DESCRIPTION", "VENDOR_ALIAS", "CONTRACT_NO", "PURCHASE_ORDER", "DELIVERY_INSTALLMENT", "RECEIPT_LOT", "ACCEPTED_DATE", "PLANT", "STORAGE_LOCATION", "PACKAGE_TYPE", "UNITS_PER_PACKAGE", "INITIAL_QTY", "CURRENT_REMAIN", "PHYSICAL_LOCATION", "OPENING_STATUS", "VERIFIED"];

const packagingDetailGroups = [
  {
    title: "สินค้า",
    fields: [
      ["ITEM_LENGTH_CM", "ยาว", "ซม."], ["ITEM_WIDTH_CM", "กว้าง", "ซม."],
      ["ITEM_HEIGHT_CM", "สูง", "ซม."], ["ITEM_WEIGHT_KG", "น้ำหนัก/ชิ้น", "กก."],
    ],
  },
  {
    title: "กล่อง",
    fields: [
      ["BOX_LENGTH_CM", "ยาว", "ซม."], ["BOX_WIDTH_CM", "กว้าง", "ซม."],
      ["BOX_HEIGHT_CM", "สูง", "ซม."], ["BOX_TARE_WEIGHT_KG", "น้ำหนักกล่องเปล่า", "กก."],
    ],
  },
  {
    title: "การวางบนพาเลท",
    fields: [
      ["BOXES_PER_LAYER", "กล่อง/ชั้น", "กล่อง"], ["LAYERS", "จำนวนชั้น", "ชั้น"],
      ["PALLET_LENGTH_M", "พาเลทยาว", "ม."], ["PALLET_WIDTH_M", "พาเลทกว้าง", "ม."],
      ["LOAD_HEIGHT_M", "ความสูงรวม", "ม."], ["PALLET_TARE_KG", "น้ำหนักพาเลทเปล่า", "กก."],
      ["MAX_PALLET_GROSS_KG", "น้ำหนักรวมสูงสุด", "กก."],
    ],
  },
] as const;

const xmlEscape = (item: unknown) => String(item ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

function columnReference(index: number) {
  let current = index + 1;
  let result = "";
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function xlsxCell(reference: string, value: unknown, style: number) {
  return `<c r="${reference}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function worksheetXml(sheet: Sheet, title: string, instruction: string, editableColumns: number[]) {
  const lastColumn = columnReference(sheet.headers.length - 1);
  const lastRow = sheet.rows.length + 4;
  const widths = sheet.headers.map((header, index) => {
    const descriptive = ["MATERIAL_DESCRIPTION", "VENDOR_ALIAS", "CONTRACT_NO", "PHYSICAL_LOCATION"].includes(header);
    const width = descriptive ? 26 : Math.max(13, Math.min(22, header.length + 3));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const titleRow = `<row r="1" ht="30" customHeight="1">${xlsxCell("A1", title, 1)}</row>`;
  const instructionRow = `<row r="2" ht="24" customHeight="1">${xlsxCell("A2", instruction, 2)}</row>`;
  const headerRow = `<row r="4" ht="28" customHeight="1">${sheet.headers.map((header, index) => xlsxCell(`${columnReference(index)}4`, header, 3)).join("")}</row>`;
  const bodyRows = sheet.rows.map((row, rowIndex) => {
    const excelRow = rowIndex + 5;
    const cells = sheet.headers.map((_, columnIndex) => xlsxCell(
      `${columnReference(columnIndex)}${excelRow}`,
      row[columnIndex] ?? "",
      editableColumns.includes(columnIndex) ? 4 : 5,
    )).join("");
    return `<row r="${excelRow}">${cells}</row>`;
  }).join("");
  const validationEnd = Math.max(5, lastRow);
  const validations = sheet.name === "PACKAGING_PROFILE"
    ? `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="H5:H${validationEnd}"><formula1>&quot;${packageTypes.join(",")}&quot;</formula1></dataValidation></dataValidations>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>${widths}</cols>
  <sheetData>${titleRow}${instructionRow}${headerRow}${bodyRows}</sheetData>
  <autoFilter ref="A4:${lastColumn}${lastRow}"/>
  <mergeCells count="2"><mergeCell ref="A1:${lastColumn}1"/><mergeCell ref="A2:${lastColumn}2"/></mergeCells>
  ${validations}
</worksheet>`;
}

async function setupWorkbookBlob(sheets: Sheet[]) {
  const { strToU8, zipSync } = await import("fflate");
  const packaging = sheets.find((sheet) => sheet.name === "PACKAGING_PROFILE");
  const opening = sheets.find((sheet) => sheet.name === "OPENING_HANDLING_UNITS");
  if (!packaging || !opening) throw new Error("ยังไม่มีข้อมูลสำหรับ Export Setup Workbook");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="PACKAGING_PROFILE" sheetId="1" r:id="rId1"/><sheet name="OPENING_HANDLING_UNITS" sheetId="2" r:id="rId2"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="4"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="16"/><name val="Aptos Display"/></font><font><b/><color rgb="FFC45116"/><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B3B66"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF97316"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF4CC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFDDE5ED"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="49" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(worksheetXml(
      packaging,
      "MEA Synapse · Packaging Profile",
      "ตรวจและแก้ช่องสีเหลือง: รูปแบบบรรจุ ขนาด น้ำหนัก และการวางพาเลท แล้ว Import กลับเข้าระบบ",
      packaging.headers.map((_, index) => index).filter((index) => index === 7 || index === 8 || index >= 12),
    )),
    "xl/worksheets/sheet2.xml": strToU8(worksheetXml(opening, "MEA Synapse · Opening Handling Units", "กรอกช่องสีเหลือง: INITIAL_QTY, CURRENT_REMAIN (เว้นว่างได้) และ PHYSICAL_LOCATION", [14, 15, 16])),
  };
  return new Blob([zipSync(files, { level: 6 })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const normalize = (item: unknown) =>
  String(item ?? "").trim().toLowerCase().replace(/[\s_./\\()\-]+/g, "");

function recordValue(row: RecordRow, aliases: string[], fallback = "") {
  for (const alias of aliases) {
    const key = Object.keys(row).find((candidate) => normalize(candidate) === normalize(alias));
    if (key && row[key] !== null && row[key] !== undefined) {
      const result = String(row[key]).trim();
      if (result) return result;
    }
  }
  return fallback;
}

function column(headers: string[], aliases: string[]) {
  const wanted = aliases.map(normalize);
  return headers.findIndex((header) => wanted.includes(normalize(header)));
}

function cell(sheet: Sheet, row: string[], aliases: string[]) {
  const index = column(sheet.headers, aliases);
  return index >= 0 ? String(row[index] ?? "").trim() : "";
}

function numeric(item: string) {
  const parsed = Number(item.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimal(item: number, digits = 3) {
  if (!Number.isFinite(item)) return "";
  return String(Number(item.toFixed(digits)));
}

function alignedSheet(sheet: Sheet, headers: string[]) {
  const indexes = headers.map((header) => column(sheet.headers, [header]));
  return {
    ...sheet,
    headers: [...headers],
    rows: sheet.rows.map((row) => indexes.map((index) => index >= 0 ? String(row[index] ?? "") : "")),
  };
}

function rowKey(sheet: Sheet, row: string[]) {
  return [
    cell(sheet, row, ["material"]),
    cell(sheet, row, ["vendoralias"]),
    cell(sheet, row, ["contractno"]),
    cell(sheet, row, ["purchaseorder"]),
  ].join("|").toUpperCase();
}

function setCellValue(sheet: Sheet, row: string[], header: string, value: string) {
  const index = column(sheet.headers, [header]);
  if (index >= 0) row[index] = value;
}

function rowObject(sheet: Sheet, row: string[]) {
  return Object.fromEntries(sheet.headers.map((header, index) => [header, String(row[index] ?? "")]));
}

function recalculatePackagingRow(sheet: Sheet, row: string[]) {
  const copy = [...row];
  const unitsPerBox = numeric(cell(sheet, copy, ["unitsperpackage"]));
  const itemWeight = numeric(cell(sheet, copy, ["itemweightkg"]));
  const boxTare = numeric(cell(sheet, copy, ["boxtareweightkg"]));
  const boxesPerLayer = numeric(cell(sheet, copy, ["boxesperlayer"]));
  const layers = numeric(cell(sheet, copy, ["layers", "layersbyheight", "maximumstacklayers"]));
  const palletTare = numeric(cell(sheet, copy, ["pallettarekg", "pallettareweight"]));
  const maxGross = numeric(cell(sheet, copy, ["maxpalletgrosskg", "maxpalletgrossweight"]));
  const boxGross = unitsPerBox > 0 && itemWeight > 0 ? (unitsPerBox * itemWeight) + boxTare : 0;
  const layoutBoxes = boxesPerLayer > 0 && layers > 0 ? Math.floor(boxesPerLayer * layers) : 0;
  const weightBoxes = boxGross > 0 && maxGross > palletTare
    ? Math.floor((maxGross - palletTare) / boxGross)
    : 0;
  const boxesPerPallet = layoutBoxes > 0 && weightBoxes > 0
    ? Math.min(layoutBoxes, weightBoxes)
    : Math.max(layoutBoxes, weightBoxes);
  const unitsPerPallet = boxesPerPallet > 0 && unitsPerBox > 0 ? boxesPerPallet * unitsPerBox : 0;
  const palletGross = boxesPerPallet > 0 && boxGross > 0 ? palletTare + (boxesPerPallet * boxGross) : 0;
  if (boxGross > 0) setCellValue(sheet, copy, "BOX_GROSS_WEIGHT_KG", decimal(boxGross));
  if (boxesPerPallet > 0) setCellValue(sheet, copy, "BOXES_PER_PALLET", decimal(boxesPerPallet, 0));
  if (unitsPerPallet > 0) setCellValue(sheet, copy, "UNITS_PER_PALLET", decimal(unitsPerPallet, 0));
  if (palletGross > 0) setCellValue(sheet, copy, "CALC_PALLET_GROSS_KG", decimal(palletGross));
  return copy;
}

function mergePackagingCalculation(sheets: Sheet[]) {
  const sourceProfile = sheets.find((sheet) => sheet.name === "PACKAGING_PROFILE");
  if (!sourceProfile) return sheets;
  const profile = alignedSheet(sourceProfile, packagingHeaders);
  const calculation = sheets.find((sheet) => sheet.name === calculationSheetName);
  if (!calculation) {
    return sheets.map((sheet) => sheet.name === "PACKAGING_PROFILE" ? profile : sheet)
      .filter((sheet) => wantedSheets.includes(sheet.name));
  }

  const detailAliases: Record<(typeof packagingDetailHeaders)[number], string[]> = {
    ASSUMPTION_STATUS: ["assumptionstatus"],
    ITEM_LENGTH_CM: ["itemlengthcm"], ITEM_WIDTH_CM: ["itemwidthcm"],
    ITEM_HEIGHT_CM: ["itemheightcm"], ITEM_WEIGHT_KG: ["itemweightkg"],
    BOX_LENGTH_CM: ["boxlengthcm"], BOX_WIDTH_CM: ["boxwidthcm"],
    BOX_HEIGHT_CM: ["boxheightcm"], BOX_TARE_WEIGHT_KG: ["boxtareweightkg"],
    BOX_GROSS_WEIGHT_KG: ["boxgrossweightkg"], BOXES_PER_LAYER: ["boxesperlayer"],
    LAYERS: ["layers", "layersbyheight", "maximumstacklayers"],
    BOXES_PER_PALLET: ["boxesperpallet"], UNITS_PER_PALLET: ["unitsperpallet"],
    PALLET_LENGTH_M: ["palletlengthm"], PALLET_WIDTH_M: ["palletwidthm"],
    LOAD_HEIGHT_M: ["loadheightm", "palletheightm"], PALLET_TARE_KG: ["pallettarekg"],
    MAX_PALLET_GROSS_KG: ["maxpalletgrosskg"], CALC_PALLET_GROSS_KG: ["calcpalletgrosskg", "palletgrosskg"],
  };
  const calculationsByKey = new Map<string, string[]>();
  const calculationsByMaterial = new Map<string, string[]>();
  calculation.rows.forEach((row) => {
    const material = materialKey(cell(calculation, row, ["material"]));
    if (!material) return;
    calculationsByKey.set(rowKey(calculation, row), row);
    if (!calculationsByMaterial.has(material)) calculationsByMaterial.set(material, row);
  });
  const rows = profile.rows.map((row) => {
    const source = calculationsByKey.get(rowKey(profile, row))
      ?? calculationsByMaterial.get(materialKey(cell(profile, row, ["material"])));
    if (!source) return row;
    const copy = [...row];
    packagingDetailHeaders.forEach((header) => {
      const current = cell(profile, copy, [header]);
      const imported = cell(calculation, source, detailAliases[header]);
      if (!current && imported) setCellValue(profile, copy, header, imported);
    });
    return recalculatePackagingRow(profile, copy);
  });
  return sheets.map((sheet) => sheet.name === "PACKAGING_PROFILE" ? { ...profile, rows } : sheet)
    .filter((sheet) => wantedSheets.includes(sheet.name));
}

function materialKey(item: unknown) {
  return String(item ?? "").trim().replace(/\.0$/, "").toUpperCase();
}

function buildMaterialLookup(materialRows: RecordRow[] | undefined) {
  const lookup = new Map<string, MaterialReference>();
  (materialRows ?? []).forEach((row) => {
    const reference = {
      description: recordValue(row, ["material_name", "material_description", "description"]),
      baseUnit: recordValue(row, ["base_unit", "unit"]),
    };
    [
      recordValue(row, ["material_id"]),
      recordValue(row, ["sap_material_id"]),
      recordValue(row, ["material_code"]),
      recordValue(row, ["material_number"]),
    ].forEach((candidate) => {
      const key = materialKey(candidate);
      if (key) lookup.set(key, reference);
    });
  });
  return lookup;
}

function enrichSheetsFromMaterialMaster(
  sheets: Sheet[],
  materialLookup: Map<string, MaterialReference>,
) {
  if (!materialLookup.size) return sheets;
  let workbookChanged = false;
  const enriched = sheets.map((sheet) => {
    const materialIndex = column(sheet.headers, ["material"]);
    const descriptionIndex = column(sheet.headers, ["materialdescription"]);
    const unitIndex = column(sheet.headers, ["baseunit"]);
    if (materialIndex < 0 || descriptionIndex < 0) return sheet;
    let sheetChanged = false;
    const rows = sheet.rows.map((row) => {
      const reference = materialLookup.get(materialKey(row[materialIndex]));
      if (!reference) return row;
      const missingDescription = !String(row[descriptionIndex] ?? "").trim() && reference.description;
      const missingUnit = unitIndex >= 0 && !String(row[unitIndex] ?? "").trim() && reference.baseUnit;
      if (!missingDescription && !missingUnit) return row;
      const copy = [...row];
      if (missingDescription) copy[descriptionIndex] = reference.description;
      if (missingUnit) copy[unitIndex] = reference.baseUnit;
      sheetChanged = true;
      return copy;
    });
    if (!sheetChanged) return sheet;
    workbookChanged = true;
    return { ...sheet, rows };
  });
  return workbookChanged ? enriched : sheets;
}

function excelColumn(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

const officeRelationshipNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function xmlElements(root: Document | Element, localName: string) {
  const namespaced = [...root.getElementsByTagNameNS("*", localName)];
  return namespaced.length
    ? namespaced
    : [...root.getElementsByTagName(localName)];
}

function matrixFromXml(parser: DOMParser, source: Uint8Array, shared: string[]) {
  const xml = parser.parseFromString(new TextDecoder().decode(source), "text/xml");
  return xmlElements(xml, "row")
    .map((rowNode) => {
      const row: string[] = [];
      xmlElements(rowNode, "c").forEach((node) => {
        const index = excelColumn(node.getAttribute("r") ?? "A1");
        const kind = node.getAttribute("t") ?? "";
        const raw = xmlElements(node, "v")[0]?.textContent ?? "";
        row[index] = (kind === "s"
          ? shared[Number(raw)] ?? ""
          : kind === "inlineStr"
            ? xmlElements(node, "is")[0]?.textContent ?? ""
            : raw).trim();
      });
      return row;
    })
    .filter((row) => row.some(Boolean));
}

function sheetFromMatrix(name: string, matrix: string[][], aliases: string[]) {
  let headerIndex = 0;
  let best = -1;
  matrix.slice(0, 30).forEach((row, index) => {
    const score = aliases.filter((alias) => column(row, [alias]) >= 0).length;
    if (score > best) {
      best = score;
      headerIndex = index;
    }
  });
  return { name, headers: matrix[headerIndex] ?? [], rows: matrix.slice(headerIndex + 1, headerIndex + 5001) };
}

async function readWorkbook(file: File): Promise<Sheet[]> {
  const { strFromU8, unzipSync } = await import("fflate");
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const parser = new DOMParser();
  const sharedXml = archive["xl/sharedStrings.xml"];
  const shared = sharedXml
    ? xmlElements(
      parser.parseFromString(strFromU8(sharedXml), "text/xml"),
      "si",
    ).map((node) => node.textContent ?? "")
    : [];
  const workbookXml = archive["xl/workbook.xml"];
  const relsXml = archive["xl/_rels/workbook.xml.rels"];
  if (!workbookXml || !relsXml) throw new Error("ไม่พบโครงสร้าง Workbook ในไฟล์ Excel");
  const workbook = parser.parseFromString(strFromU8(workbookXml), "text/xml");
  const rels = parser.parseFromString(strFromU8(relsXml), "text/xml");
  const targets = new Map(xmlElements(rels, "Relationship").map((node) => [node.getAttribute("Id") ?? "", node.getAttribute("Target") ?? ""]));
  const descriptors = xmlElements(workbook, "sheet").map((node) => {
    const name = node.getAttribute("name") ?? "";
    const relationshipId =
      node.getAttributeNS(officeRelationshipNamespace, "id")
      ?? node.getAttribute("r:id")
      ?? "";
    const target = targets.get(relationshipId) ?? "";
    return { name, path: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}` };
  });
  const missing = wantedSheets.filter((name) => !descriptors.some((sheet) => sheet.name === name));
  if (missing.length) throw new Error(`ไม่พบชีท ${missing.join(", ")}`);
  const aliases = [
    "material", "packagetype", "unitsperpackage", "initialqty", "currentremain",
    "itemlengthcm", "boxlengthcm", "boxesperpallet", "maxpalletgrosskg",
  ];
  const readableSheets = [
    ...wantedSheets,
    ...(descriptors.some((sheet) => sheet.name === calculationSheetName) ? [calculationSheetName] : []),
  ];
  return readableSheets.map((name) => {
    const descriptor = descriptors.find((sheet) => sheet.name === name)!;
    const source = archive[descriptor.path];
    if (!source) throw new Error(`ไม่สามารถอ่านชีท ${name}`);
    return sheetFromMatrix(name, matrixFromXml(parser, source, shared), aliases);
  });
}

function sheetsFromContracts(
  contractRows: RecordRow[],
  materialLookup: Map<string, MaterialReference>,
): Sheet[] {
  const profiles = new Map<string, string[]>();
  const openings = new Map<string, string[]>();
  contractRows.forEach((source, index) => {
    const material = recordValue(source, ["material_id", "material_code", "material_number", "material"]);
    if (!material) return;
    const materialReference = materialLookup.get(materialKey(material));
    const description = recordValue(
      source,
      ["material_name", "material_description", "description"],
      materialReference?.description,
    );
    const vendor = recordValue(source, ["vendor_name", "vendor_alias"]);
    const contract = recordValue(source, ["contract_number", "contract_no"]);
    const po = recordValue(source, ["purchase_order", "purchase_order_no", "po"]);
    const itemId = recordValue(source, ["contract_item_id"]);
    const installment = recordValue(source, ["installment_no", "delivery_installment", "line_item"]);
    const lot = recordValue(source, ["lot_code", "receipt_lot", "delivery_lot"]);
    const accepted = recordValue(source, ["acceptance_date", "accepted_date", "receipt_date", "expected_delivery_date"]).slice(0, 10);
    const unit = recordValue(source, ["base_unit", "unit"], materialReference?.baseUnit || "EA");
    const profileKey = [material, vendor, contract, po].join("|");
    if (!profiles.has(profileKey)) {
      profiles.set(profileKey, [material, description, vendor, contract, po, "2401", "0001", "", "", unit, accepted, "NO"]);
    }
    const openingKey = itemId || [profileKey, installment, lot, accepted, index].join("|");
    if (!openings.has(openingKey)) {
      openings.set(openingKey, ["", itemId, material, description, vendor, contract, po, installment, lot, accepted, "2401", "0001", "", "", "", "", "", "OPENING_UNKNOWN", "NO"]);
    }
  });
  return [
    { name: "PACKAGING_PROFILE", headers: packagingHeaders, rows: [...profiles.values()] },
    { name: "OPENING_HANDLING_UNITS", headers: openingHeaders, rows: [...openings.values()] },
  ];
}

function hydrateImportedOpening(sheets: Sheet[]) {
  return sheets.map((sheet) => {
    if (sheet.name !== "OPENING_HANDLING_UNITS") return sheet;
    const initialIndex = column(sheet.headers, ["initialqty"]);
    const remainIndex = column(sheet.headers, ["currentremain"]);
    if (initialIndex < 0 || remainIndex < 0) return sheet;
    return {
      ...sheet,
      rows: sheet.rows.map((row) => {
        if (String(row[remainIndex] ?? "").trim()) return row;
        const copy = [...row];
        copy[remainIndex] = String(row[initialIndex] ?? "").trim();
        return copy;
      }),
    };
  });
}

const fmt = (amount: number) => new Intl.NumberFormat("en-US").format(amount);

export default function FifoPackagingSetupView({
  contractRows,
  materialRows = [],
  onPublishOpening,
}: {
  contractRows: RecordRow[];
  materialRows?: RecordRow[];
  onPublishOpening?: (
    profiles: RecordRow[],
    handlingUnits: RecordRow[],
    sourceReference: string,
  ) => Promise<boolean>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [tab, setTab] = useState<"packaging" | "opening">("packaging");
  const [confirmed, setConfirmed] = useState({ packaging: false, opening: false });
  const [reconciled, setReconciled] = useState(false);
  const [publishedAt, setPublishedAt] = useState("");
  const [supabaseSynced, setSupabaseSynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expandedProfile, setExpandedProfile] = useState("");
  const materialLookup = useMemo(() => buildMaterialLookup(materialRows), [materialRows]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { publishedAt?: string; supabaseSynced?: boolean } | null;
      setPublishedAt(saved?.publishedAt ?? "");
      setSupabaseSynced(saved?.supabaseSynced === true);
    } catch {
      // Old preview snapshots must not block the setup screen.
    }
  }, []);

  useEffect(() => {
    setSheets((current) => enrichSheetsFromMaterialMaster(current, materialLookup));
  }, [materialLookup]);

  const sourceRows = useMemo(
    () => contractRows.filter((row) => recordValue(row, ["material_id", "material_code", "material_number", "material"])),
    [contractRows],
  );
  const packaging = sheets.find((sheet) => sheet.name === "PACKAGING_PROFILE");
  const opening = sheets.find((sheet) => sheet.name === "OPENING_HANDLING_UNITS");
  const packagingRows = useMemo(
    () => packaging?.rows.filter((row) => cell(packaging, row, ["material"])) ?? [],
    [packaging],
  );
  const openingRows = useMemo(
    () => opening?.rows.filter((row) => cell(opening, row, ["material"])) ?? [],
    [opening],
  );
  const huRows = useMemo(
    () => openingRows.map((row, index) => ({
      row,
      huId: (opening && cell(opening, row, ["huid", "handlingunitid"])) || `HU-KT-GOLIVE-${String(index + 1).padStart(6, "0")}`,
    })),
    [opening, openingRows],
  );
  const packagingDetailsComplete = (row: string[]) => Boolean(packaging && [
    "itemlengthcm", "itemwidthcm", "itemheightcm", "itemweightkg",
    "boxlengthcm", "boxwidthcm", "boxheightcm", "boxtareweightkg",
    "boxesperlayer", "layers", "palletlengthm", "palletwidthm", "loadheightm",
    "pallettarekg", "maxpalletgrosskg",
  ].every((header) => numeric(cell(packaging, row, [header])) > 0));
  const packagingValid = Boolean(packagingRows.length && packagingRows.every((row) =>
    packaging && cell(packaging, row, ["packagetype"]) && numeric(cell(packaging, row, ["unitsperpackage"])) > 0,
  ));
  const openingValid = Boolean(openingRows.length && openingRows.every((row) => {
    if (!opening) return false;
    const initial = numeric(cell(opening, row, ["initialqty"]));
    const remain = numeric(cell(opening, row, ["currentremain"]));
    return Boolean(cell(opening, row, ["packagetype"])) &&
      numeric(cell(opening, row, ["unitsperpackage"])) > 0 &&
      Boolean(cell(opening, row, ["physicallocation"])) &&
      initial > 0 && remain >= 0 && remain <= initial;
  }));

  const resetWorkflow = () => {
    setConfirmed({ packaging: false, opening: false });
    setReconciled(false);
    setPublishedAt("");
    setSupabaseSynced(false);
    setError("");
    setExpandedProfile("");
  };

  const createFromContracts = () => {
    if (!sourceRows.length) {
      setError("ยังไม่พบรายการ Material จากข้อมูลรวมสัญญา กรุณา Publish Contract & Delivery Lot ก่อน");
      return;
    }
    resetWorkflow();
    setSheets(sheetsFromContracts(sourceRows, materialLookup));
    setSourceLabel(`ดึงอัตโนมัติจากรวมสัญญา · ${fmt(sourceRows.length)} รายการ`);
    setTab("packaging");
  };

  const updateCell = (sheetName: string, rowReference: string[], header: string, nextValue: string) => {
    setSheets((current) => current.map((sheet) => {
      if (sheet.name !== sheetName) return sheet;
      const rowIndex = sheet.rows.indexOf(rowReference);
      const columnIndex = column(sheet.headers, [header]);
      if (rowIndex < 0 || columnIndex < 0) return sheet;
      return {
        ...sheet,
        rows: sheet.rows.map((row, index) => {
          if (index !== rowIndex) return row;
          const copy = [...row];
          copy[columnIndex] = nextValue;
          return sheetName === "PACKAGING_PROFILE"
            ? recalculatePackagingRow(sheet, copy)
            : copy;
        }),
      };
    }));
  };

  const updateOpeningInitial = (rowReference: string[], nextValue: string) => {
    setSheets((current) => current.map((sheet) => {
      if (sheet.name !== "OPENING_HANDLING_UNITS") return sheet;
      const rowIndex = sheet.rows.indexOf(rowReference);
      const initialIndex = column(sheet.headers, ["initialqty"]);
      const remainIndex = column(sheet.headers, ["currentremain"]);
      if (rowIndex < 0 || initialIndex < 0 || remainIndex < 0) return sheet;
      return {
        ...sheet,
        rows: sheet.rows.map((row, index) => {
          if (index !== rowIndex) return row;
          const copy = [...row];
          const previousInitial = String(copy[initialIndex] ?? "");
          const previousRemain = String(copy[remainIndex] ?? "");
          copy[initialIndex] = nextValue;
          if (!previousRemain || previousRemain === previousInitial) copy[remainIndex] = nextValue;
          return copy;
        }),
      };
    }));
  };

  const fillOpeningDummy = () => {
    setSheets((current) => current.map((sheet) => {
      if (sheet.name !== "OPENING_HANDLING_UNITS") return sheet;
      const locationIndex = column(sheet.headers, ["physicallocation"]);
      const initialIndex = column(sheet.headers, ["initialqty"]);
      const remainIndex = column(sheet.headers, ["currentremain"]);
      if (locationIndex < 0 || initialIndex < 0 || remainIndex < 0) return sheet;
      return {
        ...sheet,
        rows: sheet.rows.map((row, index) => {
          if (!cell(sheet, row, ["material"])) return row;
          const copy = [...row];
          const unitsPerPackage = Math.max(1, numeric(cell(sheet, row, ["unitsperpackage"])));
          const packageCount = 2 + (index % 9);
          const quantity = unitsPerPackage * packageCount;
          const aisle = String((index % 8) + 1).padStart(2, "0");
          const rack = String((Math.floor(index / 8) % 12) + 1).padStart(2, "0");
          const level = String((index % 4) + 1).padStart(2, "0");
          copy[locationIndex] = `DUMMY-A${aisle}-R${rack}-L${level}`;
          copy[initialIndex] = String(quantity);
          copy[remainIndex] = String(quantity);
          return copy;
        }),
      };
    }));
    setConfirmed((current) => ({ ...current, opening: false }));
    setReconciled(false);
    setPublishedAt("");
    setSupabaseSynced(false);
    setError("");
  };

  const confirmPackaging = () => {
    setSheets((current) => {
      const packagingSheet = current.find((sheet) => sheet.name === "PACKAGING_PROFILE");
      if (!packagingSheet) return current;
      const profiles = new Map(packagingSheet.rows.map((row) => [
        [
          cell(packagingSheet, row, ["material"]),
          cell(packagingSheet, row, ["vendoralias"]),
          cell(packagingSheet, row, ["contractno"]),
          cell(packagingSheet, row, ["purchaseorder"]),
        ].join("|"),
        {
          type: cell(packagingSheet, row, ["packagetype"]),
          units: cell(packagingSheet, row, ["unitsperpackage"]),
        },
      ]));
      return current.map((sheet) => {
        if (sheet.name !== "OPENING_HANDLING_UNITS") return sheet;
        const typeIndex = column(sheet.headers, ["packagetype"]);
        const unitsIndex = column(sheet.headers, ["unitsperpackage"]);
        return {
          ...sheet,
          rows: sheet.rows.map((row) => {
            const key = [
              cell(sheet, row, ["material"]),
              cell(sheet, row, ["vendoralias"]),
              cell(sheet, row, ["contractno"]),
              cell(sheet, row, ["purchaseorder"]),
            ].join("|");
            const profile = profiles.get(key);
            if (!profile || typeIndex < 0 || unitsIndex < 0) return row;
            const copy = [...row];
            copy[typeIndex] = profile.type;
            copy[unitsIndex] = profile.units;
            return copy;
          }),
        };
      });
    });
    setConfirmed((current) => ({ ...current, packaging: true }));
    setTab("opening");
  };

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    event.target.value = "";
    if (!next) return;
    setBusy(true);
    resetWorkflow();
    try {
      setSheets(enrichSheetsFromMaterialMaster(
        hydrateImportedOpening(mergePackagingCalculation(await readWorkbook(next))),
        materialLookup,
      ));
      setSourceLabel(next.name);
      setTab("packaging");
    } catch (reason) {
      setSheets([]);
      setSourceLabel("");
      setError(reason instanceof Error ? reason.message : "อ่านไฟล์ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function exportSetupWorkbook() {
    try {
      setError("");
      const url = URL.createObjectURL(await setupWorkbookBlob(sheets));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "MEA_Synapse_FIFO_Packaging_Opening_GoLive.xlsx";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "สร้างไฟล์ Setup Workbook ไม่สำเร็จ");
    }
  }

  async function publish() {
    if (!sourceLabel || !confirmed.packaging || !confirmed.opening || !reconciled) return;
    const profiles = packaging
      ? packagingRows.map((row) => rowObject(packaging, row))
      : [];
    const handlingUnits = opening
      ? huRows.map(({ row, huId }) => ({
          ...rowObject(opening, row),
          HU_ID: huId,
        }))
      : [];
    setBusy(true);
    setError("");
    if (onPublishOpening) {
      const saved = await onPublishOpening(profiles, handlingUnits, sourceLabel);
      if (!saved) {
        setError("ยังบันทึก Opening HU และ Stock ลง Supabase ไม่สำเร็จ จึงยังไม่พร้อมใช้คำนวณการจ่าย");
        setBusy(false);
        return;
      }
    } else {
      setError("ยังไม่ได้เชื่อม API สำหรับ Publish Opening ลง Supabase");
      setBusy(false);
      return;
    }
    const now = new Date().toISOString();
    localStorage.setItem(storageKey, JSON.stringify({
      id: `FIFO-OPENING-${Date.now()}`,
      source: sourceLabel,
      publishedAt: now,
      plant: "2401",
      storageLocation: "0001",
      packagingProfileCount: packagingRows.length,
      packagingProfiles: profiles,
      handlingUnits: huRows.length,
      huIds: huRows.map((item) => item.huId),
      supabaseSynced: true,
    }));
    setPublishedAt(now);
    setSupabaseSynced(true);
    setBusy(false);
  }

  function exportRegister() {
    if (!opening) return;
    const quote = (item: string) => `"${item.replace(/"/g, '""')}"`;
    const data = [
      ["HU_ID", "MATERIAL", "DESCRIPTION", "CONTRACT", "DELIVERY_LOT", "PACKAGE_TYPE", "INITIAL_QTY", "REMAIN", "LOCATION"],
      ...huRows.map(({ row, huId }) => [
        huId,
        cell(opening, row, ["material"]),
        cell(opening, row, ["materialdescription"]),
        cell(opening, row, ["contractno"]),
        cell(opening, row, ["deliveryinstallment", "receiptlot"]),
        cell(opening, row, ["packagetype"]),
        cell(opening, row, ["initialqty"]),
        cell(opening, row, ["currentremain"]),
        cell(opening, row, ["physicallocation"]),
      ]),
    ];
    const url = URL.createObjectURL(new Blob(["\uFEFF", data.map((row) => row.map(quote).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "MEA_Synapse_HU_Opening_Register.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fifo-setup-page page-stack">
      <input ref={inputRef} className="import-hidden-input" type="file" accept=".xlsx" onChange={onFile} />

      <section className="fifo-setup-hero">
        <div>
          <span>FIFO FOUNDATION · ADMIN WORKSPACE</span>
          <h2>FIFO, Packaging &amp; Opening Setup</h2>
          <p>ดึงข้อมูลสัญญาให้อัตโนมัติ แล้วกรอกเฉพาะรูปแบบ Packing ตำแหน่งจัดเก็บ และยอดตั้งต้น</p>
        </div>
        <aside>
          <small>Current scope</small>
          <strong>คลังคลองเตย · Plant 2401 / SLoc 0001</strong>
          <span>ออกแบบให้ขยายสู่คลังบางพลีและเมืองใหม่ได้</span>
        </aside>
      </section>

      <section className="fifo-setup-explainer">
        <article><b className="fifo-setup-badge system">SYSTEM</b><strong>ดึงจากรวมสัญญา</strong><p>Material, Description, Vendor, Contract, PO, งวดส่งมอบ และวันที่ตรวจรับ</p></article>
        <article><b className="fifo-setup-badge admin">ADMIN</b><strong>ตรวจข้อมูล Packing</strong><p>ขนาดสินค้า/กล่อง น้ำหนัก จำนวนต่อกล่อง การวางพาเลท ตำแหน่ง และยอดตั้งต้น</p></article>
        <article><b className="fifo-setup-badge auto">AUTO</b><strong>ระบบคำนวณให้</strong><p>กล่องและชิ้นต่อพาเลท น้ำหนักรวม Current Remain, Handling Unit ID และทะเบียน Opening</p></article>
      </section>

      <section className="fifo-setup-lifecycle">
        <article>
          <b>ครั้งเดียวตอนเริ่มระบบ</b>
          <strong>Export → กรอก Excel → Import กลับ → Publish Opening</strong>
          <p>ใช้ตั้งยอดคงเหลือและตำแหน่งของของเดิมในคลังก่อน Go-live ไม่ต้องกรอกชุดเดิมซ้ำทุกครั้ง</p>
        </article>
        <article>
          <b>หลัง Go-live</b>
          <strong>รับของตามสัญญา → ระบบสร้าง HU/FIFO ต่อเนื่อง</strong>
          <p>ข้อมูล Material และสัญญามาจาก Import รวมสัญญา ส่วน Packing เดิมนำกลับมาใช้ได้ และถามเพิ่มเฉพาะรูปแบบใหม่</p>
        </article>
      </section>

      <section className="panel fifo-setup-workflow">
        <div className="panel-title fifo-setup-workflow-head">
          <div><span>AUTOMATIC OPENING WORKFLOW</span><h3>ดึงข้อมูลรวมสัญญา → เติม Packing → ตรวจยอด → Publish</h3></div>
          <div className="fifo-setup-workflow-actions">
            {sourceLabel ? <small>{sourceLabel}</small> : null}
            <button className="btn primary" type="button" onClick={createFromContracts} disabled={!sourceRows.length || busy}>
              ดึงข้อมูลจากรวมสัญญา ({fmt(sourceRows.length)})
            </button>
            <button className="btn secondary" type="button" onClick={exportSetupWorkbook} disabled={!packaging || !opening || busy}>
              Export Setup Workbook
            </button>
            <button className="btn secondary" type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
              {busy ? "กำลังอ่านไฟล์..." : "Import ไฟล์ที่กรอกแล้ว"}
            </button>
          </div>
        </div>
        <div className="fifo-setup-steps">
          {[
            ["1", "Review Packaging", confirmed.packaging],
            ["2", "Review Opening HU", confirmed.opening],
            ["3", "Reconcile Stock", reconciled],
            ["4", "Publish Opening", supabaseSynced],
          ].map(([step, label, done], index) => (
            <article key={String(step)} className={done ? "done" : (index === 0 && packaging) || (index === 1 && confirmed.packaging) || (index === 2 && confirmed.opening) || (index === 3 && reconciled) ? "active" : ""}>
              <i>{done ? "✓" : step}</i><strong>{label}</strong>
            </article>
          ))}
        </div>
        {error ? <div className="fifo-setup-error">{error}</div> : null}
      </section>

      {!packaging || !opening ? (
        <section className="panel fifo-setup-empty">
          <i>↻</i>
          <h3>เริ่มจากข้อมูล “รวมสัญญา” ที่ Publish แล้ว</h3>
          <p>ระบบพบ {fmt(sourceRows.length)} รายการที่พร้อมตั้งต้น โดยไม่ต้องกรอก Material, บริษัท, Contract และ PO ซ้ำ</p>
          <div className="fifo-setup-workflow-actions">
            <button className="btn primary" type="button" onClick={createFromContracts} disabled={!sourceRows.length}>ดึงข้อมูลอัตโนมัติ</button>
            <a className="btn secondary" href={setupTemplateUrl} download>ดาวน์โหลด Template เปล่า</a>
          </div>
        </section>
      ) : (
        <section className="panel fifo-setup-review">
          <div className="fifo-setup-tabs">
            <button className={tab === "packaging" ? "active" : ""} type="button" onClick={() => setTab("packaging")}>1 · PACKAGING_PROFILE <b>{packagingRows.length}</b></button>
            <button className={tab === "opening" ? "active" : ""} type="button" disabled={!confirmed.packaging} onClick={() => setTab("opening")}>2 · OPENING_HANDLING_UNITS <b>{openingRows.length}</b></button>
          </div>
          <div className="fifo-setup-review-head">
            <div>
              <span>{tab === "packaging" ? "PACKAGING MASTER" : "OPENING INVENTORY"}</span>
              <h3>{tab === "packaging" ? "ตรวจ Packing ขนาด น้ำหนัก และความจุต่อพาเลทแยกตามพัสดุ/บริษัท" : "กรอกเฉพาะตำแหน่งกับยอดตั้งต้น ระบบเติมยอดคงเหลือให้"}</h3>
            </div>
            <b className={`fifo-setup-status ${(tab === "packaging" ? packagingValid : openingValid) ? "good" : "bad"}`}>
              {(tab === "packaging" ? packagingValid : openingValid) ? "พร้อมยืนยัน" : "กรอกช่องสีเหลืองให้ครบ"}
            </b>
          </div>

          <div className="live-table-wrap fifo-setup-table-wrap">
            {tab === "packaging" ? (
              <table className="live-table fifo-setup-table fifo-setup-edit-table">
                <thead><tr><th>Material / Description</th><th>Vendor / Contract / PO</th><th>Package Type</th><th>Units / Package</th><th>รายละเอียด Packing</th><th>Status</th></tr></thead>
                <tbody>
                  {packagingRows.map((row, index) => {
                    const type = cell(packaging, row, ["packagetype"]);
                    const units = numeric(cell(packaging, row, ["unitsperpackage"]));
                    const valid = Boolean(type && units > 0);
                    const detailComplete = packagingDetailsComplete(row);
                    const profileId = `${rowKey(packaging, row)}-${index}`;
                    const expanded = expandedProfile === profileId;
                    return (
                      <Fragment key={profileId}>
                        <tr>
                          <td><strong>{cell(packaging, row, ["material"]) || "—"}</strong><small>{cell(packaging, row, ["materialdescription"]) || "—"}</small></td>
                          <td><strong>{cell(packaging, row, ["vendoralias"]) || "ไม่พบชื่อบริษัท"}</strong><small>{[cell(packaging, row, ["contractno"]), cell(packaging, row, ["purchaseorder"])].filter(Boolean).join(" · ") || "—"}</small></td>
                          <td>
                            <select aria-label="Package Type" value={type} onChange={(event) => updateCell("PACKAGING_PROFILE", row, "PACKAGE_TYPE", event.target.value)}>
                              <option value="">เลือก Packing</option>
                              {packageTypes.map((option) => <option key={option} value={option}>{option}</option>)}
                            </select>
                          </td>
                          <td><input aria-label="Units per package" type="number" min="0.000001" step="any" value={cell(packaging, row, ["unitsperpackage"])} onChange={(event) => updateCell("PACKAGING_PROFILE", row, "UNITS_PER_PACKAGE", event.target.value)} /></td>
                          <td>
                            <button className={`fifo-setup-detail-toggle ${detailComplete ? "complete" : ""}`} type="button" onClick={() => setExpandedProfile(expanded ? "" : profileId)}>
                              {expanded ? "ซ่อนรายละเอียด" : detailComplete ? "ดูรายละเอียด Packing" : "กรอกรายละเอียด Packing"}
                            </button>
                            <small>{detailComplete
                              ? `${fmt(numeric(cell(packaging, row, ["boxesperpallet"])))} กล่อง · ${fmt(numeric(cell(packaging, row, ["unitsperpallet"])))} หน่วย/พาเลท`
                              : "ยังไม่มีขนาดและน้ำหนัก"}</small>
                          </td>
                          <td><b className={`fifo-setup-status ${valid && detailComplete ? "good" : valid ? "warning" : "bad"}`}>{!valid ? "กรอก Packing" : detailComplete ? "ครบ" : "รอตรวจรายละเอียด"}</b></td>
                        </tr>
                        {expanded ? (
                          <tr className="fifo-setup-detail-row">
                            <td colSpan={6}>
                              <div className="fifo-setup-detail-head">
                                <div><b>รายละเอียด Packing</b><span>{cell(packaging, row, ["material"])} · {cell(packaging, row, ["vendoralias"]) || "SUP-UNKNOWN"}</span></div>
                                <em>{cell(packaging, row, ["assumptionstatus"]) === "TEMPORARY_ESTIMATE" ? "ค่าประมาณชั่วคราว—ต้องยืนยันกับผู้ขาย/หน้างาน" : "ข้อมูล Packaging Master"}</em>
                              </div>
                              <div className="fifo-setup-calculated">
                                <article><span>น้ำหนักรวม/กล่อง</span><strong>{fmt(numeric(cell(packaging, row, ["boxgrossweightkg"])))} กก.</strong></article>
                                <article><span>จำนวนกล่อง/พาเลท</span><strong>{fmt(numeric(cell(packaging, row, ["boxesperpallet"])))} กล่อง</strong></article>
                                <article><span>จำนวนชิ้น/พาเลท</span><strong>{fmt(numeric(cell(packaging, row, ["unitsperpallet"])))} ชิ้น</strong></article>
                                <article><span>น้ำหนักรวม/พาเลท</span><strong>{fmt(numeric(cell(packaging, row, ["calcpalletgrosskg"])))} / {fmt(numeric(cell(packaging, row, ["maxpalletgrosskg"])))} กก.</strong></article>
                              </div>
                              <div className="fifo-setup-detail-groups">
                                {packagingDetailGroups.map((group) => (
                                  <section key={group.title}>
                                    <h4>{group.title}</h4>
                                    <div>
                                      {group.fields.map(([header, label, unit]) => (
                                        <label key={header}>
                                          <span>{label}</span>
                                          <span className="fifo-setup-number-input"><input aria-label={`${label} ${unit}`} type="number" min="0" step="any" value={cell(packaging, row, [header])} onChange={(event) => updateCell("PACKAGING_PROFILE", row, header, event.target.value)} /><i>{unit}</i></span>
                                        </label>
                                      ))}
                                    </div>
                                  </section>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="live-table fifo-setup-table fifo-setup-edit-table">
                <thead><tr><th>Generated HU ID</th><th>Material / Contract / Lot</th><th>Package</th><th>Physical Location</th><th>Initial Qty</th><th>Current Remain</th><th>Status</th></tr></thead>
                <tbody>
                  {huRows.map(({ row, huId }, index) => {
                    const initial = numeric(cell(opening, row, ["initialqty"]));
                    const remain = numeric(cell(opening, row, ["currentremain"]));
                    const valid = Boolean(cell(opening, row, ["physicallocation"])) && initial > 0 && remain >= 0 && remain <= initial;
                    return (
                      <tr key={huId}>
                        <td><strong>{huId}</strong><small>System generated</small></td>
                        <td><strong>{cell(opening, row, ["material"]) || "—"}</strong><small>{[cell(opening, row, ["contractno"]), cell(opening, row, ["deliveryinstallment", "receiptlot"])].filter(Boolean).join(" · ") || "—"}</small></td>
                        <td><strong>{cell(opening, row, ["packagetype"]) || "—"}</strong><small>{fmt(numeric(cell(opening, row, ["unitsperpackage"])))} หน่วย</small></td>
                        <td><input aria-label="Physical location" placeholder="เช่น A-01-01" value={cell(opening, row, ["physicallocation"])} onChange={(event) => updateCell("OPENING_HANDLING_UNITS", row, "PHYSICAL_LOCATION", event.target.value)} /></td>
                        <td><input aria-label="Initial quantity" type="number" min="0.000001" step="any" value={cell(opening, row, ["initialqty"])} onChange={(event) => updateOpeningInitial(row, event.target.value)} /></td>
                        <td><input aria-label="Current remain" type="number" min="0" step="any" value={cell(opening, row, ["currentremain"])} readOnly aria-readonly="true" title="ระบบคำนวณจากยอดตั้งต้นและรายการเคลื่อนไหวสต็อก" /></td>
                        <td><b className={`fifo-setup-status ${valid ? "good" : "bad"}`}>{valid ? "Valid" : `แถว ${index + 1}`}</b></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <footer className="fifo-setup-footer">
            <div>
              <strong>{fmt(tab === "packaging" ? packagingRows.length : openingRows.length)} records</strong>
              <small>{tab === "packaging" ? "ข้อมูลสัญญาเป็น Read-only ส่วน Packing ขนาด น้ำหนัก และพาเลทแก้ได้ก่อนยืนยัน" : "Current Remain เริ่มเท่ากับ Initial Qty และระบบจะปรับจากรายการเคลื่อนไหวสต็อกเท่านั้น"}</small>
            </div>
            {tab === "packaging" ? (
              <button className="btn primary" type="button" disabled={!packagingValid} onClick={confirmPackaging}>Confirm Packaging →</button>
            ) : (
              <div className="fifo-setup-footer-actions">
                <button className="btn secondary" type="button" onClick={fillOpeningDummy}>เติม Dummy สำหรับทดสอบ</button>
                <button className="btn primary" type="button" disabled={!openingValid} onClick={() => setConfirmed((current) => ({ ...current, opening: true }))}>Confirm Opening HU</button>
              </div>
            )}
          </footer>
        </section>
      )}

      {confirmed.opening ? (
        <section className="panel fifo-setup-publish">
          <div><span>RECONCILE &amp; PUBLISH</span><h3>ตรวจความพร้อมก่อนใช้เป็นหลักฐาน FIFO</h3><p>ตรวจยอดรวมกับ Stock คลังคลองเตยก่อน Publish และ Export ทะเบียน HU ไปตรวจหน้างานได้</p></div>
          <div className="fifo-setup-publish-actions">
            <button className="btn secondary" type="button" onClick={exportRegister}>Export HU Register</button>
            <button className="btn secondary" type="button" disabled={reconciled} onClick={() => setReconciled(true)}>{reconciled ? "✓ Reconciled" : "Run Reconcile"}</button>
            <button className="btn primary" type="button" disabled={!reconciled || supabaseSynced || busy} onClick={publish}>{supabaseSynced ? "✓ Opening Published to Supabase" : busy ? "กำลังบันทึก Supabase..." : publishedAt ? "Sync Opening to Supabase" : "Publish FIFO Opening Snapshot"}</button>
          </div>
          {supabaseSynced && publishedAt ? <div className="fifo-setup-notice"><b>Supabase พร้อมใช้ในหน้าคำนวณการจ่าย</b><span>{new Date(publishedAt).toLocaleString("th-TH")} · {fmt(packagingRows.length)} Profiles · {fmt(huRows.length)} HU</span></div> : publishedAt ? <div className="fifo-setup-error">Snapshot เดิมอยู่เฉพาะ Local Preview — กด Sync Opening to Supabase เพื่อให้หน้าคำนวณการจ่ายนำไปใช้</div> : null}
        </section>
      ) : null}
    </div>
  );
}
