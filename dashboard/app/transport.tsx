"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRequest, formatNumber } from "./lib";
import {
  DIST_GEO,
  REPLENISHMENT_PLAN,
  ROUTES,
  SEED_TRIPS,
  VEHICLES,
  WAREHOUSES,
  type Trip,
} from "./transport-data";

export type TransportView = "dashboard" | "planner" | "map" | "history";

export const transportNav: Array<[TransportView, string, string]> = [
  ["dashboard", "ภาพรวมขนส่ง", "⌂"],
  ["planner", "วางแผนจัดรถ", "▤"],
  ["map", "แผนที่เส้นทาง", "◎"],
  ["history", "ประวัติการเดินรถ", "◷"],
];

const transportTitles: Record<TransportView, [string, string, string]> = {
  dashboard: ["TRANSPORT", "ภาพรวมการขนส่ง", "สรุปรถ คนขับ และงานที่รอจัดส่งจากแผนจริง"],
  planner: [
    "ROUTE OPTIMIZER",
    "วางแผนจัดรถและปรับเส้นทาง",
    "ดึงงานจากแผน replenishment ที่ locked แล้ว จัดเส้นทางแบบ nearest-neighbour + 2-opt (ฟรี ไม่ต้องมี engine ภายนอก) แบ่งรถตามจำนวนจุด แล้วบันทึกลง Supabase",
  ],
  map: ["ROUTE MAP", "แผนที่เส้นทางการจ่าย", "ตำแหน่งคลังและเขตปลายทางบนผังภายใน"],
  history: ["TRIP HISTORY", "ประวัติการเดินรถ", "เที่ยวรถที่บันทึกในระบบ พร้อมค่าน้ำมันจริงเทียบประมาณการ"],
};

// ---- Normalised transport data ----
type TGeo = {
  ref: string;
  name: string;
  x: number;
  y: number;
  lat: number;
  lon: number;
  districtId: string | null;
  isWarehouse: boolean;
};
type TLeg = { dist: number; toll: number; time: number };
type TVehicle = {
  id: string;
  code: string;
  plate: string;
  currentWarehouse: string;
  driver: string;
  maxWt: number;
  fuelRate: number;
  fuelPrice: number;
  active: boolean;
};
type TTrip = {
  id: string;
  code: string;
  batch: string | null;
  vehicle: string;
  driver: string;
  warehouse: string;
  route: string[];
  dist: number;
  toll: number;
  fuel: number;
  fuelActual: number | null;
  date: string;
  status: string;
  notes: string;
};
type QueueRow = {
  districtRef: string;
  districtId: string;
  districtName: string;
  totalQty: number;
  lineCount: number;
  suggestedWarehouse: string;
  suggestedDistanceKm: number;
  planId: string | null;
  planNumber: string;
};

type TransportData = {
  geo: Record<string, TGeo>;
  routes: Record<string, Record<string, TLeg>>;
  vehicles: TVehicle[];
  trips: TTrip[];
  warehouses: string[];
  queue: QueueRow[];
};

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (v == null ? "" : String(v));

function localData(): TransportData {
  const geo: Record<string, TGeo> = {};
  Object.entries(DIST_GEO).forEach(([ref, g]) => {
    geo[ref] = {
      ref,
      name: g.name,
      x: g.x,
      y: g.y,
      lat: g.lat,
      lon: g.lon,
      districtId: null,
      isWarehouse: ref === "WH",
    };
  });
  const routes: Record<string, Record<string, TLeg>> = {};
  (Object.keys(ROUTES) as Array<keyof typeof ROUTES>).forEach((wh) => {
    routes[wh] = {};
    Object.entries(ROUTES[wh]).forEach(([ref, leg]) => {
      routes[wh][ref] = { dist: leg.dist, toll: leg.toll, time: leg.time };
    });
  });
  const vehicles: TVehicle[] = VEHICLES.map((v) => ({
    id: v.id,
    code: v.code,
    plate: v.plate,
    currentWarehouse: v.currentWh,
    driver: v.driver,
    maxWt: v.maxWt,
    fuelRate: v.fuelRate,
    fuelPrice: v.fuelPrice,
    active: v.active,
  }));
  const trips: TTrip[] = SEED_TRIPS.map((t: Trip) => ({
    id: t.id,
    code: t.id,
    batch: t.batch,
    vehicle: t.veh,
    driver: t.driver,
    warehouse: t.wh,
    route: t.route,
    dist: t.dist,
    toll: t.toll,
    fuel: t.fuel,
    fuelActual: t.fuelAct,
    date: t.date,
    status: t.status,
    notes: t.notes,
  }));
  return { geo, routes, vehicles, trips, warehouses: [...WAREHOUSES], queue: [] };
}

