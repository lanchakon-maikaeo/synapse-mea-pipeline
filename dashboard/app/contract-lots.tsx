"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";

// ของเข้าคลังตามสัญญา (M26): รวมสัญญา matched with 105 and Stock คลองเตย.
// Planners release installments that passed inspection but have no 105 yet;
// the released quantity is added to the Khlong Toei stock until 105 arrives.

type Status = "ready" | "awaiting_105" | "confirmed" | "accepted_before" | "overdue" | "pending";

type Lot = {
  material_id: string;
  material_name: string | null;
  unit: string | null;
  purchase_order: string;
  order_kind: "contract" | "order" | "no_contract";
  contract_number: string | null;
  line_item: string;
  installment_count: number;
  vendor: string | null;
  quantity: number | null;
  delivery_date: string | null;
  acceptance_date: string | null;
  received_qty: number;
  receipt_count: number;
  first_receipt: string | null;
  last_receipt: string | null;
  in_stock: boolean;
  kt_stock_qty: number;
  relevant: boolean;
  status: Status;
  release_id: string | null;
  release_qty: number | null;
  release_counting: boolean;
  released_by: string | null;
  released_at: string | null;
  release_note: string | null;
};

type Summary = {
  contract_lines: number;
  relevant_lines: number;
  ready: number;
  awaiting_105: number;
  confirmed: number;
  overdue: number;
  pending: number;
  accepted_before: number;
  no_contract: number;
  receipts_from: string | null;
  receipts_to: string | null;
};

type Payload = { scope: "relevant" | "all"; summary: Summary; rows: Lot[] };
type Filter = "todo" | Status | "no_contract" | "all";

const STATUS: Record<Status, [string, string]> = {
  awaiting_105: ["ผ่านตรวจรับ · รอ Key 105", "warn"],
  confirmed: ["ยืนยันจ่ายได้แล้ว", "ok"],
  ready: ["จ่ายได้ (มี 105)", "ok"],
  overdue: ["ยังไม่ผ่านตรวจรับ · เลยกำหนดส่ง", "bad"],
  pending: ["ยังไม่ผ่านตรวจรับ", "idle"],
  accepted_before: ["ตรวจรับก่อนช่วงข้อมูล 105", "idle"],
};

const KIND: Record<Lot["order_kind"], string> = {
  contract: "สัญญา",
  order: "ใบสั่ง",
  no_contract: "ไม่พบในรวมสัญญา",
};

const thai = (value: string | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value
    : date.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });
};

const DEMO: Payload = {
  scope: "relevant",
  summary: { contract_lines: 984, relevant_lines: 3, ready: 1, awaiting_105: 1, confirmed: 0, overdue: 1,
    pending: 0, accepted_before: 0, no_contract: 0, receipts_from: "2025-01-22", receipts_to: "2026-10-30" },
  rows: [
    { material_id: "614507000100", material_name: "PG. CLAMP (1-BOLT) COVER", unit: "EA", purchase_order: "1400005614",
      order_kind: "contract", contract_number: "MA8-8785-WGA", line_item: "3", installment_count: 4, vendor: "บริษัทตัวอย่าง",
      quantity: 21000, delivery_date: "2026-11-04", acceptance_date: "2026-10-30", received_qty: 0, receipt_count: 0,
      first_receipt: null, last_receipt: null, in_stock: true, kt_stock_qty: 12000, relevant: true, status: "awaiting_105",
      release_id: null, release_qty: null, release_counting: false, released_by: null, released_at: null, release_note: null },
    { material_id: "614526030700", material_name: "STR JOINT SPL KIT 12/20kV F/70 SQMM.", unit: "KIT", purchase_order: "1400005806",
      order_kind: "contract", contract_number: "MP9-8950-GGA", line_item: "1", installment_count: 1, vendor: "บริษัทตัวอย่าง",
      quantity: 500, delivery_date: "2026-11-07", acceptance_date: "2026-07-14", received_qty: 500, receipt_count: 1,
      first_receipt: "2026-07-14", last_receipt: "2026-07-14", in_stock: true, kt_stock_qty: 480, relevant: true, status: "ready",
      release_id: null, release_qty: null, release_counting: false, released_by: null, released_at: null, release_note: null },
    { material_id: "560500440200", material_name: "MACHINE BOLT 1/2X2 IN", unit: "EA", purchase_order: "1300174693",
      order_kind: "order", contract_number: null, line_item: "3", installment_count: 3, vendor: "บริษัทตัวอย่าง",
      quantity: 10000, delivery_date: "2026-09-24", acceptance_date: null, received_qty: 0, receipt_count: 0,
      first_receipt: null, last_receipt: null, in_stock: true, kt_stock_qty: 9000, relevant: true, status: "overdue",
      release_id: null, release_qty: null, release_counting: false, released_by: null, released_at: null, release_note: null },
  ],
};

