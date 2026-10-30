"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";
import {
  addDays,
  moveTrip,
  solveDispatch,
  summarizeTrips,
  type DispatchDemand,
  type DispatchDistrict,
  type DispatchPlan,
  type PlannedTrip,
  type TripMode,
} from "./dispatch-solver";
import { WEEKDAYS } from "./delivery-calendar";

// จัดรถประจำสัปดาห์: goods-first dispatch from the locked plan + extra requests.

type SavedTrip = {
  dispatch_trip_id: string;
  trip_date: string | null;
  vehicle_code: string | null;
  mode: TripMode;
  seq: number;
  stops: PlannedTrip["stops"];
  pallets: number;
  weight_kg: number;
  km: number | null;
  minutes: number | null;
  cost_baht: number | null;
  layout: PlannedTrip["layout"] | null;
};
type SavedPlan = {
  dispatch_plan_id: string;
  week_start: string;
  status: "draft" | "confirmed";
  metrics: Partial<DispatchPlan["metrics"]> & { zone?: DispatchPlan["zone_metrics"] };
  warnings: DispatchPlan["warnings"];
  note: string | null;
  created_at: string;
  created_by_name: string | null;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
  trips: SavedTrip[];
};

const MODE_TEXT: Record<TripMode, string> = { delivery: "ส่งถึงเขต", pickup: "เขตมารับเอง", overflow: "ยังไม่มีรถ" };

function mondayOf(offsetWeeks: number) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offsetWeeks * 7);
  return d.toISOString().slice(0, 10);
}