function mapStatus(s: string) {
  return (
    { planned: "วางแผน", dispatched: "ออกรถแล้ว", completed: "ส่งครบ", cancelled: "ยกเลิก" }[s] ?? s
  );
}

async function loadRemote(token: string): Promise<TransportData> {
  const [geoRows, vehRows, matrixRows, tripRows] = await Promise.all([
    apiRequest<Row[]>("/v1/transport/geo", token),
    apiRequest<Row[]>("/v1/transport/vehicles", token),
    apiRequest<Row[]>("/v1/transport/route-matrix", token),
    apiRequest<Row[]>("/v1/transport/trips?limit=200", token),
  ]);
  // Dispatch queue is best-effort (empty until locked plans exist).
  let queueRows: Row[] = [];
  try {
    queueRows = await apiRequest<Row[]>("/v1/transport/dispatch-queue", token);
  } catch {
    queueRows = [];
  }
  const geo: Record<string, TGeo> = {};
  geoRows.forEach((g) => {
    geo[str(g.district_ref)] = {
      ref: str(g.district_ref),
      name: str(g.name_th),
      x: num(g.map_x),
      y: num(g.map_y),
      lat: num(g.latitude),
      lon: num(g.longitude),
      districtId: g.district_id ? str(g.district_id) : null,
      isWarehouse: g.is_warehouse === true,
    };
  });
  const routes: Record<string, Record<string, TLeg>> = {};
  matrixRows.forEach((r) => {
    const wh = str(r.warehouse_code);
    routes[wh] = routes[wh] ?? {};
    routes[wh][str(r.district_ref)] = {
      dist: num(r.distance_km),
      toll: num(r.toll_thb),
      time: num(r.travel_minutes),
    };
  });
  const vehicles: TVehicle[] = vehRows.map((v) => ({
    id: str(v.vehicle_id),
    code: str(v.asset_code),
    plate: str(v.plate),
    currentWarehouse: str(v.current_warehouse),
    driver: str(v.driver_name),
    maxWt: num(v.max_weight_kg),
    fuelRate: num(v.fuel_rate_km_per_l),
    fuelPrice: num(v.fuel_price_thb_per_l),
    active: v.is_active !== false,
  }));
  const trips: TTrip[] = tripRows.map((t) => ({
    id: str(t.trip_id),
    code: str(t.trip_code),
    batch: t.batch_code ? str(t.batch_code) : null,
    vehicle: str(t.vehicle_id),
    driver: str(t.driver_name),
    warehouse: str(t.warehouse_code),
    route: Array.isArray(t.route_district_refs)
      ? (t.route_district_refs as unknown[]).map(str)
      : [],
    dist: num(t.total_distance_km),
    toll: num(t.total_toll_thb),
    fuel: num(t.fuel_cost_estimate_thb),
    fuelActual: t.fuel_cost_actual_thb == null ? null : num(t.fuel_cost_actual_thb),
    date: str(t.trip_date),
    status: mapStatus(str(t.status)),
    notes: str(t.notes),
  }));
  const queue: QueueRow[] = queueRows.map((q) => ({
    districtRef: str(q.district_ref),
    districtId: str(q.district_id),
    districtName: str(q.district_name_th),
    totalQty: num(q.total_qty),
    lineCount: num(q.line_count),
    suggestedWarehouse: str(q.suggested_warehouse),
    suggestedDistanceKm: num(q.suggested_distance_km),
    planId: q.replenishment_plan_id ? str(q.replenishment_plan_id) : null,
    planNumber: str(q.plan_number),
  }));
  const warehouses = Object.keys(routes).length ? Object.keys(routes) : [...WAREHOUSES];
  return { geo, routes, vehicles, trips, warehouses, queue };
}

