"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";

// ปฏิทินส่งของ: zone → weekday runs, cut-off rule, the extra requests attached
// to each upcoming run, and a report of who keeps asking for extra items.

type Zone = {
  zone_code: string;
  name_th: string;
  weekday: number;
  vehicle: string | null;
  sort_order: number;
  districts: Array<{ district_id: string; district_name: string; stop_order: number }>;
};
type Settings = {
  cutoff_days_before: number;
  cutoff_hour: number;
  reserve_weekday: number;
  plan_lock_weekday: number;
  plan_lock_hour: number;
};
type Upcoming = {
  ad_hoc_issue_id: string;
  issue_number: string;
  district_id: string;
  district_name: string;
  material_id: string;
  material_name: string | null;
  unit: string | null;
  requested_qty: number;
  status: string;
  urgency_code: string | null;
  delivery_mode: string | null;
  delivery_date: string | null;
  delivery_zone: string | null;
  alert_level: string | null;
};
type Calendar = { settings: Settings; zones: Zone[]; unzoned: Array<{ district_id: string; district_name: string }>; upcoming: Upcoming[]; today: string };
type Report = {
  days: number;
  total: number;
  by_mode: Record<string, number>;
  by_urgency: Record<string, number>;
  by_district: Array<{ district_id: string; district_name: string; requests: number; urgent: number; alerts: number; materials: number }>;
  repeats: Array<{ district_id: string; district_name: string; material_id: string; material_name: string | null; unit: string | null; requests: number; qty: number; last_request: string }>;
};

export const WEEKDAYS = ["", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์"];
export const MODE_LABEL: Record<string, string> = {
  zone_run: "พ่วงรอบโซนสัปดาห์นี้",
  reserve_run: "รอบสำรองวันศุกร์",
  express: "ส่งพิเศษ (ต้องอนุมัติ)",
  next_week_run: "รอบโซนสัปดาห์หน้า",
  unzoned: "ยังไม่กำหนดโซน",
};
export const URGENCY_LABEL: Record<string, string> = {
  normal: "ไม่ด่วน",
  outage: "ไฟดับ / ซ่อมฉุกเฉิน",
  stock_out_job: "ของหมดและมีงานรอ",
  project_start: "งานโครงการเริ่มตามกำหนด",
  other_urgent: "ด่วนเหตุอื่น",
};

const shortDate = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" });
};

function weekDates(today: string, offsetWeeks: number) {
  const base = new Date(`${today}T00:00:00`);
  const monday = new Date(base);
  monday.setDate(base.getDate() - ((base.getDay() + 6) % 7) + offsetWeeks * 7);
  return [1, 2, 3, 4, 5].map((weekday) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + weekday - 1);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { weekday, iso };
  });
}

