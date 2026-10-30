// Goods-first weekly dispatch solver.
//
// Input: one week's demand per district (pallets, weight, promise day from the zone
// calendar) + trucks + settings. Output: truck trips by day, pick-ups (only when the
// trucks cannot cover the week), overflow, and the fixed-zone plan for the same goods
// so the planner sees the difference.
//
// Steps
//   1. A district above one truckload gets full-truck trips first.
//   2. Remaining loads are merged with the Clarke-Wright savings rule while the trip
//      stays within pallets, payload, the 09:30-15:00 window and the stop limit.
//   3. Trips are placed on truck-days, earliest promise first, on the latest free day
//      that is not after the promise (one trip per truck per day).
//   4. Only if trips are left without a truck-day: single-district trips with enough
//      pallets, near the warehouse, from districts that allow pick-up and have not
//      picked up recently become pick-ups (urgent goods are never pushed to pick-up).
//   5. Anything still left is overflow: defer non-urgent goods or borrow a truck.

export type DispatchSettings = {
  start_time: string;
  return_by: string;
  unload_minutes: number;
  avg_speed_kmh: number;
  road_factor: number;
  pickup_max_km: number;
  pickup_min_pallets: number;
  pickup_rotation_weeks: number;
  max_stops_per_trip: number;
  baht_per_km: number;
  toll_per_trip: number;
  warehouse_lat: number;
  warehouse_lon: number;
  delivery_weekdays: number[];
  default_pallet_kg?: number;
  /** Minutes to reload between two trips of the same truck on one day. */
  reload_minutes?: number;
  /** 1 = one trip per truck per day (current practice); 2 lets a truck back early run a second short trip. */
  max_trips_per_truck_day?: number;
};

export type DispatchVehicle = {
  vehicle_code: string;
  label: string;
  pallet_capacity: number;
  max_payload_kg: number | null;
  is_active?: boolean;
};

export type DispatchItem = {
  source: "plan" | "extra";
  reference: string;
  material_id: string;
  material_name: string | null;
  unit: string | null;
  qty: number;
  full_pallets: number;
  mixed_fraction: number;
  weight_kg: number;
  packing_missing: boolean;
  lot_size_estimate?: boolean;
  urgent: boolean;
};

export type DispatchDistrict = {
  district_id: string;
  district_name: string;
  zone: string | null;
  zone_weekday: number | null;
  promise_date: string | null;
  latitude: number | null;
  longitude: number | null;
  depot_km: number | null;
  has_vehicle: boolean | null;
  pickup_allowed: boolean;
  last_pickup_date: string | null;
  pallets: number;
  full_pallets: number;
  mixed_fraction: number;
  weight_kg: number;
  lines: number;
  extra_lines: number;
  packing_missing_lines: number;
  weight_estimated_lines: number;
  urgent: boolean;
  items?: DispatchItem[];
};

export type DispatchDemand = {
  week_start: string;
  settings: DispatchSettings;
  vehicles: DispatchVehicle[];
  districts: DispatchDistrict[];
  plan_statuses?: string[];
};

export type TripMode = "delivery" | "pickup" | "overflow";

export type PlannedStop = {
  district_id: string;
  district_name: string;
  pallets: number;
  full_pallets: number;
  mixed_pallets: number;
  weight_kg: number;
  promise_date: string | null;
  urgent: boolean;
  eta: string | null;
};

export type PalletSlot = { slot: number; row: number; side: "L" | "R"; district_id: string | null; kind: "full" | "mixed" | "empty" };

export type PlannedTrip = {
  id: string;
  mode: TripMode;
  trip_date: string | null;
  vehicle_code: string | null;
  due_date: string | null;
  stops: PlannedStop[];
  pallets: number;
  weight_kg: number;
  km: number;
  minutes: number;
  cost_baht: number;
  start_time: string | null;
  return_time: string | null;
  layout: PalletSlot[];
  reason: string | null;
};

export type PlanMetrics = {
  delivery_trips: number;
  pickups: number;
  overflow_trips: number;
  pallets: number;
  km: number;
  truck_hours: number;
  cost_baht: number;
  fill_rate: number;
  stops: number;
  stops_on_promise: number;
  stops_late: number;
  truck_days: number;
};

