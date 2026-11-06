"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ImportSummary, { type FileFact } from "./import-summary";
import type { SummaryInput } from "./material-summary";
import { formatDateTime, formatNumber, type Role } from "./lib";
import { readSourceFile } from "./sap-file-reader";
import type { SapRow } from "./sap-import";
import {
  isImportBackendMissing,
  sourceImportApi,
  type ChangeRow,
  type ChangeType,
  type CurrentSourceState,
  type ImportRun,
  type SourceKind,
} from "./source-import-client";
import { dateFromFileName, readMaterialWorkbook, readStockWorkbook, readUsageWorkbook } from "./source-workbooks";

type Parsed = {
  name: string;
  size: number;
  sha256: string;
  sheet: string;
  metadata: Record<string, unknown>;
  warnings: string[];
  rows: Array<{ row_number: number; payload: Record<string, unknown> }>;
};

type Slot = {
  file: File | null;
  snapshotDate: string;
  parsed: Parsed | null;
  error: string;
  run: ImportRun | null;
  progress: string;
};

const ORDER: SourceKind[] = ["stock", "district_stock", "contracts", "receipts_105", "usage", "materials"];
// Material Master does not feed the summary table below
const SUMMARY_KINDS = ORDER.filter((kind) => kind !== "materials");

const SOURCES: Record<SourceKind, {
  title: string;
  cadence: string;
  use: string;
  accept: string;
  hint: string;
}> = {
  stock: {
    title: "Stock คลังคลองเตย",
    cadence: "ทุกวัน",
    use: "Stock คลังคลองเตย (โรงงาน 2401) · ใช้ดูของพร้อมจ่าย · ระบบเก็บเฉพาะแถวโรงงาน 2401",
    accept: ".xlsx",
    hint: "Stock_update_วว.ดด.ปป.XLSX จาก SAP (คลังคลองเตย 2401)",
  },
  district_stock: {
    title: "Stock เขต",
    cadence: "ก่อนคำนวณ",
    use: "Stock ที่ 18 เขต · ใช้คำนวณว่าเขตมีของพอใช้กี่เดือน · ระบบเก็บเฉพาะแถวโรงงานของเขต",
    accept: ".xlsx",
    hint: "Stock.xlsx ชีท update-stock (วันที่ในช่อง K1)",
  },
  contracts: {
    title: "รวมสัญญา",
    cadence: "ทุกวัน",
    use: "สัญญา / PO / งวดส่งมอบ / วันผ่านตรวจรับ · จับคู่กับ 105 ที่หน้าของเข้าคลังตามสัญญา",
    accept: ".xlsx,.csv",
    hint: "INPUT_รวมสัญญา หรือไฟล์เดียวที่มีทั้งรวมสัญญาและ 105",
  },
  receipts_105: {
    title: "รับเข้า 105",
    cadence: "ทุกวัน",
    use: "ล็อตที่รับเข้าคลองเตยแล้ว · เก็บสะสม ไฟล์ใหม่ส่งเฉพาะช่วงวันที่ล่าสุดได้",
    accept: ".xlsx,.csv",
    hint: "105_update_วว.ดด.ปป.XLSX (แบบมีใบสั่งซื้อ 13 หรือ 17 ช่อง)",
  },
  usage: {
    title: "อัตราการใช้งาน",
    cadence: "เดือนละครั้ง",
    use: "ยอดใช้ 12 เดือนของแต่ละเขต · ใช้คำนวณ CMP",
    accept: ".xlsx",
    hint: "อัตราการใช้งาน.xlsx ชีท Check CMP (12 เดือนขึ้นไป)",
  },
  materials: {
    title: "Material Master",
    cadence: "เมื่อรายการเปลี่ยน",
    use: "รายการพัสดุ + พัสดุ VMI ที่ระบบคำนวณการจ่าย · ยืนยันแล้วอัปเดต Material Master ทันที",
    accept: ".xlsx",
    hint: "คลังคลองเตย.xlsx (MASTER + VMI คลองเตย) หรือ Master Material.xlsx (เพิ่มรหัส/แก้ชื่อ ไม่เปลี่ยน VMI)",
  },
};

