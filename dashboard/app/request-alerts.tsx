"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";

// แจ้งเตือนเบิกผิดปกติ: requests (extra / change) that are far above what the
// district received before, its CMP, or would leave > 6 months of stock.

export type AlertSignal = { code: string; level: "medium" | "high"; label: string };
export type RequestCheck = {
  level: "normal" | "medium" | "high";
  signals: AlertSignal[];
  baseline?: {
    history_count?: number;
    history_max?: number | null;
    history_avg?: number | null;
    last_issue_date?: string | null;
    cmp?: number | null;
    district_stock?: number | null;
    months_after?: number | null;
    recent_extra_requests?: number;
  };
};

export type RequestAlert = {
  alert_id: string;
  source: "ad_hoc" | "change_request";
  reference: string | null;
  district_id: string;
  district_name: string | null;
  material_id: string;
  material_name: string | null;
  unit: string | null;
  requested_qty: number;
  level: "medium" | "high";
  signals: AlertSignal[];
  baseline: RequestCheck["baseline"];
  reason: string | null;
  requested_by_name: string | null;
  status: "open" | "acknowledged" | "dismissed";
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  created_at: string;
  request_status: string | null;
};

const dateTime = (value: string | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("th-TH", { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
};

const num = (value: number | null | undefined, unit?: string | null) =>
  value === null || value === undefined ? "—" : `${formatNumber(value, value % 1 ? 1 : 0)}${unit ? ` ${unit}` : ""}`;

export function CheckSummary({ check, unit }: { check: RequestCheck; unit?: string | null }) {
  const b = check.baseline ?? {};
  return (
    <div className={`ra-check ${check.level}`}>
      <strong>
        {check.level === "normal" ? "✓ ปริมาณอยู่ในเกณฑ์ปกติ" : check.level === "high" ? "⚠ ผิดปกติมาก — ระบบจะแจ้งเตือนผู้วางแผน" : "⚠ สูงกว่าปกติ — ระบบจะแจ้งเตือนผู้วางแผน"}
      </strong>
      {check.signals.length > 0 && (
        <ul>{check.signals.map((signal) => <li key={signal.code} className={signal.level}>{signal.label}</li>)}</ul>
      )}
      <dl>
        <div><dt>เคยจ่ายสูงสุด/ครั้ง</dt><dd>{num(b.history_max, unit)}</dd></div>
        <div><dt>เฉลี่ย/ครั้ง</dt><dd>{num(b.history_avg, unit)}</dd></div>
        <div><dt>CMP/เดือน</dt><dd>{num(b.cmp, unit)}</dd></div>
        <div><dt>สต็อกเขต</dt><dd>{num(b.district_stock, unit)}</dd></div>
        <div><dt>หลังรับพอใช้</dt><dd>{b.months_after === null || b.months_after === undefined ? "—" : `${b.months_after} เดือน`}</dd></div>
        <div><dt>ขอเพิ่มใน 30 วัน</dt><dd>{formatNumber(b.recent_extra_requests ?? 0)} ครั้ง</dd></div>
      </dl>
    </div>
  );
}

export function RequestAlertsView({
  token,
  role,
  demoMode,
}: {
  token: string | null;
  role: string;
  demoMode: boolean;
}) {
  const [rows, setRows] = useState<RequestAlert[]>([]);
  const [status, setStatus] = useState<"open" | "">("open");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const canReview = role === "admin" || role === "planner";

  const load = useCallback(async () => {
    setError("");
    if (demoMode || !token) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      setRows(await apiRequest<RequestAlert[]>(`/v1/request-alerts${status ? `?status=${status}` : ""}`, token));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดการแจ้งเตือนไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [demoMode, status, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const counts = useMemo(() => ({
    high: rows.filter((row) => row.status === "open" && row.level === "high").length,
    medium: rows.filter((row) => row.status === "open" && row.level === "medium").length,
  }), [rows]);

  const review = async (alert: RequestAlert, decision: "acknowledge" | "dismiss") => {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`/v1/request-alerts/${alert.alert_id}/review`, token, {
        method: "POST",
        body: JSON.stringify({ decision, note: note.trim() }),
      });
      setNotice(decision === "acknowledge" ? "บันทึกว่าตรวจแล้ว" : "บันทึกว่าไม่ผิดปกติ");
      setReviewing(null);
      setNote("");
      await load();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack ra-page">
      <section className="oh-summary ra-summary">
        <article className={counts.high ? "attn" : ""}>
          <span>ผิดปกติมาก (รอตรวจ)</span>
          <strong>{formatNumber(counts.high)}</strong>
          <small>เกิน 3 เท่าของที่เคยจ่าย / เกิน 6 เดือนของ CMP / พอใช้เกิน 9 เดือน</small>
        </article>
        <article>
          <span>สูงกว่าปกติ (รอตรวจ)</span>
          <strong>{formatNumber(counts.medium)}</strong>
          <small>เกิน 1.5 เท่าของที่เคยจ่าย / เกิน 3 เดือนของ CMP / ขอซ้ำบ่อย</small>
        </article>
        <article>
          <span>เกณฑ์ที่ใช้ตรวจ</span>
          <small className="ra-rules">
            เทียบกับปริมาณที่เคยจ่ายให้เขต 12 เดือน (SYNAPSE + ไฟล์เดิม) · CMP · สต็อกเขต · จำนวนครั้งที่ขอเพิ่มใน 30 วัน
          </small>
        </article>
      </section>

      <div className="oh-tabs" role="tablist">
        {([["open", "รอตรวจ"], ["", "ทั้งหมด (180 วัน)"]] as Array<["open" | "", string]>).map(([key, label]) => (
          <button key={label} type="button" role="tab" aria-selected={status === key} className={status === key ? "active" : ""} onClick={() => setStatus(key)}>
            {label}
          </button>
        ))}
        <span className="oh-tabs-spacer" />
        <button type="button" className="btn ghost" disabled={loading} onClick={() => void load()}>รีเฟรช</button>
      </div>

      {error && <p className="pk-error">{error}</p>}
      {notice && <p className="um-notice">{notice}</p>}

      {loading && !rows.length ? (
        <p className="panel pk-empty">กำลังโหลด…</p>
      ) : rows.length === 0 ? (
        <p className="panel pk-empty">{demoMode ? "โหมดสาธิต: ไม่มีข้อมูลแจ้งเตือน" : status === "open" ? "ไม่มีคำขอผิดปกติที่รอตรวจ" : "ยังไม่มีประวัติการแจ้งเตือน"}</p>
      ) : (
        rows.map((alert) => (
          <article key={alert.alert_id} className={`panel ra-card ${alert.level} ${alert.status}`}>
            <header>
              <div>
                <span className={`oh-badge ${alert.level === "high" ? "attn" : "info"}`}>{alert.level === "high" ? "ผิดปกติมาก" : "สูงกว่าปกติ"}</span>
                <span className="oh-badge muted">{alert.source === "ad_hoc" ? "ขอจ่ายกรณีพิเศษ" : "ขอเปลี่ยนจำนวนในแผน"}</span>
                {alert.reference && <small>{alert.reference}</small>}
              </div>
              <small>{dateTime(alert.created_at)}</small>
            </header>
            <div className="ra-head">
              <div>
                <strong>เขต{alert.district_name ?? alert.district_id}</strong>
                <span>{alert.material_name ?? alert.material_id}</span>
                <small>{alert.material_id}</small>
              </div>
              <div className="ra-qty">
                <small>ขอ</small>
                <strong>{num(alert.requested_qty, alert.unit)}</strong>
              </div>
            </div>
            <CheckSummary check={{ level: alert.level, signals: alert.signals, baseline: alert.baseline }} unit={alert.unit} />
            {alert.reason && <p className="ra-reason">เหตุผลของเขต: “{alert.reason}” {alert.requested_by_name ? `— ${alert.requested_by_name}` : ""}</p>}
            {alert.status !== "open" ? (
              <p className="ra-reviewed">
                {alert.status === "acknowledged" ? "ตรวจแล้ว" : "ไม่ผิดปกติ"} · {alert.reviewed_by_name ?? "—"} · {dateTime(alert.reviewed_at)}
                {alert.review_note && <> · “{alert.review_note}”</>}
              </p>
            ) : canReview && (
              reviewing === alert.alert_id ? (
                <div className="ra-review">
                  <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="ผลการตรวจ เช่น โทรยืนยันกับเขตแล้ว / ลดจำนวนเหลือ … / เป็นงานโครงการจริง" autoFocus />
                  <button type="button" className="btn ghost" onClick={() => setReviewing(null)}>ยกเลิก</button>
                  <button type="button" className="btn ghost" disabled={busy || note.trim().length < 3} onClick={() => void review(alert, "dismiss")}>ไม่ผิดปกติ</button>
                  <button type="button" className="btn primary" disabled={busy || note.trim().length < 3} onClick={() => void review(alert, "acknowledge")}>ตรวจแล้ว</button>
                </div>
              ) : (
                <div className="ra-actions">
                  <button type="button" className="btn primary" onClick={() => { setReviewing(alert.alert_id); setNote(""); }}>บันทึกผลการตรวจ</button>
                </div>
              )
            )}
          </article>
        ))
      )}
      <p className="oh-hint">การแจ้งเตือนไม่ได้บล็อกคำขอ · ผู้วางแผนยังอนุมัติหรือไม่อนุมัติคำขอได้ตามปกติ และระบบเก็บประวัติการตรวจทุกครั้ง</p>
    </div>
  );
}
