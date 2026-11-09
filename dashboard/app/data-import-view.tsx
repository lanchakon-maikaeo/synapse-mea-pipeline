"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { formatDateTime, formatNumber } from "./lib";

import { text, Badge } from "./view-helpers";

export type ImportSourceKey = "stock" | "usage" | "contracts" | "history";
export const importSequence: ImportSourceKey[] = [
  "stock",
  "usage",
  "contracts",
  "history",
];
export const historicalSheetNames = [
  "History จ่ายได้ตามแผน",
  "History ไม่รับของ",
];
export type ImportedSheet = {
  headers: string[];
  rows: string[][];
  sheetName: string;
  totalRows: number;
};
export type ImportHistoryRecord = {
  id: string;
  sourceKey: ImportSourceKey;
  fileName: string;
  importedAt: string;
  importedBy: string;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  status: "published" | "needs_review" | "failed";
  version: number;
};

export type PublishedDataSnapshot = {
  id: string;
  version: number;
  publishedAt: string;
  publishedBy: string;
  batches: Array<{
    sourceKey: ImportSourceKey;
    fileName: string;
    acceptedCount: number;
    rejectedCount: number;
    version: number;
  }>;
};

export const publishedSnapshotStorageKey = "mea-synapse.local-published-data-snapshot";

export function loadPublishedSnapshot(): PublishedDataSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(publishedSnapshotStorageKey);
    if (!value) return null;
    const parsed = JSON.parse(value) as PublishedDataSnapshot;
    return parsed?.id && parsed?.publishedAt && Array.isArray(parsed.batches)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export const initialImportHistory: ImportHistoryRecord[] = [
  {
    id: "IMP-ST-20260721-003",
    sourceKey: "stock",
    fileName: "Stock_2026-07-21.xlsx",
    importedAt: "2026-07-21T07:00:00+07:00",
    importedBy: "Admin",
    rowCount: 2_223,
    acceptedCount: 2_218,
    rejectedCount: 5,
    status: "published",
    version: 3,
  },
  {
    id: "IMP-PO-20260721-006",
    sourceKey: "contracts",
    fileName: "รวมสัญญา_2026-07-21.xlsx",
    importedAt: "2026-07-21T06:30:00+07:00",
    importedBy: "Admin",
    rowCount: 4_806,
    acceptedCount: 4_791,
    rejectedCount: 15,
    status: "published",
    version: 6,
  },
  {
    id: "IMP-HX-20260718-002",
    sourceKey: "history",
    fileName: "คลังคลองเตย_2026-07-18.xlsx",
    importedAt: "2026-07-18T15:42:00+07:00",
    importedBy: "Admin",
    rowCount: 1_348,
    acceptedCount: 1_348,
    rejectedCount: 0,
    status: "published",
    version: 2,
  },
  {
    id: "IMP-CM-20260701-004",
    sourceKey: "usage",
    fileName: "อัตราการใช้งาน_2026-07.xlsx",
    importedAt: "2026-07-01T09:15:00+07:00",
    importedBy: "Admin",
    rowCount: 2_000,
    acceptedCount: 1_992,
    rejectedCount: 8,
    status: "published",
    version: 4,
  },
  {
    id: "IMP-ST-20260720-002",
    sourceKey: "stock",
    fileName: "Stock_2026-07-20.xlsx",
    importedAt: "2026-07-20T07:02:00+07:00",
    importedBy: "Admin",
    rowCount: 2_218,
    acceptedCount: 2_218,
    rejectedCount: 0,
    status: "published",
    version: 2,
  },
  {
    id: "IMP-PO-20260720-005",
    sourceKey: "contracts",
    fileName: "รวมสัญญา_2026-07-20.xlsx",
    importedAt: "2026-07-20T06:35:00+07:00",
    importedBy: "Admin",
    rowCount: 4_781,
    acceptedCount: 4_769,
    rejectedCount: 12,
    status: "published",
    version: 5,
  },
];

export const importProfiles: Record<
  ImportSourceKey,
  {
    title: string;
    subtitle: string;
    schedule: string;
    icon: string;
    fileHint: string;
    required: Array<{ label: string; aliases: string[] }>;
    rules: string[];
  }