const CHANGE_LABELS: Record<ChangeType, string> = {
  new: "รายการใหม่",
  changed: "ข้อมูลเปลี่ยน",
  reappeared: "กลับมาในไฟล์",
  missing: "ไม่พบในไฟล์ใหม่",
};

const FIELD_LABELS: Record<string, string> = {
  unrestricted_qty: "ไม่จำกัด",
  stock_in_transfer_qty: "การส่ง/การโอน",
  unrestricted_value: "มูลค่า",
  base_unit: "หน่วย",
  material_name: "ชื่อวัสดุ",
  is_vmi: "VMI",
  category: "หมวด",
  in_master: "อยู่ในชีท MASTER",
  snapshot_date: "วันที่ข้อมูล",
  cmp_monthly: "CMP",
  source_cmp: "CMP ในไฟล์",
  monthly_usage: "ยอดใช้รายเดือน",
  quantity: "จำนวน",
  unit: "หน่วย",
  contract_number: "สัญญา",
  acceptance_date: "วันผ่านตรวจรับ",
  delivery_date: "วันส่งมอบ",
  line_item: "งวด",
  po_item: "งวด",
  vendor: "ผู้ขาย",
  posting_date: "วันที่ผ่านรายการ",
  as_of_date: "ข้อมูลถึง",
};

const dayKey = (value: string) =>
  new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
const dayLabel = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

const emptySlot = (): Slot => ({ file: null, snapshotDate: "", parsed: null, error: "", run: null, progress: "" });

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "ใช่" : "ไม่ใช่";
  if (typeof value === "number") return formatNumber(value, 2);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function describeChange(row: ChangeRow): string {
  if (row.before && row.after) {
    const fields = [...new Set([...Object.keys(row.before), ...Object.keys(row.after)])]
      .filter((field) => JSON.stringify(row.before?.[field]) !== JSON.stringify(row.after?.[field]));
    return fields.slice(0, 4).map((field) =>
      `${FIELD_LABELS[field] ?? field}: ${display(row.before?.[field])} → ${display(row.after?.[field])}`,
    ).join(" · ") || "ไม่มีช่องที่เปลี่ยน";
  }
  const source = row.after ?? row.before ?? {};
  return ["material_name", "item_description", "unrestricted_qty", "cmp_monthly", "quantity", "unit", "base_unit"]
    .filter((field) => source[field] !== undefined && source[field] !== "")
    .slice(0, 3)
    .map((field) => `${FIELD_LABELS[field] ?? field}: ${display(source[field])}`)
    .join(" · ");
}

function statusLabel(run: ImportRun) {
  if (run.status === "committed") return ["บันทึกแล้ว", "confirmed"];
  if (run.status === "discarded") return ["ยกเลิก", "discarded"];
  if (run.status === "staged") return [run.is_stale ? "ต้องตรวจใหม่" : "รอยืนยัน", "pending"];
  return ["กำลังอัปโหลด", "pending"];
}

