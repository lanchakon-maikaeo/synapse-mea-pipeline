// Transport module data — ported from the prior pipeline (synapse-prior/mea_wms_main.html).
// Self-contained client-side dataset: the new Supabase route pipeline (m08) is
// scope-excluded (HTTP 410) and depends on forecasting/route-job workers that are
// not part of Business Rules v1, so the transport planner reuses the prior app's
// embedded masters (vehicles, district geo, warehouse→district route matrix).

export type Vehicle = {
  id: string;
  plate: string;
  type: string;
  code: string;
  storLoc: string;
  wh: string;
  currentWh: string;
  loanStatus: string;
  maxWt: number;
  maxVol: number;
  fuelRate: number; // km per litre
  fuelPrice: number; // THB per litre
  driver: string;
  active: boolean;
  color: string;
  colorLight: string;
};

export type GeoNode = {
  lat: number;
  lon: number;
  name: string;
  x: number;
  y: number;
};

export type RouteLeg = {
  dist: number; // km
  toll: number; // THB
  time: number; // minutes
  uf: number; // unload fixed minutes
  up: number; // unload per pallet minutes
};

export type Warehouse = "คลองเตย" | "บางพลี" | "เมืองใหม่";

export type Trip = {
  id: string;
  batch: string;
  veh: string;
  driver: string;
  wh: string;
  route: string[];
  dist: number;
  toll: number;
  fuel: number;
  fuelAct: number | null;
  date: string;
  depart: string;
  ret: string;
  status: string;
  wt: number;
  maxWt: number;
  notes: string;
};

export type PlanLine = {
  id: string;
  batch: string;
  wh: string;
  dist: string;
  matId: string;
  qty: number;
  priorityScore: number;
  priority: string;
};

export const VEHICLES: Vehicle[] = [
  { id: "V707", plate: "ทะเบียน 707", type: "6-wheel", code: "พด.707", storLoc: "0001", wh: "คลองเตย", currentWh: "คลองเตย", loanStatus: "HOME", maxWt: 5000, maxVol: 24.2, fuelRate: 12.5, fuelPrice: 35.5, driver: "สมชาย กาญจนา", active: true, color: "#005BAC", colorLight: "#DBEAFE" },
  { id: "V708", plate: "ทะเบียน 708", type: "6-wheel", code: "พด.708", storLoc: "0001", wh: "คลองเตย", currentWh: "คลองเตย", loanStatus: "HOME", maxWt: 5000, maxVol: 24.2, fuelRate: 12.5, fuelPrice: 35.5, driver: "ณรงค์ ทองดี", active: true, color: "#10B981", colorLight: "#D1FAE5" },
  { id: "V701", plate: "ทะเบียน 701", type: "6-wheel", code: "พด.701", storLoc: "0002", wh: "บางพลี", currentWh: "บางพลี", loanStatus: "HOME", maxWt: 5000, maxVol: 24.2, fuelRate: 12.5, fuelPrice: 35.5, driver: "วิชัย ประสาน", active: true, color: "#F59E0B", colorLight: "#FEF3C7" },
  { id: "V702", plate: "ทะเบียน 702", type: "6-wheel", code: "พด.702", storLoc: "0006", wh: "เมืองใหม่", currentWh: "เมืองใหม่", loanStatus: "HOME", maxWt: 5000, maxVol: 24.2, fuelRate: 13.0, fuelPrice: 35.5, driver: "นิรันดร์ สุขใจ", active: true, color: "#EF4444", colorLight: "#FEE2E2" },
  { id: "V703", plate: "ทะเบียน 703", type: "6-wheel", code: "พด.703", storLoc: "0006", wh: "เมืองใหม่", currentWh: "เมืองใหม่", loanStatus: "HOME", maxWt: 5000, maxVol: 24.2, fuelRate: 13.0, fuelPrice: 35.5, driver: "ประสงค์ ดีงาม", active: true, color: "#8B5CF6", colorLight: "#EDE9FE" },
  { id: "V706", plate: "ทะเบียน 706", type: "6-wheel", code: "พด.706", storLoc: "0006", wh: "เมืองใหม่", currentWh: "เมืองใหม่", loanStatus: "HOME", maxWt: 5000, maxVol: 24.2, fuelRate: 13.0, fuelPrice: 35.5, driver: "มานะ ขยัน", active: true, color: "#EC4899", colorLight: "#FCE7F3" },
];

