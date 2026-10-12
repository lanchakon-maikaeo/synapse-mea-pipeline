"use client";

import { useState } from "react";
import { formatNumber } from "./lib";
import { sapColumns, type SapKind, type SapRow } from "./sap-import";
import { readSourceFile } from "./sap-file-reader";

type CheckedFile = {
  name: string;
  sha256: string;
  rows: SapRow[];
  warnings: string[];
};
type CheckedData = { contracts: CheckedFile; receipts_105: CheckedFile };

const labels: Record<SapKind, string> = {
  contracts: "รวมสัญญา",
  receipts_105: "รับเข้า 105",
};

function exportCsv(kind: SapKind, rows: SapRow[]) {
  const columns = sapColumns[kind];
  const cell = (value: string) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [
    columns.map(([title]) => cell(title)).join(","),
    ...rows.map((row) => columns.map(([, field]) => cell(row.payload[field])).join(",")),
  ];
  const blob = new Blob(["\uFEFF", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `synapse_checked_${kind}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SapImportPreview() {
  const [mode, setMode] = useState<"workbook" | "separate">("workbook");
  const [combined, setCombined] = useState<File | null>(null);
  const [contracts, setContracts] = useState<File | null>(null);
  const [receipts, setReceipts] = useState<File | null>(null);
  const [checked, setChecked] = useState<CheckedData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const checkFiles = async () => {
    const contractFile = mode === "workbook" ? combined : contracts;
    const receiptFile = mode === "workbook" ? combined : receipts;
    if (!contractFile || !receiptFile) return;
    setBusy(true);
    setError("");
    setChecked(null);
    try {
      const contractResult = await readSourceFile(contractFile, "contracts");
      const receiptResult = await readSourceFile(receiptFile, "receipts_105", contractResult.rows);
      setChecked({
        contracts: { name: contractFile.name, ...contractResult },
        receipts_105: { name: receiptFile.name, ...receiptResult },
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ตรวจไฟล์ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel sap-import-panel" aria-label="ตรวจไฟล์ SAP ก่อนนำเข้า">
      <div className="panel-title">
        <div>
          <span>SAP DAILY FILE CHECK · PREVIEW ONLY</span>
          <h3>ตรวจไฟล์รวมสัญญาและรับเข้า 105</h3>
          <p>เลือกไฟล์ ตรวจหัวตารางและรายการ แล้วดาวน์โหลดผลที่ตรวจผ่านได้ทันที</p>
        </div>
      </div>
      <div className="sap-import-body">
        <p className="sap-import-help" role="status">
          โหมดนี้ตรวจเฉพาะบนเครื่องของคุณ: ไม่อัปโหลด ไม่บันทึกลง Supabase และไม่เปลี่ยนข้อมูลในระบบ
          · ยังไม่เปรียบเทียบกับข้อมูลเดิมหรือหักยอดจ่าย 301 · 105 คือรับเข้าเพื่อเตรียมจ่าย ไม่ใช่ยอดพร้อมจ่าย
        </p>
        <div className="sap-import-entry">
          <div className="sap-import-mode" aria-label="รูปแบบไฟล์นำเข้า">
            <button type="button" aria-pressed={mode === "workbook"} disabled={busy}
              onClick={() => { setMode("workbook"); setChecked(null); }}>ไฟล์เดียว 2 ชีท</button>
            <button type="button" aria-pressed={mode === "separate"} disabled={busy}
              onClick={() => { setMode("separate"); setChecked(null); }}>ไฟล์ SAP แยก 2 ไฟล์</button>
          </div>
          <div className={`sap-import-files ${mode === "workbook" ? "single" : ""}`}>
            {mode === "workbook" ? (
              <label>ไฟล์ Excel ที่เตรียมไว้
                <input type="file" accept=".xlsx" disabled={busy}
                  onChange={(event) => { setCombined(event.target.files?.[0] ?? null); setChecked(null); }} />
                <small>{combined?.name ?? "ต้องมีชีท INPUT_รวมสัญญา และ INPUT_105จริง"}</small>
              </label>
            ) : <>
              <label>ไฟล์รวมสัญญา
                <input type="file" accept=".xlsx,.csv" disabled={busy}
                  onChange={(event) => { setContracts(event.target.files?.[0] ?? null); setChecked(null); }} />
                <small>{contracts?.name ?? "เลือก .xlsx หรือ .csv"}</small>
              </label>
              <label>ไฟล์รับเข้า 105
                <input type="file" accept=".xlsx,.csv" disabled={busy}
                  onChange={(event) => { setReceipts(event.target.files?.[0] ?? null); setChecked(null); }} />
                <small>{receipts?.name ?? "เลือก .xlsx หรือ .csv"}</small>
              </label>
            </>}
            <button type="button" className="btn primary" disabled={busy ||
              (mode === "workbook" ? !combined : !contracts || !receipts)}
              onClick={() => void checkFiles()}>
              {busy ? "กำลังตรวจไฟล์..." : "ตรวจไฟล์"}
            </button>
          </div>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {checked && <div className="sap-import-review" role="status">
          <h4>ตรวจไฟล์ผ่าน</h4>
          <p>จำนวนต่อไปนี้เป็นจำนวนรายการ ไม่รวมปริมาณต่างหน่วยเข้าด้วยกัน</p>
          <div className="sap-import-counts">
            {(["contracts", "receipts_105"] as const).map((kind) => {
              const result = checked[kind];
              return <article key={kind}>
                <strong>{labels[kind]}</strong>
                <div><span>รายการที่ตรวจผ่าน</span><b>{formatNumber(result.rows.length)}</b></div>
                <small>{result.name}</small>
                <div><span>ข้อควรตรวจ</span><b>{formatNumber(result.warnings.length)}</b></div>
                {result.warnings.slice(0, 5).map((warning, index) =>
                  <p key={index}>{warning}</p>)}
                <button type="button" className="btn ghost"
                  onClick={() => exportCsv(kind, result.rows)}>ดาวน์โหลด CSV ที่ตรวจผ่าน</button>
              </article>;
            })}
          </div>
          <h4>ตัวอย่างรายการ (20 แถวแรก)</h4>
          <div className="sap-import-table-wrap">
            <table className="sap-import-table">
              <thead><tr><th>แหล่งข้อมูล</th><th>แถว</th><th>วัสดุ</th><th>ใบสั่งซื้อ</th><th>รหัสจัดหา / Mat. Doc.</th><th>จำนวน</th><th>หน่วย</th></tr></thead>
              <tbody>
                {(["contracts", "receipts_105"] as const).flatMap((kind) =>
                  checked[kind].rows.slice(0, 20).map((row) => <tr key={`${kind}-${row.row_number}`}>
                    <td>{labels[kind]}</td><td>{row.row_number}</td>
                    <td>{row.payload.material_code}</td><td>{row.payload.purchase_order}</td>
                    <td>{kind === "contracts" ? row.payload.procurement_code : row.payload.material_document}</td>
                    <td>{row.payload.quantity}</td><td>{row.payload.unit}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        </div>}
      </div>
    </section>
  );
}
