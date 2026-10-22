"use client";

import { Fragment, useDeferredValue, useMemo, useState } from "react";
import { formatNumber } from "./lib";
import {
  buildMaterialSummary,
  type InstallmentStatus,
  type MaterialSummary,
  type SummaryInput,
} from "./material-summary";

export type FileFact = {
  label: string;
  rows: number;
  source: string;
  changes?: { new?: number; changed?: number; missing?: number; unchanged?: number } | null;
};

type Filter = "relevant" | "open" | "overdue" | "unit" | "unmatched" | "no_usage" | "all";

const FILTERS: Array<[Filter, string]> = [
  ["relevant", "มีใน Stock / สัญญา / 105"],
  ["open", "มีงวดค้างรับ"],
  ["overdue", "เลยกำหนดส่ง"],
  ["unit", "หน่วยไม่ตรง"],
  ["unmatched", "105 ไม่พบในสัญญา"],
  ["no_usage", "มี Stock แต่ไม่มีอัตราการใช้"],
  ["all", "ทั้งหมด"],
];

const STATUS_LABEL: Record<InstallmentStatus, [string, string]> = {
  complete: ["รับครบ (105)", "done"],
  accepted: ["ตรวจรับแล้ว (ไม่พบใน 105)", "done"],
  partial: ["รับบางส่วน", "warn"],
  pending: ["ยังไม่ถึงกำหนด", "idle"],
  overdue: ["เลยกำหนดส่ง", "bad"],
  unit_mismatch: ["หน่วยไม่ตรง", "bad"],
};

const FLAG_LABEL: Record<string, string> = {
  overdue: "เลยกำหนด",
  unit_mismatch: "หน่วยไม่ตรง",
  receipt_without_contract: "105 ไม่พบในสัญญา",
  no_usage: "ไม่มีอัตราการใช้",
};

function matches(item: MaterialSummary, filter: Filter) {
  const open = item.installments.some((row) => ["pending", "overdue", "partial"].includes(row.status));
  switch (filter) {
    case "relevant": return item.inStock || item.installments.length > 0 || item.receiptCount > 0;
    case "open": return open;
    case "overdue": return item.flags.includes("overdue");
    case "unit": return item.flags.includes("unit_mismatch");
    case "unmatched": return item.unmatchedReceipts > 0;
    case "no_usage": return item.flags.includes("no_usage");
    default: return true;
  }
}

const qty = (value: number) => formatNumber(value, 2);