function useTransportData(token: string | null) {
  const [data, setData] = useState<TransportData>(() => localData());
  const [source, setSource] = useState<"supabase" | "local">("local");
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!token) {
      setData(localData());
      setSource("local");
      return;
    }
    setLoading(true);
    try {
      const remote = await loadRemote(token);
      if (remote.warehouses.length && remote.vehicles.length) {
        setData(remote);
        setSource("supabase");
      } else {
        setData(localData());
        setSource("local");
      }
    } catch {
      setData(localData());
      setSource("local");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const saveTrip = useCallback(
    async (warehouse: string, stops: string[], notes: string, planId: string | null) => {
      if (source === "supabase" && token) {
        await apiRequest<Row>("/v1/transport/trips", token, {
          method: "POST",
          body: JSON.stringify({
            warehouse_code: warehouse,
            stops,
            notes,
            replenishment_plan_id: planId,
          }),
        });
        await reload();
        return "supabase" as const;
      }
      const plan = optimizePlan(data, warehouse, stops);
      const local: TTrip = {
        id: `LOCAL-${Date.now()}-${Math.floor(Math.random() * 999)}`,
        code: `TRP-LOCAL-${Math.floor(Math.random() * 9000 + 1000)}`,
        batch: null,
        vehicle: plan.vehicle?.id ?? "-",
        driver: plan.vehicle?.driver ?? "-",
        warehouse,
        route: plan.order,
        dist: plan.matrixDist,
        toll: plan.totalToll,
        fuel: plan.fuelCost,
        fuelActual: null,
        date: new Date().toLocaleDateString("th-TH"),
        status: "วางแผน",
        notes,
      };
      setData((cur) => ({ ...cur, trips: [local, ...cur.trips] }));
      return "local" as const;
    },
    [data, reload, source, token],
  );

  return { data, source, loading, reload, saveTrip };
}

// ---- Free route optimizer (haversine tour + nearest-neighbour + 2-opt) ----
function haversineKm(a: TGeo, b: TGeo) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function tourKm(geo: Record<string, TGeo>, wh: TGeo | null, order: string[]) {
  if (!wh || !order.length) return 0;
  let d = 0;
  let prev = wh;
  for (const id of order) {
    const g = geo[id];
    if (g) {
      d += haversineKm(prev, g);
      prev = g;
    }
  }
  d += haversineKm(prev, wh); // return to depot
  return Math.round(d * 10) / 10;
}

function nearestNeighbour(geo: Record<string, TGeo>, wh: TGeo | null, stops: string[]) {
  const remaining = stops.filter((id) => geo[id]);
  const order: string[] = [];
  let cur = wh;
  while (remaining.length && cur) {
    let bi = 0;
    let best = Infinity;
    remaining.forEach((id, idx) => {
      const d = haversineKm(cur as TGeo, geo[id]);
      if (d < best) {
        best = d;
        bi = idx;
      }
    });
    const next = remaining.splice(bi, 1)[0];
    order.push(next);
    cur = geo[next];
  }
  return order;
}