// Lat/lon from DB_Route (Latitude, Longitude); x,y are positions on the internal
// 850×520 SVG canvas. WH = central warehouse (Khlong Toei).
export const DIST_GEO: Record<string, GeoNode> = {
  WH: { lat: 13.72, lon: 100.55, name: "คลังกลาง (คลองเตย)", x: 165, y: 265 },
  "5501": { lat: 13.75, lon: 100.52, name: "การไฟฟ้าเขต นวลจันทร์", x: 100, y: 225 },
  "5601": { lat: 13.81, lon: 100.49, name: "การไฟฟ้าเขต สามเสน", x: 55, y: 155 },
  "5701": { lat: 13.72, lon: 100.58, name: "การไฟฟ้าเขต นนทบุรี", x: 205, y: 265 },
  "5801": { lat: 13.85, lon: 100.55, name: "การไฟฟ้าเขต ธนบุรี", x: 155, y: 105 },
  "5901": { lat: 13.73, lon: 100.48, name: "การไฟฟ้าเขต บางใหญ่", x: 42, y: 248 },
  "6001": { lat: 13.68, lon: 100.51, name: "การไฟฟ้าเขต ลาดกระบัง", x: 80, y: 310 },
  "6501": { lat: 13.59, lon: 101.01, name: "การไฟฟ้าเขต บางนา", x: 595, y: 365 },
  "6601": { lat: 13.52, lon: 101.08, name: "การไฟฟ้าเขต วัดเลียบ", x: 678, y: 430 },
  "6701": { lat: 13.61, lon: 100.92, name: "การไฟฟ้าเขต คลองเตย", x: 510, y: 340 },
  "6801": { lat: 13.65, lon: 100.98, name: "การไฟฟ้าเขต ราชภูมิบุรณะ", x: 568, y: 295 },
  "6901": { lat: 13.45, lon: 101.15, name: "การไฟฟ้าเขต ยานนาวา", x: 758, y: 498 },
  "7001": { lat: 13.5, lon: 101.2, name: "การไฟฟ้าเขต บางขุนเทียน", x: 800, y: 448 },
  "7501": { lat: 14.0, lon: 100.8, name: "การไฟฟ้าเขต บางบัวทอง", x: 30, y: 200 },
  "7601": { lat: 14.35, lon: 100.55, name: "การไฟฟ้าเขต บางปะกิ", x: 90, y: 110 },
  "7701": { lat: 14.8, lon: 100.4, name: "การไฟฟ้าเขต สมุทรปราการ", x: 135, y: 70 },
  "7801": { lat: 13.9, lon: 101.5, name: "การไฟฟ้าเขต บางพลี", x: 70, y: 315 },
  "7901": { lat: 13.75, lon: 101.8, name: "การไฟฟ้าเขต มีนบุรี", x: 220, y: 350 },
  "8001": { lat: 13.5, lon: 102.1, name: "การไฟฟ้าเขต บางเขน", x: 45, y: 330 },
};