function demoCalendar(): { calendar: Calendar; report: Report } {
  const z = (zone_code: string, name_th: string, weekday: number, vehicle: string, names: string[]): Zone => ({
    zone_code, name_th, weekday, vehicle, sort_order: 0,
    districts: names.map((district_name, index) => ({ district_id: `${zone_code}${index}`, district_name, stop_order: index + 1 })),
  });
  const today = new Date();
  const iso = (offset: number) => {
    const d = new Date(today); d.setDate(today.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const monday = (today.getDay() + 6) % 7;
  return {
    calendar: {
      today: iso(0),
      settings: { cutoff_days_before: 1, cutoff_hour: 14, reserve_weekday: 5, plan_lock_weekday: 4, plan_lock_hour: 12 },
      unzoned: [],
      zones: [
        z("E", "ตะวันออก", 2, "พด.707", ["ลาดกระบัง", "มีนบุรี", "บางกะปิ"]),
        z("SE", "ตะวันออกเฉียงใต้", 2, "พด.708", ["บางพลี", "สมุทรปราการ", "บางนา"]),
        z("IN", "ใจกลาง", 2, "พด.708", ["คลองเตย", "วัดเลียบ"]),
        z("W", "ตะวันตก", 3, "พด.707", ["บางบัวทอง", "บางใหญ่"]),
        z("N", "เหนือ", 3, "พด.708", ["นนทบุรี", "สามเสน"]),
        z("NE", "ตะวันออกเฉียงเหนือ", 4, "พด.707", ["บางเขน", "นวลจันทร์"]),
        z("S", "ใต้/ฝั่งธน", 4, "พด.708", ["บางขุนเทียน", "ราษฎร์บูรณะ", "ธนบุรี", "ยานนาวา"]),
      ],
      upcoming: [
        { ad_hoc_issue_id: "d1", issue_number: "AH-1", district_id: "5502", district_name: "สามเสน", material_id: "592038410000",
          material_name: "D/F CUTOUT 12kA", unit: "EA", requested_qty: 20, status: "approved", urgency_code: "normal",
          delivery_mode: "zone_run", delivery_date: iso(2 - monday), delivery_zone: "N", alert_level: "normal" },
        { ad_hoc_issue_id: "d2", issue_number: "AH-2", district_id: "5506", district_name: "ลาดกระบัง", material_id: "120030001000",
          material_name: "สายอะลูมิเนียม 185", unit: "M", requested_qty: 4000, status: "pending_approval", urgency_code: "outage",
          delivery_mode: "reserve_run", delivery_date: iso(4 - monday), delivery_zone: "E", alert_level: "high" },
      ],
    },
    report: {
      days: 90, total: 42,
      by_mode: { zone_run: 28, next_week_run: 9, reserve_run: 4, express: 1 },
      by_urgency: { normal: 35, outage: 4, stock_out_job: 3 },
      by_district: [
        { district_id: "5509", district_name: "คลองเตย", requests: 9, urgent: 1, alerts: 2, materials: 6 },
        { district_id: "5506", district_name: "ลาดกระบัง", requests: 6, urgent: 2, alerts: 1, materials: 4 },
      ],
      repeats: [
        { district_id: "5509", district_name: "คลองเตย", material_id: "471050004000", material_name: "PVC CONDUIT 3/8 IN", unit: "EA",
          requests: 4, qty: 400, last_request: iso(-3) },
      ],
    },
  };
}

export function DeliveryCalendarView({ token, role, demoMode }: { token: string | null; role: string; demoMode: boolean }) {
  const [calendar, setCalendar] = useState<Calendar | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [week, setWeek] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ zones: Record<string, { weekday: number; vehicle: string }>; settings: Settings } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const canEdit = role === "admin" || role === "planner";
  const canReport = ["admin", "planner", "academic", "viewer"].includes(role);

  const load = useCallback(async () => {
    setError("");
    if (demoMode) {
      const demo = demoCalendar();
      setCalendar(demo.calendar);
      setReport(demo.report);
      return;
    }
    if (!token) return;
    try {
      const [cal, rep] = await Promise.all([
        apiRequest<Calendar>("/v1/delivery/calendar", token),
        canReport ? apiRequest<Report>("/v1/extra-requests/report?days=90", token) : Promise.resolve(null),
      ]);
      setCalendar(cal);
      setReport(rep);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดปฏิทินไม่สำเร็จ");
    }
  }, [canReport, demoMode, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const days = useMemo(() => (calendar ? weekDates(calendar.today, week) : []), [calendar, week]);
  const settings = calendar?.settings;

  const startEdit = () => {
    if (!calendar) return;
    setDraft({
      zones: Object.fromEntries(calendar.zones.map((zone) => [zone.zone_code, { weekday: zone.weekday, vehicle: zone.vehicle ?? "" }])),
      settings: { ...calendar.settings },
    });
    setEditing(true);
  };

  const save = async () => {
    if (!token || !draft) return;
    setBusy(true);
    setError("");
    try {
      const next = await apiRequest<Calendar>("/v1/delivery/calendar", token, {
        method: "POST",
        body: JSON.stringify({
          zones: Object.entries(draft.zones).map(([zone_code, value]) => ({ zone_code, ...value })),
          settings: draft.settings,
        }),
      });
      setCalendar(next);
      setEditing(false);
      setNotice("บันทึกปฏิทินส่งของแล้ว · มีผลกับคำขอเพิ่มที่ส่งเข้ามาหลังจากนี้");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  if (!calendar) return <p className="panel pk-empty">{error || "กำลังโหลดปฏิทิน…"}</p>;

  return (
    <div className="stack dc-page">
      <section className="panel dc-rules">
        <div>
          <span>กติกาประจำสัปดาห์</span>
          <ol>
            <li>คำนวณและส่งแผนให้เขต → เขตยืนยันภายใน <b>{WEEKDAYS[settings!.plan_lock_weekday]} {settings!.plan_lock_hour}:00 น.</b> แล้วล็อกแผน</li>
            <li>ทุกเขตได้รับของตาม <b>วันส่งประจำโซน</b> ด้านล่าง (ไปส่งทุกเขต ไม่ต้องมารับเอง)</li>
            <li>คำขอเพิ่มหลังล็อก: ส่งก่อน <b>{settings!.cutoff_days_before === 0 ? "วันส่ง" : `${settings!.cutoff_days_before} วันก่อนวันส่ง`} เวลา {settings!.cutoff_hour}:00 น.</b> → พ่วงไปกับรอบโซนนั้น</li>
            <li>เลยเวลาตัดรอบ: ไม่ด่วน → รอบสัปดาห์หน้า · ด่วน (ระบุเหตุผล) → รอบสำรองวัน<b>{WEEKDAYS[settings!.reserve_weekday]}</b> หรือส่งพิเศษเมื่ออนุมัติ</li>
          </ol>
        </div>
        {canEdit && !editing && <button type="button" className="btn ghost" onClick={startEdit}>แก้ไขวันส่ง / เวลาตัดรอบ</button>}
      </section>

      {error && <p className="pk-error">{error}</p>}
      {notice && <p className="um-notice">{notice}</p>}

      {editing && draft && (
        <section className="panel dc-edit">
          <h4>แก้ไขวันส่งประจำโซน</h4>
          <div className="dc-edit-grid">
            {calendar.zones.map((zone) => (
              <label key={zone.zone_code}>
                <span><b>{zone.zone_code}</b> {zone.name_th}</span>
                <div>
                  <select value={draft.zones[zone.zone_code].weekday} onChange={(event) => setDraft({
                    ...draft, zones: { ...draft.zones, [zone.zone_code]: { ...draft.zones[zone.zone_code], weekday: Number(event.target.value) } },
                  })}>
                    {[1, 2, 3, 4, 5].map((day) => <option key={day} value={day}>{WEEKDAYS[day]}</option>)}
                  </select>
                  <input value={draft.zones[zone.zone_code].vehicle} placeholder="รถ" onChange={(event) => setDraft({
                    ...draft, zones: { ...draft.zones, [zone.zone_code]: { ...draft.zones[zone.zone_code], vehicle: event.target.value } },
                  })} />
                </div>
              </label>
            ))}
          </div>
          <div className="dc-edit-grid">
            <label><span>ตัดรอบคำขอเพิ่ม (กี่วันก่อนวันส่ง)</span>
              <select value={draft.settings.cutoff_days_before} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, cutoff_days_before: Number(event.target.value) } })}>
                {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value === 0 ? "วันเดียวกัน" : `${value} วัน`}</option>)}
              </select></label>
            <label><span>เวลาตัดรอบ (ชั่วโมง)</span>
              <input type="number" min={0} max={23} value={draft.settings.cutoff_hour} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, cutoff_hour: Number(event.target.value) } })} /></label>
            <label><span>วันรอบสำรอง</span>
              <select value={draft.settings.reserve_weekday} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, reserve_weekday: Number(event.target.value) } })}>
                {[1, 2, 3, 4, 5].map((day) => <option key={day} value={day}>{WEEKDAYS[day]}</option>)}
              </select></label>
            <label><span>ล็อกแผน (วัน / ชั่วโมง)</span>
              <div>
                <select value={draft.settings.plan_lock_weekday} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, plan_lock_weekday: Number(event.target.value) } })}>
                  {[1, 2, 3, 4, 5].map((day) => <option key={day} value={day}>{WEEKDAYS[day]}</option>)}
                </select>
                <input type="number" min={0} max={23} value={draft.settings.plan_lock_hour} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, plan_lock_hour: Number(event.target.value) } })} />
              </div></label>
          </div>
          <div className="um-actions">
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>ยกเลิก</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>บันทึก</button>
          </div>
        </section>
      )}

      <div className="oh-tabs" role="tablist">
        {[[0, "สัปดาห์นี้"], [1, "สัปดาห์หน้า"]].map(([value, label]) => (
          <button key={label} type="button" role="tab" aria-selected={week === value} className={week === value ? "active" : ""} onClick={() => setWeek(Number(value))}>{label}</button>
        ))}
        <span className="oh-tabs-spacer" />
        <button type="button" className="btn ghost" onClick={() => void load()}>รีเฟรช</button>
      </div>

      <section className="dc-week">
        {days.map(({ weekday, iso }) => {
          const zones = calendar.zones.filter((zone) => zone.weekday === weekday);
          const extras = calendar.upcoming.filter((row) => row.delivery_date === iso);
          const isReserve = weekday === settings!.reserve_weekday;
          const past = iso < calendar.today;
          return (
            <article key={iso} className={`dc-day ${iso === calendar.today ? "today" : ""} ${past ? "past" : ""}`}>
              <header><strong>{WEEKDAYS[weekday]}</strong><small>{shortDate(iso)}</small></header>
              {zones.map((zone) => (
                <div key={zone.zone_code} className="dc-run">
                  <span className="dc-zone">{zone.zone_code}</span>
                  <b>{zone.vehicle ?? "—"}</b>
                  <p>{zone.districts.map((district) => district.district_name).join(" → ")}</p>
                </div>
              ))}
              {isReserve && (
                <div className="dc-run reserve">
                  <span className="dc-zone">สำรอง</span>
                  <p>คำขอด่วนหลังตัดรอบ · ของตกค้าง · งานโครงการ</p>
                </div>
              )}
              {!zones.length && !isReserve && <p className="dc-empty">ไม่มีรอบโซน</p>}
              {extras.length > 0 && (
                <div className="dc-extras">
                  <small>คำขอเพิ่มที่พ่วงวันนี้ ({extras.length})</small>
                  <ul>
                    {extras.map((row) => (
                      <li key={row.ad_hoc_issue_id} className={row.alert_level === "high" ? "attn" : ""}>
                        <b>{row.district_name}</b> {row.material_name ?? row.material_id} · {formatNumber(row.requested_qty)} {row.unit ?? ""}
                        {row.urgency_code && row.urgency_code !== "normal" && <em> ด่วน</em>}
                        {row.alert_level && row.alert_level !== "normal" && <em className="attn"> ผิดปกติ</em>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          );
        })}
      </section>

      {calendar.upcoming.some((row) => row.delivery_mode === "express") && (
        <section className="panel dc-express">
          <h4>รอส่งพิเศษ (ต้องอนุมัติ)</h4>
          <ul>
            {calendar.upcoming.filter((row) => row.delivery_mode === "express").map((row) => (
              <li key={row.ad_hoc_issue_id}>{shortDate(row.delivery_date)} · <b>{row.district_name}</b> {row.material_name ?? row.material_id} · {formatNumber(row.requested_qty)} {row.unit ?? ""} · {URGENCY_LABEL[row.urgency_code ?? "normal"]}</li>
            ))}
          </ul>
        </section>
      )}

      {report && (
        <section className="panel dc-report">
          <h4>คำขอเพิ่ม {report.days} วันล่าสุด: {formatNumber(report.total)} รายการ</h4>
          <div className="dc-chips">
            {Object.entries(report.by_mode).map(([key, value]) => <span key={key}>{MODE_LABEL[key] ?? key} <b>{formatNumber(value)}</b></span>)}
            {Object.entries(report.by_urgency).filter(([key]) => key !== "normal").map(([key, value]) => <span key={key} className="attn">{URGENCY_LABEL[key] ?? key} <b>{formatNumber(value)}</b></span>)}
          </div>
          <div className="dc-report-grid">
            <div className="live-table-wrap">
              <table className="live-table">
                <thead><tr><th>เขต</th><th>คำขอ</th><th>ด่วน</th><th>ผิดปกติ</th><th>พัสดุ</th></tr></thead>
                <tbody>
                  {report.by_district.map((row) => (
                    <tr key={row.district_id}>
                      <td><strong>เขต{row.district_name}</strong></td>
                      <td>{formatNumber(row.requests)}</td>
                      <td>{formatNumber(row.urgent)}</td>
                      <td className={row.alerts ? "oh-attn" : ""}>{formatNumber(row.alerts)}</td>
                      <td>{formatNumber(row.materials)}</td>
                    </tr>
                  ))}
                  {!report.by_district.length && <tr><td colSpan={5}>ยังไม่มีคำขอเพิ่ม</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="live-table-wrap">
              <table className="live-table">
                <thead><tr><th>ขอซ้ำ (ควรทบทวน Min/Max)</th><th>ครั้ง</th><th>รวม</th><th>ล่าสุด</th></tr></thead>
                <tbody>
                  {report.repeats.map((row) => (
                    <tr key={`${row.district_id}|${row.material_id}`}>
                      <td><strong>เขต{row.district_name}</strong><small>{row.material_name ?? row.material_id}</small></td>
                      <td className="oh-attn">{formatNumber(row.requests)}</td>
                      <td>{formatNumber(row.qty)} {row.unit ?? ""}</td>
                      <td>{shortDate(row.last_request)}</td>
                    </tr>
                  ))}
                  {!report.repeats.length && <tr><td colSpan={4}>ยังไม่มีพัสดุที่ขอซ้ำ</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
