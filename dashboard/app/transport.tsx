"use client";

import { useMemo, useState, type ReactNode } from "react";
import { formatNumber } from "./lib";
import {
  DIST_GEO,
  REPLENISHMENT_PLAN,
  ROUTE_DISTRICT_IDS,
  ROUTES,
  SEED_TRIPS,
  VEHICLES,
  WAREHOUSES,
  districtName,
  planRoute,
  type Trip,
  type Warehouse,
} from "./transport-data";

export type TransportView = "dashboard" | "planner" | "map" | "history";

export const transportNav: Array<[TransportView, string, string]> = [
  ["dashboard", "ภาพรวมขนส่ง", "⌂"],
  ["planner", "วางแผนจัดรถ", "▤"],
  ["map", "แผนที่เส้นทาง", "◎"],
  ["history", "ประวัติการเดินรถ", "◷"],
];

const transportTitles: Record<TransportView, [string, string, string]> = {
  dashboard: [
    "TRANSPORT",
    "ภาพรวมการขนส่ง",
    "สรุปรถ คนขับ แผนการเดินรถ และงานที่รอจัดส่งของ Batch ปัจจุบัน",
  ],
  planner: [
    "ROUTE PLANNER",
    "วางแผนจัดรถและเส้นทาง",
    "เลือกคลังต้นทางและเขตปลายทาง ระบบจัดลำดับเส้นทางแบบ nearest-neighbour พร้อมคำนวณระยะทาง ค่าทางด่วน และค่าน้ำมัน",
  ],
  map: [
    "ROUTE MAP",
    "แผนที่เส้นทางการจ่าย",
    "ตำแหน่งคลังกลางและเขตปลายทางบนผังภายใน พร้อมเส้นทางที่วางแผน",
  ],
  history: [
    "TRIP HISTORY",
    "ประวัติการเดินรถ",
    "เที่ยวรถที่วางแผนและส่งครบแล้ว แยกตาม Batch พร้อมค่าน้ำมันจริงเทียบประมาณการ",
  ],
};

function statusTone(status: string) {
  if (status.includes("ส่งครบ") || status.includes("เสร็จ")) return "normal";
  if (status.includes("ยกเลิก") || status.includes("ปัญหา")) return "critical";
  return "urgent";
}

function TBadge({ children }: { children: ReactNode }) {
  return (
    <span className={`badge ${statusTone(String(children))}`}>
      <i />
      {children}
    </span>
  );
}

function MapCanvas({
  route,
  highlight,
  onPick,
}: {
  route: string[];
  highlight?: string | null;
  onPick?: (id: string) => void;
}) {
  const wh = DIST_GEO.WH;
  const points = [wh, ...route.map((id) => DIST_GEO[id])].filter(Boolean);
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg
      viewBox="0 0 850 520"
      style={{
        width: "100%",
        height: "auto",
        background:
          "linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%)",
        borderRadius: 14,
        border: "1px solid #e2e8f0",
      }}
    >
      <defs>
        <marker
          id="arrow"
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill="#E3670A" />
        </marker>
      </defs>
      {route.length > 0 && (
        <polyline
          points={polyline}
          fill="none"
          stroke="#E3670A"
          strokeWidth={2.5}
          strokeDasharray="6 4"
          markerMid="url(#arrow)"
          markerEnd="url(#arrow)"
          opacity={0.85}
        />
      )}
      {ROUTE_DISTRICT_IDS.map((id) => {
        const node = DIST_GEO[id];
        if (!node) return null;
        const inRoute = route.includes(id);
        const isHi = highlight === id;
        return (
          <g
            key={id}
            transform={`translate(${node.x},${node.y})`}
            style={{ cursor: onPick ? "pointer" : "default" }}
            onClick={() => onPick?.(id)}
          >
            <circle
              r={isHi ? 11 : 7}
              fill={inRoute ? "#E3670A" : isHi ? "#1A56DB" : "#fff"}
              stroke={inRoute ? "#c2560a" : "#94a3b8"}
              strokeWidth={2}
            />
            <text
              x={12}
              y={4}
              fontSize={11}
              fontWeight={600}
              fill="#334155"
            >
              {id}
            </text>
          </g>
        );
      })}
      {/* Warehouse marker */}
      <g transform={`translate(${wh.x},${wh.y})`}>
        <rect x={-9} y={-9} width={18} height={18} rx={4} fill="#1A56DB" />
        <text x={14} y={5} fontSize={12} fontWeight={700} fill="#1A56DB">
          คลังกลาง
        </text>
      </g>
    </svg>
  );
}