// DB_Route — warehouse → district legs. dist(km), toll(THB), time(min),
// uf=Unload_Fixed_Min, up=Unload_Per_Pallet_Min
export const ROUTES: Record<Warehouse, Record<string, RouteLeg>> = {
  คลองเตย: {
    "5501": { dist: 15.2, toll: 60, time: 35, uf: 20, up: 8 }, "5601": { dist: 22.8, toll: 80, time: 50, uf: 20, up: 8 },
    "5701": { dist: 18.5, toll: 60, time: 40, uf: 20, up: 8 }, "5801": { dist: 31.0, toll: 100, time: 65, uf: 20, up: 8 },
    "5901": { dist: 12.3, toll: 40, time: 28, uf: 20, up: 8 }, "6001": { dist: 28.7, toll: 80, time: 60, uf: 20, up: 8 },
    "6501": { dist: 48.5, toll: 140, time: 90, uf: 25, up: 10 }, "6601": { dist: 58.0, toll: 160, time: 110, uf: 25, up: 10 },
    "6701": { dist: 41.5, toll: 120, time: 80, uf: 25, up: 10 }, "6801": { dist: 35.0, toll: 100, time: 70, uf: 25, up: 10 },
    "6901": { dist: 72.5, toll: 200, time: 130, uf: 25, up: 10 }, "7001": { dist: 65.0, toll: 180, time: 120, uf: 25, up: 10 },
    "7501": { dist: 88.0, toll: 220, time: 145, uf: 30, up: 12 }, "7601": { dist: 112.0, toll: 260, time: 175, uf: 30, up: 12 },
    "7701": { dist: 138.0, toll: 300, time: 210, uf: 30, up: 12 }, "7801": { dist: 98.0, toll: 240, time: 155, uf: 30, up: 12 },
    "7901": { dist: 122.0, toll: 280, time: 185, uf: 30, up: 12 }, "8001": { dist: 155.0, toll: 320, time: 225, uf: 30, up: 12 },
  },
  บางพลี: {
    "5501": { dist: 42.0, toll: 120, time: 80, uf: 20, up: 8 }, "5601": { dist: 50.0, toll: 140, time: 95, uf: 20, up: 8 },
    "5701": { dist: 45.0, toll: 120, time: 85, uf: 20, up: 8 }, "5801": { dist: 55.0, toll: 160, time: 100, uf: 20, up: 8 },
    "5901": { dist: 38.0, toll: 100, time: 72, uf: 20, up: 8 }, "6001": { dist: 52.0, toll: 140, time: 95, uf: 20, up: 8 },
    "6501": { dist: 35.0, toll: 120, time: 70, uf: 25, up: 10 }, "6601": { dist: 42.5, toll: 120, time: 85, uf: 25, up: 10 },
    "6701": { dist: 28.0, toll: 80, time: 55, uf: 25, up: 10 }, "6801": { dist: 19.5, toll: 60, time: 45, uf: 25, up: 10 },
    "6901": { dist: 55.0, toll: 160, time: 100, uf: 25, up: 10 }, "7001": { dist: 48.5, toll: 140, time: 90, uf: 25, up: 10 },
    "7501": { dist: 115.0, toll: 280, time: 175, uf: 30, up: 12 }, "7601": { dist: 140.0, toll: 320, time: 210, uf: 30, up: 12 },
    "7701": { dist: 168.0, toll: 360, time: 245, uf: 30, up: 12 }, "7801": { dist: 75.5, toll: 200, time: 125, uf: 30, up: 12 },
    "7901": { dist: 95.0, toll: 220, time: 150, uf: 30, up: 12 }, "8001": { dist: 125.0, toll: 260, time: 190, uf: 30, up: 12 },
  },
  เมืองใหม่: {
    "5501": { dist: 95.0, toll: 240, time: 150, uf: 20, up: 8 }, "5601": { dist: 102.0, toll: 260, time: 160, uf: 20, up: 8 },
    "5701": { dist: 98.0, toll: 240, time: 155, uf: 20, up: 8 }, "5801": { dist: 108.0, toll: 260, time: 165, uf: 20, up: 8 },
    "5901": { dist: 90.0, toll: 220, time: 142, uf: 20, up: 8 }, "6001": { dist: 105.0, toll: 260, time: 162, uf: 20, up: 8 },
    "6501": { dist: 88.0, toll: 220, time: 140, uf: 25, up: 10 }, "6601": { dist: 95.0, toll: 240, time: 152, uf: 25, up: 10 },
    "6701": { dist: 80.0, toll: 200, time: 130, uf: 25, up: 10 }, "6801": { dist: 72.0, toll: 180, time: 118, uf: 25, up: 10 },
    "6901": { dist: 108.0, toll: 260, time: 168, uf: 25, up: 10 }, "7001": { dist: 100.0, toll: 240, time: 158, uf: 25, up: 10 },
    "7501": { dist: 65.0, toll: 180, time: 110, uf: 30, up: 12 }, "7601": { dist: 88.5, toll: 200, time: 140, uf: 30, up: 12 },
    "7701": { dist: 112.0, toll: 240, time: 175, uf: 30, up: 12 }, "7801": { dist: 75.5, toll: 200, time: 125, uf: 30, up: 12 },
    "7901": { dist: 95.0, toll: 220, time: 150, uf: 30, up: 12 }, "8001": { dist: 125.0, toll: 260, time: 190, uf: 30, up: 12 },
  },
};