export default function SourceImportCenter({ token, role }: { token: string | null; role: Role }) {
  const [slots, setSlots] = useState<Record<SourceKind, Slot>>(() => ({
    stock: emptySlot(), district_stock: emptySlot(), contracts: emptySlot(), receipts_105: emptySlot(), usage: emptySlot(),
    materials: emptySlot(),
  }));
  const [busy, setBusy] = useState(false);
  const [backend, setBackend] = useState<"checking" | "ready" | "missing">("checking");
  const [backendError, setBackendError] = useState("");
  const [current, setCurrent] = useState<CurrentSourceState | null>(null);
  const [history, setHistory] = useState<ImportRun[]>([]);
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [viewer, setViewer] = useState<{ runId: string; type: ChangeType; rows: ChangeRow[]; loading: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const [savedRows, setSavedRows] = useState<Partial<Record<SourceKind, Array<Record<string, unknown>>>>>({});
  const [historyDay, setHistoryDay] = useState("");
  const [historyKind, setHistoryKind] = useState<SourceKind | "all">("all");
  const canCommit = role === "admin";

  const patch = (kind: SourceKind, value: Partial<Slot>) =>
    setSlots((existing) => ({ ...existing, [kind]: { ...existing[kind], ...value } }));

  const refresh = useCallback(async (kinds: SourceKind[] = SUMMARY_KINDS) => {
    if (!token) {
      setBackend("missing");
      return;
    }
    try {
      const [state, runs] = await Promise.all([
        sourceImportApi.current(token),
        sourceImportApi.runs(token, 100),
      ]);
      setCurrent(state);
      setHistory(runs);
      setBackend("ready");
      setBackendError("");
      // Files uploaded earlier and still waiting for confirmation come back
      // after a page reload, so they can be confirmed without uploading again.
      setSlots((existing) => {
        const next = { ...existing };
        for (const kind of ORDER) {
          if (next[kind].run || next[kind].parsed) continue;
          const waiting = runs
            .filter((run) => run.source_kind === kind && run.status === "staged" && !run.is_stale)
            .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
          if (waiting) next[kind] = { ...next[kind], run: waiting };
        }
        return next;
      });
      // Accepted rows feed the material summary when no file is selected.
      const loaded = await Promise.all(kinds.filter((kind) => kind !== "materials").map(async (kind) =>
        [kind, state[kind]?.accepted_rows ? await sourceImportApi.currentRows(token, kind).catch(() => []) : []] as const));
      setSavedRows((existing) => ({ ...existing, ...Object.fromEntries(loaded) }));
    } catch (reason) {
      if (isImportBackendMissing(reason)) {
        setBackend("missing");
      } else {
        setBackend("ready");
        setBackendError(reason instanceof Error ? reason.message : "โหลดประวัติการนำเข้าไม่สำเร็จ");
      }
    }
  }, [token]);

  useEffect(() => {
    // Loading the import status is a one-off sync with the server on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const summary = useMemo(() => {
    const rowsFor = (kind: SourceKind) => slots[kind].parsed
      ? slots[kind].parsed.rows.map((row) => row.payload)
      : savedRows[kind] ?? [];
    const input: SummaryInput = {
      stock: [...rowsFor("stock"), ...rowsFor("district_stock")],
      contracts: rowsFor("contracts"),
      receipts: rowsFor("receipts_105"),
      usage: rowsFor("usage"),
    };
    const files: FileFact[] = SUMMARY_KINDS.map((kind) => {
      const parsed = slots[kind].parsed;
      const latest = current?.[kind]?.latest_commit;
      return {
        label: SOURCES[kind].title,
        rows: parsed ? parsed.rows.length : savedRows[kind]?.length ?? 0,
        source: parsed
          ? `ไฟล์ที่ตรวจรอบนี้ · ${parsed.name}`
          : latest ? `บันทึกแล้ว ${formatDateTime(latest.committed_at)}` : "ยังไม่มีข้อมูล",
        changes: slots[kind].run?.summary ?? (parsed ? null : latest?.summary ?? null),
      };
    });
    const hasRows = Object.values(input).some((rows) => rows.length > 0);
    return hasRows ? { input, files } : null;
  }, [slots, savedRows, current]);
  const selectedKinds = ORDER.filter((kind) => slots[kind].file);
  const parsedKinds = ORDER.filter((kind) => slots[kind].parsed && !slots[kind].run);
  const stagedKinds = ORDER.filter((kind) => slots[kind].run);

  const checkFiles = async () => {
    setBusy(true);
    setNotice("");
    let contractRows: SapRow[] = [];
    for (const kind of ORDER.filter((item) => slots[item].file).sort((left, right) =>
      Number(left === "receipts_105") - Number(right === "receipts_105"))) {
      const file = slots[kind].file as File;
      patch(kind, { parsed: null, error: "", run: null, progress: "กำลังตรวจไฟล์…" });
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name}: ไฟล์ใหญ่เกิน 25 MB`);
        let parsed: Parsed;
        if (kind === "contracts" || kind === "receipts_105") {
          const result = await readSourceFile(file, kind, contractRows);
          if (kind === "contracts") contractRows = result.rows;
          parsed = {
            name: file.name, size: file.size, sha256: result.sha256,
            sheet: kind === "contracts" ? "INPUT_รวมสัญญา" : "INPUT_105",
            metadata: {}, warnings: result.warnings, rows: result.rows,
          };
        } else {
          const bytes = await file.arrayBuffer();
          const result = kind === "stock" || kind === "district_stock"
            ? readStockWorkbook(new Uint8Array(bytes), {
                snapshotDate: slots[kind].snapshotDate || null,
                scope: kind === "stock" ? "warehouse" : "district",
              })
            : kind === "materials"
              ? readMaterialWorkbook(new Uint8Array(bytes))
              : readUsageWorkbook(new Uint8Array(bytes));
          parsed = {
            name: file.name, size: file.size, sha256: await sha256Hex(bytes),
            sheet: result.sheet, metadata: result.metadata, warnings: result.warnings,
            rows: result.rows as Parsed["rows"],
          };
        }
        patch(kind, { parsed, progress: "" });
      } catch (reason) {
        patch(kind, { error: reason instanceof Error ? reason.message : "ตรวจไฟล์ไม่สำเร็จ", progress: "" });
      }
    }
    setBusy(false);
  };

  const uploadAll = async () => {
    if (!token) return;
    setBusy(true);
    setNotice("");
    for (const kind of parsedKinds) {
      const parsed = slots[kind].parsed as Parsed;
      patch(kind, { error: "", progress: "กำลังอัปโหลด 0%" });
      try {
        const run = await sourceImportApi.upload(token, { kind, ...parsed }, (done, total) =>
          patch(kind, { progress: `กำลังอัปโหลด ${Math.round((done / total) * 100)}%` }));
        patch(kind, { run, progress: "" });
      } catch (reason) {
        patch(kind, { error: reason instanceof Error ? reason.message : "อัปโหลดไม่สำเร็จ", progress: "" });
      }
    }
    setBusy(false);
    void refresh();
  };

  const commit = async (kind: SourceKind) => {
    const run = slots[kind].run;
    if (!token || !run) return;
    setBusy(true);
    patch(kind, { error: "", progress: "กำลังบันทึกลงฐานข้อมูล… (ไฟล์ใหญ่อาจใช้เวลา 1–2 นาที อย่าปิดหน้านี้)" });
    try {
      const committed = await sourceImportApi.commit(token, run.import_run_id, Boolean(acknowledged[run.import_run_id]));
      patch(kind, { run: committed, progress: "" });
      setNotice(kind === "materials"
        ? "Material Master: บันทึกแล้ว และอัปเดตรายการพัสดุ / VMI ที่ใช้คำนวณการจ่ายแล้ว · รหัสที่เพิ่งเพิ่มใหม่จะมี Stock ในการคำนวณเมื่อส่ง Stock ชุดถัดไปเข้าระบบคำนวณ"
        : `${SOURCES[kind].title}: บันทึกลงฐานข้อมูลพร้อมประวัติแล้ว`);
    } catch (reason) {
      patch(kind, { error: reason instanceof Error ? reason.message : "ยืนยันไม่สำเร็จ", progress: "" });
    }
    setBusy(false);
    void refresh([kind]);
  };

  const discard = async (kind: SourceKind) => {
    const run = slots[kind].run;
    if (!token || !run) return;
    setBusy(true);
    try {
      await sourceImportApi.discard(token, run.import_run_id, "ผู้ใช้ยกเลิกหลังตรวจผลเทียบ");
      patch(kind, { run: null, parsed: null, file: null });
      setSlots((existing) => ({ ...existing, [kind]: { ...existing[kind], run: null } }));
    } catch (reason) {
      patch(kind, { error: reason instanceof Error ? reason.message : "ยกเลิกไม่สำเร็จ" });
    }
    setBusy(false);
    void refresh();
  };

  const openChanges = async (runId: string, type: ChangeType) => {
    if (!token) return;
    setViewer({ runId, type, rows: [], loading: true });
    try {
      const result = await sourceImportApi.changes(token, runId, type, 25);
      setViewer({ runId, type, rows: result.rows, loading: false });
    } catch {
      setViewer({ runId, type, rows: [], loading: false });
    }
  };

  const changeButtons = (run: ImportRun) => (
    <div className="sap-import-run-actions">
      {(["new", "changed", "reappeared", "missing"] as const)
        .filter((type) => Number(run.summary[type] ?? 0) > 0)
        .map((type) => (
          <button key={type} type="button" className="btn ghost"
            aria-pressed={viewer?.runId === run.import_run_id && viewer.type === type}
            onClick={() => void openChanges(run.import_run_id, type)}>
            ดู{CHANGE_LABELS[type]} ({formatNumber(run.summary[type])})
          </button>
        ))}
    </div>
  );

  const changeList = (run: ImportRun) => viewer?.runId === run.import_run_id && (
    <div className="sap-import-changes" aria-live="polite">
      {viewer.loading ? <p>กำลังโหลด…</p> : viewer.rows.length === 0 ? <p>ไม่มีรายการ</p> :
        viewer.rows.map((row) => (
          <div key={row.business_key}>
            <strong>{CHANGE_LABELS[viewer.type]}</strong>
            <small>{row.business_key}{row.source_row_number ? ` · แถว ${row.source_row_number}` : ""}</small>
            <small>{describeChange(row)}</small>
          </div>
        ))}
      {!viewer.loading && viewer.rows.length === 25 && <p>แสดง 25 รายการแรก</p>}
    </div>
  );

  return (
    <section className="panel sap-import-panel source-import-center" aria-label="นำเข้าไฟล์ข้อมูลประจำวันและประจำเดือน">
      <div className="panel-title">
        <div>
          <span>IMPORT CENTER · บันทึกลงฐานข้อมูลพร้อมประวัติ</span>
          <h3>นำเข้าไฟล์ 4 ไฟล์: Stock · รวมสัญญา · 105 · อัตราการใช้งาน</h3>
          <p>ตรวจไฟล์ → เทียบกับข้อมูลล่าสุด → Admin ยืนยัน ระบบเก็บทุกการเปลี่ยนแปลงย้อนดูได้ ไม่ลบข้อมูลเดิม</p>
        </div>
      </div>
      <div className="sap-import-body">
        {backend === "missing" && (
          <p className="sap-import-help warning" role="status">
            ฐานข้อมูลยังไม่ได้เปิดใช้การเก็บประวัติการนำเข้า: ตรวจไฟล์บนเครื่องได้ แต่ยังบันทึกลงฐานข้อมูลไม่ได้จนกว่าจะติดตั้ง migration
            <code> 202610200001_source_file_import_history</code>
          </p>
        )}
        {backendError && <p className="form-error" role="alert">{backendError}</p>}
        <p className="sap-import-help">
          ทุกวันเลือก Stock, รวมสัญญา และ 105 · เดือนละครั้งเพิ่มอัตราการใช้งาน · ไม่ต้องอัปโหลด 301 เพราะระบบบันทึกเองตอนจ่ายจริง
          · รายการที่ไม่พบในไฟล์ใหม่จะถูกทำเครื่องหมายให้ตรวจ ไม่ถูกลบ
        </p>

        <div className="source-import-grid">
          {ORDER.map((kind) => {
            const source = SOURCES[kind];
            const slot = slots[kind];
            const latest = current?.[kind]?.latest_commit;
            return (
              <article key={kind} className={`source-import-card ${slot.error ? "has-error" : slot.parsed ? "is-ready" : ""}`}>
                <header>
                  <strong>{source.title}</strong>
                  <span className="source-cadence">{source.cadence}</span>
                </header>
                <p>{source.use}</p>
                <label>
                  <span className="sr-only">เลือกไฟล์ {source.title}</span>
                  <input type="file" accept={source.accept} disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      patch(kind, {
                        file, parsed: null, run: null, error: "", progress: "",
                        ...(kind === "stock" || kind === "district_stock" ? { snapshotDate: file ? dateFromFileName(file.name) ?? "" : "" } : {}),
                      });
                    }} />
                </label>
                <small>{slot.file?.name ?? source.hint}</small>
                {(kind === "stock" || kind === "district_stock") && slot.file && (
                  <label className="source-date">
                    วันที่ของข้อมูล Stock (เว้นว่างได้ถ้าไฟล์มีวันที่ในช่อง K1)
                    <input type="date" value={slot.snapshotDate} disabled={busy}
                      onChange={(event) => patch(kind, { snapshotDate: event.target.value, parsed: null, run: null })} />
                  </label>
                )}
                {slot.progress && <small className="source-progress">{slot.progress}</small>}
                {slot.parsed && !slot.error && (
                  <small className="source-ok">
                    ตรวจผ่าน {formatNumber(slot.parsed.rows.length)} รายการ
                    {slot.parsed.warnings.length ? ` · ข้อควรตรวจ ${slot.parsed.warnings.length}` : ""}
                  </small>
                )}
                {slot.error && <small className="source-error" role="alert">{slot.error}</small>}
                <footer>
                  {latest
                    ? <>ล่าสุด {formatDateTime(latest.committed_at)} · {formatNumber(current?.[kind]?.accepted_rows)} รายการ</>
                    : backend === "ready" ? "ยังไม่เคยบันทึก" : ""}
                </footer>
              </article>
            );
          })}
        </div>

        <div className="pipeline-actions source-import-actions">
          <button type="button" className="btn ghost" disabled={busy || !selectedKinds.length}
            onClick={() => void checkFiles()}>
            1. ตรวจไฟล์ ({formatNumber(selectedKinds.length)})
          </button>
          <button type="button" className="btn primary"
            disabled={busy || backend !== "ready" || !parsedKinds.length}
            onClick={() => void uploadAll()}>
            2. อัปโหลดและเทียบกับข้อมูลล่าสุด ({formatNumber(parsedKinds.length)})
          </button>
        </div>
        {notice && <p className="sap-import-success" role="status">{notice}</p>}



        {stagedKinds.map((kind) => {
          const run = slots[kind].run as ImportRun;
          const summary = run.summary;
          const needsAck = run.parser_warnings.length > 0 && run.status === "staged";
          return (
            <div key={kind} className="sap-import-review" role="region" aria-label={`ผลเทียบ ${SOURCES[kind].title}`}>
              <h4>
                {SOURCES[kind].title} · {run.file_name}{" "}
                <span className={`sap-state ${statusLabel(run)[1]}`}>{statusLabel(run)[0]}</span>
              </h4>
              <p>เทียบกับข้อมูลที่บันทึกล่าสุด {formatNumber(summary.previously_accepted_rows)} รายการ · จำนวนเป็นจำนวนรายการ ไม่ใช่ปริมาณ</p>
              <div className="source-diff-counts">
                {([
                  ["ใหม่", summary.new], ["เปลี่ยน", summary.changed], ["กลับมา", summary.reappeared],
                  ["ไม่เปลี่ยน", summary.unchanged], ["ไม่พบในไฟล์ใหม่", summary.missing],
                ] as const).map(([label, value]) => (
                  <article key={label}><small>{label}</small><b>{formatNumber(value ?? 0)}</b></article>
                ))}
              </div>
              {run.same_file_as_latest_commit && (
                <p className="form-error">ไฟล์นี้เหมือนกับไฟล์ที่บันทึกครั้งล่าสุดทุกไบต์ ตรวจว่าดาวน์โหลดไฟล์ใหม่แล้วหรือยัง</p>
              )}
              {run.is_stale && (
                <p className="form-error">มีการบันทึกไฟล์ประเภทนี้รอบใหม่หลังจากตรวจ ต้องอัปโหลดและตรวจใหม่</p>
              )}
              {run.parser_warnings.map((warning, index) => <p key={index}>⚠ {warning}</p>)}
              {changeButtons(run)}
              {changeList(run)}
              {run.status === "staged" && (
                <div className="source-commit-row">
                  {needsAck && (
                    <label>
                      <input type="checkbox" checked={Boolean(acknowledged[run.import_run_id])}
                        onChange={(event) => setAcknowledged((existing) => ({
                          ...existing, [run.import_run_id]: event.target.checked,
                        }))} />
                      ตรวจข้อควรระวังข้างต้นแล้ว
                    </label>
                  )}
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => void discard(kind)}>
                    ยกเลิกรอบนี้
                  </button>
                  <button type="button" className="btn primary"
                    disabled={busy || !canCommit || run.is_stale || (needsAck && !acknowledged[run.import_run_id])}
                    title={canCommit ? undefined : "ต้องให้ Admin เป็นผู้ยืนยัน"}
                    onClick={() => void commit(kind)}>
                    {canCommit ? "ยืนยันบันทึกลงฐานข้อมูล" : "รอ Admin ยืนยัน"}
                  </button>
                </div>
              )}
              {slots[kind].progress && <p className="source-progress" role="status">{slots[kind].progress}</p>}
              {slots[kind].error && <p className="form-error" role="alert">{slots[kind].error}</p>}
            </div>
          );
        })}

        {summary && <ImportSummary input={summary.input} files={summary.files} />}

        {backend === "ready" && (
          <div className="sap-import-history">
            <h4>ประวัติการนำเข้า</h4>
            <p>ทุกรอบเก็บชื่อไฟล์ รหัสตรวจสอบไฟล์ (SHA-256) ผู้นำเข้า ผู้ยืนยัน และรายการที่เปลี่ยน · เลือกวันที่เพื่อดูรอบนำเข้าของวันนั้น</p>
            {history.length === 0 ? <p>ยังไม่มีประวัติ</p> : (() => {
              const days = [...new Set(history.map((run) => dayKey(run.committed_at ?? run.created_at)))].sort().reverse();
              const day = days.includes(historyDay) ? historyDay : days[0];
              const runs = history
                .filter((run) => dayKey(run.committed_at ?? run.created_at) === day)
                .filter((run) => historyKind === "all" || run.source_kind === historyKind)
                .sort((left, right) => ORDER.indexOf(left.source_kind) - ORDER.indexOf(right.source_kind) ||
                  (right.committed_at ?? right.created_at).localeCompare(left.committed_at ?? left.created_at));
              return (
                <>
                  <div className="source-history-filters">
                    <label>
                      <span>วันที่นำเข้า</span>
                      <select value={day} onChange={(event) => setHistoryDay(event.target.value)}>
                        {days.map((key) => {
                          const count = history.filter((run) => dayKey(run.committed_at ?? run.created_at) === key);
                          const done = count.filter((run) => run.status === "committed").length;
                          return <option key={key} value={key}>{dayLabel(key)} · {count.length} ไฟล์ (บันทึกแล้ว {done})</option>;
                        })}
                      </select>
                    </label>
                    <label>
                      <span>ประเภทไฟล์</span>
                      <select value={historyKind} onChange={(event) => setHistoryKind(event.target.value as SourceKind | "all")}>
                        <option value="all">ทุกประเภท</option>
                        {ORDER.map((kind) => <option key={kind} value={kind}>{SOURCES[kind].title}</option>)}
                      </select>
                    </label>
                  </div>
                  {runs.length === 0 ? <p>ไม่มีไฟล์ประเภทนี้ในวันที่เลือก</p> : (
                    <div className="source-history-table">
                      <div className="source-history-head">
                        <span>ไฟล์</span><span>สถานะ</span><span>เวลา · ผู้ทำ</span><span>รายการ</span><span>ใหม่ / เปลี่ยน / ไม่พบ</span><span></span>
                      </div>
                      {runs.map((run) => (
                        <div key={run.import_run_id}>
                          <div className="source-history-row">
                            <span>
                              <b>{SOURCES[run.source_kind].title}</b>
                              <small title={`SHA-256 ${run.file_sha256}`}>{run.file_name}</small>
                            </span>
                            <span><span className={`sap-state ${statusLabel(run)[1]}`}>{statusLabel(run)[0]}</span></span>
                            <span>
                              {new Date(run.committed_at ?? run.created_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}
                              <small>{run.committed_by_name ?? run.created_by_name ?? "—"}</small>
                            </span>
                            <span>{formatNumber(run.expected_row_count)}</span>
                            <span>
                              {run.status !== "uploading" && run.summary.total_rows !== undefined
                                ? `${formatNumber(run.summary.new)} / ${formatNumber(run.summary.changed)} / ${formatNumber(run.summary.missing)}`
                                : "—"}
                            </span>
                            <span>{run.status === "committed" && changeButtons(run)}</span>
                          </div>
                          {changeList(run)}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </section>
  );
}
