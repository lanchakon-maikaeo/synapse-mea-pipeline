"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDateTime, type Role } from "./lib";
import { nextUrgentAlert } from "./agentic-alerts.mjs";

type Alert = {
  alert_id: string;
  alert_type: string;
  severity: string;
  status: string;
  message: string;
  created_at: string;
  details: {
    material_id?: string;
    district_id?: string;
    location_id?: string;
    scope?: string;
    target?: string;
    action?: string;
    analysis_status?: string;
    analysis?: { summary: string; actions: string[]; uncertainties: string[]; evidence_ids: string[] };
    evidence?: Record<string, unknown>;
    limitations?: string[];
    fingerprint?: string;
  };
};
type Feed = { open_count: number; alerts: Alert[]; last_run?: { status: string; finished_at?: string } };
type Status = "open" | "acknowledged" | "resolved";

const PAGE = 30;
const tabs: [Status, string][] = [["open", "งานวันนี้"], ["acknowledged", "รับทราบแล้ว"], ["resolved", "ประวัติ"]];
const severityLabel: Record<string, string> = { critical: "เร่งด่วน", warning: "ควรตรวจสอบ", info: "งานที่ควรจัดการ" };
const scopeLabel: Record<string, string> = { warehouse: "คลังส่วนกลาง", district: "คลังประจำเขต", workflow: "แผนงาน" };
const evidenceLabels: Record<string, string> = {
  material_id: "รหัสวัสดุ", district_id: "รหัสเขต", location_id: "รหัสคลัง", snapshot_at: "เวลาของข้อมูลสต็อก",
  usage_as_of_date: "วันที่อัตราใช้", stock_qty: "สต็อกตามหลักฐาน", cmp_monthly: "อัตราใช้ต่อเดือน",
  months_available: "จำนวนเดือนที่คาดว่าพอใช้", target_gap_qty: "ส่วนต่างถึงเป้าหมายเติม", required_qty: "จำนวนที่แผนต้องการ",
  allocatable_qty: "ยอดพร้อมจัดสรร", shortfall_qty: "ส่วนขาดเทียบแผน", incomplete: "ข้อมูลยังไม่ครบ",
  count: "จำนวนรายการที่ต้องตรวจ", material_ids: "ตัวอย่างรหัสวัสดุ", oldest_snapshot: "ข้อมูลสต็อกเก่าสุด", stale: "ข้อมูลเก่า",
  plan_number: "เลขแผน", plan_id: "รหัสแผน", plan_ids: "แผนที่เกี่ยวข้อง", plan_status: "สถานะแผน", response_due_at: "กำหนดตอบแผน",
  item_count: "จำนวนรายการในแผน", items: "รายการแผนตามหลักฐาน", truncated: "แสดงรายการเพียงบางส่วน", priority: "คะแนนลำดับงานเดิม",
  needs_data_check: "ต้องตรวจข้อมูลต้นทาง", policy: "เกณฑ์เติมที่ใช้งาน", action: "สิ่งที่ควรทำ", district_name: "ชื่อเขต",
  name: "ชื่อคลัง", basis: "ฐานการเปรียบเทียบ",
};
const identity = (alert: Alert) =>
  [
    alert.details.location_id && `คลัง ${alert.details.location_id}`,
    alert.details.district_id && `เขต ${alert.details.district_id}`,
    alert.details.material_id && `วัสดุ ${alert.details.material_id}`,
    alert.details.evidence?.plan_number && `แผน ${alert.details.evidence.plan_number}`,
  ].filter(Boolean).join(" · ");
const showValue = (value: unknown) =>
  value == null ? "ไม่ทราบ" : typeof value === "object" ? JSON.stringify(value, null, 2) : typeof value === "boolean" ? (value ? "ใช่" : "ไม่") : String(value);
const seenKey = (alert: Alert) => `${alert.alert_id}:${alert.details.fingerprint ?? alert.created_at}`;