function TransportDashboard({ trips }: { trips: Trip[] }) {
  const planned = trips.filter((t) => t.status.includes("วางแผน"));
  const done = trips.filter((t) => t.status.includes("ส่งครบ"));
  const activeVeh = VEHICLES.filter((v) => v.active).length;
  const pendingLines = REPLENISHMENT_PLAN.length;
  return (
    <div className="stack">
      <section className="kpis">
        <article>
          <div>
            <span>รถพร้อมใช้งาน</span>
            <i className="dot blue" />
          </div>
          <strong>{formatNumber(activeVeh)}</strong>
          <small>6-wheel · 3 คลัง</small>
        </article>
        <article>
          <div>
            <span>เที่ยวรอออก (Batch นี้)</span>
            <i className="dot orange" />
          </div>
          <strong>{formatNumber(planned.length)}</strong>
          <small>สถานะ วางแผน</small>
        </article>
        <article>
          <div>
            <span>รายการรอจัดส่ง</span>
            <i className="dot purple" />
          </div>
          <strong>{formatNumber(pendingLines)}</strong>
          <small>Trans_Replenishment_Plan</small>
        </article>
        <article>
          <div>
            <span>ส่งครบสะสม</span>
            <i className="dot green" />
          </div>
          <strong>{formatNumber(done.length)}</strong>
          <small>ประวัติเที่ยวรถ</small>
        </article>
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <span>รถขนส่ง</span>
            <h3>สถานะรถและคนขับ</h3>
          </div>
          <b>{formatNumber(activeVeh)}</b>
        </div>
        <div className="live-table-wrap">
          <table className="live-table">
            <thead>
              <tr>
                <th>รหัสรถ</th>
                <th>ทะเบียน</th>
                <th>คลังประจำ</th>
                <th>คนขับ</th>
                <th>น้ำหนักบรรทุก</th>
                <th>อัตราน้ำมัน</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {VEHICLES.map((v) => (
                <tr key={v.id}>
                  <td>
                    <span>
                      <strong>{v.code}</strong>
                      <small>{v.id}</small>
                    </span>
                  </td>
                  <td>{v.plate}</td>
                  <td>{v.currentWh}</td>
                  <td>{v.driver}</td>
                  <td>{formatNumber(v.maxWt)} กก.</td>
                  <td>{v.fuelRate} กม./ล.</td>
                  <td>
                    <TBadge>{v.loanStatus === "HOME" ? "พร้อมใช้" : v.loanStatus}</TBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <span>BATCH ปัจจุบัน</span>
            <h3>เที่ยวรถที่วางแผนไว้</h3>
          </div>
          <b>{formatNumber(planned.length)}</b>
        </div>
        <div className="live-table-wrap">
          <table className="live-table">
            <thead>
              <tr>
                <th>เที่ยว</th>
                <th>รถ</th>
                <th>คลัง</th>
                <th>เส้นทาง</th>
                <th>ระยะทาง</th>
                <th>ค่าทางด่วน</th>
                <th>ค่าน้ำมัน (ประมาณ)</th>
              </tr>
            </thead>
            <tbody>
              {planned.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.veh}</td>
                  <td>{t.wh}</td>
                  <td>{t.route.map((id) => districtName(id)).join(" → ")}</td>
                  <td>{formatNumber(t.dist, 1)} กม.</td>
                  <td>{formatNumber(t.toll)} ฿</td>
                  <td>{formatNumber(t.fuel, 2)} ฿</td>
                </tr>
              ))}
              {planned.length === 0 && (
                <tr>
                  <td colSpan={7}>ยังไม่มีเที่ยวรถที่วางแผน</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TransportPlanner({
  onSave,
}: {
  onSave: (trip: Trip) => void;
}) {
  const [warehouse, setWarehouse] = useState<Warehouse>("คลองเตย");
  const [selected, setSelected] = useState<string[]>([]);
  const servable = useMemo(
    () => ROUTE_DISTRICT_IDS.filter((id) => ROUTES[warehouse][id]),
    [warehouse],
  );
  const toggle = (id: string) =>
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  const plan = useMemo(
    () => planRoute(warehouse, selected),
    [warehouse, selected],
  );
  const save = () => {
    if (!plan.order.length || !plan.vehicle) return;
    const today = new Date();
    const trip: Trip = {
      id: `TRP-${today.getFullYear() + 543}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 90 + 10)}`,
      batch: `BATCH-${today.getFullYear() + 543}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}-A`,
      veh: plan.vehicle.id,
      driver: plan.vehicle.driver,
      wh: warehouse,
      route: plan.order,
      dist: plan.totalDist,
      toll: plan.totalToll,
      fuel: plan.fuelCost,
      fuelAct: null,
      date: today.toLocaleDateString("th-TH"),
      depart: "",
      ret: "",
      status: "วางแผน",
      wt: 0,
      maxWt: plan.vehicle.maxWt,
      notes: "",
    };
    onSave(trip);
    setSelected([]);
  };
  return (
    <div className="stack">
      <section className="filter-bar">
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          คลังต้นทาง
          <select
            value={warehouse}
            onChange={(e) => {
              setWarehouse(e.target.value as Warehouse);
              setSelected([]);
            }}
          >
            {WAREHOUSES.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn primary"
          disabled={!plan.order.length}
          onClick={save}
        >
          ＋ บันทึกเที่ยวรถ
        </button>
      </section>

      <section className="dashboard-main">
        <article className="panel">
          <div className="panel-title">
            <div>
              <span>เลือกเขตปลายทาง</span>
              <h3>{warehouse} → เขต</h3>
            </div>
            <b>{selected.length} เขต</b>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))",
              gap: 8,
              padding: 12,
            }}
          >
            {servable.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => toggle(id)}
                className={`table-action ${selected.includes(id) ? "" : ""}`}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: selected.includes(id)
                    ? "2px solid #E3670A"
                    : "1px solid #e2e8f0",
                  background: selected.includes(id) ? "#fff7ed" : "#fff",
                  cursor: "pointer",
                }}
              >
                <strong style={{ display: "block", fontSize: 12 }}>{id}</strong>
                <small style={{ color: "#64748b" }}>{districtName(id)}</small>
              </button>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-title">
            <div>
              <span>ผลการจัดเส้นทาง</span>
              <h3>Nearest-neighbour</h3>
            </div>
          </div>
          <div className="inventory-summary" style={{ padding: 12 }}>
            <article>
              <span>ระยะทางรวม</span>
              <strong>{formatNumber(plan.totalDist, 1)}</strong>
              <small>กม.</small>
            </article>
            <article>
              <span>ค่าทางด่วน</span>
              <strong>{formatNumber(plan.totalToll)}</strong>
              <small>บาท</small>
            </article>
            <article>
              <span>เวลาโดยประมาณ</span>
              <strong>{formatNumber(plan.totalTime)}</strong>
              <small>นาที</small>
            </article>
            <article>
              <span>ค่าน้ำมันประมาณ</span>
              <strong>{formatNumber(plan.fuelCost, 2)}</strong>
              <small>บาท</small>
            </article>
          </div>
          <div style={{ padding: "0 12px 12px" }}>
            <p style={{ fontSize: 13, color: "#334155", margin: "4px 0" }}>
              รถที่แนะนำ:{" "}
              <strong>
                {plan.vehicle
                  ? `${plan.vehicle.code} · ${plan.vehicle.driver}`
                  : "ไม่มีรถประจำคลังนี้"}
              </strong>
            </p>
            <p style={{ fontSize: 13, color: "#334155", margin: "4px 0" }}>
              ลำดับการจ่าย:{" "}
              <strong>
                {plan.order.length
                  ? `คลัง → ${plan.order.join(" → ")}`
                  : "ยังไม่เลือกเขต"}
              </strong>
            </p>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <span>แผนที่เส้นทาง</span>
            <h3>เส้นทางที่วางแผน</h3>
          </div>
        </div>
        <div style={{ padding: 12 }}>
          <MapCanvas route={plan.order} onPick={toggle} />
        </div>
      </section>
    </div>
  );
}