export function ContractLotsView({ token, role, demoMode }: { token: string | null; role: string; demoMode: boolean }) {
  const canRelease = role === "admin" || role === "planner";
  const [data, setData] = useState<Payload | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState<Filter>("todo");
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (demoMode) {
      setData(DEMO);
      return;
    }
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      setData(await apiRequest<Payload>(`/v1/contract-lots${showAll ? "?scope=all" : ""}`, token));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดรายการไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [demoMode, showAll, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const visible = useMemo(() => {
    const needle = deferred.trim().toLowerCase();
    return rows.filter((row) => {
      // typing a search looks through every status, not only the chosen tab
      if (!needle) {
        if (filter === "todo" && row.status !== "awaiting_105") return false;
        if (filter === "no_contract" && row.order_kind !== "no_contract") return false;
        if (!["todo", "all", "no_contract"].includes(filter) && row.status !== filter) return false;
        return true;
      }
      return [row.material_id, row.material_name, row.purchase_order, row.contract_number, row.vendor]
        .some((value) => String(value ?? "").toLowerCase().includes(needle));
    });
  }, [deferred, filter, rows]);

  const keyOf = (row: Lot) => `${row.material_id}|${row.purchase_order}|${row.line_item}`;

  const openRelease = (row: Lot) => {
    setEditing(keyOf(row));
    setQty(String(Math.max((row.quantity ?? 0) - row.received_qty, 0) || row.quantity || ""));
    setNote("");
    setError("");
  };

  const confirm = async (row: Lot) => {
    if (!token || demoMode) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest("/v1/contract-lots/confirm", token, {
        method: "POST",
        body: JSON.stringify({ material_id: row.material_id, purchase_order: row.purchase_order,
          line_item: row.line_item, quantity: Number(qty.replaceAll(",", "")), note }),
      });
      setEditing(null);
      setNotice(`ยืนยันจ่ายได้: ${row.material_id} PO ${row.purchase_order} งวด ${row.line_item} จำนวน ${formatNumber(Number(qty.replaceAll(",", "")))} ${row.unit ?? ""} · บวกเข้า Stock คลองเตยแล้ว`);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "ยืนยันไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (row: Lot) => {
    if (!token || demoMode || !row.release_id) return;
    const reason = window.prompt("เหตุผลที่ยกเลิกการยืนยัน", "") ?? null;
    if (reason === null) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest("/v1/contract-lots/cancel", token, {
        method: "POST",
        body: JSON.stringify({ release_id: row.release_id, reason }),
      });
      setNotice(`ยกเลิกการยืนยัน ${row.material_id} PO ${row.purchase_order} งวด ${row.line_item} แล้ว`);
      await load();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "ยกเลิกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const s = data?.summary;

  return (
    <div className="stack pk-page">
      {s && (
        <section className="pk-summary cl-summary">
          {([
            ["todo", "ผ่านตรวจรับ รอ Key 105", "ผู้วางแผนยืนยันจ่ายได้", s.awaiting_105, "warn"],
            ["confirmed", "ยืนยันจ่ายได้แล้ว", "บวกใน Stock คลองเตยจนกว่า 105 จะเข้า", s.confirmed, "ok"],
            ["ready", "จ่ายได้ (มี 105)", "อยู่ใน Stock SAP แล้ว", s.ready, "ok"],
            ["overdue", "เลยกำหนดส่ง", "ยังไม่ผ่านตรวจรับ", s.overdue, "bad"],
            ["pending", "ยังไม่ถึง/รอตรวจรับ", "ยังไม่ผ่านตรวจรับ", s.pending, "idle"],
          ] as Array<[Filter, string, string, number, string]>).map(([key, label, hint, value, tone]) => (
            <button key={key} type="button" className={`pk-stat cl-${tone} ${filter === key ? "active" : ""}`}
              onClick={() => setFilter(filter === key ? "all" : key)}>
              <span>{label}</span>
              <strong>{formatNumber(value)}</strong>
              <small>{hint}</small>
            </button>
          ))}
        </section>
      )}

      <section className="panel pk-list">
        <div className="pk-toolbar">
          <div className="district-filters pk-filters">
            {([
              ["todo", "รอยืนยัน"],
              ["all", "ทั้งหมด"],
              ["accepted_before", "ตรวจรับก่อนช่วง 105"],
              ["no_contract", "105 ไม่พบในรวมสัญญา"],
            ] as Array<[Filter, string]>).map(([key, label]) => (
              <button key={key} type="button" className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
          <input className="pk-search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="ค้นหารหัสพัสดุ ชื่อ PO สัญญา หรือผู้ขาย (ค้นทุกสถานะ)" aria-label="ค้นหา" />
          <label className="pk-toggle">
            <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
            แสดงสัญญาที่ไม่เกี่ยวกับคลองเตยด้วย
          </label>
        </div>
        {s && (
          <p className="pk-readonly">
            รวมสัญญา {formatNumber(s.contract_lines)} บรรทัด · เกี่ยวกับคลองเตย {formatNumber(s.relevant_lines)} บรรทัด
            (พัสดุมีใน Stock คลองเตย หรือ PO เคยรับเข้า 105) · ข้อมูล 105 {thai(s.receipts_from)} – {thai(s.receipts_to)}
            {s.no_contract ? ` · 105 ที่ไม่พบในรวมสัญญา ${formatNumber(s.no_contract)} รายการ` : ""}
          </p>
        )}
        {!canRelease && <p className="pk-readonly">สิทธิ์ของคุณดูได้อย่างเดียว · ผู้ยืนยันจ่ายได้คือผู้วางแผนหรือผู้ดูแลระบบ</p>}
        {error && <p className="pk-error" role="alert">{error}</p>}
        {notice && <p className="sap-import-success" role="status">{notice}</p>}
        {loading && !data ? (
          <p className="pk-empty">กำลังจับคู่รวมสัญญากับ 105 และ Stock…</p>
        ) : visible.length === 0 ? (
          <p className="pk-empty">
            {rows.length ? "ไม่มีรายการในกลุ่มนี้" : "ยังไม่มีข้อมูล · Import รวมสัญญา, 105 และ Stock คลองเตยที่หน้า Import Data ก่อน"}
          </p>
        ) : (
          <div className="live-table-wrap">
            <table className="live-table pk-table cl-table">
              <thead>
                <tr>
                  <th>สถานะ</th>
                  <th>พัสดุ</th>
                  <th>PO · สัญญา/ใบสั่ง · งวด</th>
                  <th>จำนวนงวด</th>
                  <th>กำหนดส่ง · ผ่านตรวจรับ</th>
                  <th>รับเข้า 105</th>
                  <th>Stock คลองเตย</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 400).map((row) => {
                  const key = keyOf(row);
                  const [label, tone] = STATUS[row.status];
                  return (
                    <tr key={key} className={row.relevant ? "" : "cl-other"}>
                      <td>
                        <span className={`cl-status ${tone}`}>{label}</span>
                        {row.status === "confirmed" && (
                          <small>{row.release_counting ? "บวกใน Stock คลองเตยอยู่" : "105 เข้าแล้ว · ไม่บวกซ้ำ"}</small>
                        )}
                        {!row.relevant && <small>ไม่เกี่ยวกับคลองเตย</small>}
                      </td>
                      <td>
                        <strong>{row.material_id}</strong>
                        <small>{row.material_name ?? "—"}</small>
                      </td>
                      <td>
                        <strong>PO {row.purchase_order}</strong>
                        <small>
                          {KIND[row.order_kind]}{row.contract_number ? ` ${row.contract_number}` : ""}
                          {row.line_item ? ` · งวดที่ ${row.line_item}${row.installment_count > 1 ? `/${row.installment_count}` : ""}` : ""}
                        </small>
                        {row.vendor && <small>{row.vendor}</small>}
                      </td>
                      <td>{row.quantity === null ? "—" : `${formatNumber(row.quantity)} ${row.unit ?? ""}`}</td>
                      <td>
                        {thai(row.delivery_date)}
                        <small>{row.acceptance_date ? `ผ่านตรวจรับ ${thai(row.acceptance_date)}` : "ยังไม่ผ่านตรวจรับ"}</small>
                      </td>
                      <td>
                        {row.receipt_count ? `${formatNumber(row.received_qty)} ${row.unit ?? ""}` : "—"}
                        {row.receipt_count > 0 && (
                          <small>
                            {row.receipt_count > 1 ? `${row.receipt_count} ครั้ง · ` : ""}{thai(row.last_receipt)}
                            {row.quantity !== null && row.received_qty < row.quantity ? ` · ค้าง ${formatNumber(row.quantity - row.received_qty)}` : ""}
                          </small>
                        )}
                      </td>
                      <td>
                        {row.in_stock ? formatNumber(row.kt_stock_qty) : "—"}
                        {row.status === "confirmed" && row.release_qty !== null && (
                          <small>ยืนยัน +{formatNumber(row.release_qty)} · {row.released_by} {thai(row.released_at)}</small>
                        )}
                        {row.release_note && <small>{row.release_note}</small>}
                      </td>
                      <td>
                        {canRelease && row.status === "awaiting_105" && editing !== key && (
                          <button type="button" className="btn primary" onClick={() => openRelease(row)}>ยืนยันจ่ายได้</button>
                        )}
                        {canRelease && row.status === "awaiting_105" && editing === key && (
                          <div className="cl-form">
                            <label>
                              <span>จำนวนที่จ่ายได้ ({row.unit ?? ""})</span>
                              <input type="number" min="0" max={row.quantity ?? undefined} value={qty}
                                onChange={(event) => setQty(event.target.value)} />
                            </label>
                            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="หมายเหตุ (ไม่บังคับ)" />
                            <div className="um-actions">
                              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>ยกเลิก</button>
                              <button type="button" className="btn primary" disabled={busy || !Number(qty)} onClick={() => void confirm(row)}>
                                ยืนยัน
                              </button>
                            </div>
                          </div>
                        )}
                        {canRelease && row.status === "confirmed" && (
                          <button type="button" className="btn ghost" disabled={busy} onClick={() => void cancel(row)}>ยกเลิกการยืนยัน</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length > 400 && <p className="pk-empty">แสดง 400 รายการแรก · ใช้ช่องค้นหาเพื่อหารายการอื่น</p>}
          </div>
        )}
      </section>
    </div>
  );
}
