"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";
import { LEGACY_DISTRICTS } from "./legacy-history";

// ประวัติการดำเนินงาน: one place for everything that happened — plans, district
// responses, abnormal change requests, issues, ad hoc, stock movements, trips and
// the history imported from the old workbook. Backed by GET /v1/history.

export type HistoryEvent = {
  event_id: string;
  event_at: string;
  event_date: string;
  category: string;
  event_type: string;
  source: "synapse" | "legacy";
  district_id: string | null;
  district_name: string | null;
  material_id: string | null;
  material_name: string | null;
  unit: string | null;
  qty: number | null;
  ref_qty: number | null;
  plan_id: string | null;
  plan_number: string | null;
  reference: string | null;
  status: string | null;
  note: string | null;
  actor: string | null;
};

type Outcomes = { planned_lines: number; on_plan: number; adjusted: number; refused: number; pending: number };
type Week = Outcomes & {
  week_start: string;
  planned_qty: number;
  issue_events: number;
  issued_qty: number;
  issued_materials: number;
};
type DistrictRow = Outcomes & { district_id: string; district_name: string | null; last_plan_date: string | null };

export type HistoryPayload = {
  total: number;
  limit: number;
  offset: number;
  scope_district_id: string | null;
  counts: Record<string, number>;
  sources: Record<string, number>;
  first_event_date: string | null;
  last_event_date: string | null;
  outcomes: Outcomes;
  weekly: Week[];
  by_district: DistrictRow[];
  events: HistoryEvent[];
};

type Tone = "good" | "info" | "attn" | "muted" | "plan";

const EVENT_LABEL: Record<string, [string, Tone]> = {
  plan_created: ["สร้าง / ส่งแผนให้เขต", "plan"],
  plan_locked: ["ล็อกแผน พร้อมจ่าย", "plan"],
  plan_planner_approved: ["Planner อนุมัติแผน", "plan"],
  plan_academic_approved: ["วิชาการอนุมัติแผน", "plan"],
  plan_cancelled: ["ยกเลิกแผน", "muted"],
  plan_version: ["สร้างแผนฉบับใหม่", "plan"],
  qty_adjusted: ["ปรับจำนวนในแผน", "info"],
  district_confirmed: ["เขตยืนยันรับ", "good"],
  district_rejected: ["เขตไม่รับของ", "attn"],
  legacy_refused: ["เขตไม่รับของ", "attn"],
  change_requested: ["ขอเปลี่ยนจำนวน (ผิดปกติ)", "attn"],
  change_approved: ["อนุมัติคำขอเปลี่ยน", "good"],
  change_rejected: ["ไม่อนุมัติคำขอเปลี่ยน", "muted"],
  change_cancelled: ["ยกเลิกคำขอเปลี่ยน", "muted"],
  issue: ["จ่ายตามแผน (FIFO)", "good"],
  issue_adhoc: ["จ่ายกรณีพิเศษ", "info"],
  legacy_issued: ["จ่ายได้ตามแผน", "good"],
  legacy_adjusted: ["จ่ายแบบปรับจำนวน", "info"],
  return: ["รับคืนจากเขต", "info"],
  adhoc_requested: ["ขอจ่ายกรณีพิเศษ", "attn"],
  adhoc_approved: ["อนุมัติจ่ายกรณีพิเศษ", "good"],
  adhoc_rejected: ["ไม่อนุมัติจ่ายกรณีพิเศษ", "muted"],
  receipt: ["รับเข้าคลัง", "info"],
  damage: ["บันทึกของชำรุด", "attn"],
  quarantine: ["กักตรวจ", "attn"],
  adjustment: ["ปรับยอดสต็อก", "info"],
  trip: ["เที่ยวรถขนส่ง", "plan"],
};