> = {
  stock: {
    title: "Stock Snapshot",
    subtitle: "Stock คลังกลางและคลังเขตจาก SAP",
    schedule: "รายวัน",
    icon: "ST",
    fileHint: "Stock.xlsx",
    required: [
      {
        label: "Material",
        aliases: ["material", "materialnumber", "materialno", "วัสดุ", "เลขวัสดุ", "รหัสวัสดุ"],
      },
      { label: "Plant", aliases: ["plant", "โรงงาน"] },
      {
        label: "Storage Location",
        aliases: ["storagelocation", "sloc", "ที่เก็บสินค้า", "สถานที่เก็บ", "คลังย่อย"],
      },
      {
        label: "Unrestricted",
        aliases: ["unrestricted", "ไม่จำกัด", "ยอดไม่จำกัด"],
      },
    ],
    rules: [
      "ใช้ Stock คอลัมน์ไม่จำกัดเท่านั้น",
      "คลังคลองเตย = Plant 2401 / Storage Location 0001",
      "Stock เขตสรุปทุก Storage Location ที่อนุญาตของ Plant นั้น",
    ],
  },
  usage: {
    title: "Usage Rate / CMP",
    subtitle: "ประวัติการใช้งานและค่า CMP รายเดือน",
    schedule: "รายเดือน",
    icon: "CM",
    fileHint: "อัตราการใช้งาน.xlsx",
    required: [
      {
        label: "Material",
        aliases: ["material", "materialnumber", "materialno", "วัสดุ", "เลขวัสดุ", "รหัสวัสดุ"],
      },
      { label: "LY", aliases: ["ly", "lastyear"] },
      { label: "12M", aliases: ["12m", "12เดือน"] },
      { label: "6M", aliases: ["6m", "6เดือน"] },
      { label: "4M", aliases: ["4m", "4เดือน"] },
    ],
    rules: [
      "เครื่องหมาย - แทนเดือนที่ไม่มีการใช้งานและตีค่าเป็น 0",
      "CMP = ค่าเฉลี่ย LY, 12M, 6M และ 4M",
      "CMP ปัดเป็นจำนวนเต็มก่อนคำนวณแผน",
    ],
  },
  contracts: {
    title: "Contract & Delivery Lot",
    subtitle: "สัญญา PO ผู้ขาย และงวดส่งมอบ",
    schedule: "รายวัน",
    icon: "PO",
    fileHint: "รวมสัญญา.xlsx",
    required: [
      {
        label: "Material",
        aliases: ["material", "materialnumber", "materialno", "วัสดุ", "เลขวัสดุ", "รหัสวัสดุ"],
      },
      {
        label: "PO / Contract",
        aliases: ["po", "purchaseorder", "สัญญา", "เลขที่po", "รหัสจัดหา"],
      },
      {
        label: "Accepted Date",
        aliases: ["วันผ่านตรวจรับ", "accepteddate", "receiptdate", "วันที่รับ"],
      },
    ],
    rules: [
      "นำเข้าเฉพาะแถวที่มี Material",
      "อัปเดตของเดิมและเพิ่มสัญญาใหม่ใน Snapshot เดียวกัน",
      "ใช้วันผ่านตรวจรับเป็นหลักฐานลำดับ FIFO",
    ],
  },
  history: {
    title: "Historical Distribution Data",
    subtitle: "ประวัติการจ่ายได้ตามแผนและประวัติไม่รับของสำหรับ AI",
    schedule: "นำเข้าข้อมูลตั้งต้น",
    icon: "HX",
    fileHint: "คลังคลองเตย (1).xlsx",
    required: [
      { label: "Material", aliases: ["material", "รหัสพัสดุ", "รหัสวัสดุ"] },
      {
        label: "District",
        aliases: ["sourcesheet", "district", "เขต", "การไฟฟ้าเขต"],
      },
      {
        label: "Planned Quantity",
        aliases: ["จำนวนการเติมเต็มพัสดุ", "plannedquantity", "plannerqty"],
      },
      {
        label: "Actual Quantity",
        aliases: ["จำนวนที่จ่ายได้จริง", "actualquantity", "actualqty"],
      },
      {
        label: "Outcome",
        aliases: ["สถานะการจ่าย", "outcome", "status"],
      },
    ],
    rules: [
      "อ่านเฉพาะชีท History จ่ายได้ตามแผน และ History ไม่รับของ",
      "เก็บผลลัพธ์ ACCEPTED และ REJECTED แยกกัน โดยไม่ตีความการไม่รับเป็น Usage = 0",
      "ใช้ประวัติรายรายการเป็น Evidence ของ AI Suggestion และการแจ้งเตือนคำขอผิดปกติ",
    ],
  },
};

export function normalizeImportHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_./\\()\-]+/g, "");
}

export function findImportColumn(headers: string[], aliases: string[]) {
  // Excel rows can be sparse when the source sheet contains blank columns.
  // Array#map preserves those empty slots, while findIndex still visits them
  // as undefined values. Normalize every position explicitly so Historical
  // sheets with column gaps can be matched safely.
  const normalizedHeaders = Array.from(
    { length: headers.length },
    (_, index) => normalizeImportHeader(headers[index]),
  );
  const normalizedAliases = aliases.map(normalizeImportHeader).filter(Boolean);
  const exactIndex = normalizedHeaders.findIndex((header) =>
    normalizedAliases.includes(header),
  );
  if (exactIndex >= 0) return exactIndex;
  return normalizedHeaders.findIndex((header) =>
    normalizedAliases.some(
      (alias) => alias.length >= 3 && (header.includes(alias) || alias.includes(header)),
    ),
  );
}