export type DispatchWarning = { code: string; level: "info" | "warn" | "high"; message: string; district_id?: string; trip_id?: string };

export type DispatchPlan = {
  week_start: string;
  trips: PlannedTrip[];
  metrics: PlanMetrics;
  zone_metrics: PlanMetrics;
  warnings: DispatchWarning[];
};

const EARTH_KM = 6371;

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isoWeekday(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function clock(minutes: number): string {
  const m = Math.round(minutes);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p = Math.PI / 180;
  const x = Math.sin(((bLat - aLat) * p) / 2) ** 2
    + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(((bLon - aLon) * p) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(x));
}

type Ctx = {
  settings: DispatchSettings;
  byId: Map<string, DispatchDistrict>;
  limitMinutes: number;
  capacity: number;
  payload: number | null;
};

/** One-way road km. Warehouse legs use the measured depot distance when known. */
export function roadKm(ctx: Pick<Ctx, "settings" | "byId">, a: string, b: string): number {
  if (a === b) return 0;
  const s = ctx.settings;
  const da = a === "WH" ? null : ctx.byId.get(a);
  const db = b === "WH" ? null : ctx.byId.get(b);
  if (a === "WH" && db?.depot_km != null) return Number(db.depot_km);
  if (b === "WH" && da?.depot_km != null) return Number(da.depot_km);
  const pa = a === "WH" ? [s.warehouse_lat, s.warehouse_lon] : [da?.latitude, da?.longitude];
  const pb = b === "WH" ? [s.warehouse_lat, s.warehouse_lon] : [db?.latitude, db?.longitude];
  if (pa[0] == null || pa[1] == null || pb[0] == null || pb[1] == null) {
    // No coordinates: go via the warehouse (worst case, never optimistic)
    return roadKm(ctx, a, "WH") + roadKm(ctx, "WH", b);
  }
  return haversine(Number(pa[0]), Number(pa[1]), Number(pb[0]), Number(pb[1])) * s.road_factor;
}

function routeKm(ctx: Ctx, route: string[]): number {
  const path = ["WH", ...route, "WH"];
  let km = 0;
  for (let i = 0; i < path.length - 1; i += 1) km += roadKm(ctx, path[i], path[i + 1]);
  return km;
}

function routeMinutes(ctx: Ctx, route: string[], km = routeKm(ctx, route)): number {
  return (km / ctx.settings.avg_speed_kmh) * 60 + ctx.settings.unload_minutes * route.length;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

/** Shortest stop order (exhaustive up to 6 stops, otherwise far-first). */
export function bestOrder(ctx: Ctx, route: string[]): string[] {
  if (route.length <= 1) return route.slice();
  if (route.length <= 6) {
    let best = route.slice();
    let bestKm = Infinity;
    for (const p of permutations(route)) {
      const km = routeKm(ctx, p);
      if (km < bestKm - 1e-9) {
        best = p;
        bestKm = km;
      }
    }
    return best;
  }
  return route.slice().sort((a, b) => roadKm(ctx, "WH", b) - roadKm(ctx, "WH", a));
}

type Load = { district_id: string; pallets: number; full: number; weight: number };
type Route = { stops: Load[]; pallets: number; weight: number };

function perPalletKg(d: DispatchDistrict, fallback: number): number {
  return d.pallets > 0 && d.weight_kg > 0 ? d.weight_kg / d.pallets : fallback;
}

/** Pallets of this district that fit one truck (pallet slots and payload). */
function truckPallets(ctx: Ctx, d: DispatchDistrict): number {
  if (!ctx.payload) return ctx.capacity;
  const kg = perPalletKg(d, ctx.settings.default_pallet_kg ?? 1250);
  return Math.max(1, Math.min(ctx.capacity, Math.floor(ctx.payload / kg)));
}

function splitDistrict(ctx: Ctx, d: DispatchDistrict): { full: Route[]; rest: Load | null } {
  const kg = perPalletKg(d, ctx.settings.default_pallet_kg ?? 1250);
  const per = truckPallets(ctx, d);
  let pallets = d.pallets;
  let full = Math.min(d.full_pallets, d.pallets);
  const trips: Route[] = [];
  while (pallets > per) {
    const take = per;
    const takeFull = Math.min(full, take);
    full -= takeFull;
    pallets -= take;
    trips.push({ stops: [{ district_id: d.district_id, pallets: take, full: takeFull, weight: take * kg }], pallets: take, weight: take * kg });
  }
  const rest = pallets > 0 ? { district_id: d.district_id, pallets, full, weight: pallets * kg } : null;
  return { full: trips, rest };
}

function fits(ctx: Ctx, stops: string[], pallets: number, weight: number): boolean {
  if (pallets > ctx.capacity + 1e-9) return false;
  if (ctx.payload && weight > ctx.payload + 1e-6) return false;
  if (stops.length > ctx.settings.max_stops_per_trip) return false;
  return routeMinutes(ctx, bestOrder(ctx, stops)) <= ctx.limitMinutes + 1e-9;
}

/** Clarke-Wright savings merge of single-district loads. */
function savingsRoutes(ctx: Ctx, loads: Load[]): Route[] {
  const routes = new Map<string, Route>();
  const owner = new Map<string, string>();
  for (const l of loads) {
    routes.set(l.district_id, { stops: [l], pallets: l.pallets, weight: l.weight });
    owner.set(l.district_id, l.district_id);
  }
  const ids = loads.map((l) => l.district_id);
  const pairs: { s: number; a: string; b: string }[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      pairs.push({ s: roadKm(ctx, "WH", a) + roadKm(ctx, "WH", b) - roadKm(ctx, a, b), a, b });
    }
  }
  pairs.sort((x, y) => y.s - x.s || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  for (const { s, a, b } of pairs) {
    if (s <= 0) break;
    const ra = owner.get(a)!;
    const rb = owner.get(b)!;
    if (ra === rb) continue;
    const A = routes.get(ra)!;
    const B = routes.get(rb)!;
    const stops = [...A.stops, ...B.stops];
    const pallets = A.pallets + B.pallets;
    const weight = A.weight + B.weight;
    if (!fits(ctx, stops.map((x) => x.district_id), pallets, weight)) continue;
    routes.set(ra, { stops, pallets, weight });
    routes.delete(rb);
    for (const x of stops) owner.set(x.district_id, ra);
  }
  return [...routes.values()];
}

/** Fixed calendar: each zone on its own day, no mixing across zones. */
function zoneRoutes(ctx: Ctx, loads: Load[]): Route[] {
  const byZone = new Map<string, Load[]>();
  for (const l of loads) {
    const z = ctx.byId.get(l.district_id)?.zone ?? `_${l.district_id}`;
    byZone.set(z, [...(byZone.get(z) ?? []), l]);
  }
  const out: Route[] = [];
  for (const zoneLoads of byZone.values()) {
    const sorted = zoneLoads.slice().sort((a, b) => roadKm(ctx, "WH", b.district_id) - roadKm(ctx, "WH", a.district_id));
    let cur: Route | null = null;
    for (const l of sorted) {
      if (cur && fits(ctx, [...cur.stops, l].map((x) => x.district_id), cur.pallets + l.pallets, cur.weight + l.weight)) {
        cur = { stops: [...cur.stops, l], pallets: cur.pallets + l.pallets, weight: cur.weight + l.weight };
        continue;
      }
      if (cur) out.push(cur);
      cur = { stops: [l], pallets: l.pallets, weight: l.weight };
    }
    if (cur) out.push(cur);
  }
  return out;
}

function buildLayout(stops: PlannedStop[], capacity: number): PalletSlot[] {
  // Two pallets across, rows from the cab (row 1) to the tailgate. The last stop is
  // loaded first (front), the first stop sits at the tailgate.
  const slots: PalletSlot[] = [];
  const queue: { district_id: string; kind: "full" | "mixed" }[] = [];
  for (const s of stops.slice().reverse()) {
    for (let i = 0; i < s.full_pallets; i += 1) queue.push({ district_id: s.district_id, kind: "full" });
    for (let i = 0; i < s.mixed_pallets; i += 1) queue.push({ district_id: s.district_id, kind: "mixed" });
  }
  const total = Math.max(capacity, queue.length);
  for (let i = 0; i < total; i += 1) {
    const q = queue[i];
    slots.push({
      slot: i + 1,
      row: Math.floor(i / 2) + 1,
      side: i % 2 === 0 ? "L" : "R",
      district_id: q?.district_id ?? null,
      kind: q?.kind ?? "empty",
    });
  }
  return slots;
}

function dueDate(ctx: Ctx, weekStart: string, stops: Load[]): string | null {
  const dates = stops
    .map((s) => ctx.byId.get(s.district_id)?.promise_date)
    .filter((d): d is string => Boolean(d))
    .sort();
  return dates[0] ?? addDays(weekStart, 4);
}

function toTrip(ctx: Ctx, weekStart: string, route: Route, id: string): PlannedTrip {
  const order = bestOrder(ctx, route.stops.map((s) => s.district_id));
  const byStop = new Map(route.stops.map((s) => [s.district_id, s]));
  const km = routeKm(ctx, order);
  const minutes = routeMinutes(ctx, order, km);
  const start = minutesOf(ctx.settings.start_time);
  let t = start;
  let prev = "WH";
  const stops: PlannedStop[] = order.map((id2) => {
    const l = byStop.get(id2)!;
    const d = ctx.byId.get(id2)!;
    t += (roadKm(ctx, prev, id2) / ctx.settings.avg_speed_kmh) * 60;
    const eta = clock(t);
    t += ctx.settings.unload_minutes;
    prev = id2;
    const pallets = Math.ceil(l.pallets - 1e-9);
    const full = Math.min(Math.round(l.full), pallets);
    return {
      district_id: id2,
      district_name: d.district_name,
      pallets,
      full_pallets: full,
      mixed_pallets: pallets - full,
      weight_kg: Math.round(l.weight),
      promise_date: d.promise_date,
      urgent: d.urgent,
      eta,
    };
  });
  const pallets = stops.reduce((a, s) => a + s.pallets, 0);
  return {
    id,
    mode: "delivery",
    trip_date: null,
    vehicle_code: null,
    due_date: dueDate(ctx, weekStart, route.stops),
    stops,
    pallets,
    weight_kg: Math.round(route.weight),
    km: Math.round(km * 10) / 10,
    minutes: Math.round(minutes),
    cost_baht: Math.round(km * ctx.settings.baht_per_km + ctx.settings.toll_per_trip),
    start_time: clock(start),
    return_time: clock(start + minutes),
    layout: buildLayout(stops, ctx.capacity),
    reason: null,
  };
}

function workDays(weekStart: string, settings: DispatchSettings): string[] {
  const days = settings.delivery_weekdays?.length ? settings.delivery_weekdays : [1, 2, 3, 4, 5];
  return days.slice().sort().map((d) => addDays(weekStart, d - 1));
}

function shiftClock(value: string | null, delta: number): string | null {
  return value == null ? null : clock(minutesOf(value) + delta);
}

/** Move a trip's clock times so it leaves at `start` (minutes after midnight). */
function retime(trip: PlannedTrip, start: number): void {
  const delta = start - minutesOf(trip.start_time ?? clock(start));
  if (!delta) return;
  trip.start_time = shiftClock(trip.start_time, delta);
  trip.return_time = shiftClock(trip.return_time, delta);
  for (const s of trip.stops) s.eta = shiftClock(s.eta, delta);
}

type TruckDay = { date: string; vehicle: string; trips: PlannedTrip[] };

function dayMinutes(day: TruckDay, reload: number): number {
  return day.trips.reduce((a, t) => a + t.minutes, 0) + reload * Math.max(0, day.trips.length - 1);
}

/** Lay trips of one truck-day back to back from the start time. */
function sequenceDay(day: TruckDay, startMinutes: number, reload: number): void {
  let t = startMinutes;
  for (const trip of day.trips) {
    retime(trip, t);
    t += trip.minutes + reload;
  }
}

/**
 * Earliest promise first (urgent, then longer trips first inside a day); each trip
 * goes on the latest working day not after its promise where a truck still has time
 * before the return deadline. A truck back early can run a second short trip.
 */
function assignDays(ctx: Ctx, trips: PlannedTrip[], days: string[], vehicles: DispatchVehicle[]): PlannedTrip[] {
  const reload = ctx.settings.reload_minutes ?? 30;
  const truckDays: TruckDay[] = [];
  for (const date of days) for (const v of vehicles) truckDays.push({ date, vehicle: v.vehicle_code, trips: [] });
  const order = trips.slice().sort((a, b) =>
    (a.due_date ?? "").localeCompare(b.due_date ?? "")
    || Number(b.stops.some((s) => s.urgent)) - Number(a.stops.some((s) => s.urgent))
    || b.minutes - a.minutes);
  const maxTrips = Math.max(1, ctx.settings.max_trips_per_truck_day ?? 1);
  const room = (day: TruckDay, trip: PlannedTrip) =>
    day.trips.length < maxTrips && dayMinutes(day, reload) + (day.trips.length ? reload : 0) + trip.minutes <= ctx.limitMinutes + 1e-9;
  const place = (day: TruckDay, trip: PlannedTrip) => {
    day.trips.push(trip);
    trip.trip_date = day.date;
    trip.vehicle_code = day.vehicle;
  };
  const unplaced: PlannedTrip[] = [];
  for (const trip of order) {
    const due = trip.due_date ?? days[days.length - 1];
    // latest day first; on a day prefer an empty truck, then the one with the most time left
    const ok = truckDays
      .filter((d) => d.date <= due && room(d, trip))
      .sort((x, y) => y.date.localeCompare(x.date) || x.trips.length - y.trips.length || dayMinutes(x, reload) - dayMinutes(y, reload));
    if (ok[0]) place(ok[0], trip);
    else unplaced.push(trip);
  }
  // Late but still this week (flagged as late)
  for (const trip of unplaced.slice()) {
    const pick = truckDays.filter((d) => room(d, trip))
      .sort((x, y) => x.date.localeCompare(y.date) || x.trips.length - y.trips.length)[0];
    if (!pick) continue;
    place(pick, trip);
    unplaced.splice(unplaced.indexOf(trip), 1);
  }
  const start = minutesOf(ctx.settings.start_time);
  for (const day of truckDays) {
    day.trips.sort((a, b) => b.minutes - a.minutes);
    sequenceDay(day, start, reload);
  }
  return unplaced;
}

function emptyMetrics(): PlanMetrics {
  return { delivery_trips: 0, pickups: 0, overflow_trips: 0, pallets: 0, km: 0, truck_hours: 0, cost_baht: 0,
    fill_rate: 0, stops: 0, stops_on_promise: 0, stops_late: 0, truck_days: 0 };
}

export function summarizeTrips(trips: PlannedTrip[], capacity: number): PlanMetrics {
  const m = emptyMetrics();
  const deliveries = trips.filter((t) => t.mode === "delivery");
  m.delivery_trips = deliveries.length;
  m.pickups = trips.filter((t) => t.mode === "pickup").length;
  m.overflow_trips = trips.filter((t) => t.mode === "overflow").length;
  m.pallets = trips.reduce((a, t) => a + t.pallets, 0);
  m.km = Math.round(deliveries.reduce((a, t) => a + t.km, 0) * 10) / 10;
  m.truck_hours = Math.round((deliveries.reduce((a, t) => a + t.minutes, 0) / 60) * 10) / 10;
  m.cost_baht = deliveries.reduce((a, t) => a + t.cost_baht, 0);
  const delivered = deliveries.reduce((a, t) => a + t.pallets, 0);
  m.fill_rate = deliveries.length ? Math.round((delivered / (capacity * deliveries.length)) * 1000) / 1000 : 0;
  m.truck_days = deliveries.filter((t) => t.trip_date).length;
  for (const t of trips) {
    for (const s of t.stops) {
      m.stops += 1;
      if (t.mode === "overflow" || !t.trip_date) m.stops_late += 1;
      else if (!s.promise_date || t.trip_date <= s.promise_date) m.stops_on_promise += 1;
      else m.stops_late += 1;
    }
  }
  return m;
}

function weeksBetween(a: string, b: string): number {
  return Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / (7 * 86400000);
}

export function solveDispatch(demand: DispatchDemand): DispatchPlan {
  const settings = demand.settings;
  const vehicles = demand.vehicles.filter((v) => v.is_active !== false);
  const warnings: DispatchWarning[] = [];
  const byId = new Map(demand.districts.map((d) => [d.district_id, d]));
  const capacity = vehicles.length ? Math.min(...vehicles.map((v) => v.pallet_capacity)) : 8;
  const payloads = vehicles.map((v) => v.max_payload_kg).filter((x): x is number => x != null && x > 0);
  const payload = payloads.length === vehicles.length && payloads.length ? Math.min(...payloads) : null;
  const ctx: Ctx = {
    settings,
    byId,
    capacity,
    payload,
    limitMinutes: minutesOf(settings.return_by) - minutesOf(settings.start_time),
  };

  if (!vehicles.length) warnings.push({ code: "no_vehicle", level: "high", message: "ไม่มีรถที่เปิดใช้งาน" });
  if (!payload) {
    warnings.push({ code: "payload_unknown", level: "warn",
      message: "ยังไม่ได้กรอกน้ำหนักบรรทุกของรถ ระบบตรวจเฉพาะจำนวนพาเลท ยังไม่ตรวจน้ำหนัก" });
  }

  const active = demand.districts.filter((d) => d.pallets > 0);
  const missing = active.reduce((a, d) => a + d.packing_missing_lines, 0);
  const lines = active.reduce((a, d) => a + d.lines, 0);
  if (missing > 0) {
    warnings.push({ code: "packing_missing", level: "warn",
      message: `${missing} จาก ${lines} รายการยังไม่มีข้อมูล Packing จำนวนพาเลทเป็นค่าประมาณ` });
  }
  for (const d of active) {
    if (d.depot_km == null && (d.latitude == null || d.longitude == null)) {
      warnings.push({ code: "no_distance", level: "warn", district_id: d.district_id,
        message: `${d.district_name} ไม่มีระยะทางหรือพิกัด` });
    }
    if (payload && perPalletKg(d, settings.default_pallet_kg ?? 1250) > payload) {
      warnings.push({ code: "pallet_over_payload", level: "high", district_id: d.district_id,
        message: `${d.district_name} พาเลทเฉลี่ยหนักเกินน้ำหนักบรรทุกของรถ` });
    }
  }

  // 1-2. full-truck splits, then savings merge
  const fullRoutes: Route[] = [];
  const rest: Load[] = [];
  for (const d of active) {
    const s = splitDistrict(ctx, d);
    fullRoutes.push(...s.full);
    if (s.rest) rest.push(s.rest);
  }
  const routes = [...fullRoutes, ...savingsRoutes(ctx, rest)];
  let n = 0;
  const trips = routes.map((r) => toTrip(ctx, demand.week_start, r, `T${String(++n).padStart(2, "0")}`));

  // 3. place on truck-days
  const days = workDays(demand.week_start, settings);
  let unplaced = assignDays(ctx, trips, days, vehicles);

  // 4. pick-up only for the trips the trucks cannot cover
  if (unplaced.length) {
    const candidates = trips
      .filter((t) => t.stops.length === 1)
      .map((t) => ({ t, d: byId.get(t.stops[0].district_id)! }))
      .filter(({ t, d }) => d.pickup_allowed && d.has_vehicle !== false && !t.stops[0].urgent
        && t.pallets >= settings.pickup_min_pallets && (d.depot_km ?? roadKm(ctx, "WH", d.district_id)) <= settings.pickup_max_km)
      .map(({ t, d }) => ({
        t,
        d,
        recent: d.last_pickup_date != null && weeksBetween(d.last_pickup_date, demand.week_start) < settings.pickup_rotation_weeks,
        km: d.depot_km ?? roadKm(ctx, "WH", d.district_id),
      }))
      .sort((a, b) => Number(a.recent) - Number(b.recent) || a.km - b.km || b.t.pallets - a.t.pallets);
    const chosen = new Set<string>();
    const pickedDistricts = new Set<string>();
    for (const c of candidates) {
      if (chosen.size >= unplaced.length) break;
      if (pickedDistricts.has(c.d.district_id)) continue;
      chosen.add(c.t.id);
      pickedDistricts.add(c.d.district_id);
    }
    if (chosen.size) {
      for (const t of trips) {
        if (!chosen.has(t.id)) continue;
        const d = byId.get(t.stops[0].district_id)!;
        t.mode = "pickup";
        t.trip_date = demand.week_start;
        t.vehicle_code = null;
        t.km = 0;
        t.minutes = 0;
        t.cost_baht = 0;
        t.return_time = null;
        t.start_time = null;
        t.stops[0].eta = null;
        const why = [`สัปดาห์นี้รถคลัง ${vehicles.length} คันส่งไม่ทัน (${trips.length} เที่ยว)`,
          `ของเขตเดียว ${t.pallets} พาเลท`, `ห่างคลัง ${Math.round(d.depot_km ?? 0)} กม.`];
        if (d.has_vehicle == null) why.push("ต้องสอบถามว่าเขตมีรถว่าง");
        if (d.last_pickup_date && weeksBetween(d.last_pickup_date, demand.week_start) < settings.pickup_rotation_weeks) {
          why.push(`มารับแล้วเมื่อ ${d.last_pickup_date} (ไม่มีเขตอื่นเข้าเกณฑ์)`);
        }
        t.reason = why.join(" · ");
      }
      for (const t of trips) if (t.mode === "delivery") { t.trip_date = null; t.vehicle_code = null; }
      unplaced = assignDays(ctx, trips.filter((t) => t.mode === "delivery"), days, vehicles);
    }
  }

  // 5. overflow
  for (const t of unplaced) {
    t.mode = "overflow";
    t.trip_date = null;
    t.vehicle_code = null;
    const urgent = t.stops.some((s) => s.urgent);
    t.reason = urgent
      ? "มีของด่วน: ขอรถเพิ่ม / รถเช่า หรือโทรนัดเขตมารับ"
      : "รถไม่พอ: เลื่อนไปสัปดาห์ถัดไป หรือขอรถเพิ่ม";
    warnings.push({ code: "overflow", level: urgent ? "high" : "warn", trip_id: t.id,
      message: `${t.stops.map((s) => s.district_name).join(", ")} (${t.pallets} พาเลท) ยังไม่มีรถ — ${t.reason}` });
  }
  warnings.push(...lateWarnings(trips));

  const sorted = trips.sort((a, b) =>
    (a.mode === b.mode ? 0 : a.mode === "delivery" ? -1 : a.mode === "pickup" && b.mode === "overflow" ? -1 : 1)
    || (a.trip_date ?? "").localeCompare(b.trip_date ?? "")
    || (a.vehicle_code ?? "").localeCompare(b.vehicle_code ?? ""));

  // Fixed-zone plan for the same goods
  const zoneTrips = [...fullRoutes, ...zoneRoutes(ctx, rest)].map((r, i) => {
    const t = toTrip(ctx, demand.week_start, r, `Z${i + 1}`);
    const d = byId.get(r.stops[0].district_id);
    t.trip_date = d?.promise_date ?? null;
    return t;
  });
  const slotsPerWeek = days.length * vehicles.length;
  if (zoneTrips.length > slotsPerWeek) {
    zoneTrips.slice(slotsPerWeek).forEach((t) => { t.mode = "overflow"; });
  }

  const metrics = summarizeTrips(sorted, capacity);
  if ((settings.max_trips_per_truck_day ?? 1) < 2 && (metrics.stops_late || metrics.pickups || metrics.overflow_trips)) {
    const alt = solveDispatch({ ...demand, settings: { ...settings, max_trips_per_truck_day: 2 } }).metrics;
    const better = alt.stops_late < metrics.stops_late || alt.pickups < metrics.pickups || alt.overflow_trips < metrics.overflow_trips;
    if (better) {
      warnings.push({ code: "second_trip_hint", level: "info",
        message: `ถ้าให้รถที่กลับคลังเร็ววิ่งเที่ยวที่ 2 ในวันเดียวกัน: ส่งหลังวันโซน ${alt.stops_late} จุด (ตอนนี้ ${metrics.stops_late}) · เขตมารับเอง ${alt.pickups} (ตอนนี้ ${metrics.pickups}) · ยังไม่มีรถ ${alt.overflow_trips} (ตอนนี้ ${metrics.overflow_trips}) — เปิดได้ที่ตั้งค่า "เที่ยวต่อรถต่อวัน"` });
    }
  }

  return {
    week_start: demand.week_start,
    trips: sorted,
    metrics,
    zone_metrics: summarizeTrips(zoneTrips, capacity),
    warnings,
  };
}

function lateWarnings(trips: PlannedTrip[]): DispatchWarning[] {
  const late: string[] = [];
  for (const t of trips) {
    if (t.mode !== "delivery" || !t.trip_date) continue;
    for (const s of t.stops) {
      if (s.promise_date && t.trip_date > s.promise_date) {
        const days = Math.round((Date.parse(t.trip_date) - Date.parse(s.promise_date)) / 86400000);
        late.push(`${s.district_name} (+${days} วัน)`);
      }
    }
  }
  return late.length
    ? [{ code: "late", level: "warn", message: `ส่งหลังวันประจำโซน ${late.length} เขต: ${late.join(", ")} · ถ้าเขตต้องใช้ของก่อน ย้ายเที่ยวหรือเสนอให้มารับเอง` }]
    : [];
}

/** Planner moves a trip to another day / truck; returns the conflicts it causes. */
export function moveTrip(plan: DispatchPlan, tripId: string, date: string | null, vehicle: string | null,
  mode: TripMode, capacity = 8, settings?: Pick<DispatchSettings, "start_time" | "return_by" | "reload_minutes" | "max_trips_per_truck_day">): DispatchPlan {
  const trips = plan.trips.map((t) => (t.id === tripId
    ? { ...t, stops: t.stops.map((s) => ({ ...s })), trip_date: date, vehicle_code: mode === "delivery" ? vehicle : null, mode,
        reason: t.mode === mode ? t.reason : mode === "pickup" ? "ผู้วางแผนกำหนดให้เขตมารับ" : t.reason }
    : t));
  const warnings = plan.warnings.filter((w) => !["slot_conflict", "late", "overflow"].includes(w.code));
  const start = minutesOf(settings?.start_time ?? "09:30");
  const limit = minutesOf(settings?.return_by ?? "15:00") - start;
  const reload = settings?.reload_minutes ?? 30;
  const byDay = new Map<string, PlannedTrip[]>();
  for (const t of trips) {
    if (t.mode === "overflow") {
      warnings.push({ code: "overflow", level: "warn", trip_id: t.id,
        message: `${t.stops.map((s) => s.district_name).join(", ")} (${t.pallets} พาเลท) ยังไม่มีรถ` });
      continue;
    }
    if (t.mode !== "delivery" || !t.trip_date || !t.vehicle_code) continue;
    const key = `${t.trip_date}|${t.vehicle_code}`;
    byDay.set(key, [...(byDay.get(key) ?? []), t]);
  }
  for (const [key, list] of byDay) {
    const day: TruckDay = { date: key.split("|")[0], vehicle: key.split("|")[1], trips: list.sort((a, b) => b.minutes - a.minutes) };
    if (list.some((t) => t.id === tripId)) sequenceDay(day, start, reload);
    if (dayMinutes(day, reload) > limit || list.length > Math.max(1, settings?.max_trips_per_truck_day ?? 1)) {
      warnings.push({ code: "slot_conflict", level: "high", trip_id: tripId,
        message: `รถ ${day.vehicle} วันที่ ${day.date}: ${list.map((t) => t.id).join(" + ")} เกินเวลาหรือจำนวนเที่ยวต่อวัน (กลับคลังก่อน ${settings?.return_by?.slice(0, 5) ?? "15:00"})` });
    }
  }
  warnings.push(...lateWarnings(trips));
  return { ...plan, trips, warnings, metrics: summarizeTrips(trips, capacity) };
}