const dayLabel = (iso: string | null) => {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00`).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" });
};

const baht = (value: number) => `${formatNumber(Math.round(value))} บาท`;

function fromSaved(plan: SavedPlan, capacity: number): DispatchPlan {
  const trips: PlannedTrip[] = plan.trips.map((t) => ({
    id: `S${String(t.seq).padStart(2, "0")}`,
    mode: t.mode,
    trip_date: t.trip_date,
    vehicle_code: t.vehicle_code,
    due_date: t.stops.map((s) => s.promise_date).filter(Boolean).sort()[0] ?? null,
    stops: t.stops,
    pallets: Number(t.pallets),
    weight_kg: Number(t.weight_kg),
    km: Number(t.km ?? 0),
    minutes: Number(t.minutes ?? 0),
    cost_baht: Number(t.cost_baht ?? 0),
    start_time: (t.stops[0] as { start_time?: string } | undefined)?.start_time ?? null,
    return_time: (t.stops[0] as { return_time?: string } | undefined)?.return_time ?? null,
    layout: t.layout ?? [],
    reason: (t.stops[0] as { reason?: string } | undefined)?.reason ?? null,
  }));
  const zone = plan.metrics.zone ?? summarizeTrips([], capacity);
  return { week_start: plan.week_start, trips, metrics: summarizeTrips(trips, capacity), zone_metrics: zone, warnings: plan.warnings ?? [] };
}

// ---------------------------------------------------------------- demo
const DEMO_DISTRICTS: Array<[string, string, string, number, number, number, number, number]> = [
  ["5501", "นวลจันทร์", "NE", 4, 13.81895, 100.6441, 26, 2], ["5502", "สามเสน", "N", 3, 13.78054, 100.51764, 16.8, 2],
  ["5503", "นนทบุรี", "N", 3, 13.87001, 100.51778, 28.7, 3], ["5504", "ธนบุรี", "S", 4, 13.746714, 100.470228, 16.1, 1],
  ["5505", "บางใหญ่", "W", 3, 13.848364, 100.436094, 32, 2], ["5506", "ลาดกระบัง", "E", 2, 13.815641, 100.746123, 32.5, 7],
  ["5507", "บางนา", "SE", 2, 13.67613, 100.59186, 8, 4], ["5508", "วัดเลียบ", "IN", 2, 13.741944, 100.5, 7.6, 2],
  ["5509", "คลองเตย", "IN", 2, 13.72156, 100.55539, 1, 5], ["5510", "ราษฎร์บูรณะ", "S", 4, 13.679075, 100.513051, 10, 2],
  ["5511", "ยานนาวา", "S", 4, 13.693056, 100.493333, 13, 1], ["5512", "บางขุนเทียน", "S", 4, 13.65557, 100.42435, 23, 2],
  ["5513", "บางบัวทอง", "W", 3, 13.945677, 100.37977, 49, 3], ["5514", "บางกะปิ", "E", 2, 13.74407, 100.60137, 11, 4],
  ["5515", "สมุทรปราการ", "SE", 2, 13.594317, 100.606817, 23, 2], ["5516", "บางพลี", "SE", 2, 13.6416, 100.71325, 23.5, 2],
  ["5517", "มีนบุรี", "E", 2, 13.811607, 100.708497, 35, 3], ["5518", "บางเขน", "NE", 4, 13.87107, 100.59534, 27, 2],
];

function demoDemand(week: string): DispatchDemand {
  return {
    week_start: week,
    settings: {
      start_time: "09:30:00", return_by: "15:00:00", unload_minutes: 40, avg_speed_kmh: 30, road_factor: 1.55,
      pickup_max_km: 17, pickup_min_pallets: 5, pickup_rotation_weeks: 4, max_stops_per_trip: 4, baht_per_km: 9.64,
      toll_per_trip: 89, warehouse_lat: 13.72, warehouse_lon: 100.55, delivery_weekdays: [1, 2, 3, 4, 5], default_pallet_kg: 1250,
    },
    vehicles: [
      { vehicle_code: "707", label: "พด.707 (6 ล้อ)", pallet_capacity: 8, max_payload_kg: null },
      { vehicle_code: "708", label: "พด.708 (6 ล้อ)", pallet_capacity: 8, max_payload_kg: null },
    ],
    districts: DEMO_DISTRICTS.map(([id, name, zone, wd, lat, lon, km, pallets]) => ({
      district_id: id, district_name: name, zone, zone_weekday: wd, promise_date: addDays(week, wd - 1),
      latitude: lat, longitude: lon, depot_km: km, has_vehicle: ["5509", "5507", "5514"].includes(id) ? true : null,
      pickup_allowed: true, last_pickup_date: id === "5509" ? addDays(week, -14) : null,
      pallets, full_pallets: Math.max(0, pallets - 1), mixed_fraction: 0.7, weight_kg: pallets * 1150,
      lines: pallets * 3, extra_lines: id === "5506" ? 1 : 0, packing_missing_lines: id === "5513" ? 4 : 0,
      weight_estimated_lines: 0, urgent: id === "5506",
      items: [],
    })),
  };
}

// ---------------------------------------------------------------- view
export function DispatchBoardView({ token, role, demoMode }: { token: string | null; role: string; demoMode: boolean }) {
  const canPlan = role === "admin" || role === "planner";
  const canSeeDemand = canPlan || role === "picker";
  const [weekOffset, setWeekOffset] = useState(1);
  const week = mondayOf(weekOffset);
  const [demand, setDemand] = useState<DispatchDemand | null>(null);
  const [saved, setSaved] = useState<SavedPlan[]>([]);
  const [plan, setPlan] = useState<DispatchPlan | null>(null);
  const [source, setSource] = useState<"solver" | "draft" | "confirmed">("solver");
  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const capacity = demand?.vehicles.length ? Math.min(...demand.vehicles.map((v) => v.pallet_capacity)) : 8;

  const load = useCallback(async () => {
    setError("");
    setNotice("");
    setLoading(true);
    setSelected(null);
    try {
      if (demoMode) {
        const d = demoDemand(week);
        setDemand(d);
        setSaved([]);
        setPlan(solveDispatch(d));
        setSource("solver");
        return;
      }
      if (!token) return;
      const [d, p] = await Promise.all([
        canSeeDemand ? apiRequest<DispatchDemand>(`/v1/dispatch/demand?week=${week}`, token) : Promise.resolve(null),
        apiRequest<SavedPlan[]>(`/v1/dispatch/plans?week=${week}`, token),
      ]);
      setDemand(d);
      setSaved(p);
      const confirmed = p.find((x) => x.status === "confirmed");
      const draft = p.find((x) => x.status === "draft");
      const cap = d?.vehicles.length ? Math.min(...d.vehicles.map((v) => v.pallet_capacity)) : 8;
      if (confirmed) {
        setPlan(fromSaved(confirmed, cap));
        setSource("confirmed");
      } else if (draft && canPlan) {
        setPlan(fromSaved(draft, cap));
        setSource("draft");
      } else if (d) {
        setPlan(solveDispatch(d));
        setSource("solver");
      } else {
        setPlan(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [canPlan, canSeeDemand, demoMode, token, week]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const resolve = () => {
    if (!demand) return;
    setPlan(solveDispatch(demand));
    setSource("solver");
    setSelected(null);
    setNotice("คำนวณใหม่จากของที่ต้องส่งล่าสุดแล้ว");
  };

  const save = async (status: "draft" | "confirmed") => {
    if (!plan) return;
    if (status === "confirmed" && plan.warnings.some((w) => w.code === "slot_conflict")) {
      setError("มีรถ 2 เที่ยวในวันเดียวกัน แก้ก่อนยืนยัน");
      return;
    }
    if (demoMode) {
      setNotice(status === "confirmed" ? "ตัวอย่าง: ยืนยันแผนจัดรถแล้ว เขตจะเห็นวันส่ง/วันมารับ" : "ตัวอย่าง: บันทึกร่างแล้ว");
      setSource(status);
      return;
    }
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest("/v1/dispatch/plans", token, {
        method: "POST",
        body: JSON.stringify({
          week_start: week,
          status,
          metrics: { ...plan.metrics, zone: plan.zone_metrics },
          warnings: plan.warnings,
          trips: plan.trips.map((t) => ({
            trip_date: t.trip_date,
            vehicle_code: t.vehicle_code,
            mode: t.mode,
            pallets: t.pallets,
            weight_kg: t.weight_kg,
            km: t.km,
            minutes: t.minutes,
            cost_baht: t.cost_baht,
            layout: t.layout,
            // trip-level notes ride on the first stop
            stops: t.stops.map((s, i) => (i === 0 ? { ...s, reason: t.reason, start_time: t.start_time, return_time: t.return_time } : s)),
          })),
        }),
      });
      await load();
      setNotice(status === "confirmed"
        ? "ยืนยันแผนจัดรถแล้ว · เขตเห็นวันส่งหรือวันมารับของตัวเองในเมนูรอบส่งของ"
        : "บันทึกร่างแล้ว");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const move = (tripId: string, value: string) => {
    if (!plan) return;
    const [mode, date, vehicle] = value.split("|");
    setPlan(moveTrip(plan, tripId, date || null, vehicle || null, mode as TripMode, capacity, demand?.settings));
    if (source !== "solver") setSource("solver");
  };

  // ---------------- district view: own confirmed trips only
  if (role === "district") {
    const confirmed = saved.find((p) => p.status === "confirmed");
    return (
      <div className="stack dp-page">
        <WeekSwitch week={week} offset={weekOffset} setOffset={setWeekOffset} onRefresh={() => void load()} />
        {error && <p className="pk-error">{error}</p>}
        {loading && !confirmed ? <p className="panel pk-empty">กำลังโหลด…</p> : !confirmed ? (
          <p className="panel pk-empty">คลังยังไม่ยืนยันการจัดรถของสัปดาห์นี้ · ดูวันส่งประจำโซนได้ที่แท็บถัดไป</p>
        ) : (
          <section className="dp-district-list">
            {confirmed.trips.map((t) => (
              <article key={t.dispatch_trip_id} className={`panel dp-district-card ${t.mode}`}>
                <span className={`dp-mode ${t.mode}`}>{MODE_TEXT[t.mode]}</span>
                <strong>{t.mode === "pickup" ? `มารับได้ตั้งแต่ ${dayLabel(t.trip_date)}` : dayLabel(t.trip_date)}</strong>
                {t.stops.filter((s) => s.district_id).map((s) => (
                  <p key={s.district_id}>
                    {s.district_name} · {s.pallets} พาเลท{s.eta && t.mode === "delivery" ? ` · ถึงประมาณ ${s.eta} น.` : ""}
                    {t.mode === "delivery" && t.stops.length > 1 ? ` · รถ ${t.vehicle_code}` : ""}
                  </p>
                ))}
                {t.mode === "pickup" && (
                  <small>{(t.stops[0] as { reason?: string }).reason ?? "สัปดาห์นี้รถคลังไม่พอ"} · ของจัดพาเลทรอไว้ โฟล์คลิฟท์ขึ้นรถให้</small>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
    );
  }

  if (loading && !plan) return <p className="panel pk-empty">{error || "กำลังโหลดของที่ต้องส่ง…"}</p>;

  const days = [1, 2, 3, 4, 5].map((wd) => ({ wd, iso: addDays(week, wd - 1) }));
  const vehicles = demand?.vehicles ?? [];
  const m = plan?.metrics;
  const z = plan?.zone_metrics;
  const active = (demand?.districts ?? []).filter((d) => d.pallets > 0);
  const totalPallets = active.reduce((a, d) => a + d.pallets, 0);
  const missingLines = active.reduce((a, d) => a + d.packing_missing_lines, 0);
  const totalLines = active.reduce((a, d) => a + d.lines, 0);
  const selectedTrip = plan?.trips.find((t) => t.id === selected) ?? null;
  const slotOptions = [
    ...days.flatMap(({ wd, iso }) => vehicles.map((v) => ({ value: `delivery|${iso}|${v.vehicle_code}`, label: `${WEEKDAYS[wd]} · ${v.label}` }))),
    { value: `pickup|${week}|`, label: "ให้เขตมารับเอง" },
    { value: "overflow||", label: "ยังไม่มีรถ (เลื่อน/ขอรถเพิ่ม)" },
  ];
  const diff = (a?: number, b?: number) => (a == null || b == null || b === 0 ? null : Math.round(((a - b) / b) * 100));

  return (
    <div className="stack dp-page">
      <section className="panel dp-intro">
        <div>
          <span>จัดรถจากของจริงของสัปดาห์</span>
          <p>
            รวมแผนที่ล็อกแล้ว + คำขอเพิ่มที่ตัดรอบเข้าสัปดาห์นี้ → นับพาเลทและน้ำหนัก → จับเขตที่ไปทางเดียวกันขึ้นรถเดียว (ไม่เกิน {capacity} พาเลท กลับถึงคลังก่อน {demand?.settings.return_by.slice(0, 5) ?? "15:00"})
            → ส่งไม่ช้ากว่าวันประจำโซน · ให้เขตมารับเองเฉพาะสัปดาห์ที่รถ {vehicles.length} คันไม่พอ
          </p>
        </div>
        {canPlan && <button type="button" className="btn ghost" onClick={() => setShowSettings((v) => !v)}>{showSettings ? "ปิดการตั้งค่า" : "ตั้งค่ารถ / เกณฑ์มารับเอง"}</button>}
      </section>

      <WeekSwitch week={week} offset={weekOffset} setOffset={setWeekOffset} onRefresh={() => void load()} />

      {error && <p className="pk-error">{error}</p>}
      {notice && <p className="um-notice">{notice}</p>}

      {showSettings && demand && canPlan && (
        <DispatchSettingsPanel demand={demand} token={token} demoMode={demoMode} onSaved={async (msg) => { await load(); setNotice(msg); }} />
      )}

      {demand && totalPallets === 0 && source === "solver" ? (
        <p className="panel pk-empty">
          ยังไม่มีของที่ต้องส่งในสัปดาห์ {dayLabel(week)} · แผนการจ่ายต้องผ่านการยืนยันของเขตก่อน หรือยังไม่มีคำขอเพิ่มที่ตัดรอบเข้าสัปดาห์นี้
        </p>
      ) : plan && m && z && (
        <>
          <section className="oh-summary dp-kpis">
            <article className={m.delivery_trips + m.overflow_trips <= z.delivery_trips + z.overflow_trips ? "good" : ""}>
              <span>เที่ยวรถคลัง</span>
              <strong>{m.delivery_trips}</strong>
              <small>แบบโซนตายตัว {z.delivery_trips + z.overflow_trips} เที่ยว{diff(m.delivery_trips, z.delivery_trips + z.overflow_trips) != null ? ` (${diff(m.delivery_trips, z.delivery_trips + z.overflow_trips)}%)` : ""}</small>
            </article>
            <article>
              <span>ระยะทาง / ชั่วโมงรถ</span>
              <strong>{formatNumber(Math.round(m.km))} กม.</strong>
              <small>{m.truck_hours} ชม. · แบบโซน {formatNumber(Math.round(z.km))} กม.</small>
            </article>
            <article>
              <span>น้ำมัน + ทางด่วน</span>
              <strong>{formatNumber(m.cost_baht)}</strong>
              <small>บาท · แบบโซน {formatNumber(z.cost_baht)} · {m.pallets ? `${formatNumber(Math.round(m.cost_baht / Math.max(1, m.pallets - plan.trips.filter((t) => t.mode !== "delivery").reduce((a, t) => a + t.pallets, 0))))} บาท/พาเลท` : ""}</small>
            </article>
            <article>
              <span>รถเต็มเฉลี่ย</span>
              <strong>{Math.round(m.fill_rate * 100)}%</strong>
              <small>{formatNumber(totalPallets)} พาเลท · แบบโซน {Math.round(z.fill_rate * 100)}%</small>
            </article>
            <article className={m.pickups || m.overflow_trips || m.stops_late ? "attn" : "good"}>
              <span>เขตมารับเอง / ยังไม่มีรถ</span>
              <strong>{m.pickups} / {m.overflow_trips}</strong>
              <small>ส่งตรงหรือก่อนวันโซน {m.stops_on_promise}/{m.stops} จุด</small>
            </article>
          </section>

          <section className="dp-toolbar">
            <span className={`dp-source ${source}`}>
              {source === "confirmed" ? "แผนที่ยืนยันแล้ว" : source === "draft" ? "ร่างที่บันทึกไว้" : "ผลคำนวณ (ยังไม่บันทึก)"}
            </span>
            {missingLines > 0 && <span className="dp-flag">พาเลทเป็นค่าประมาณ {missingLines}/{totalLines} รายการ (ไม่มี Packing)</span>}
            <span className="oh-tabs-spacer" />
            {canPlan && demand && <button type="button" className="btn ghost" onClick={resolve}>คำนวณใหม่</button>}
            {canPlan && <button type="button" className="btn ghost" disabled={busy} onClick={() => void save("draft")}>บันทึกร่าง</button>}
            {canPlan && <button type="button" className="btn primary" disabled={busy} onClick={() => void save("confirmed")}>ยืนยันแผนจัดรถ</button>}
          </section>

          {plan.warnings.length > 0 && (
            <ul className="dp-warnings">
              {plan.warnings.map((w, i) => <li key={`${w.code}-${i}`} className={w.level}>{w.message}</li>)}
            </ul>
          )}

          <section className="dp-board" style={{ gridTemplateColumns: `120px repeat(${days.length}, minmax(0, 1fr))` }}>
            <div className="dp-corner" />
            {days.map(({ wd, iso }) => <div key={iso} className="dp-dayhead"><b>{WEEKDAYS[wd]}</b><small>{dayLabel(iso)}</small></div>)}
            {vehicles.map((v) => (
              <div key={v.vehicle_code} className="dp-row">
                <div className="dp-truck"><b>{v.label}</b><small>{v.pallet_capacity} พาเลท{v.max_payload_kg ? ` · ${formatNumber(v.max_payload_kg / 1000)} ตัน` : ""}</small></div>
                {days.map(({ iso }) => {
                  const cell = plan.trips
                    .filter((t) => t.mode === "delivery" && t.trip_date === iso && t.vehicle_code === v.vehicle_code)
                    .sort((a, b) => (a.start_time ?? "").localeCompare(b.start_time ?? ""));
                  const conflict = plan.warnings.some((w) => w.code === "slot_conflict" && cell.some((t) => t.id === w.trip_id));
                  return (
                    <div key={iso} className={`dp-cell ${conflict ? "conflict" : ""}`}>
                      {cell.map((t) => <TripCard key={t.id} trip={t} capacity={v.pallet_capacity} active={selected === t.id} onClick={() => setSelected(selected === t.id ? null : t.id)} />)}
                      {!cell.length && <span className="dp-free">ว่าง</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>

          {plan.trips.some((t) => t.mode !== "delivery") && (
            <section className="dp-extra">
              {(["pickup", "overflow"] as TripMode[]).map((mode) => {
                const list = plan.trips.filter((t) => t.mode === mode);
                if (!list.length) return null;
                return (
                  <div key={mode} className="panel">
                    <h4>{mode === "pickup" ? `ให้เขตมารับเอง (${list.length})` : `ยังไม่มีรถ (${list.length})`}</h4>
                    {list.map((t) => <TripCard key={t.id} trip={t} capacity={capacity} active={selected === t.id} onClick={() => setSelected(selected === t.id ? null : t.id)} wide />)}
                  </div>
                );
              })}
            </section>
          )}

          {selectedTrip && (
            <section className="panel dp-detail">
              <header>
                <h4>{selectedTrip.id} · {MODE_TEXT[selectedTrip.mode]}{selectedTrip.trip_date ? ` · ${dayLabel(selectedTrip.trip_date)}` : ""}{selectedTrip.vehicle_code ? ` · รถ ${selectedTrip.vehicle_code}` : ""}</h4>
                {canPlan && (
                  <label>
                    <span>ย้ายไป</span>
                    <select
                      value={`${selectedTrip.mode}|${selectedTrip.mode === "overflow" ? "" : selectedTrip.trip_date ?? ""}|${selectedTrip.vehicle_code ?? ""}`}
                      onChange={(event) => move(selectedTrip.id, event.target.value)}
                    >
                      {slotOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                )}
              </header>
              {selectedTrip.reason && <p className="dp-reason">{selectedTrip.reason}</p>}
              <div className="dp-detail-grid">
                <div>
                  <table className="dp-stops">
                    <thead><tr><th>#</th><th>เขต</th><th>พาเลท (เต็ม/รวม)</th><th>น้ำหนัก</th><th>ถึง</th><th>วันโซน</th></tr></thead>
                    <tbody>
                      {selectedTrip.stops.map((s, i) => (
                        <tr key={s.district_id} className={s.promise_date && selectedTrip.trip_date && selectedTrip.mode === "delivery" && selectedTrip.trip_date > s.promise_date ? "late" : ""}>
                          <td>{i + 1}</td>
                          <td>{s.district_name}{s.urgent && <em className="dp-urgent"> ด่วน</em>}</td>
                          <td>{s.full_pallets} / {s.mixed_pallets}</td>
                          <td>{formatNumber(s.weight_kg)} กก.</td>
                          <td>{s.eta ?? "—"}</td>
                          <td>{dayLabel(s.promise_date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selectedTrip.mode === "delivery" && (
                    <p className="dp-meta">
                      ระยะทาง {selectedTrip.km} กม. · ใช้เวลา {Math.floor(selectedTrip.minutes / 60)} ชม. {selectedTrip.minutes % 60} นาที
                      {selectedTrip.return_time ? ` · กลับถึงคลังประมาณ ${selectedTrip.return_time} น.` : ""} · {baht(selectedTrip.cost_baht)}
                    </p>
                  )}
                  <DistrictItems trip={selectedTrip} districts={demand?.districts ?? []} />
                </div>
                {selectedTrip.mode === "delivery" && selectedTrip.layout.length > 0 && <TruckLayout trip={selectedTrip} />}
              </div>
            </section>
          )}

          {demand && (
            <details className="panel dp-demand">
              <summary>ของที่ต้องส่งรายเขต ({active.length} เขต · {formatNumber(totalPallets)} พาเลท)</summary>
              <table>
                <thead><tr><th>เขต</th><th>โซน / วันส่ง</th><th>รายการ</th><th>พาเลทเต็ม</th><th>พาเลทรวม</th><th>รวม</th><th>น้ำหนัก</th><th>ห่างคลัง</th><th>หมายเหตุ</th></tr></thead>
                <tbody>
                  {active.map((d) => (
                    <tr key={d.district_id}>
                      <td>{d.district_name}</td>
                      <td>{d.zone ?? "—"} · {dayLabel(d.promise_date)}</td>
                      <td>{d.lines}{d.extra_lines ? ` (+เพิ่ม ${d.extra_lines})` : ""}</td>
                      <td>{formatNumber(d.full_pallets)}</td>
                      <td>{formatNumber(Math.round(d.mixed_fraction * 100) / 100)}</td>
                      <td><b>{d.pallets}</b></td>
                      <td>{formatNumber(d.weight_kg)} กก.</td>
                      <td>{d.depot_km != null ? `${d.depot_km} กม.` : "—"}</td>
                      <td>
                        {d.urgent && <em className="dp-urgent">ด่วน </em>}
                        {d.packing_missing_lines > 0 && <span className="dp-flag">ประมาณ {d.packing_missing_lines} รายการ</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {saved.length > 0 && (
            <p className="dp-meta">
              {saved.map((p) => `${p.status === "confirmed" ? "ยืนยัน" : "ร่าง"}โดย ${p.status === "confirmed" ? p.confirmed_by_name ?? "-" : p.created_by_name ?? "-"} เมื่อ ${new Date(p.confirmed_at ?? p.created_at).toLocaleString("th-TH")}`).join(" · ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function WeekSwitch({ week, offset, setOffset, onRefresh }: { week: string; offset: number; setOffset: (n: number) => void; onRefresh: () => void }) {
  return (
    <div className="oh-tabs" role="tablist">
      {[[0, "สัปดาห์นี้"], [1, "สัปดาห์หน้า"], [2, "อีก 2 สัปดาห์"]].map(([value, label]) => (
        <button key={label} type="button" role="tab" aria-selected={offset === value} className={offset === value ? "active" : ""} onClick={() => setOffset(Number(value))}>{label}</button>
      ))}
      <span className="dp-weeklabel">{dayLabel(week)} – {dayLabel(addDays(week, 4))}</span>
      <span className="oh-tabs-spacer" />
      <button type="button" className="btn ghost" onClick={onRefresh}>รีเฟรช</button>
    </div>
  );
}

function TripCard({ trip, capacity, active, onClick, wide }: { trip: PlannedTrip; capacity: number; active: boolean; onClick: () => void; wide?: boolean }) {
  return (
    <button type="button" className={`dp-trip ${trip.mode} ${active ? "active" : ""} ${wide ? "wide" : ""}`} onClick={onClick}>
      <span className="dp-trip-head">
        <b>{trip.id}</b>
        <span className="dp-fill"><i style={{ width: `${Math.min(100, (trip.pallets / capacity) * 100)}%` }} /></span>
        <small>{trip.pallets}/{capacity}</small>
      </span>
      <span className="dp-trip-stops">{trip.stops.map((s) => `${s.district_name} ${s.pallets}`).join(" → ")}</span>
      {trip.mode === "delivery" && <small>{trip.start_time && trip.start_time !== "09:30" ? `ออก ${trip.start_time} · ` : ""}{trip.km} กม. · กลับ {trip.return_time ?? "—"}</small>}
      {trip.mode !== "delivery" && trip.reason && <small>{trip.reason}</small>}
    </button>
  );
}

function TruckLayout({ trip }: { trip: PlannedTrip }) {
  const order = new Map(trip.stops.map((s, i) => [s.district_id, i + 1]));
  const rows = Math.ceil(trip.layout.length / 2);
  return (
    <figure className="dp-layout">
      <figcaption>ผังวางพาเลท (มองจากด้านบน)</figcaption>
      <div className="dp-cab">หัวรถ</div>
      <div className="dp-deck" style={{ gridTemplateRows: `repeat(${rows}, 1fr)` }}>
        {trip.layout.map((slot) => (
          <span key={slot.slot} className={`dp-pallet ${slot.kind} s${order.get(slot.district_id ?? "") ?? 0}`}>
            {slot.district_id ? <><b>{order.get(slot.district_id)}</b><small>{slot.kind === "full" ? "เต็ม" : "รวม"}</small></> : ""}
          </span>
        ))}
      </div>
      <div className="dp-cab tail">ท้ายรถ · ลงจุดที่ 1 ก่อน</div>
    </figure>
  );
}

function DistrictItems({ trip, districts }: { trip: PlannedTrip; districts: DispatchDistrict[] }) {
  const rows = trip.stops.flatMap((s) => (districts.find((d) => d.district_id === s.district_id)?.items ?? []).map((item) => ({ s, item })));
  if (!rows.length) return null;
  return (
    <details className="dp-items">
      <summary>รายการพัสดุ ({rows.length})</summary>
      <table>
        <thead><tr><th>เขต</th><th>พัสดุ</th><th>จำนวน</th><th>พาเลท</th><th>ที่มา</th></tr></thead>
        <tbody>
          {rows.map(({ s, item }, i) => (
            <tr key={`${item.material_id}-${i}`}>
              <td>{s.district_name}</td>
              <td>{item.material_name ?? item.material_id}{item.packing_missing && <span className="dp-flag"> {item.lot_size_estimate ? "ประมาณจาก Lot Size" : "ไม่มี Packing"}</span>}</td>
              <td>{formatNumber(item.qty)} {item.unit ?? ""}</td>
              <td>{item.full_pallets > 0 ? `${item.full_pallets} เต็ม + ` : ""}{Math.round(item.mixed_fraction * 100)}%</td>
              <td>{item.source === "extra" ? `ขอเพิ่ม ${item.reference}` : item.reference}{item.urgent && <em className="dp-urgent"> ด่วน</em>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <small>ส่วนที่ไม่เต็มพาเลท ระบบรวมของหลายรายการของเขตเดียวกันขึ้นพาเลทเดียว (พาเลทรวม)</small>
    </details>
  );
}

function DispatchSettingsPanel({ demand, token, demoMode, onSaved }: {
  demand: DispatchDemand; token: string | null; demoMode: boolean; onSaved: (msg: string) => Promise<void> | void;
}) {
  const s = demand.settings;
  const [form, setForm] = useState({
    pickup_max_km: String(s.pickup_max_km),
    pickup_min_pallets: String(s.pickup_min_pallets),
    pickup_rotation_weeks: String(s.pickup_rotation_weeks),
    unload_minutes: String(s.unload_minutes),
    avg_speed_kmh: String(s.avg_speed_kmh),
    loose_per_mixed_pallet: String((s as { loose_per_mixed_pallet?: number }).loose_per_mixed_pallet ?? 30),
    return_by: s.return_by.slice(0, 5),
    max_trips_per_truck_day: String(s.max_trips_per_truck_day ?? 1),
    reload_minutes: String(s.reload_minutes ?? 30),
  });
  const [payload, setPayload] = useState<Record<string, string>>(
    Object.fromEntries(demand.vehicles.map((v) => [v.vehicle_code, v.max_payload_kg ? String(v.max_payload_kg / 1000) : ""])),
  );
  const [districts, setDistricts] = useState<Record<string, { has_vehicle: string; pickup_allowed: boolean; depot_km: string }>>(
    Object.fromEntries(demand.districts.map((d) => [d.district_id, {
      has_vehicle: d.has_vehicle == null ? "" : String(d.has_vehicle), pickup_allowed: d.pickup_allowed, depot_km: d.depot_km == null ? "" : String(d.depot_km),
    }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const near = useMemo(() => demand.districts.filter((d) => (d.depot_km ?? 999) <= Number(form.pickup_max_km)).map((d) => d.district_name), [demand.districts, form.pickup_max_km]);

  const submit = async () => {
    if (demoMode) {
      await onSaved("ตัวอย่าง: บันทึกการตั้งค่าแล้ว");
      return;
    }
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest("/v1/dispatch/config", token, {
        method: "POST",
        body: JSON.stringify({
          settings: {
            pickup_max_km: Number(form.pickup_max_km), pickup_min_pallets: Number(form.pickup_min_pallets),
            pickup_rotation_weeks: Number(form.pickup_rotation_weeks), unload_minutes: Number(form.unload_minutes),
            avg_speed_kmh: Number(form.avg_speed_kmh), loose_per_mixed_pallet: Number(form.loose_per_mixed_pallet),
            return_by: form.return_by,
            max_trips_per_truck_day: Number(form.max_trips_per_truck_day), reload_minutes: Number(form.reload_minutes),
          },
          vehicles: Object.entries(payload).map(([vehicle_code, tons]) => ({
            vehicle_code, max_payload_kg: tons.trim() ? String(Math.round(Number(tons) * 1000)) : "",
          })),
          districts: Object.entries(districts).map(([district_id, v]) => ({
            district_id, has_vehicle: v.has_vehicle, pickup_allowed: v.pickup_allowed, depot_km: v.depot_km,
          })),
        }),
      });
      await onSaved("บันทึกการตั้งค่าแล้ว · กดคำนวณใหม่เพื่อใช้ค่าใหม่");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof form, label: string, hint?: string) => (
    <label><span>{label}</span><input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />{hint && <small>{hint}</small>}</label>
  );

  return (
    <section className="panel dp-settings">
      <h4>รถ</h4>
      <div className="dc-edit-grid">
        {demand.vehicles.map((v) => (
          <label key={v.vehicle_code}>
            <span>{v.label} · น้ำหนักบรรทุกสูงสุด (ตัน)</span>
            <input inputMode="decimal" placeholder="ยังไม่ได้กรอก" value={payload[v.vehicle_code] ?? ""} onChange={(e) => setPayload({ ...payload, [v.vehicle_code]: e.target.value })} />
            <small>{v.pallet_capacity} พาเลท · ว่างไว้ = ไม่ตรวจน้ำหนัก</small>
          </label>
        ))}
        {field("return_by", "ต้องกลับถึงคลังก่อน")}
        {field("unload_minutes", "เวลาลงของต่อจุด (นาที)")}
        {field("avg_speed_kmh", "ความเร็วเฉลี่ยรวมรถติด (กม./ชม.)")}
        {field("loose_per_mixed_pallet", "ของไม่เต็มพาเลท: กี่หีบห่อต่อ 1 พาเลทรวม")}
        <label>
          <span>เที่ยวต่อรถต่อวัน</span>
          <select value={form.max_trips_per_truck_day} onChange={(e) => setForm({ ...form, max_trips_per_truck_day: e.target.value })}>
            <option value="1">1 เที่ยว (แบบปัจจุบัน)</option>
            <option value="2">สูงสุด 2 เที่ยว ถ้ากลับคลังทัน</option>
          </select>
          <small>เที่ยวที่ 2 ออกได้หลังรถกลับ + เวลาโหลดของ</small>
        </label>
        {field("reload_minutes", "เวลาโหลดของก่อนออกเที่ยวที่ 2 (นาที)")}
      </div>
      <h4>เกณฑ์ให้เขตมารับเอง (ใช้เฉพาะสัปดาห์ที่รถไม่พอ)</h4>
      <div className="dc-edit-grid">
        {field("pickup_max_km", "ห่างคลังไม่เกิน (กม.)", near.join(", "))}
        {field("pickup_min_pallets", "ของเขตเดียวอย่างน้อย (พาเลท)")}
        {field("pickup_rotation_weeks", "ผลัดกัน: มารับแล้วใน (สัปดาห์) → ไปท้ายคิว")}
      </div>
      <table className="dp-district-settings">
        <thead><tr><th>เขต</th><th>ห่างคลัง (กม.)</th><th>มีรถมารับได้</th><th>ให้มารับได้</th></tr></thead>
        <tbody>
          {demand.districts.map((d) => {
            const v = districts[d.district_id];
            return (
              <tr key={d.district_id}>
                <td>{d.district_name}</td>
                <td><input value={v.depot_km} onChange={(e) => setDistricts({ ...districts, [d.district_id]: { ...v, depot_km: e.target.value } })} /></td>
                <td>
                  <select value={v.has_vehicle} onChange={(e) => setDistricts({ ...districts, [d.district_id]: { ...v, has_vehicle: e.target.value } })}>
                    <option value="">ไม่ทราบ (ต้องถาม)</option>
                    <option value="true">มี</option>
                    <option value="false">ไม่มี</option>
                  </select>
                </td>
                <td><input type="checkbox" checked={v.pickup_allowed} onChange={(e) => setDistricts({ ...districts, [d.district_id]: { ...v, pickup_allowed: e.target.checked } })} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="pk-error">{error}</p>}
      <div className="um-actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>บันทึกการตั้งค่า</button></div>
    </section>
  );
}