const CATEGORIES: Array<[string, string]> = [
  ["all", "ทั้งหมด"],
  ["issue", "การจ่าย"],
  ["district", "เขตตอบรับ / ไม่รับ"],
  ["change", "คำขอผิดปกติ"],
  ["plan", "แผนการจ่าย"],
  ["adhoc", "จ่ายกรณีพิเศษ"],
  ["stock", "สต็อก / รับเข้า"],
  ["transport", "ขนส่ง"],
];

export const HISTORY_DISTRICTS: Array<[string, string]> = Object.keys(LEGACY_DISTRICTS).map(
  (name, index) => [String(5501 + index), name],
);

type Range = "4w" | "3m" | "12m" | "all" | "custom";

function isoDate(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function rangeFrom(range: Range): string {
  const now = new Date();
  if (range === "4w") return isoDate(new Date(now.getTime() - 28 * 86400000));
  if (range === "3m") return isoDate(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()));
  if (range === "12m") return isoDate(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));
  return "";
}

const thaiDate = (value: string | null | undefined, withYear = true) => {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("th-TH", { day: "numeric", month: "short", ...(withYear ? { year: "2-digit" } : {}) });
};

const timeOf = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const text = date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  return text === "00:00" ? "" : text;
};

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

function qtyText(event: HistoryEvent) {
  if (event.event_type === "plan_created") return event.qty ? `${formatNumber(event.qty)} รายการ` : "—";
  if (event.event_type === "trip") return event.qty ? `${formatNumber(event.qty, 1)} กม.` : "—";
  if (event.event_type === "district_rejected" || event.event_type === "legacy_refused") return "ไม่รับ";
  if (event.qty === null || event.qty === undefined) return "—";
  return `${formatNumber(event.qty)} ${event.unit ?? ""}`.trim();
}

function refText(event: HistoryEvent) {
  if (event.ref_qty === null || event.ref_qty === undefined) return "";
  if (event.event_type === "district_rejected" || event.event_type === "legacy_refused") {
    return `แผน ${formatNumber(event.ref_qty)} ${event.unit ?? ""}`.trim();
  }
  if (event.ref_qty === event.qty) return "";
  if (event.event_type === "trip" || event.event_type === "plan_created") return "";
  return `จากแผน ${formatNumber(event.ref_qty)}`;
}

function labelFor(event: HistoryEvent): [string, Tone] {
  const base = EVENT_LABEL[event.event_type] ?? [event.event_type, "muted" as Tone];
  if (event.event_type === "district_confirmed" && event.ref_qty !== null && event.qty !== null && event.qty !== event.ref_qty) {
    return ["เขตยืนยัน (ปรับจำนวน)", "info"];
  }
  return base;
}

function toCsv(events: HistoryEvent[]) {
  const header = ["วันที่", "เวลา", "เหตุการณ์", "ที่มา", "เขต", "รหัสพัสดุ", "รายการพัสดุ", "จำนวน", "หน่วย",
    "จำนวนตามแผน", "เลขที่แผน", "อ้างอิง", "หมายเหตุ / เหตุผล", "ผู้ดำเนินการ"];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = events.map((event) => [
    event.event_date, timeOf(event.event_at), labelFor(event)[0],
    event.source === "legacy" ? "ระบบเดิม" : "SYNAPSE",
    event.district_name ?? event.district_id ?? "", event.material_id ?? "", event.material_name ?? "",
    event.qty ?? "", event.unit ?? "", event.ref_qty ?? "", event.plan_number ?? "", event.reference ?? "",
    event.note ?? "", event.actor ?? "",
  ].map(escape).join(","));
  return `﻿${[header.join(","), ...lines].join("\n")}`;
}