export function importedSheetFromMatrix(
  matrix: string[][],
  sheetName: string,
  required: Array<{ label: string; aliases: string[] }>,
): ImportedSheet {
  const candidates = matrix.slice(0, 30);
  let headerIndex = 0;
  let bestScore = -1;
  candidates.forEach((row, index) => {
    const score = required.filter(
      (requirement) => findImportColumn(row, requirement.aliases) >= 0,
    ).length;
    if (score > bestScore) {
      bestScore = score;
      headerIndex = index;
    }
  });
  return {
    headers: matrix[headerIndex] ?? [],
    rows: matrix.slice(headerIndex + 1, headerIndex + 5001),
    sheetName,
    totalRows: Math.max(0, matrix.length - headerIndex - 1),
  };
}

export function parseCsvMatrix(source: string) {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) matrix.push(row);
  return matrix;
}

export function excelColumnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return [...letters].reduce(
    (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
    0,
  ) - 1;
}

export function parseExcelWorksheet(
  parser: DOMParser,
  source: Uint8Array,
  shared: string[],
) {
  const worksheet = parser.parseFromString(
    new TextDecoder().decode(source),
    "text/xml",
  );
  return [...worksheet.getElementsByTagName("row")]
    .map((rowNode) => {
      const values: string[] = [];
      [...rowNode.getElementsByTagName("c")].forEach((cellNode) => {
        const column = excelColumnIndex(cellNode.getAttribute("r") ?? "A1");
        const kind = cellNode.getAttribute("t") ?? "";
        const raw = cellNode.getElementsByTagName("v")[0]?.textContent ?? "";
        const value =
          kind === "s"
            ? shared[Number(raw)] ?? ""
            : kind === "inlineStr"
              ? cellNode.getElementsByTagName("is")[0]?.textContent ?? ""
              : raw;
        values[column] = value.trim();
      });
      return values;
    })
    .filter((row) => row.some(Boolean));
}