function twoOpt(geo: Record<string, TGeo>, wh: TGeo | null, initial: string[]) {
  let order = [...initial];
  if (order.length < 4 || !wh) return order;
  let improved = true;
  let guard = 0;
  while (improved && guard < 60) {
    improved = false;
    guard += 1;
    for (let i = 0; i < order.length - 1; i += 1) {
      for (let k = i + 1; k < order.length; k += 1) {
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, k + 1).reverse(),
          ...order.slice(k + 1),
        ];
        if (tourKm(geo, wh, candidate) + 1e-6 < tourKm(geo, wh, order)) {
          order = candidate;
          improved = true;
        }
      }
    }
  }
  return order;
}

type OptimizedPlan = {
  order: string[];
  tourDist: number;
  matrixDist: number;
  totalToll: number;
  totalTime: number;
  fuelCost: number;
  vehicle: TVehicle | null;
};

function optimizePlan(
  data: TransportData,
  warehouse: string,
  stops: string[],
): OptimizedPlan {
  const wh = Object.values(data.geo).find((g) => g.isWarehouse) ?? null;
  const nn = nearestNeighbour(data.geo, wh, stops);
  const order = twoOpt(data.geo, wh, nn);
  const legs = data.routes[warehouse] ?? {};
  const matrixDist = order.reduce((s, id) => s + (legs[id]?.dist ?? 0), 0);
  const totalToll = order.reduce((s, id) => s + (legs[id]?.toll ?? 0), 0);
  const totalTime = order.reduce((s, id) => s + (legs[id]?.time ?? 0), 0);
  const vehicle =
    data.vehicles.find((v) => v.currentWarehouse === warehouse && v.active) ?? null;
  const dist = tourKm(data.geo, wh, order);
  const fuelCost = vehicle
    ? Math.round((dist / vehicle.fuelRate) * vehicle.fuelPrice * 100) / 100
    : 0;
  return {
    order,
    tourDist: dist,
    matrixDist: Math.round(matrixDist * 10) / 10,
    totalToll,
    totalTime,
    fuelCost,
    vehicle,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function statusTone(status: string) {
  if (status.includes("ส่งครบ")) return "normal";
  if (status.includes("ยกเลิก")) return "critical";
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
  geo,
  route,
  highlight,
  onPick,
}: {
  geo: Record<string, TGeo>;
  route: string[];
  highlight?: string | null;
  onPick?: (id: string) => void;
}) {
  const wh = Object.values(geo).find((g) => g.isWarehouse) ?? null;
  const nodes = Object.values(geo).filter((g) => !g.isWarehouse);
  const points = [wh, ...route.map((id) => geo[id])].filter(Boolean) as TGeo[];
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg
      viewBox="0 0 850 520"
      style={{
        width: "100%",
        height: "auto",
        background: "linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%)",
        borderRadius: 14,
        border: "1px solid #e2e8f0",
      }}
    >
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
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
      {nodes.map((node) => {
        const inRoute = route.includes(node.ref);
        const isHi = highlight === node.ref;
        return (
          <g
            key={node.ref}
            transform={`translate(${node.x},${node.y})`}
            style={{ cursor: onPick ? "pointer" : "default" }}
            onClick={() => onPick?.(node.ref)}
          >
            <circle
              r={isHi ? 11 : 7}
              fill={inRoute ? "#E3670A" : isHi ? "#1A56DB" : "#fff"}
              stroke={inRoute ? "#c2560a" : "#94a3b8"}
              strokeWidth={2}
            />
            <text x={12} y={4} fontSize={11} fontWeight={600} fill="#334155">
              {node.ref}
            </text>
          </g>
        );
      })}
      {wh && (
        <g transform={`translate(${wh.x},${wh.y})`}>
          <rect x={-9} y={-9} width={18} height={18} rx={4} fill="#1A56DB" />
          <text x={14} y={5} fontSize={12} fontWeight={700} fill="#1A56DB">
            คลัง
          </text>
        </g>
      )}
    </svg>
  );
}