export function OperationHistoryView({
  token,
  role,
  demoMode,
  demoPayload,
}: {
  token: string | null;
  role: string;
  demoMode: boolean;
  demoPayload?: HistoryPayload;
}) {
  const [tab, setTab] = useState<"timeline" | "weekly" | "district">("timeline");
  const [range, setRange] = useState<Range>("3m");
  const [from, setFrom] = useState(rangeFrom("3m"));
  const [to, setTo] = useState("");
  const [district, setDistrict] = useState("");
  const [material, setMaterial] = useState("");
  const [source, setSource] = useState("");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState({ material: "", query: "" });
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [extra, setExtra] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const isDistrict = role === "district";

  const params = useMemo(() => {
    const search = new URLSearchParams();
    if (from) search.set("from", from);
    if (to) search.set("to", to);
    if (district && !isDistrict) search.set("district_id", district);
    if (applied.material) search.set("material", applied.material);
    if (source) search.set("source", source);
    if (category !== "all") search.set("category", category);
    if (applied.query) search.set("q", applied.query);
    return search;
  }, [from, to, district, isDistrict, applied, source, category]);

  const load = useCallback(async () => {
    setError("");
    setExtra([]);
    if (demoMode || !token) {
      setData(demoPayload ?? null);
      return;
    }
    setLoading(true);
    try {
      const search = new URLSearchParams(params);
      search.set("limit", "200");
      setData(await apiRequest<HistoryPayload>(`/v1/history?${search.toString()}`, token));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดประวัติไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [demoMode, demoPayload, params, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const events = useMemo(() => [...(data?.events ?? []), ...extra], [data, extra]);

  const loadMore = async () => {
    if (!token || !data) return;
    setLoadingMore(true);
    try {
      const search = new URLSearchParams(params);
      search.set("limit", "200");
      search.set("offset", String(events.length));
      const next = await apiRequest<HistoryPayload>(`/v1/history?${search.toString()}`, token);
      setExtra((current) => [...current, ...next.events]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดเพิ่มไม่สำเร็จ");
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      let rows = events;
      if (!demoMode && token && data && data.total > events.length) {
        rows = [];
        for (let offset = 0; offset < Math.min(data.total, 20000); offset += 2000) {
          const search = new URLSearchParams(params);
          search.set("limit", "2000");
          search.set("offset", String(offset));
          const page = await apiRequest<HistoryPayload>(`/v1/history?${search.toString()}`, token);
          rows = rows.concat(page.events);
          if (page.events.length < 2000) break;
        }
      }
      const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `synapse-history-${isoDate(new Date())}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "ส่งออกไม่สำเร็จ");
    } finally {
      setExporting(false);
    }
  };

  const chooseRange = (next: Range) => {
    setRange(next);
    if (next !== "custom") {
      setFrom(rangeFrom(next));
      setTo("");
    }
  };

  const outcomes = data?.outcomes ?? { planned_lines: 0, on_plan: 0, adjusted: 0, refused: 0, pending: 0 };
  const decided = outcomes.planned_lines - outcomes.pending;
  const totalCount = Object.values(data?.counts ?? {}).reduce((sum, value) => sum + value, 0);
  const weekMax = Math.max(1, ...(data?.weekly ?? []).map((week) => week.planned_lines));

  // Group the timeline by day.
  const days = useMemo(() => {
    const groups: Array<{ date: string; items: HistoryEvent[] }> = [];
    for (const event of events) {
      const last = groups[groups.length - 1];
      if (last && last.date === event.event_date) last.items.push(event);
      else groups.push({ date: event.event_date, items: [event] });
    }
    return groups;
  }, [events]);

  const districtName = (id: string) => HISTORY_DISTRICTS.find(([code]) => code === id)?.[1] ?? id;

  return (
    <div className="stack oh-page">
      <section className="oh-summary">
        <article>
          <span>รายการตามแผน</span>
          <strong>{formatNumber(outcomes.planned_lines)}</strong>
          <small>
            {data?.first_event_date
              ? `${thaiDate(data.first_event_date)} – ${thaiDate(data.last_event_date)}`
              : "ในช่วงที่เลือก"}
          </small>
        </article>
        <article className="good">
          <span>จ่ายได้ตามแผน</span>
          <strong>{formatNumber(outcomes.on_plan)}</strong>
          <small>{pct(outcomes.on_plan, decided)}% ของรายการที่ปิดแล้ว</small>
        </article>
        <article>
          <span>ปรับจำนวน</span>
          <strong>{formatNumber(outcomes.adjusted)}</strong>
          <small>จ่ายไม่ตรงจำนวนแผน</small>
        </article>
        <article className={outcomes.refused ? "attn" : ""}>
          <span>ไม่รับของ</span>
          <strong>{formatNumber(outcomes.refused)}</strong>
          <small>{pct(outcomes.refused, decided)}% ของรายการที่ปิดแล้ว</small>
        </article>
        <article>
          <span>รอดำเนินการ</span>
          <strong>{formatNumber(outcomes.pending)}</strong>
          <small>ยังไม่จ่าย / เขตยังไม่ตอบ</small>
        </article>
      </section>

      <section className="panel oh-filters">
        <div className="oh-filter-row">
          <div className="district-filters oh-range" role="group" aria-label="ช่วงเวลา">
            {([
              ["4w", "4 สัปดาห์"],
              ["3m", "3 เดือน"],
              ["12m", "12 เดือน"],
              ["all", "ทั้งหมด"],
              ["custom", "กำหนดเอง"],
            ] as Array<[Range, string]>).map(([key, label]) => (
              <button key={key} type="button" className={range === key ? "active" : ""} onClick={() => chooseRange(key)}>
                {label}
              </button>
            ))}
          </div>
          {range === "custom" && (
            <div className="oh-dates">
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="ตั้งแต่" />
              <span>ถึง</span>
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="ถึง" />
            </div>
          )}
        </div>
        <form
          className="oh-filter-row"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ material: material.trim(), query: query.trim() });
          }}
        >
          {!isDistrict && (
            <select value={district} onChange={(event) => setDistrict(event.target.value)} aria-label="เขต">
              <option value="">ทุกเขต</option>
              {HISTORY_DISTRICTS.map(([code, name]) => (
                <option key={code} value={code}>เขต{name}</option>
              ))}
            </select>
          )}
          <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="แหล่งข้อมูล">
            <option value="">ทุกแหล่งข้อมูล</option>
            <option value="synapse">บันทึกใน SYNAPSE</option>
            <option value="legacy">จากไฟล์ระบบเดิม</option>
          </select>
          <input
            className="pk-search oh-material"
            value={material}
            onChange={(event) => setMaterial(event.target.value)}
            placeholder="รหัสหรือชื่อพัสดุ"
            aria-label="พัสดุ"
          />
          <input
            className="pk-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ค้นหา: เลขที่แผน เหตุผล ผู้ดำเนินการ HU"
            aria-label="ค้นหา"
          />
          <button type="submit" className="btn primary">ค้นหา</button>
          {(applied.material || applied.query || district || source) && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setMaterial("");
                setQuery("");
                setDistrict("");
                setSource("");
                setApplied({ material: "", query: "" });
              }}
            >
              ล้างตัวกรอง
            </button>
          )}
        </form>
        {isDistrict && <p className="oh-scope">แสดงเฉพาะประวัติของเขตคุณ</p>}
      </section>

      <div className="oh-tabs" role="tablist">
        {([
          ["timeline", "ไทม์ไลน์ทุกเหตุการณ์"],
          ["weekly", "สรุปรายสัปดาห์"],
          ["district", "สรุปรายเขต"],
        ] as Array<[typeof tab, string]>).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        <span className="oh-tabs-spacer" />
        <button type="button" className="btn ghost" disabled={exporting || !events.length} onClick={() => void exportCsv()}>
          {exporting ? "กำลังส่งออก…" : "ส่งออก CSV"}
        </button>
      </div>

      {error && <p className="pk-error">{error}</p>}

      {tab === "timeline" && (
        <section className="panel oh-timeline">
          <div className="district-filters oh-cats">
            {CATEGORIES.map(([key, label]) => {
              const count = key === "all" ? totalCount : data?.counts?.[key] ?? 0;
              if (key !== "all" && !count && category !== key) return null;
              return (
                <button key={key} type="button" className={category === key ? "active" : ""} onClick={() => setCategory(key)}>
                  {label} <em>{formatNumber(count)}</em>
                </button>
              );
            })}
          </div>
          {loading ? (
            <p className="pk-empty">กำลังโหลดประวัติ…</p>
          ) : !events.length ? (
            <p className="pk-empty">
              ไม่พบประวัติในช่วงนี้ · ลองเลือก “ทั้งหมด” หรือนำเข้าประวัติจากไฟล์เดิมที่เมนู “ประวัติจากระบบเดิม”
            </p>
          ) : (
            <div className="oh-days">
              {days.map((day) => (
                <div className="oh-day" key={day.date}>
                  <div className="oh-day-head">
                    <strong>{thaiDate(day.date)}</strong>
                    <span>{formatNumber(day.items.length)} เหตุการณ์</span>
                  </div>
                  <ul>
                    {day.items.map((event) => {
                      const [label, tone] = labelFor(event);
                      const ref = refText(event);
                      return (
                        <li key={event.event_id} className={`oh-event ${tone}`}>
                          <div className="oh-when">
                            <span className={`oh-badge ${tone}`}>{label}</span>
                            <small>
                              {timeOf(event.event_at)}
                              {event.source === "legacy" && <em className="oh-legacy">ระบบเดิม</em>}
                            </small>
                          </div>
                          <div className="oh-what">
                            {event.material_id ? (
                              <>
                                <strong>{event.material_name ?? event.material_id}</strong>
                                <small>{event.material_id}</small>
                              </>
                            ) : (
                              <strong>{event.plan_number ?? event.reference ?? "—"}</strong>
                            )}
                          </div>
                          <div className="oh-where">
                            {event.district_id ? `เขต${event.district_name ?? districtName(event.district_id)}` : "—"}
                          </div>
                          <div className="oh-qty">
                            <strong>{qtyText(event)}</strong>
                            {ref && <small>{ref}</small>}
                          </div>
                          <div className="oh-detail">
                            {(event.plan_number && event.material_id) || (event.reference && (event.material_id || event.plan_number)) ? (
                              <small>
                                {[event.material_id ? event.plan_number : null, event.reference].filter(Boolean).join(" · ")}
                              </small>
                            ) : null}
                            {event.note && <p>{event.note}</p>}
                            {event.actor && <small>โดย {event.actor}</small>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {data && events.length < data.total && (
                <button type="button" className="btn ghost oh-more" disabled={loadingMore || demoMode} onClick={() => void loadMore()}>
                  {loadingMore ? "กำลังโหลด…" : `โหลดเพิ่ม (แสดง ${formatNumber(events.length)} จาก ${formatNumber(data.total)})`}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {tab === "weekly" && (
        <section className="panel oh-weekly">
          <div className="oh-legend">
            <span><i className="good" />จ่ายได้ตามแผน</span>
            <span><i className="info" />ปรับจำนวน</span>
            <span><i className="attn" />ไม่รับของ</span>
            <span><i className="muted" />รอดำเนินการ</span>
          </div>
          {!data?.weekly.length ? (
            <p className="pk-empty">ยังไม่มีข้อมูลรายสัปดาห์ในช่วงนี้</p>
          ) : (
            <div className="live-table-wrap">
              <table className="live-table oh-week-table">
                <thead>
                  <tr>
                    <th>สัปดาห์</th>
                    <th>รายการตามแผน</th>
                    <th className="oh-bar-col">ผลลัพธ์</th>
                    <th>จ่ายได้ตามแผน</th>
                    <th>ไม่รับ</th>
                    <th>ครั้งที่จ่าย</th>
                    <th>{applied.material ? "จำนวนที่จ่าย" : "จำนวนที่จ่าย (รวมทุกหน่วย)"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.weekly.map((week) => {
                    const closed = week.planned_lines - week.pending;
                    return (
                      <tr key={week.week_start}>
                        <td>
                          <strong>{thaiDate(week.week_start)}</strong>
                          <small>ถึง {thaiDate(isoDate(new Date(new Date(`${week.week_start}T00:00:00`).getTime() + 6 * 86400000)))}</small>
                        </td>
                        <td>{formatNumber(week.planned_lines)}</td>
                        <td className="oh-bar-col">
                          <div className="oh-bar" style={{ width: `${Math.max(4, (week.planned_lines / weekMax) * 100)}%` }}>
                            {(["on_plan", "adjusted", "refused", "pending"] as const).map((key) =>
                              week[key] ? (
                                <i
                                  key={key}
                                  className={{ on_plan: "good", adjusted: "info", refused: "attn", pending: "muted" }[key]}
                                  style={{ flexGrow: week[key] }}
                                  title={`${formatNumber(week[key])}`}
                                />
                              ) : null,
                            )}
                          </div>
                        </td>
                        <td>
                          {formatNumber(week.on_plan)}
                          <small>{closed ? `${pct(week.on_plan, closed)}%` : "—"}</small>
                        </td>
                        <td className={week.refused ? "oh-attn" : ""}>{formatNumber(week.refused)}</td>
                        <td>
                          {formatNumber(week.issue_events)}
                          <small>{formatNumber(week.issued_materials)} รายการพัสดุ</small>
                        </td>
                        <td>{formatNumber(week.issued_qty)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!applied.material && (
                <p className="oh-hint">จำนวนที่จ่ายรวมพัสดุหลายหน่วย ใช้ดูแนวโน้มเท่านั้น · กรอกรหัสพัสดุในตัวกรองเพื่อดูจำนวนจริงต่อสัปดาห์</p>
              )}
            </div>
          )}
        </section>
      )}

      {tab === "district" && (
        <section className="panel oh-district">
          {!data?.by_district.length ? (
            <p className="pk-empty">ยังไม่มีข้อมูลรายเขตในช่วงนี้</p>
          ) : (
            <div className="live-table-wrap">
              <table className="live-table">
                <thead>
                  <tr>
                    <th>เขต</th>
                    <th>รายการตามแผน</th>
                    <th>จ่ายได้ตามแผน</th>
                    <th>ปรับจำนวน</th>
                    <th>ไม่รับของ</th>
                    <th className="oh-bar-col">อัตราไม่รับ</th>
                    <th>แผนล่าสุด</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_district.map((row) => {
                    const closed = row.planned_lines - row.pending;
                    const rate = pct(row.refused, closed);
                    return (
                      <tr key={row.district_id}>
                        <td><strong>เขต{row.district_name ?? districtName(row.district_id)}</strong><small>{row.district_id}</small></td>
                        <td>{formatNumber(row.planned_lines)}</td>
                        <td>{formatNumber(row.on_plan)}<small>{closed ? `${pct(row.on_plan, closed)}%` : "—"}</small></td>
                        <td>{formatNumber(row.adjusted)}</td>
                        <td className={row.refused ? "oh-attn" : ""}>{formatNumber(row.refused)}</td>
                        <td className="oh-bar-col">
                          <div className="oh-rate">
                            <div><i className={rate >= 20 ? "attn" : "info"} style={{ width: `${rate}%` }} /></div>
                            <span className={rate >= 20 ? "oh-attn" : ""}>{rate}%</span>
                          </div>
                        </td>
                        <td>{thaiDate(row.last_plan_date)}</td>
                        <td>
                          {!isDistrict && (
                            <button
                              type="button"
                              className="btn ghost"
                              onClick={() => {
                                setDistrict(row.district_id);
                                setTab("timeline");
                              }}
                            >
                              ดูประวัติ
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="oh-hint">อัตราไม่รับ ≥ 20% ไฮไลต์สีส้ม · คิดจากรายการที่ปิดแล้ว (ไม่รวมรายการที่รอดำเนินการ)</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