export async function readImportSheets(
  file: File,
  required: Array<{ label: string; aliases: string[] }>,
  requestedSheetNames?: string[],
): Promise<ImportedSheet[]> {
  if (file.name.toLowerCase().endsWith(".csv")) {
    if (requestedSheetNames?.length) {
      throw new Error("ข้อมูล Historical ต้องเป็นไฟล์ .xlsx ที่มี 2 ชีทตามที่กำหนด");
    }
    const matrix = parseCsvMatrix(await file.text());
    return [importedSheetFromMatrix(matrix, "CSV", required)];
  }

  const { strFromU8, unzipSync } = await import("fflate");
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const parser = new DOMParser();
  const sharedXml = archive["xl/sharedStrings.xml"];
  const shared = sharedXml
    ? [...parser.parseFromString(strFromU8(sharedXml), "text/xml").getElementsByTagName("si")].map(
        (node) => node.textContent ?? "",
      )
    : [];
  const workbookXml = archive["xl/workbook.xml"];
  if (!workbookXml) throw new Error("ไม่พบ Workbook ในไฟล์ Excel");
  const workbook = parser.parseFromString(strFromU8(workbookXml), "text/xml");
  const relationshipXml = archive["xl/_rels/workbook.xml.rels"];
  const relationships = relationshipXml
    ? [...parser.parseFromString(strFromU8(relationshipXml), "text/xml").getElementsByTagName("Relationship")]
    : [];
  const targetById = new Map(
    relationships.map((node) => [
      node.getAttribute("Id") ?? "",
      node.getAttribute("Target") ?? "",
    ]),
  );
  const fallbackPaths = Object.keys(archive)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/sheet(\d+)/i)?.[1] ?? 0);
      const rightNumber = Number(right.match(/sheet(\d+)/i)?.[1] ?? 0);
      return leftNumber - rightNumber;
    });
  const workbookSheets = [...workbook.getElementsByTagName("sheet")].map(
    (node, index) => {
      const relationshipId = node.getAttribute("r:id") ?? "";
      const target = targetById.get(relationshipId) ?? "";
      const path = target
        ? target.startsWith("/")
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, "")}`
        : fallbackPaths[index];
      return {
        name: node.getAttribute("name") ?? `Sheet ${index + 1}`,
        path,
      };
    },
  );
  const selected = requestedSheetNames?.length
    ? requestedSheetNames.map((requestedName) =>
        workbookSheets.find(
          (item) => normalizeImportHeader(item.name) === normalizeImportHeader(requestedName),
        ),
      )
    : [workbookSheets[0]];
  if (selected.some((item) => !item?.path || !archive[item.path])) {
    const missingNames = requestedSheetNames?.filter(
      (requestedName) =>
        !workbookSheets.some(
          (item) => normalizeImportHeader(item.name) === normalizeImportHeader(requestedName),
        ),
    );
    throw new Error(
      missingNames?.length
        ? `ไม่พบชีทที่จำเป็น: ${missingNames.join(", ")}`
        : "ไม่พบ Worksheet ในไฟล์ Excel",
    );
  }
  return selected.map((item) => {
    const matrix = parseExcelWorksheet(parser, archive[item!.path], shared);
    return importedSheetFromMatrix(matrix, item!.name, required);
  });
}

export async function readImportSheet(
  file: File,
  required: Array<{ label: string; aliases: string[] }>,
): Promise<ImportedSheet> {
  const sheets = await readImportSheets(file, required);
  if (!sheets[0]) throw new Error("ไม่พบ Worksheet ในไฟล์ Excel");
  return sheets[0];
}

export function DataImportView({ onOpenPlanner }: { onOpenPlanner: () => void }) {
  const [sourceKey, setSourceKey] = useState<ImportSourceKey>("stock");
  const [completedSequence, setCompletedSequence] = useState<ImportSourceKey[]>([]);
  // Start empty during SSR, then restore the local snapshot on the client.
  // This avoids a server/client HTML mismatch when the browser already has a
  // previously published Local Demo snapshot in localStorage.
  const [publishedSnapshot, setPublishedSnapshot] = useState<PublishedDataSnapshot | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<ImportedSheet | null>(null);
  const [historicalSheets, setHistoricalSheets] = useState<ImportedSheet[]>([]);
  const [history, setHistory] = useState<ImportHistoryRecord[]>(
    initialImportHistory,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [manualMapping, setManualMapping] = useState<Record<string, number>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const profile = importProfiles[sourceKey];
  const latestImport = history[0] ?? null;
  const nextRequiredSource = importSequence[completedSequence.length] ?? null;
  const sequenceComplete = completedSequence.length === importSequence.length;
  const snapshotPublishedAt = publishedSnapshot?.publishedAt ?? null;

  useEffect(() => {
    const restoreSnapshot = window.setTimeout(() => {
      setPublishedSnapshot(loadPublishedSnapshot());
    }, 0);
    return () => window.clearTimeout(restoreSnapshot);
  }, []);

  const validation = useMemo(() => {
    if (!sheet) return null;
    const sheetsToValidate =
      sourceKey === "history" && historicalSheets.length ? historicalSheets : [sheet];
    const createMatches = (candidate: ImportedSheet) =>
      profile.required.map((requirement) => {
        const manuallySelected = Object.prototype.hasOwnProperty.call(
          manualMapping,
          requirement.label,
        );
        return {
          ...requirement,
          manuallySelected,
          index: manuallySelected
            ? manualMapping[requirement.label]
            : findImportColumn(candidate.headers, requirement.aliases),
        };
      });
    const sheetStats = sheetsToValidate.map((candidate) => {
      const candidateMatches = createMatches(candidate);
      const materialColumn =
        candidateMatches.find((item) => item.label === "Material")?.index ?? -1;
      const invalidRows = candidate.rows.filter((row) =>
        materialColumn >= 0 ? !String(row[materialColumn] ?? "").trim() : false,
      ).length;
      return {
        sheet: candidate,
        matches: candidateMatches,
        missing: candidateMatches.filter((item) => item.index < 0),
        invalidRows,
        validRows: Math.max(0, candidate.totalRows - invalidRows),
      };
    });
    const matches = createMatches(sheet);
    const missingLabels = new Set(
      sheetStats.flatMap((item) => item.missing.map((match) => match.label)),
    );
    const invalidRows = sheetStats.reduce((sum, item) => sum + item.invalidRows, 0);
    const totalRows = sheetStats.reduce((sum, item) => sum + item.sheet.totalRows, 0);
    return {
      matches,
      missing: profile.required.filter((item) => missingLabels.has(item.label)),
      invalidRows,
      validRows: Math.max(0, totalRows - invalidRows),
      totalRows,
      sheetStats,
    };
  }, [historicalSheets, manualMapping, profile, sheet, sourceKey]);

  const resetFile = () => {
    setFile(null);
    setSheet(null);
    setHistoricalSheets([]);
    setError("");
    setReviewOpen(false);
    setManualMapping({});
    if (inputRef.current) inputRef.current.value = "";
  };

  const loadFile = async (nextFile: File | undefined) => {
    if (!nextFile) return;
    if (!/\.(xlsx|csv)$/i.test(nextFile.name)) {
      setError("รองรับเฉพาะไฟล์ .xlsx และ .csv");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const parsedSheets =
        sourceKey === "history"
          ? await readImportSheets(nextFile, profile.required, historicalSheetNames)
          : [await readImportSheet(nextFile, profile.required)];
      const parsed = parsedSheets[0];
      if (!parsed?.headers.length) throw new Error("ไม่พบหัวตารางในไฟล์");
      setFile(nextFile);
      setSheet(parsed);
      setHistoricalSheets(sourceKey === "history" ? parsedSheets : []);
      setReviewOpen(true);
    } catch (loadError) {
      setFile(null);
      setSheet(null);
      setHistoricalSheets([]);
      setError(
        loadError instanceof Error ? loadError.message : "ไม่สามารถอ่านไฟล์ได้",
      );
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void loadFile(event.target.files?.[0]);
  };

  const confirmImport = () => {
    if (!file || !sheet || !validation || validation.missing.length || busy) return;
    const sourceIndex = importSequence.indexOf(sourceKey);
    if (sourceIndex !== completedSequence.length) return;
    const nextVersion =
      Math.max(
        0,
        ...history
          .filter((record) => record.sourceKey === sourceKey)
          .map((record) => record.version),
      ) + 1;
    const nextRecord: ImportHistoryRecord = {
      id: `IMP-${sourceKey.toUpperCase()}-${Date.now()}`,
      sourceKey,
      fileName: file.name,
      importedAt: new Date().toISOString(),
      importedBy: "Admin",
      rowCount: validation.totalRows,
      acceptedCount: validation.validRows,
      rejectedCount: validation.invalidRows,
      status: validation.invalidRows > 0 ? "needs_review" : "published",
      version: nextVersion,
    };
    setHistory((current) => [nextRecord, ...current]);
    const nextCompleted = [...completedSequence, sourceKey];
    setCompletedSequence(nextCompleted);
    const nextSource = importSequence[nextCompleted.length];
    setReviewOpen(false);
    setFile(null);
    setSheet(null);
    setHistoricalSheets([]);
    setError("");
    setManualMapping({});
    if (inputRef.current) inputRef.current.value = "";
    if (nextSource) setSourceKey(nextSource);
  };

  const restartSequence = () => {
    setCompletedSequence([]);
    setSourceKey("stock");
    resetFile();
  };

  const publishSnapshot = () => {
    if (!sequenceComplete) return;
    const publishedAt = new Date().toISOString();
    const nextVersion = (publishedSnapshot?.version ?? 0) + 1;
    const nextSnapshot: PublishedDataSnapshot = {
      id: `SNAP-${publishedAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-V${nextVersion}`,
      version: nextVersion,
      publishedAt,
      publishedBy: "Admin",
      batches: importSequence.map((key) => {
        const record = [...history]
          .filter((item) => item.sourceKey === key)
          .sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0];
        return {
          sourceKey: key,
          fileName: record?.fileName ?? "—",
          acceptedCount: record?.acceptedCount ?? 0,
          rejectedCount: record?.rejectedCount ?? 0,
          version: record?.version ?? 0,
        };
      }),
    };
    window.localStorage.setItem(publishedSnapshotStorageKey, JSON.stringify(nextSnapshot));
    setPublishedSnapshot(nextSnapshot);
  };

  useEffect(() => {
    if (!reviewOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") resetFile();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [reviewOpen]);

  return (
    <div className="stack import-page">
      <section className="import-hero">
        <div>
          <span>DATA FOUNDATION · LOCAL / STAGING</span>
          <h2>จากไฟล์ SAP สู่ข้อมูลพร้อมใช้งาน</h2>
          <p>
            นำเข้า ตรวจสอบ และประมวลผลเป็น Snapshot ก่อนส่งต่อให้แต่ละ Module
            โดยไม่เขียนทับข้อมูลเดิมทันที
          </p>
        </div>
        <div className="import-hero-actions">
          <div className="import-hero-state">
            <i />
            <span>
              <small>Environment</small>
              <strong>LOCAL PREVIEW</strong>
            </span>
          </div>
        </div>
      </section>

      <section className="import-overview" aria-label="สถานะการนำเข้าล่าสุด">
        <article className="import-latest-card">
          <span>LAST IMPORT</span>
          <strong>{latestImport ? formatDateTime(latestImport.importedAt) : "—"}</strong>
          <small>
            {latestImport
              ? `${importProfiles[latestImport.sourceKey].title} · ${latestImport.fileName}`
              : "ยังไม่มีประวัติการนำเข้า"}
          </small>
        </article>
        <article>
          <span>IMPORT BATCHES</span>
          <strong>{formatNumber(history.length)}</strong>
          <small>เก็บเป็นเวอร์ชัน ไม่เขียนทับประวัติ</small>
        </article>
        <article>
          <span>ACCEPTED ROWS</span>
          <strong>
            {formatNumber(history.reduce((sum, record) => sum + record.acceptedCount, 0))}
          </strong>
          <small>จำนวนแถวที่ผ่านการตรวจทั้งหมด</small>
        </article>
        <article>
          <span>NEEDS REVIEW</span>
          <strong>
            {formatNumber(history.reduce((sum, record) => sum + record.rejectedCount, 0))}
          </strong>
          <small>เก็บแยกเพื่อตรวจสอบ ไม่ทิ้งข้อมูล</small>
        </article>
      </section>

      <section className="panel import-sequence-panel" aria-label="ลำดับการนำเข้าข้อมูล">
        <div className="panel-title import-sequence-title">
          <div>
            <span>ORDERED IMPORT · ADMIN WORKFLOW</span>
            <h3>นำเข้าข้อมูลตามลำดับ 1–4 เพื่อป้องกันข้อมูลตกหล่น</h3>
            <p>
              เลือกไฟล์จากกล่องปัจจุบัน ตรวจสอบข้อมูลใน Pop-up และกดยืนยัน
              ระบบจึงจะเปิดกล่องถัดไปให้อัตโนมัติ
            </p>
          </div>
          <div className={`import-sequence-progress ${sequenceComplete ? "complete" : ""}`}>
            <strong>{completedSequence.length} / {importSequence.length}</strong>
            <small>{sequenceComplete ? "ครบทุกแหล่งข้อมูล" : "เสร็จแล้วในรอบนี้"}</small>
          </div>
        </div>

        <div className="import-sequence-grid">
          {importSequence.map((key, index) => {
            const item = importProfiles[key];
            const completed = completedSequence.includes(key);
            const current = key === nextRequiredSource && !sequenceComplete;
            const locked = index > completedSequence.length;
            const selected = sourceKey === key;
            return (
              <button
                type="button"
                key={key}
                className={`${selected ? "selected" : ""} ${completed ? "completed" : ""} ${current ? "current" : ""}`}
                disabled={locked}
                aria-current={selected ? "step" : undefined}
                aria-label={
                  current
                    ? `Import ${item.fileHint}`
                    : completed
                      ? `${item.title} ยืนยันแล้ว`
                      : `${item.title} รอขั้นตอนก่อนหน้า`
                }
                onClick={() => {
                  if (locked || completed) return;
                  setSourceKey(key);
                  resetFile();
                  window.setTimeout(() => inputRef.current?.click(), 0);
                }}
              >
                <i>{completed ? "✓" : locked ? "🔒" : index + 1}</i>
                <span>
                  <b>STEP {index + 1}</b>
                  <strong>{item.title}</strong>
                  <small>{item.fileHint} · {item.schedule}</small>
                  <em>
                    {completed
                      ? "✓ ยืนยันแล้ว"
                      : current
                        ? "⇧ Import File"
                        : "🔒 รอขั้นตอนก่อนหน้า"}
                  </em>
                </span>
              </button>
            );
          })}
        </div>

        <input
          ref={inputRef}
          className="import-hidden-input"
          type="file"
          accept=".xlsx,.csv"
          onChange={onFileChange}
          aria-label={`เลือกไฟล์ ${profile.fileHint}`}
        />

        {error && (
          <div className="form-error import-sequence-error" role="alert">
            {error}
          </div>
        )}

        <footer className={`import-readiness-strip ${sequenceComplete ? "ready" : ""} ${snapshotPublishedAt ? "published" : ""}`}>
          <div>
            <i>{sequenceComplete ? "✓" : "!"}</i>
            <span>
              <strong>
                {sequenceComplete && snapshotPublishedAt
                  ? "Data Snapshot: Published"
                  : sequenceComplete
                    ? "Data Readiness: Ready to publish"
                    : snapshotPublishedAt
                      ? "Data Snapshot: Published · new import in progress"
                    : "Data Readiness: In progress"}
              </strong>
              <small>
                {sequenceComplete && snapshotPublishedAt
                  ? `Snapshot v${publishedSnapshot?.version} · ${publishedSnapshot?.id} · ยืนยันเมื่อ ${formatDateTime(snapshotPublishedAt)}`
                  : sequenceComplete
                    ? "ข้อมูลทั้ง 4 แหล่งผ่านการตรวจแล้ว กรุณายืนยันก่อนส่งต่อให้ Module"
                    : snapshotPublishedAt
                      ? `Planner ใช้ Snapshot v${publishedSnapshot?.version} ล่าสุดได้ระหว่างนำเข้ารอบใหม่`
                    : `รายการถัดไป: ${nextRequiredSource ? importProfiles[nextRequiredSource].title : "—"}`}
              </small>
            </span>
          </div>
          {(sequenceComplete || snapshotPublishedAt) && (
            <div className="import-publish-actions">
              {sequenceComplete && (
                <button type="button" className="btn import-publish-button" onClick={publishSnapshot}>
                  {snapshotPublishedAt ? "Publish New Data Snapshot" : "Publish Data Snapshot"}
                  <small>{snapshotPublishedAt ? "เผยแพร่ Snapshot เวอร์ชันใหม่" : "ยืนยันชุดข้อมูลและนำไปใช้งาน"}</small>
                </button>
              )}
              {snapshotPublishedAt && (
                <>
                  <button type="button" className="btn primary" onClick={onOpenPlanner}>
                    ไปที่ Planner Workspace →
                  </button>
                  {sequenceComplete && (
                    <button type="button" className="btn ghost" onClick={restartSequence}>
                      เริ่มรอบ Import ใหม่
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </footer>
      </section>

      {snapshotPublishedAt && publishedSnapshot && (
        <section className="panel published-snapshot-panel" aria-label="Published Data Snapshot">
          <div className="panel-title">
            <div>
              <span>DATA SNAPSHOT · PUBLISHED</span>
              <h3>ชุดข้อมูลที่ Planner ใช้งานอยู่</h3>
              <p>
                ระบบเก็บรายการแหล่งข้อมูลและเวอร์ชันที่ประกอบเป็น Snapshot นี้ไว้สำหรับสอบกลับ
              </p>
            </div>
            <Badge>v{publishedSnapshot.version}</Badge>
          </div>
          <div className="published-snapshot-meta">
            <span><b>Snapshot ID</b>{publishedSnapshot.id}</span>
            <span><b>Published by</b>{publishedSnapshot.publishedBy}</span>
            <span><b>Published at</b>{formatDateTime(publishedSnapshot.publishedAt)}</span>
          </div>
          <div className="published-snapshot-sources">
            {publishedSnapshot.batches.map((batch) => (
              <article key={batch.sourceKey}>
                <i>{importProfiles[batch.sourceKey].icon}</i>
                <span>
                  <b>{importProfiles[batch.sourceKey].title}</b>
                  <small>{batch.fileName} · v{batch.version}</small>
                </span>
                <strong>{formatNumber(batch.acceptedCount)} rows</strong>
              </article>
            ))}
          </div>
        </section>
      )}

      {reviewOpen && file && sheet && validation && (
        <div
          className="import-review-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) resetFile();
          }}
        >
          <section
            className="import-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-review-title"
          >
            <header>
              <div>
                <span>STEP {importSequence.indexOf(sourceKey) + 1} · DATA REVIEW</span>
                <h3 id="import-review-title">
                  {sourceKey === "history" ? "ตรวจสอบประวัติทั้ง 2 ชีทก่อนยืนยัน" : "ตรวจสอบข้อมูลก่อนยืนยัน"}
                </h3>
                <p>
                  {sourceKey === "history"
                    ? "ระบบแยกผลจ่ายได้ตามแผนและไม่รับของ แต่ยืนยันเป็น Historical Import รอบเดียว"
                    : "ระบบจะยังไม่รับข้อมูลและไม่เปิดขั้นตอนถัดไปจนกด Confirm"}
                </p>
              </div>
              <button type="button" onClick={resetFile} aria-label="ปิดหน้าตรวจสอบ">
                ×
              </button>
            </header>

            <div className="import-review-file">
              <i>{profile.icon}</i>
              <div>
                <strong>{file.name}</strong>
                <small>
                  {(file.size / 1024 / 1024).toFixed(2)} MB · {sourceKey === "history" ? `${historicalSheets.length} ชีท` : `Sheet: ${sheet.sheetName}`} ·{" "}
                  {formatNumber(validation.totalRows)} แถว
                </small>
              </div>
              <Badge>{profile.title}</Badge>
            </div>

            <div className="import-review-summary">
              <article>
                <span>ทั้งหมด</span>
                <strong>{formatNumber(validation.totalRows)}</strong>
                <small>Rows detected</small>
              </article>
              <article className="accepted">
                <span>พร้อมนำเข้า</span>
                <strong>{formatNumber(validation.validRows)}</strong>
                <small>Accepted rows</small>
              </article>
              <article className={validation.invalidRows ? "warning" : "accepted"}>
                <span>ต้องตรวจสอบ</span>
                <strong>{formatNumber(validation.invalidRows)}</strong>
                <small>เก็บแยก ไม่ทิ้งข้อมูล</small>
              </article>
              <article className={validation.missing.length ? "failed" : "accepted"}>
                <span>คอลัมน์จำเป็น</span>
                <strong>{validation.matches.length - validation.missing.length}/{validation.matches.length}</strong>
                <small>{validation.missing.length ? "ข้อมูลยังไม่พร้อม" : "ตรวจพบครบ"}</small>
              </article>
            </div>

            {sourceKey === "history" && historicalSheets.length === 2 && (
              <div className="import-history-outcome-tabs" aria-label="เลือกตรวจสอบชีท Historical">
                {validation.sheetStats.map((item) => {
                  const accepted = normalizeImportHeader(item.sheet.sheetName).includes(
                    normalizeImportHeader("จ่ายได้ตามแผน"),
                  );
                  return (
                    <button
                      type="button"
                      key={item.sheet.sheetName}
                      className={`${accepted ? "accepted" : "rejected"} ${sheet.sheetName === item.sheet.sheetName ? "active" : ""}`}
                      onClick={() => setSheet(item.sheet)}
                    >
                      <i>{accepted ? "✓" : "×"}</i>
                      <span>
                        <b>{accepted ? "จ่ายได้ตามแผน" : "ไม่รับของ"}</b>
                        <small>{item.sheet.sheetName}</small>
                      </span>
                      <strong>{formatNumber(item.sheet.totalRows)} รายการ</strong>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="import-review-body">
              <div className="import-review-table">
                <div>
                  <strong>Data Preview</strong>
                  <small>5 แถวแรก · {sheet.sheetName}</small>
                </div>
                <div className="live-table-wrap">
                  <table className="live-table">
                    <thead>
                      <tr>
                        {sheet.headers.slice(0, 8).map((header, index) => (
                          <th key={`${header}-${index}`}>{header || `Column ${index + 1}`}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.rows.slice(0, 5).map((row, rowIndex) => (
                        <tr key={`review-${rowIndex}`}>
                          {sheet.headers.slice(0, 8).map((_, columnIndex) => (
                            <td key={`review-cell-${rowIndex}-${columnIndex}`}>
                              {text(row[columnIndex])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <aside className="import-review-checks">
                <strong>Column Mapping · {sheet.sheetName}</strong>
                {validation.matches.map((match) => (
                  <div key={match.label} className={match.index < 0 ? "failed" : ""}>
                    <i>{match.index < 0 ? "!" : "✓"}</i>
                    <span>
                      <b>{match.label}</b>
                      <select
                        aria-label={`เลือกคอลัมน์สำหรับ ${match.label}`}
                        value={match.index >= 0 ? match.index : ""}
                        onChange={(event) =>
                          setManualMapping((current) => ({
                            ...current,
                            [match.label]: event.target.value === "" ? -1 : Number(event.target.value),
                          }))
                        }
                      >
                        <option value="">— เลือกคอลัมน์ —</option>
                        {sheet.headers.map((header, columnIndex) => (
                          <option key={`${match.label}-${columnIndex}`} value={columnIndex}>
                            {header || `Column ${columnIndex + 1}`}
                          </option>
                        ))}
                      </select>
                      <small>
                        {match.index < 0
                          ? "ระบบยังจับคู่ไม่ได้ กรุณาเลือกเอง"
                          : match.manuallySelected
                            ? "Admin เลือกคอลัมน์นี้"
                            : "ระบบจับคู่อัตโนมัติ"}
                      </small>
                    </span>
                  </div>
                ))}
                <section>
                  <strong>Business Rules</strong>
                  {profile.rules.map((rule) => (
                    <p key={rule}>• {rule}</p>
                  ))}
                </section>
              </aside>
            </div>

            {validation.missing.length > 0 && (
              <div className="form-error import-review-error" role="alert">
                ไม่พบคอลัมน์ที่จำเป็น: {validation.missing.map((item) => item.label).join(", ")}
                กรุณาเลือกคอลัมน์ที่ตรงกันใน Column Mapping หรือ Cancel เพื่อเลือกไฟล์ใหม่
              </div>
            )}

            <footer>
              <p>
                <strong>Local Preview:</strong> การยืนยันจะสร้าง Import Batch จำลอง
                และเก็บประวัติเดิมไว้ ไม่ส่งข้อมูลเข้า Production
              </p>
              <div>
                <button type="button" className="btn ghost" onClick={resetFile}>
                  Cancel · เลือกไฟล์ใหม่
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={confirmImport}
                  disabled={validation.missing.length > 0 || busy}
                >
                  Confirm & Continue →
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}

      <section className="panel import-history-panel">
        <div className="panel-title">
          <div>
            <span>IMPORT HISTORY · APPEND-ONLY</span>
            <h3>ประวัติการนำเข้าและเวอร์ชันข้อมูล</h3>
          </div>
          <small>{history.length} Import Batches</small>
        </div>
        <aside className="import-history-notice">
          <i>✓</i>
          <div>
            <strong>ข้อมูลใหม่ไม่ลบข้อมูลเดิม</strong>
            <p>
              แต่ละการอัปโหลดจะสร้าง Batch และ Version ใหม่ เพื่อให้ตรวจสอบย้อนหลัง
              เปรียบเทียบ และสอบกลับว่าใครนำเข้าข้อมูลเมื่อใดได้
            </p>
          </div>
        </aside>
        <div className="live-table-wrap import-history-table">
          <table className="live-table">
            <thead>
              <tr>
                <th>Batch ID</th>
                <th>ประเภทข้อมูล</th>
                <th>ไฟล์</th>
                <th>Version</th>
                <th>ผลการตรวจ</th>
                <th>ผู้ Import</th>
                <th>วันและเวลา</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {history.map((record) => (
                <tr key={record.id}>
                  <td>
                    <strong>{record.id}</strong>
                  </td>
                  <td>{importProfiles[record.sourceKey].title}</td>
                  <td>
                    <span className="import-file-cell">
                      <i>{importProfiles[record.sourceKey].icon}</i>
                      <span>{record.fileName}</span>
                    </span>
                  </td>
                  <td>v{record.version}</td>
                  <td>
                    <strong>{formatNumber(record.acceptedCount)}</strong> ผ่าน ·{" "}
                    <span className={record.rejectedCount ? "has-rejected" : ""}>
                      {formatNumber(record.rejectedCount)} ต้องตรวจ
                    </span>
                  </td>
                  <td>{record.importedBy}</td>
                  <td>{formatDateTime(record.importedAt)}</td>
                  <td>
                    <Badge>
                      {record.status === "published"
                        ? "Published"
                        : record.status === "needs_review"
                          ? "Needs review"
                          : "Failed"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="import-history-footer">
          <span>
            ฐานข้อมูลรองรับ <strong>raw.import_batches</strong> และเก็บ Source Snapshot
            แยกตาม Batch เพื่อรักษาประวัติเดิม
          </span>
          <span>Local Preview แสดงข้อมูลตัวอย่างสำหรับตรวจ UX</span>
        </footer>
      </section>
    </div>
  );
}