function SourceTag({ source, loading }: { source: "supabase" | "local"; loading: boolean }) {
  return (
    <aside
      className={`runtime-message ${source === "supabase" ? "" : "warning"}`}
      role="status"
      style={{
        background: source === "supabase" ? "#ecfdf5" : undefined,
        borderColor: source === "supabase" ? "#a7f3d0" : undefined,
      }}
    >
      <i>{source === "supabase" ? "✓" : "!"}</i>
      <div>
        <strong>
          {loading
            ? "กำลังโหลดข้อมูลขนส่ง…"
            : source === "supabase"
              ? "เชื่อมต่อ Supabase แล้ว — ข้อมูลจริงจาก /v1/transport"
              : "โหมดข้อมูลต้นแบบ (ยังไม่ได้ deploy migration M13/M13b)"}
        </strong>
        <p>
          {source === "supabase"
            ? "รถ เส้นทาง งานรอจัดส่ง และเที่ยวรถ อ่าน/บันทึกผ่าน m13_transport_dispatch → ตาราง core/ops บน Supabase"
            : "ใช้ชุดข้อมูล DB_Route ที่พอร์ตจากแอปเก่า เมื่อ deploy migration 202607250001/250002 จะสลับเป็นข้อมูลจริงและงานจากแผน replenishment อัตโนมัติ"}
        </p>
      </div>
    </aside>
  );
}