function TransportMap() {
  const [picked, setPicked] = useState<string | null>(null);
  const [warehouse, setWarehouse] = useState<Warehouse>("คลองเตย");
  const route = picked ? [picked] : [];
  const leg = picked ? ROUTES[warehouse][picked] : null;
  return (
    <div className="stack">
      <section className="filter-bar">
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          คลังต้นทาง
          <select
            value={warehouse}
            onChange={(e) => setWarehouse(e.target.value as Warehouse)}
          >
            {WAREHOUSES.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 13, color: "#64748b" }}>
          คลิกจุดเขตบนแผนที่เพื่อดูระยะทางจากคลัง
        </span>
      </section>
      <section className="panel">
        <div style={{ padding: 12 }}>
          <MapCanvas
            route={route}
            highlight={picked}
            onPick={(id) => setPicked(id)}
          />
        </div>
      </section>
      {picked && leg && (
        <section className="inventory-summary">
          <article>
            <span>เขตปลายทาง</span>
            <strong style={{ fontSize: 15 }}>{districtName(picked)}</strong>
            <small>{picked}</small>
          </article>
          <article>
            <span>ระยะทางจาก {warehouse}</span>
            <strong>{formatNumber(leg.dist, 1)}</strong>
            <small>กม.</small>
          </article>
          <article>
            <span>ค่าทางด่วน</span>
            <strong>{formatNumber(leg.toll)}</strong>
            <small>บาท</small>
          </article>
          <article>
            <span>เวลาเดินทาง</span>
            <strong>{formatNumber(leg.time)}</strong>
            <small>นาที</small>
          </article>
        </section>
      )}
    </div>
  );
}