export const WAREHOUSES: Warehouse[] = ["คลองเตย", "บางพลี", "เมืองใหม่"];

// District IDs served by the route matrix, in canonical order.
export const ROUTE_DISTRICT_IDS = Object.keys(DIST_GEO).filter((id) => id !== "WH");

// Trans_Replenishment_Plan — current confirmed batch awaiting dispatch.
export const REPLENISHMENT_PLAN: PlanLine[] = [
  { id: "PLN-20260316-001", batch: "BATCH-20260316-A", wh: "คลองเตย", dist: "5501", matId: "MAT001", qty: 150, priorityScore: 8.5, priority: "สูง" },
  { id: "PLN-20260316-003", batch: "BATCH-20260316-A", wh: "คลองเตย", dist: "5501", matId: "MAT010", qty: 380, priorityScore: 7.0, priority: "กลาง" },
  { id: "PLN-20260316-004", batch: "BATCH-20260316-A", wh: "คลองเตย", dist: "5701", matId: "MAT001", qty: 180, priorityScore: 9.5, priority: "สูง" },
  { id: "PLN-20260316-006", batch: "BATCH-20260316-A", wh: "คลองเตย", dist: "5901", matId: "MAT001", qty: 190, priorityScore: 9.8, priority: "สูง" },
  { id: "PLN-20260316-008", batch: "BATCH-20260316-A", wh: "บางพลี", dist: "6601", matId: "MAT001", qty: 188, priorityScore: 9.7, priority: "สูง" },
  { id: "PLN-20260316-010", batch: "BATCH-20260316-A", wh: "เมืองใหม่", dist: "7601", matId: "MAT001", qty: 185, priorityScore: 9.2, priority: "สูง" },
  { id: "PLN-20260316-012", batch: "BATCH-20260316-A", wh: "เมืองใหม่", dist: "7901", matId: "MAT001", qty: 192, priorityScore: 9.5, priority: "สูง" },
];