// Bell in the top bar: proactive advice from the alert worker, scoped to the
// signed-in user's role by the agentic_alert_feed RPC.
export default function AlertPanel({ token, role, onNavigate, onAsk }: {
  token: string;
  role: Role;
  onNavigate: (target: string) => void;
  onAsk: (question: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("open");
  const [offset, setOffset] = useState(0);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [peek, setPeek] = useState<Alert | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const shown = useRef(new Set<string>());
  const sequence = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/alerts?status=${status}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal,
      });
      if (!response.ok) throw Error("อ่านแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่");
      const data: Feed = await response.json();
      if (signal?.aborted || current !== sequence.current) return;
      setFeed(data);
      setOpenCount(data.open_count);
      if (status === "open") {
        const urgent = nextUrgentAlert(data.alerts, shown.current) as Alert | null;
        if (urgent) {
          shown.current.add(seenKey(urgent));
          setPeek(urgent);
        } else {
          setPeek((was) => (data.alerts.some((a) => a.alert_id === was?.alert_id && a.severity === "critical") ? was : null));
        }
      }
    } catch (e) {
      if (!signal?.aborted && current === sequence.current) setError(e instanceof Error ? e.message : "บริการแจ้งเตือนขัดข้อง");
    } finally {
      if (!signal?.aborted && current === sequence.current) setLoading(false);
    }
  }, [token, status, offset]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void refresh(controller.signal));
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);

  const close = () => { setOpen(false); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not([disabled]),summary"));
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const acknowledge = async (id: string) => {
    setError("");
    try {
      const response = await fetch("/api/alerts", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ alert_id: id }),
      });
      if (!response.ok) throw Error("รับทราบไม่สำเร็จ");
      setPeek(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "รับทราบไม่สำเร็จ");
    }
  };
  const showOpen = () => { setStatus("open"); setOffset(0); setOpen(true); setPeek(null); };

  return (
    <>
      <button ref={button} type="button" className="notification" onClick={showOpen}
        aria-label={`แจ้งเตือน ${openCount} รายการ`} aria-expanded={open}>
        <span aria-hidden="true">🔔</span>
        {openCount > 0 && <b>{openCount > 9 ? "9+" : openCount}</b>}
      </button>
      {peek && !open && createPortal(
        <aside className="agent-notice" role="status" aria-live="polite">
          <header>
            <span className="agent-icon" aria-hidden="true">✦</span>
            <div><strong>มีเรื่องสำคัญที่ควรดู</strong><small>SYNAPSE · ผู้ช่วย</small></div>
            <button type="button" aria-label="ย่อคำแนะนำสำคัญ" onClick={() => setPeek(null)}>✕</button>
          </header>
          <h3>{peek.message}</h3>
          <small>{identity(peek)}</small>
          <p>{peek.details.analysis?.summary ?? peek.details.action}</p>
          <button type="button" className="btn primary" onClick={showOpen}>ดูคำแนะนำและสิ่งที่ควรทำ ↗</button>
        </aside>,
        document.body,
      )}
      {open && createPortal(
        <div className="agent-backdrop" onClick={close}>
          <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="งานวันนี้และแจ้งเตือน"
            className="agent-panel" onClick={(event) => event.stopPropagation()}>
            <header>
              <span className="agent-icon" aria-hidden="true">✦</span>
              <div>
                <small>SYNAPSE · ผู้ช่วย</small>
                <h2>วันนี้ควรทำอะไร</h2>
                <small>ประเมินใหม่ทุกชั่วโมง</small>
              </div>
              <button type="button" onClick={() => void refresh()} aria-label="โหลดแจ้งเตือนล่าสุด" disabled={loading}>↻</button>
              <button type="button" onClick={close} aria-label="ปิดแจ้งเตือน">✕</button>
            </header>
            <nav className="agent-tabs">
              {tabs.map(([key, label]) => (
                <button type="button" key={key} aria-pressed={status === key}
                  onClick={() => { setStatus(key); setOffset(0); setFeed(null); }}>{label}</button>
              ))}
            </nav>
            <div className="agent-list">
              {error && <p role="alert" className="agent-error">{error}</p>}
              {feed?.last_run && (
                <small>ประเมินล่าสุด {formatDateTime(feed.last_run.finished_at)} · {feed.last_run.status === "succeeded" ? "สำเร็จ" : "ยังไม่สำเร็จ"}</small>
              )}
              {!feed && loading && <p>กำลังโหลด…</p>}
              {feed?.alerts.length === 0 && <p className="agent-empty">ไม่มีรายการในสถานะนี้</p>}
              {feed?.alerts.map((alert) => (
                <article key={alert.alert_id} className={`agent-card ${alert.severity}`}>
                  <div className="agent-meta">
                    <b>{severityLabel[alert.severity] ?? alert.severity}</b>
                    <span>{scopeLabel[alert.details.scope ?? ""] ?? "ระบบ"}</span>
                  </div>
                  <h3>{alert.message}</h3>
                  {identity(alert) && <small>{identity(alert)}</small>}
                  <p>{alert.details.action ?? alert.message}</p>
                  {alert.details.analysis && (
                    <>
                      <p className="agent-summary">{alert.details.analysis.summary}</p>
                      <ul>{alert.details.analysis.actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                    </>
                  )}
                  {alert.alert_type === "agentic" && alert.details.analysis_status !== "analyzed" && (
                    <small>คำแนะนำจากหลักฐาน · Agent ยังไม่ได้วิเคราะห์เพิ่มเติม</small>
                  )}
                  {[...(alert.details.limitations ?? []), ...(alert.details.analysis?.uncertainties ?? [])].map((x, i) => <small key={i}>{x}</small>)}
                  <details>
                    <summary>ดูหลักฐานและเวลาของข้อมูล</summary>
                    <dl>
                      {Object.entries(alert.details.evidence ?? {}).map(([key, value]) => (
                        <div key={key}><dt>{evidenceLabels[key] ?? key}</dt><dd>{showValue(value)}</dd></div>
                      ))}
                    </dl>
                  </details>
                  <div className="agent-actions">
                    {status === "open" && role !== "viewer" && (
                      <button type="button" className="btn ghost" onClick={() => void acknowledge(alert.alert_id)}>รับทราบ</button>
                    )}
                    <button type="button" className="btn primary" onClick={() => { onNavigate(alert.details.target ?? "operations"); setOpen(false); }}>เปิดข้อมูลต้นทาง</button>
                    <button type="button" className="btn ghost" onClick={() => {
                      onAsk(`ตรวจข้อมูลล่าสุดเกี่ยวกับ ${alert.message} (${identity(alert)}) และแนะนำสิ่งที่ควรทำ พร้อมหลักฐาน`);
                      setOpen(false);
                    }}>ถาม Agent ต่อ</button>
                  </div>
                </article>
              ))}
            </div>
            <footer>
              <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>ก่อนหน้า</button>
              <span>รายการ {feed?.alerts.length ? offset + 1 : 0}–{offset + (feed?.alerts.length ?? 0)}</span>
              <button type="button" disabled={!feed || feed.alerts.length < PAGE || loading} onClick={() => setOffset(offset + PAGE)}>ถัดไป</button>
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