function TransportHistory({ trips }: { trips: Trip[] }) {
  const [filter, setFilter] = useState("");
  const rows = trips.filter(
    (t) =>
      !filter ||
      `${t.id} ${t.batch} ${t.veh} ${t.driver} ${t.wh}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  return (
    <div className="stack">
      <section className="filter-bar">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="ค้นหา เที่ยว / Batch / รถ / คนขับ / คลัง"
        />
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>ประวัติเที่ยวรถ</span>
            <h3>{rows.length} เที่ยว</h3>
          </div>
        </div>
        <div className="live-table-wrap">
          <table className="live-table">
            <thead>
              <tr>
                <th>เที่ยว</th>
                <th>Batch</th>
                <th>รถ / คนขับ</th>
                <th>คลัง</th>
                <th>เส้นทาง</th>
                <th>ระยะทาง</th>
                <th>ค่าน้ำมัน (ประมาณ/จริง)</th>
                <th>วันที่</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.batch}</td>
                  <td>
                    <span>
                      <strong>{t.veh}</strong>
                      <small>{t.driver}</small>
                    </span>
                  </td>
                  <td>{t.wh}</td>
                  <td>{t.route.join(" → ")}</td>
                  <td>{formatNumber(t.dist, 1)} กม.</td>
                  <td>
                    {formatNumber(t.fuel, 2)}
                    {t.fuelAct != null ? ` / ${formatNumber(t.fuelAct, 2)}` : " / —"}
                  </td>
                  <td>{t.date}</td>
                  <td>
                    <TBadge>{t.status}</TBadge>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9}>ไม่พบเที่ยวรถ</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function TransportModule({ view }: { view: TransportView }) {
  const [trips, setTrips] = useState<Trip[]>(SEED_TRIPS);
  const [eyebrow, title, description] = transportTitles[view];
  return (
    <>
      <header className="page-head user-page-head">
        <div>
          <span>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>
      <aside className="runtime-message warning" role="status">
        <i>!</i>
        <div>
          <strong>โมดูลขนส่งใช้ข้อมูลต้นแบบจาก pipeline เดิม</strong>
          <p>
            เส้นทาง ระยะทางและรถ มาจากชุดข้อมูล DB_Route/รถของแอปเดิม เพื่อให้ใช้งานได้เหมือน
            pipeline เก่า เที่ยวรถที่บันทึกใหม่จะเก็บในเซสชันนี้ ยังไม่เชื่อมตาราง Supabase
            (routing อยู่นอกขอบเขต Business Rules v1)
          </p>
        </div>
      </aside>
      {view === "dashboard" && <TransportDashboard trips={trips} />}
      {view === "planner" && (
        <TransportPlanner onSave={(t) => setTrips((cur) => [t, ...cur])} />
      )}
      {view === "map" && <TransportMap />}
      {view === "history" && <TransportHistory trips={trips} />}
    </>
  );
}