function TransportDashboard({ data }: { data: TransportData }) {
  const planned = data.trips.filter((t) => t.status.includes("วางแผน"));
  const done = data.trips.filter((t) => t.status.includes("ส่งครบ"));
  const activeVeh = data.vehicles.filter((v) => v.active).length;
  const pending = data.queue.length || REPLENISHMENT_PLAN.length;
  return (
    <div className="stack">
      <section className="kpis">
        <article>
          <div>
            <span>รถพร้อมใช้งาน</span>
            <i className="dot blue" />
          </div>
          <strong>{formatNumber(activeVeh)}</strong>
          <small>{data.warehouses.length} คลัง</small>
        </article>
        <article>
          <div>
            <span>เที่ยวรอออก</span>
            <i className="dot orange" />
          </div>
          <strong>{formatNumber(planned.length)}</strong>
          <small>สถานะ วางแผน</small>
        </article>
        <article>
          <div>
            <span>เขตรอจัดส่ง</span>
            <i className="dot purple" />
          </div>
          <strong>{formatNumber(pending)}</strong>
          <small>{data.queue.length ? "จากแผน locked" : "ต้นแบบ"}</small>
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
              </tr>
            </thead>
            <tbody>
              {data.vehicles.map((v) => (
                <tr key={v.id}>
                  <td>
                    <span>
                      <strong>{v.code}</strong>
                      <small>{v.id}</small>
                    </span>
                  </td>
                  <td>{v.plate}</td>
                  <td>{v.currentWarehouse}</td>
                  <td>{v.driver}</td>
                  <td>{formatNumber(v.maxWt)} กก.</td>
                  <td>{v.fuelRate} กม./ล.</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TransportPlanner({
  data,
  onSave,
}: {
  data: TransportData;
  onSave: (
    warehouse: string,
    stops: string[],
    notes: string,
    planId: string | null,
  ) => Promise<"supabase" | "local">;
}) {
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>("");
  const [selected, setSelected] = useState<string[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [maxStops, setMaxStops] = useState(6);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const warehouse =
    selectedWarehouse && data.warehouses.includes(selectedWarehouse)
      ? selectedWarehouse
      : data.warehouses[0] ?? "";
  const servable = useMemo(
    () => Object.keys(data.routes[warehouse] ?? {}).sort(),
    [data.routes, warehouse],
  );
  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const addFromQueue = (q: QueueRow) => {
    if (data.warehouses.includes(q.suggestedWarehouse)) setSelectedWarehouse(q.suggestedWarehouse);
    setPlanId(q.planId);
    setSelected((cur) => (cur.includes(q.districtRef) ? cur : [...cur, q.districtRef]));
  };
  const plan = useMemo(() => optimizePlan(data, warehouse, selected), [data, warehouse, selected]);
  const trips = useMemo(
    () => (maxStops > 0 ? chunk(plan.order, maxStops) : [plan.order]),
    [plan.order, maxStops],
  );
  const save = async () => {
    if (!plan.order.length) return;
    setBusy(true);
    setMsg("");
    try {
      let where: "supabase" | "local" = "local";
      for (const c of trips) {
        if (c.length) where = await onSave(warehouse, c, notes.trim(), planId);
      }
      setSelected([]);
      setNotes("");
      setPlanId(null);
      setMsg(
        `${where === "supabase" ? "บันทึกลง Supabase" : "บันทึก (ต้นแบบ)"} ${trips.length} เที่ยวแล้ว`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {data.queue.length > 0 && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>งานรอจัดส่ง · จากแผน replenishment ที่ locked</span>
              <h3>เลือกเขตเข้าทริป</h3>
            </div>
            <b>{data.queue.length} เขต</b>
          </div>
          <div className="live-table-wrap">
            <table className="live-table">
              <thead>
                <tr>
                  <th>เขต</th>
                  <th>Plan</th>
                  <th>รายการ</th>
                  <th>ปริมาณรวม</th>
                  <th>คลังใกล้สุด</th>
                  <th>ระยะทาง</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.queue.map((q) => (
                  <tr key={q.districtRef}>
                    <td>
                      <span>
                        <strong>{q.districtName}</strong>
                        <small>{q.districtId}</small>
                      </span>
                    </td>
                    <td>{q.planNumber || "—"}</td>
                    <td>{formatNumber(q.lineCount)}</td>
                    <td>{formatNumber(q.totalQty, 2)}</td>
                    <td>{q.suggestedWarehouse}</td>
                    <td>{formatNumber(q.suggestedDistanceKm, 1)} กม.</td>
                    <td>
                      <button
                        type="button"
                        className="table-action"
                        disabled={selected.includes(q.districtRef)}
                        onClick={() => addFromQueue(q)}
                      >
                        {selected.includes(q.districtRef) ? "เพิ่มแล้ว" : "เพิ่มเข้าทริป"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="filter-bar">
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          คลังต้นทาง
          <select
            value={warehouse}
            onChange={(e) => {
              setSelectedWarehouse(e.target.value);
              setSelected([]);
              setPlanId(null);
            }}
          >
            {data.warehouses.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          จุดต่อรถ
          <input
            type="number"
            min={1}
            max={18}
            value={maxStops}
            onChange={(e) => setMaxStops(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 64, padding: "4px 6px", borderRadius: 6, border: "1px solid #e2e8f0" }}
          />
        </label>
        <button className="btn primary" disabled={busy || !plan.order.length} onClick={save}>
          ＋ บันทึก {trips.length > 1 ? `${trips.length} เที่ยว` : "เที่ยวรถ"}
        </button>
        {msg && <span style={{ fontSize: 13, color: "#0f766e" }}>{msg}</span>}
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
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: selected.includes(id) ? "2px solid #E3670A" : "1px solid #e2e8f0",
                  background: selected.includes(id) ? "#fff7ed" : "#fff",
                  cursor: "pointer",
                }}
              >
                <strong style={{ display: "block", fontSize: 12 }}>{id}</strong>
                <small style={{ color: "#64748b" }}>{data.geo[id]?.name ?? id}</small>
              </button>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-title">
            <div>
              <span>ผลการปรับเส้นทาง</span>
              <h3>Nearest-neighbour + 2-opt</h3>
            </div>
          </div>
          <div className="inventory-summary" style={{ padding: 12 }}>
            <article>
              <span>ระยะทางทัวร์ (2-opt)</span>
              <strong>{formatNumber(plan.tourDist, 1)}</strong>
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
                {plan.vehicle ? `${plan.vehicle.code} · ${plan.vehicle.driver}` : "ไม่มีรถประจำคลังนี้"}
              </strong>
            </p>
            <p style={{ fontSize: 13, color: "#334155", margin: "4px 0" }}>
              ลำดับที่ปรับแล้ว:{" "}
              <strong>{plan.order.length ? `คลัง → ${plan.order.join(" → ")} → คลัง` : "ยังไม่เลือกเขต"}</strong>
            </p>
            {trips.length > 1 && (
              <p style={{ fontSize: 13, color: "#b45309", margin: "4px 0" }}>
                เกิน {maxStops} จุด — จะถูกแบ่งเป็น {trips.length} เที่ยว/รถ
              </p>
            )}
            {planId && (
              <p style={{ fontSize: 12, color: "#0f766e", margin: "4px 0" }}>
                ผูกกับแผน replenishment • plan {planId.slice(0, 8)}
              </p>
            )}
            <label style={{ display: "block", marginTop: 8, fontSize: 13 }}>
              หมายเหตุ
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="บันทึกเพิ่มเติม (ถ้ามี)"
                style={{ width: "100%", marginTop: 4, padding: "6px 8px", borderRadius: 6, border: "1px solid #e2e8f0" }}
              />
            </label>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <span>แผนที่เส้นทาง</span>
            <h3>เส้นทางที่ปรับแล้ว</h3>
          </div>
        </div>
        <div style={{ padding: 12 }}>
          <MapCanvas geo={data.geo} route={plan.order} onPick={toggle} />
        </div>
      </section>
    </div>
  );
}

function TransportMap({ data }: { data: TransportData }) {
  const [warehouse, setWarehouse] = useState<string>(data.warehouses[0] ?? "");
  const [picked, setPicked] = useState<string | null>(null);
  const leg = picked ? data.routes[warehouse]?.[picked] : null;
  return (
    <div className="stack">
      <section className="filter-bar">
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          คลังต้นทาง
          <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
            {data.warehouses.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 13, color: "#64748b" }}>คลิกจุดเขตบนแผนที่เพื่อดูระยะทางจากคลัง</span>
      </section>
      <section className="panel">
        <div style={{ padding: 12 }}>
          <MapCanvas
            geo={data.geo}
            route={picked ? [picked] : []}
            highlight={picked}
            onPick={setPicked}
          />
        </div>
      </section>
      {picked && leg && (
        <section className="inventory-summary">
          <article>
            <span>เขตปลายทาง</span>
            <strong style={{ fontSize: 15 }}>{data.geo[picked]?.name ?? picked}</strong>
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

function TransportHistory({ data }: { data: TransportData }) {
  const [filter, setFilter] = useState("");
  const rows = data.trips.filter(
    (t) =>
      !filter ||
      `${t.code} ${t.batch ?? ""} ${t.vehicle} ${t.driver} ${t.warehouse}`
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
                  <td>{t.code}</td>
                  <td>{t.batch ?? "—"}</td>
                  <td>
                    <span>
                      <strong>{t.vehicle}</strong>
                      <small>{t.driver}</small>
                    </span>
                  </td>
                  <td>{t.warehouse}</td>
                  <td>{t.route.join(" → ")}</td>
                  <td>{formatNumber(t.dist, 1)} กม.</td>
                  <td>
                    {formatNumber(t.fuel, 2)}
                    {t.fuelActual != null ? ` / ${formatNumber(t.fuelActual, 2)}` : " / —"}
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

export function TransportModule({
  view,
  token,
}: {
  view: TransportView;
  token: string | null;
}) {
  const { data, source, loading, saveTrip } = useTransportData(token);
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
      <SourceTag source={source} loading={loading} />
      {view === "dashboard" && <TransportDashboard data={data} />}
      {view === "planner" && <TransportPlanner data={data} onSave={saveTrip} />}
      {view === "map" && <TransportMap data={data} />}
      {view === "history" && <TransportHistory data={data} />}
    </>
  );
}