export default function ImportSummary({ input, files }: { input: SummaryInput; files: FileFact[] }) {
  const [filter, setFilter] = useState<Filter>("relevant");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState("");
  const [limit, setLimit] = useState(50);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const { rows, totals } = useMemo(() => buildMaterialSummary(input), [input]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([key]) =>
    [key, rows.filter((item) => matches(item, key)).length])) as Record<Filter, number>, [rows]);
  const visible = useMemo(() => rows.filter((item) => matches(item, filter) && (!deferredQuery ||
    item.material.includes(deferredQuery) || item.name.toLowerCase().includes(deferredQuery) ||
    item.installments.some((row) => row.purchaseOrder.includes(deferredQuery) ||
      row.contractNumber.toLowerCase().includes(deferredQuery)))), [rows, filter, deferredQuery]);
  const finished = totals.complete + totals.accepted;

  return (
    <section className="panel import-summary" aria-label="สรุปข้อมูลตามรหัสพัสดุ">
      <div className="panel-title">
        <div>
          <span>MATERIAL SUMMARY · เชื่อม 4 ไฟล์ด้วยรหัสพัสดุ</span>
          <h3>สรุปข้อมูลหลัง Import</h3>
          <p>Stock คลองเตย · อัตราการใช้ (CMP) · งวดสัญญา · รับเข้า 105 — นับเป็นจำนวนรายการ ปริมาณแสดงแยกตามพัสดุและหน่วยของมันเอง</p>
        </div>
      </div>
      <div className="import-summary-body">
        <div className="summary-files">
          {files.map((file) => (
            <article key={file.label}>
              <header><strong>{file.label}</strong><small>{file.source}</small></header>
              <b>{formatNumber(file.rows)} <small>รายการ</small></b>
              {file.changes ? (
                <p>
                  ใหม่ {formatNumber(file.changes.new ?? 0)} · อัปเดต {formatNumber(file.changes.changed ?? 0)}
                  {" "}· ไม่เปลี่ยน {formatNumber(file.changes.unchanged ?? 0)} · ไม่พบในไฟล์ใหม่ {formatNumber(file.changes.missing ?? 0)}
                </p>
              ) : <p>{file.rows ? "ยังไม่ได้เทียบกับข้อมูลที่บันทึก" : "ยังไม่มีข้อมูล"}</p>}
            </article>
          ))}
        </div>

        <div className="summary-kpis">
          <article><small>พัสดุที่เกี่ยวข้อง</small><b>{formatNumber(counts.relevant)}</b>
            <p>ใน Stock {formatNumber(totals.materialsInStock)} · มีสัญญา {formatNumber(totals.materialsWithContracts)} · มีรับเข้า {formatNumber(totals.materialsWithReceipts)}</p></article>
          <article><small>งวดสัญญาทั้งหมด</small><b>{formatNumber(totals.installments)}</b>
            <p>จาก {formatNumber(totals.materialsWithContracts)} พัสดุ</p></article>
          <article className="good"><small>งวดที่จบแล้ว</small><b>{formatNumber(finished)}</b>
            <p>รับครบตาม 105 {formatNumber(totals.complete)} · ตรวจรับแล้ว (ไม่พบใน 105) {formatNumber(totals.accepted)}</p></article>
          <article><small>งวดค้างรับ</small><b>{formatNumber(totals.pending + totals.partial)}</b>
            <p>ยังไม่ถึงกำหนด {formatNumber(totals.pending)} · รับบางส่วน {formatNumber(totals.partial)}</p></article>
          <article className={totals.overdue ? "bad" : ""}><small>เลยกำหนดส่ง</small><b>{formatNumber(totals.overdue)}</b>
            <p>ยังไม่รับเข้าและยังไม่ตรวจรับ</p></article>
          <article><small>รับเข้า 105</small><b>{formatNumber(totals.receipts)}</b>
            <p>ตรงงวดสัญญา {formatNumber(totals.matchedReceipts)} · ไม่พบในสัญญา {formatNumber(totals.unmatchedReceipts)}</p></article>
          <article className={totals.unitMismatch ? "bad" : ""}><small>หน่วยไม่ตรง</small><b>{formatNumber(totals.unitMismatch)}</b>
            <p>งวดที่หน่วยในสัญญากับ 105 ต่างกัน</p></article>
        </div>

        <div className="summary-tools">
          <div className="summary-filters" role="group" aria-label="กรองพัสดุ">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" aria-pressed={filter === key}
                onClick={() => { setFilter(key); setLimit(50); }}>
                {label} <b>{formatNumber(counts[key])}</b>
              </button>
            ))}
          </div>
          <input value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50); }}
            placeholder="ค้นหารหัส / ชื่อพัสดุ / PO / เลขสัญญา" aria-label="ค้นหาพัสดุ" />
        </div>

        <div className="summary-table-wrap">
          <table className="summary-table">
            <thead>
              <tr>
                <th>พัสดุ</th><th>Stock คลองเตย</th><th>CMP รวม / เดือน</th><th>พอใช้ (เดือน)</th>
                <th>PO / งวด</th><th>งวดจบ</th><th>งวดค้าง</th><th>รับเข้า 105</th><th>ต้องตรวจ</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, limit).map((item) => {
                const done = item.installments.filter((row) => ["complete", "accepted"].includes(row.status)).length;
                const pending = item.installments.filter((row) => ["pending", "partial", "overdue"].includes(row.status)).length;
                const expanded = open === item.material;
                return (
                  <Fragment key={item.material}>
                    <tr className={expanded ? "expanded" : ""}>
                      <td>
                        <button type="button" className="summary-expand" aria-expanded={expanded}
                          disabled={!item.installments.length}
                          onClick={() => setOpen(expanded ? "" : item.material)}>
                          {item.installments.length ? (expanded ? "▾" : "▸") : "·"}
                        </button>
                        <span><strong>{item.material}</strong><small>{item.name || "—"}{item.unit ? ` · ${item.unit}` : ""}</small></span>
                      </td>
                      <td>{item.inStock ? qty(item.stockQty) : "—"}</td>
                      <td>{item.cmpTotal ? <>{qty(item.cmpTotal)}<small>{formatNumber(item.districtCount)} เขต</small></> : "—"}</td>
                      <td>{item.monthsOfCover === null ? "—" : formatNumber(item.monthsOfCover, 1)}</td>
                      <td>{item.installments.length ? `${formatNumber(item.purchaseOrders)} / ${formatNumber(item.installments.length)}` : "—"}</td>
                      <td>{item.installments.length ? formatNumber(done) : "—"}</td>
                      <td>{item.installments.length ? formatNumber(pending) : "—"}</td>
                      <td>{item.receiptCount ? <>{formatNumber(item.receiptCount)} ครั้ง<small>ล่าสุด {item.lastReceiptDate || "—"}</small></> : "—"}</td>
                      <td>{item.flags.map((flag) => <span key={flag} className="summary-flag">{FLAG_LABEL[flag] ?? flag}</span>)}</td>
                    </tr>
                    {expanded && (
                      <tr className="summary-detail">
                        <td colSpan={9}>
                          <table>
                            <thead>
                              <tr><th>PO</th><th>งวด</th><th>สัญญา</th><th>จำนวนงวด</th><th>กำหนดส่ง</th><th>วันผ่านตรวจรับ</th><th>รับเข้า 105</th><th>สถานะ</th></tr>
                            </thead>
                            <tbody>
                              {item.installments.map((row) => (
                                <tr key={`${row.purchaseOrder}-${row.installment}`}>
                                  <td>{row.purchaseOrder}</td>
                                  <td>{row.installment}</td>
                                  <td>{row.contractNumber || "—"}</td>
                                  <td>{qty(row.quantity)} {row.unit}</td>
                                  <td>{row.deliveryDate || "—"}</td>
                                  <td>{row.acceptanceDate || "—"}</td>
                                  <td>{row.receiptCount ? `${qty(row.receivedQty)} (${formatNumber(row.receiptCount)} ครั้ง · ${row.lastReceiptDate})` : "—"}</td>
                                  <td><span className={`summary-status ${STATUS_LABEL[row.status][1]}`}>{STATUS_LABEL[row.status][0]}</span></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!visible.length && <p className="summary-empty">ไม่พบพัสดุตามเงื่อนไข</p>}
        </div>
        {visible.length > limit && (
          <div className="summary-more">
            <button type="button" className="btn ghost" onClick={() => setLimit(limit + 100)}>
              แสดงเพิ่ม ({formatNumber(Math.min(100, visible.length - limit))} จาก {formatNumber(visible.length - limit)} ที่เหลือ)
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