export const SEED_TRIPS: Trip[] = [
  { id: "TRP-20260316-01", batch: "BATCH-20260316-A", veh: "V707", driver: "สมชาย กาญจนา", wh: "คลองเตย", route: ["5501", "5701", "5901"], dist: 58.0, toll: 140, fuel: 253.88, fuelAct: null, date: "16/03/2569", depart: "", ret: "", status: "วางแผน", wt: 0, maxWt: 5000, notes: "" },
  { id: "TRP-20260316-02", batch: "BATCH-20260316-A", veh: "V701", driver: "วิชัย ประสาน", wh: "บางพลี", route: ["6601"], dist: 42.5, toll: 120, fuel: 263.44, fuelAct: null, date: "16/03/2569", depart: "", ret: "", status: "วางแผน", wt: 0, maxWt: 5000, notes: "" },
  { id: "TRP-20260316-03", batch: "BATCH-20260316-A", veh: "V702", driver: "ณรงค์ ทองดี", wh: "เมืองใหม่", route: ["7601", "7901"], dist: 220.0, toll: 460, fuel: 1287.0, fuelAct: null, date: "16/03/2569", depart: "", ret: "", status: "วางแผน", wt: 0, maxWt: 5000, notes: "" },
  { id: "TRP-20260310-01", batch: "BATCH-20260310-A", veh: "V707", driver: "สมชาย กาญจนา", wh: "คลองเตย", route: ["5501", "5801", "6001"], dist: 85.5, toll: 220, fuel: 374.69, fuelAct: 390, date: "10/03/2569", depart: "07:00", ret: "16:30", status: "ส่งครบ", wt: 0, maxWt: 5000, notes: "ส่งครบทุกเขต" },
  { id: "TRP-20260310-03", batch: "BATCH-20260310-A", veh: "V702", driver: "ณรงค์ ทองดี", wh: "เมืองใหม่", route: ["8001"], dist: 125.0, toll: 260, fuel: 731.25, fuelAct: 750, date: "10/03/2569", depart: "06:30", ret: "17:00", status: "ส่งครบ", wt: 0, maxWt: 5000, notes: "เส้นทางไกล ออกก่อน" },
  { id: "TRP-20260313-01", batch: "BATCH-20260313-A", veh: "V701", driver: "วิชัย ประสาน", wh: "บางพลี", route: ["6501", "6701"], dist: 75.5, toll: 200, fuel: 468.13, fuelAct: 480, date: "13/03/2569", depart: "07:00", ret: "16:00", status: "ส่งครบ", wt: 0, maxWt: 5000, notes: "" },
  { id: "TRP-20260309-02", batch: "BATCH-20260309-A", veh: "V703", driver: "ณรงค์ ทองดี", wh: "เมืองใหม่", route: ["7701"], dist: 112.0, toll: 240, fuel: 655.2, fuelAct: 670, date: "09/03/2569", depart: "06:30", ret: "17:00", status: "ส่งครบ", wt: 0, maxWt: 5000, notes: "" },
  { id: "TRP-20260307-01", batch: "BATCH-20260307-A", veh: "V702", driver: "ณรงค์ ทองดี", wh: "เมืองใหม่", route: ["7501", "7701"], dist: 180.0, toll: 380, fuel: 1053.0, fuelAct: 1080, date: "07/03/2569", depart: "06:00", ret: "18:00", status: "ส่งครบ", wt: 0, maxWt: 5000, notes: "เส้นทางยาว 2 เขต" },
];

// Straight-line km between two geo nodes (prior app's kmDist).
export function kmDist(a: GeoNode, b: GeoNode) {
  const LAT = 111.2;
  const LON = 108.1;
  const dy = (a.lat - b.lat) * LAT;
  const dx = (a.lon - b.lon) * LON;
  return Math.round(Math.sqrt(dy * dy + dx * dx) * 10) / 10;
}

export function districtName(id: string) {
  return DIST_GEO[id]?.name ?? id;
}

export type PlannedRoute = {
  order: string[];
  totalDist: number;
  totalToll: number;
  totalTime: number;
  fuelCost: number;
  vehicle: Vehicle | null;
};

// Nearest-neighbour ordering from the warehouse, then leg metrics summed from the
// route matrix. Mirrors the prior planner's greedy sequencing.
export function planRoute(
  warehouse: Warehouse,
  districtIds: string[],
): PlannedRoute {
  const legs = ROUTES[warehouse];
  const remaining = districtIds.filter((id) => legs[id]);
  const order: string[] = [];
  let cursor = DIST_GEO.WH;
  while (remaining.length) {
    let bestIdx = 0;
    let bestKm = Infinity;
    remaining.forEach((id, idx) => {
      const km = kmDist(cursor, DIST_GEO[id]);
      if (km < bestKm) {
        bestKm = km;
        bestIdx = idx;
      }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    order.push(next);
    cursor = DIST_GEO[next];
  }
  const totalDist = order.reduce((sum, id) => sum + (legs[id]?.dist ?? 0), 0);
  const totalToll = order.reduce((sum, id) => sum + (legs[id]?.toll ?? 0), 0);
  const totalTime = order.reduce((sum, id) => sum + (legs[id]?.time ?? 0), 0);
  const vehicle =
    VEHICLES.find((v) => v.currentWh === warehouse && v.active) ?? null;
  const fuelCost = vehicle
    ? Math.round((totalDist / vehicle.fuelRate) * vehicle.fuelPrice * 100) / 100
    : 0;
  return {
    order,
    totalDist: Math.round(totalDist * 10) / 10,
    totalToll,
    totalTime,
    fuelCost,
    vehicle,
  };
}
