"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  apiRequest,
  formatDateTime,
  formatNumber,
  type Role,
} from "./lib";
import type { RoadOptimizationResult } from "./route-optimizer";
import type {
  RoadGeometry,
  TransportRoadMapProps,
} from "./transport-road-map";
import {
  DIST_GEO,
  REPLENISHMENT_PLAN,
  SEED_TRIPS,
  VEHICLES,
  planRoute,
  type Warehouse,
} from "./transport-data";

const TransportRoadMap = dynamic<TransportRoadMapProps>(
  () =>
    import("./transport-road-map").then((module) => module.TransportRoadMap),
  {
    ssr: false,
    loading: () => (
      <div className="transport-map-loading" role="status">
        กำลังโหลดแผนที่…
      </div>
    ),
  },
);

export type TransportView = "dashboard" | "planner" | "map" | "history";

export const transportNav: Array<[TransportView, string, string]> = [
  ["dashboard", "ภาพรวมขนส่ง", "⌂"],
  ["planner", "วางแผนจัดรถ", "▤"],
  ["map", "แผนที่เส้นทาง", "◎"],
  ["history", "ประวัติการเดินรถ", "◷"],
];

export function canMutateTransport(role: Role) {
  return role === "admin" || role === "planner";
}

export function transportNavForRole(role: Role) {
  return canMutateTransport(role)
    ? transportNav
    : transportNav.filter(([view]) => view !== "planner");
}

const transportTitles: Record<TransportView, [string, string, string]> = {
  dashboard: ["การขนส่ง", "ภาพรวมการขนส่ง", "ดูรถ คนขับ และงานที่รอจัดส่ง"],
  planner: [
    "จัดเส้นทาง",
    "วางแผนจัดรถและปรับเส้นทาง",
    "ทดลองจัดลำดับจุดส่งบนถนน แล้วส่งแผนที่ล็อกแล้วทั้งชุดให้ OR-Tools + Valhalla คำนวณแผนเส้นทาง ขั้นตอนนี้ยังไม่สร้างเที่ยวรถ",
  ],
  map: ["แผนที่เส้นทาง", "แผนที่เส้นทางการจ่าย", "ดูเส้นทางถนนจากข้อมูล OSM และสถานะการยืนยันพิกัด"],
  history: ["ประวัติเที่ยวรถ", "ประวัติการเดินรถ", "เที่ยวรถที่บันทึกในระบบ พร้อมค่าน้ำมันจริงเทียบประมาณการ"],
};

// ---- Normalised transport data ----
type GeocodeStatus = "candidate" | "verified" | "quarantined";
type VehicleAvailability = "available" | "unavailable" | "unknown";

type WarehouseRouteReadiness = {
  warehouseCode: string;
  geocodeStatus: GeocodeStatus | "missing";
  canonicalWarehouseId: string | null;
  canonicalOriginReady: boolean;
  routeEligible: boolean;
};

type TransportReadiness = {
  operationalWritesEnabled: boolean;
  activeWarehouses: number;
  activeVehicles: number;
  verifiedWarehouseGeocodes: number;
  verifiedDistrictGeocodes: number;
  quarantinedGeocodes: number;
  warehousesMissingGeocode: number;
  verifiedDepotsMissingCanonicalOrigin: number;
  warehouseRouteReadiness: WarehouseRouteReadiness[];
  routeReady: boolean;
  routeReadinessStatus: string;
  optimizationWorkerReady: boolean;
  optimizationWorkerStatus: string;
  optimizationEligiblePlanIds: string[];
  optimizationEligiblePlanIdsAttested: boolean;
  tripPersistenceReady: boolean;
  tripPersistenceStatus: string;
};

type TGeo = {
  ref: string;
  name: string;
  lat: number;
  lon: number;
  districtId: string | null;
  isWarehouse: boolean;
  warehouseCode: string | null;
  verificationStatus: GeocodeStatus;
  routeEligible: boolean;
  sourceReference: string | null;
};
type TVehicle = {
  id: string;
  code: string;
  plate: string;
  currentWarehouse: string;
  driver: string;
  maxWt: number;
  fuelRate: number;
  active: boolean;
  availability: VehicleAvailability;
  availabilityEvidence: string | null;
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
  fuel: number;
  fuelActual: number | null;
  date: string;
  status: string;
  notes: string;
  evidenceStatus: "legacy_illustrative_unverified";
};
type QueueRow = {
  districtRef: string;
  districtId: string;
  districtName: string;
  totalQty: number | null;
  lineCount: number;
  originLocationId: string | null;
  originWarehouseId: string | null;
  originWarehouse: string;
  originWarehouseGeocodeStatus: GeocodeStatus | "missing";
  routeEligible: boolean;
  planId: string | null;
  planNumber: string;
  estimatedWeightKg: number | null;
  weightComplete: boolean;
};

type RouteOptimizationJob = {
  route_job_id: string;
  job_id: string;
  replenishment_plan_id: string;
  forecast_run_id?: string | null;
  algorithm_version: string;
  matrix_source: "valhalla";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
  attempt_count?: number;
  max_attempts?: number;
  route_plan_id?: string | null;
  route_plan_status?: string | null;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  idempotent_replay?: boolean;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  } | null;
};

type OptimizationAttemptStatus =
  | "submitting"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

type PersistedOptimizationAttempt = {
  version: 1;
  planId: string;
  groupKey: string;
  requestId: string;
  routeJobId: string | null;
  status: OptimizationAttemptStatus;
  updatedAt: string;
};

const uuidPattern =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const optimizationSessionPrefix = "synapse.transport.optimization.v1";
const activeOptimizationStatuses: OptimizationAttemptStatus[] = [
  "submitting",
  "queued",
  "running",
];
const terminalOptimizationStatuses: OptimizationAttemptStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

function optimizationAttemptStatus(
  value: unknown,
): OptimizationAttemptStatus | null {
  return [
    ...activeOptimizationStatuses,
    ...terminalOptimizationStatuses,
  ].includes(value as OptimizationAttemptStatus)
    ? (value as OptimizationAttemptStatus)
    : null;
}

function optimizationSessionKey(actorId: string, planId: string) {
  return `${optimizationSessionPrefix}:${actorId}:${planId}`;
}

function readOptimizationAttempt(actorId: string, planId: string) {
  if (
    typeof window === "undefined" ||
    !uuidPattern.test(actorId) ||
    !uuidPattern.test(planId)
  ) {
    return null;
  }
  const key = optimizationSessionKey(actorId, planId);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedOptimizationAttempt>;
    const status = optimizationAttemptStatus(parsed.status);
    const valid =
      parsed.version === 1 &&
      parsed.planId === planId &&
      typeof parsed.groupKey === "string" &&
      typeof parsed.requestId === "string" &&
      parsed.requestId.length > 0 &&
      parsed.requestId.length <= 64 &&
      /^[A-Za-z0-9_-]+$/.test(parsed.requestId) &&
      (parsed.routeJobId === null ||
        (typeof parsed.routeJobId === "string" &&
          uuidPattern.test(parsed.routeJobId))) &&
      Boolean(status) &&
      (status === "submitting" || typeof parsed.routeJobId === "string") &&
      typeof parsed.updatedAt === "string";
    if (!valid) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return parsed as PersistedOptimizationAttempt;
  } catch {
    return null;
  }
}

function writeOptimizationAttempt(
  actorId: string,
  attempt: PersistedOptimizationAttempt,
) {
  if (
    typeof window === "undefined" ||
    !uuidPattern.test(actorId) ||
    !uuidPattern.test(attempt.planId)
  ) {
    return;
  }
  try {
    // Deliberately persist only opaque job/idempotency identifiers and state.
    // Access tokens, user profile data, payloads and route evidence never enter
    // browser storage.
    window.sessionStorage.setItem(
      optimizationSessionKey(actorId, attempt.planId),
      JSON.stringify(attempt),
    );
  } catch {
    // Private browsing and enterprise policies may disable storage. The API's
    // actor-scoped idempotency remains the authoritative duplicate guard.
  }
}

function assertJobMatchesPlan(
  job: RouteOptimizationJob,
  planId: string,
  expectedRouteJobId?: string,
) {
  const status = optimizationAttemptStatus(job.status);
  if (
    job.replenishment_plan_id !== planId ||
    !uuidPattern.test(job.route_job_id) ||
    (expectedRouteJobId && job.route_job_id !== expectedRouteJobId) ||
    !status ||
    job.matrix_source !== "valhalla"
  ) {
    throw new Error("ผลคำนวณไม่ตรงกับแผนหรืองานที่ร้องขอ");
  }
  return status;
}

type TransportData = {
  geo: Record<string, TGeo>;
  vehicles: TVehicle[];
  trips: TTrip[];
  warehouses: string[];
  queue: QueueRow[];
  readiness: TransportReadiness | null;
};

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const coordinateNum = (value: unknown) => {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return Number.NaN;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};
const str = (v: unknown) => (v == null ? "" : String(v));
type DataSource = "supabase" | "demo" | "error";

function geoStatus(value: unknown): TGeo["verificationStatus"] {
  return value === "verified" || value === "quarantined"
    ? value
    : "candidate";
}

function vehicleAvailability(row: Row): {
  status: VehicleAvailability;
  evidence: string | null;
} {
  const rawStatus = str(row.availability_status).trim().toLowerCase();
  const evidence =
    str(row.availability_evidence).trim() ||
    str(row.availability_checked_at).trim() ||
    null;
  if (
    ["unavailable", "busy", "blocked", "maintenance"].includes(rawStatus) ||
    row.is_available === false
  ) {
    return { status: "unavailable", evidence };
  }
  if (
    (rawStatus === "available" || row.is_available === true) &&
    evidence
  ) {
    return { status: "available", evidence };
  }
  return { status: "unknown", evidence };
}

function parseReadiness(row: Row): TransportReadiness {
  const depots: WarehouseRouteReadiness[] = Array.isArray(
    row.warehouse_route_readiness,
  )
    ? (row.warehouse_route_readiness as Row[]).map(
        (depot): WarehouseRouteReadiness => ({
          warehouseCode: str(depot.warehouse_code),
          geocodeStatus:
            depot.geocode_status === "verified" ||
            depot.geocode_status === "quarantined"
              ? depot.geocode_status
              : depot.geocode_status === "candidate" ||
                  depot.geocode_status === "unverified"
                ? "candidate"
              : "missing",
          canonicalWarehouseId: depot.canonical_warehouse_id
            ? str(depot.canonical_warehouse_id)
            : null,
          canonicalOriginReady: depot.canonical_origin_ready === true,
          routeEligible: depot.route_eligible === true,
        }),
      )
    : [];
  const rawEligiblePlanIds = row.optimization_eligible_plan_ids;
  const eligiblePlanIdsAttested =
    Array.isArray(rawEligiblePlanIds) &&
    rawEligiblePlanIds.every(
      (planId) => typeof planId === "string" && uuidPattern.test(planId),
    );
  const eligiblePlanIds = eligiblePlanIdsAttested
    ? [...new Set(rawEligiblePlanIds as string[])]
    : [];
  return {
    operationalWritesEnabled: row.operational_writes_enabled === true,
    activeWarehouses: num(row.active_warehouses),
    activeVehicles: num(row.active_vehicles),
    verifiedWarehouseGeocodes: num(row.verified_warehouse_geocodes),
    verifiedDistrictGeocodes: num(row.verified_district_geocodes),
    quarantinedGeocodes: num(row.quarantined_geocodes),
    warehousesMissingGeocode: num(row.warehouses_missing_geocode),
    verifiedDepotsMissingCanonicalOrigin: num(
      row.verified_depots_missing_canonical_origin,
    ),
    warehouseRouteReadiness: depots,
    routeReady: row.route_ready === true,
    routeReadinessStatus:
      str(row.route_readiness_status) || "unknown_route_readiness",
    optimizationWorkerReady: row.optimization_worker_ready === true,
    optimizationWorkerStatus:
      str(row.optimization_worker_status) || "unknown_worker_readiness",
    optimizationEligiblePlanIds: eligiblePlanIds,
    optimizationEligiblePlanIdsAttested: eligiblePlanIdsAttested,
    tripPersistenceReady: row.trip_persistence_ready === true,
    tripPersistenceStatus:
      str(row.trip_persistence_status) || "unknown_persistence_readiness",
  };
}

function hasValidCoordinates(point: TGeo | null | undefined) {
  return Boolean(
    point &&
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lon) &&
      point.lat >= -90 &&
      point.lat <= 90 &&
      point.lon >= -180 &&
      point.lon <= 180,
  );
}

function emptyData(): TransportData {
  return {
    geo: {},
    vehicles: [],
    trips: [],
    warehouses: [],
    queue: [],
    readiness: null,
  };
}

const demoDistrictNames: Record<string, string> = {
  "5501": "เขตนวลจันทร์",
  "5601": "เขตสามเสน",
  "5701": "เขตนนทบุรี",
  "5801": "เขตธนบุรี",
  "5901": "เขตบางใหญ่",
  "6001": "เขตลาดกระบัง",
  "6501": "เขตบางนา",
  "6601": "เขตวัดเลียบ",
  "6701": "เขตคลองเตย",
  "6801": "เขตราษฎร์บูรณะ",
  "6901": "เขตยานนาวา",
  "7001": "เขตบางขุนเทียน",
  "7501": "เขตบางบัวทอง",
  "7601": "เขตบางกะปิ",
  "7701": "เขตสมุทรปราการ",
  "7801": "เขตบางพลี",
  "7901": "เขตมีนบุรี",
  "8001": "เขตบางเขน",
};

const demoWeightByDistrict: Record<string, number> = {
  "5501": 2_800,
  "5701": 2_100,
  "5901": 1_600,
};

function demoTransportData(): TransportData {
  const geo: Record<string, TGeo> = {
    WH: {
      ref: "WH",
      name: "คลังกลางคลองเตย",
      lat: DIST_GEO.WH.lat,
      lon: DIST_GEO.WH.lon,
      districtId: null,
      isWarehouse: true,
      warehouseCode: "คลองเตย",
      verificationStatus: "verified",
      routeEligible: true,
      sourceReference: "LOCAL DEMO · คลังกลางคลองเตย",
    },
  };
  Object.entries(DIST_GEO).forEach(([ref, point]) => {
    if (ref === "WH") return;
    geo[ref] = {
      ref,
      name: `${ref} : ${demoDistrictNames[ref] ?? point.name}`,
      lat: point.lat,
      lon: point.lon,
      districtId: ref,
      isWarehouse: false,
      warehouseCode: null,
      verificationStatus: "verified",
      routeEligible: true,
      sourceReference: "LOCAL DEMO · พิกัดประกอบการออกแบบ UX",
    };
  });

  const vehicles: TVehicle[] = VEHICLES.filter(
    (vehicle) => vehicle.currentWh === "คลองเตย" && vehicle.active,
  ).map((vehicle) => ({
    id: vehicle.id,
    code: vehicle.code,
    plate: vehicle.plate,
    currentWarehouse: "คลองเตย",
    driver: vehicle.driver,
    maxWt: 6_000,
    fuelRate: vehicle.fuelRate,
    active: true,
    availability: "available",
    availabilityEvidence:
      "LOCAL DEMO · รถ 6 ล้อ · พื้นที่ใช้งานเฉลี่ย 2.45 × 5.20 ม. · ไม่ซ้อนสูง · ไม่มีอุปกรณ์ยก",
  }));

  const planRows = REPLENISHMENT_PLAN.filter(
    (line) => line.wh === "คลองเตย",
  );
  const grouped = new Map<string, typeof planRows>();
  planRows.forEach((line) => {
    grouped.set(line.dist, [...(grouped.get(line.dist) ?? []), line]);
  });
  const planId = "11111111-1111-4111-8111-111111111111";
  const queue: QueueRow[] = [...grouped.entries()].map(([districtRef, rows]) => ({
    districtRef,
    districtId: districtRef,
    districtName: demoDistrictNames[districtRef] ?? districtRef,
    totalQty: rows.reduce((sum, row) => sum + row.qty, 0),
    lineCount: rows.length,
    originLocationId: "demo-location-khlong-toei",
    originWarehouseId: "demo-warehouse-khlong-toei",
    originWarehouse: "คลองเตย",
    originWarehouseGeocodeStatus: "verified",
    routeEligible: true,
    planId,
    planNumber: "WP-DEMO-W30 · Final Plan",
    estimatedWeightKg: demoWeightByDistrict[districtRef] ?? 1_200,
    weightComplete: true,
  }));

  const trips: TTrip[] = SEED_TRIPS.filter(
    (trip) => trip.wh === "คลองเตย",
  ).map((trip) => ({
    id: trip.id,
    code: trip.id,
    batch: trip.batch,
    vehicle: trip.veh,
    driver: trip.driver,
    warehouse: trip.wh,
    route: trip.route,
    dist: trip.dist,
    fuel: trip.fuel,
    fuelActual: trip.fuelAct,
    date: trip.date,
    status: trip.status,
    notes: trip.notes,
    evidenceStatus: "legacy_illustrative_unverified",
  }));

  return {
    geo,
    vehicles,
    trips,
    warehouses: ["คลองเตย"],
    queue,
    readiness: null,
  };
}

function mapStatus(s: string) {
  return (
    { planned: "วางแผน", dispatched: "ออกรถแล้ว", completed: "ส่งครบ", cancelled: "ยกเลิก" }[s] ?? s
  );
}

async function loadRemote(token: string): Promise<TransportData> {
  const [readinessRow, geoRows, vehRows, tripRows, queueRows] =
    await Promise.all([
      apiRequest<Row>("/v1/transport/readiness", token),
      apiRequest<Row[]>("/v1/transport/geo", token),
      apiRequest<Row[]>("/v1/transport/vehicles", token),
      apiRequest<Row[]>("/v1/transport/trips?limit=200", token),
      apiRequest<Row[]>("/v1/transport/dispatch-queue", token),
    ]);
  const geo: Record<string, TGeo> = {};
  geoRows.forEach((g) => {
    geo[str(g.district_ref)] = {
      ref: str(g.district_ref),
      name: str(g.name_th),
      lat: coordinateNum(g.latitude),
      lon: coordinateNum(g.longitude),
      districtId: g.district_id ? str(g.district_id) : null,
      isWarehouse: g.is_warehouse === true,
      warehouseCode: g.warehouse_code ? str(g.warehouse_code) : null,
      verificationStatus: geoStatus(g.geocode_status),
      routeEligible: g.route_eligible === true,
      sourceReference: g.source_reference ? str(g.source_reference) : null,
    };
  });
  const vehicles: TVehicle[] = vehRows.map((v) => {
    const availability = vehicleAvailability(v);
    return {
      id: str(v.vehicle_id),
      code: str(v.asset_code),
      plate: str(v.plate),
      currentWarehouse: str(v.current_warehouse),
      driver: str(v.driver_name),
      maxWt: num(v.max_weight_kg),
      fuelRate: num(v.fuel_rate_km_per_l),
      active: v.is_active !== false,
      availability: availability.status,
      availabilityEvidence: availability.evidence,
    };
  });
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
    fuel: num(t.fuel_cost_estimate_thb),
    fuelActual: t.fuel_cost_actual_thb == null ? null : num(t.fuel_cost_actual_thb),
    date: str(t.trip_date),
    status: str(t.status),
    notes: str(t.notes),
    // The current trip-summary contract has no persisted authenticated
    // real-road evidence fields. Treat every returned row as legacy evidence.
    evidenceStatus: "legacy_illustrative_unverified",
  }));
  const queue: QueueRow[] = queueRows.map((q) => ({
    districtRef: str(q.district_ref),
    districtId: str(q.district_id),
    districtName: str(q.district_name_th),
    totalQty: q.total_qty == null ? null : num(q.total_qty),
    lineCount: num(q.line_count),
    originLocationId: q.origin_location_id
      ? str(q.origin_location_id)
      : null,
    originWarehouseId: q.origin_warehouse_id
      ? str(q.origin_warehouse_id)
      : null,
    originWarehouse: str(q.suggested_warehouse),
    originWarehouseGeocodeStatus:
      q.suggested_warehouse_geocode_status === "verified" ||
      q.suggested_warehouse_geocode_status === "quarantined"
        ? q.suggested_warehouse_geocode_status
        : q.suggested_warehouse_geocode_status === "candidate" ||
            q.suggested_warehouse_geocode_status === "unverified"
          ? "candidate"
        : "missing",
    routeEligible: q.route_eligible === true,
    planId: q.replenishment_plan_id ? str(q.replenishment_plan_id) : null,
    planNumber: str(q.plan_number),
    estimatedWeightKg:
      q.estimated_weight_kg == null ? null : num(q.estimated_weight_kg),
    weightComplete: q.weight_complete === true,
  }));
  const warehouses = Object.values(geo)
    .filter(
      (point) =>
        point.isWarehouse &&
        point.verificationStatus === "verified" &&
        point.routeEligible,
    )
    .map((point) => point.warehouseCode || point.ref);
  return {
    geo,
    vehicles,
    trips,
    warehouses,
    queue,
    readiness: parseReadiness(readinessRow),
  };
}

function useTransportData(token: string | null, role: Role, demoMode = false) {
  const [data, setData] = useState<TransportData>(emptyData);
  const [source, setSource] = useState<DataSource>(demoMode ? "demo" : "error");
  const [loading, setLoading] = useState(Boolean(token) && !demoMode);
  const [loadError, setLoadError] = useState("");

  const reload = useCallback(async () => {
    if (demoMode) {
      setData(demoTransportData());
      setSource("demo");
      setLoadError("");
      setLoading(false);
      return;
    }
    if (!token) {
      setData(emptyData());
      setSource("error");
      setLoadError("กรุณาเข้าสู่ระบบเพื่อดูข้อมูลขนส่ง");
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      const remote = await loadRemote(token);
      setData(remote);
      setSource("supabase");
    } catch (loadFailure) {
      setData(emptyData());
      setSource("error");
      setLoadError(
        loadFailure instanceof Error
          ? loadFailure.message
          : "โหลดข้อมูลขนส่งไม่สำเร็จ",
      );
    } finally {
      setLoading(false);
    }
  }, [demoMode, token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const optimizeRoad = useCallback(
    async (
      depot: TGeo,
      stops: TGeo[],
      planId: string,
      avoidTolls: boolean,
    ): Promise<RoadOptimizationResult> => {
      if (source === "demo") {
        const warehouse: Warehouse = "คลองเตย";
        const local = planRoute(
          warehouse,
          stops.map((stop) => stop.ref),
        );
        const orderedStops = local.order
          .map((ref) => stops.find((stop) => stop.ref === ref))
          .filter((stop): stop is TGeo => Boolean(stop));
        return {
          provider: "osrm",
          engineMode: "development-demo",
          profile: "truck-constraints-preview",
          algorithm: "road-matrix-nearest-neighbour-2opt",
          objective: "duration",
          order: local.order,
          distanceKm: local.totalDist,
          durationMinutes: local.totalTime,
          baselineCost: local.totalTime,
          optimizedCost: local.totalTime,
          improvementPercent: 0,
          geometry: {
            type: "LineString",
            coordinates: [
              [depot.lon, depot.lat],
              ...orderedStops.map(
                (stop) => [stop.lon, stop.lat] as [number, number],
              ),
              [depot.lon, depot.lat],
            ],
          },
          dataVersion: null,
          dataVersionSource: "unavailable-development",
          generatedAt: "2026-08-18T00:00:00.000Z",
        };
      }
      if (
        source !== "supabase" ||
        !token ||
        !canMutateTransport(role)
      ) {
        throw new Error(
          "ผู้ดูแลระบบและผู้วางแผนที่เข้าสู่ระบบแล้วเท่านั้นที่คำนวณเส้นทางได้",
        );
      }
      return apiRequest<RoadOptimizationResult>(
        "/v1/transport/optimize",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            // Coordinates are intentionally omitted: the authorization gate
            // replaces these IDs with verified canonical geodata.
            depot: { id: depot.warehouseCode || depot.ref },
            stops: stops.map((stop) => ({ id: stop.ref })),
            replenishment_plan_id: planId,
            objective: "duration",
            avoidTolls,
          }),
        },
      );
    },
    [role, source, token],
  );

  const cancelLegacyTrip = useCallback(
    async (tripId: string) => {
      if (
        source !== "supabase" ||
        !token ||
        !canMutateTransport(role)
      ) {
        throw new Error(
          "ผู้ดูแลระบบและผู้วางแผนที่เข้าสู่ระบบแล้วเท่านั้นที่ยกเลิกเที่ยวรถได้",
        );
      }
      await apiRequest<Row>(
        `/v1/transport/trips/${encodeURIComponent(tripId)}/status`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ status: "cancelled" }),
        },
      );
      await reload();
    },
    [reload, role, source, token],
  );

  const queueOptimizationJob = useCallback(
    async (planId: string, idempotencyKey: string) => {
      if (
        source !== "supabase" ||
        !token ||
        !canMutateTransport(role)
      ) {
        throw new Error(
          "ผู้ดูแลระบบและผู้วางแผนที่เข้าสู่ระบบแล้วเท่านั้นที่ส่งแผนไปคำนวณได้",
        );
      }
      return apiRequest<RouteOptimizationJob>(
        "/v1/transport/optimization-jobs",
        token,
        {
          method: "POST",
          headers: { "X-Request-ID": idempotencyKey },
          body: JSON.stringify({
            replenishment_plan_id: planId,
            matrix_source: "valhalla",
          }),
        },
      );
    },
    [role, source, token],
  );

  const readOptimizationJob = useCallback(
    async (routeJobId: string) => {
      if (
        source !== "supabase" ||
        !token ||
        !canMutateTransport(role)
      ) {
        throw new Error(
          "ผู้ดูแลระบบและผู้วางแผนที่เข้าสู่ระบบแล้วเท่านั้นที่ดูสถานะงานคำนวณได้",
        );
      }
      return apiRequest<RouteOptimizationJob>(
        `/v1/transport/optimization-jobs/${encodeURIComponent(routeJobId)}`,
        token,
      );
    },
    [role, source, token],
  );

  return {
    data,
    source,
    loading,
    loadError,
    reload,
    optimizeRoad,
    cancelLegacyTrip,
    queueOptimizationJob,
    readOptimizationJob,
  };
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

type QueueGroup = {
  key: string;
  planId: string | null;
  planNumber: string;
  warehouse: string;
  rows: QueueRow[];
  routeEligible: boolean;
  blocker: string | null;
};

type FleetChunk = {
  vehicle: TVehicle;
  stops: string[];
  weightKg: number;
};

function queueGroups(rows: QueueRow[]): QueueGroup[] {
  const groups = new Map<string, QueueGroup>();
  for (const row of rows) {
    const key = `${row.planId ?? "missing-plan"}::${row.originWarehouse || "missing-origin"}`;
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, {
        key,
        planId: row.planId,
        planNumber: row.planNumber || "ไม่พบเลขแผน",
        warehouse: row.originWarehouse,
        rows: [row],
        routeEligible: false,
        blocker: null,
      });
    }
  }
  return [...groups.values()]
    .map((group) => {
      const blocked = group.rows.find(
        (row) =>
          !row.planId ||
          !row.originLocationId ||
          !row.originWarehouseId ||
          !row.originWarehouse ||
          row.originWarehouseGeocodeStatus !== "verified" ||
          !row.routeEligible,
      );
      let blocker: string | null = null;
      if (blocked) {
        blocker = !blocked.planId
          ? "ไม่มี replenishment_plan_id"
          : !blocked.originLocationId
            ? "ไม่มี origin_location_id"
            : !blocked.originWarehouseId
              ? "ไม่มี origin_warehouse_id"
              : !blocked.originWarehouse
                ? "ยังไม่ได้เชื่อมรหัสคลังกับระบบขนส่ง"
                : blocked.originWarehouseGeocodeStatus !== "verified"
                  ? `พิกัดคลังเป็น ${blocked.originWarehouseGeocodeStatus}`
                  : `จุด ${blocked.districtRef} ยังจัดเส้นทางไม่ได้ (route_eligible=false)`;
      }
      return {
        ...group,
        routeEligible: blocker === null,
        blocker,
      };
    })
    .sort((a, b) =>
      `${a.planNumber}-${a.warehouse}`.localeCompare(
        `${b.planNumber}-${b.warehouse}`,
        "th",
      ),
    );
}

function depotForWarehouse(
  data: TransportData,
  warehouse: string,
  allowLegacyFallback = false,
) {
  const exact =
    Object.values(data.geo).find(
      (point) =>
        point.isWarehouse &&
        (point.warehouseCode === warehouse || point.ref === warehouse),
    ) ?? null;
  if (exact || !allowLegacyFallback) return exact;
  return Object.values(data.geo).find((point) => point.isWarehouse) ?? null;
}

function mapPoints(
  data: TransportData,
  warehouse: string,
  selected: string[],
  route: string[],
  allowLegacyFallback = false,
): TransportRoadMapProps["points"] {
  const depot = depotForWarehouse(data, warehouse, allowLegacyFallback);
  const sequence = new Map(route.map((id, index) => [id, index + 1]));
  return Object.values(data.geo)
    .filter((point) => !point.isWarehouse || point.ref === depot?.ref)
    .map((point) => ({
      id: point.ref,
      name: point.name,
      lat: point.lat,
      lon: point.lon,
      isDepot: point.ref === depot?.ref,
      selected: selected.includes(point.ref),
      sequence: sequence.get(point.ref),
      verificationStatus: point.verificationStatus,
      routeEligible: point.routeEligible,
    }));
}

function sameStopSet(expected: string[], actual: string[]) {
  return (
    expected.length === actual.length &&
    new Set(expected).size === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((id) => actual.includes(id))
  );
}

function allocateFleet(
  order: string[],
  rows: QueueRow[],
  vehicles: TVehicle[],
  preferredVehicleId: string,
  maxStops: number,
): { chunks: FleetChunk[]; totalWeightKg: number; error: string | null } {
  if (!order.length) return { chunks: [], totalWeightKg: 0, error: null };
  const rowByStop = new Map(rows.map((row) => [row.districtRef, row]));
  const incomplete = order.find((id) => {
    const row = rowByStop.get(id);
    return (
      !row ||
      !row.weightComplete ||
      row.estimatedWeightKg == null ||
      !Number.isFinite(row.estimatedWeightKg) ||
      row.estimatedWeightKg < 0
    );
  });
  if (incomplete) {
    return {
      chunks: [],
      totalWeightKg: 0,
      error: `ยังยืนยันน้ำหนักของ ${incomplete} ไม่ครบ จึงยังจัดรถหรือบันทึกไม่ได้`,
    };
  }
  const weights = new Map(
    order.map((id) => [id, rowByStop.get(id)?.estimatedWeightKg ?? 0]),
  );
  const usable = vehicles
    .filter(
      (vehicle) =>
        vehicle.active &&
        Number.isFinite(vehicle.maxWt) &&
        vehicle.maxWt > 0,
    )
    .sort((a, b) => {
      if (a.id === preferredVehicleId) return -1;
      if (b.id === preferredVehicleId) return 1;
      return b.maxWt - a.maxWt;
    });
  if (!usable.length) {
    return {
      chunks: [],
      totalWeightKg: 0,
      error:
        "ยังไม่มีข้อมูลยืนยันว่ารถของคลังนี้พร้อมออกงาน การมีสถานะใช้งานในทะเบียน (is_active) ยังไม่ยืนยันความพร้อมของรถ",
    };
  }

  const chunks: FleetChunk[] = [];
  let cursor = 0;
  const remaining = [...usable];
  while (cursor < order.length) {
    const firstWeight = weights.get(order[cursor]) ?? 0;
    const vehicleIndex = remaining.findIndex(
      (vehicle) => vehicle.maxWt >= firstWeight,
    );
    if (vehicleIndex < 0) {
      return {
        chunks: [],
        totalWeightKg: 0,
        error: `น้ำหนักของ ${order[cursor]} เกินความจุรถที่เหลือทั้งหมด`,
      };
    }
    const [vehicle] = remaining.splice(vehicleIndex, 1);
    const stops: string[] = [];
    let weightKg = 0;
    while (cursor < order.length && stops.length < maxStops) {
      const nextWeight = weights.get(order[cursor]) ?? 0;
      if (stops.length > 0 && weightKg + nextWeight > vehicle.maxWt) break;
      if (nextWeight > vehicle.maxWt) break;
      stops.push(order[cursor]);
      weightKg += nextWeight;
      cursor += 1;
    }
    chunks.push({ vehicle, stops, weightKg });
    if (cursor < order.length && remaining.length === 0) {
      return {
        chunks: [],
        totalWeightKg: 0,
        error:
          "จำนวนรถไม่พอสำหรับแยกเที่ยวตามน้ำหนักและจำนวนจุด กรุณาลดจุดส่งหรือเพิ่มรถ",
      };
    }
  }
  return {
    chunks,
    totalWeightKg: [...weights.values()].reduce(
      (sum, weight) => sum + weight,
      0,
    ),
    error: null,
  };
}

function SourceTag({
  source,
  loading,
  error,
  onRetry,
}: {
  source: DataSource;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const isError = source === "error" && !loading;
  return (
    <aside
      className={`runtime-message transport-source ${loading ? "loading" : source}`}
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      <i>{source === "supabase" ? "✓" : source === "demo" ? "D" : "×"}</i>
      <div>
        <strong>
          {loading
            ? "กำลังโหลดข้อมูลขนส่ง…"
            : source === "supabase"
              ? "โหลดข้อมูลขนส่งแล้ว"
              : source === "demo"
                ? "พร้อมทดลองวางแผนด้วยข้อมูลตัวอย่าง"
              : "โหลดข้อมูลขนส่งไม่สำเร็จ จึงยังวางแผนไม่ได้"}
        </strong>
        <p>
          {source === "supabase"
            ? "ใช้ข้อมูลแผน รถ และพิกัดจากระบบขนส่ง หากโหลดไม่ได้ ระบบจะหยุดการวางแผน"
            : source === "demo"
              ? "ทดลองด้วยแผนจำลอง รถ พด.707/708 และข้อมูล 18 เขต ข้อมูลนี้ใช้ทดสอบเท่านั้น ไม่บันทึกลงฐานข้อมูลจริงหรือสร้างเที่ยวรถ"
            : error || "ยังตรวจสถานะข้อมูลขนส่งไม่ได้"}
        </p>
      </div>
      {isError && (
        <button type="button" className="btn ghost" onClick={onRetry}>
          ลองโหลดอีกครั้ง
        </button>
      )}
    </aside>
  );
}

function readinessText(status: string) {
  return (
    {
      ready: "ผ่านการตรวจ",
      blocked_no_verified_district_geocodes:
        "ยังไม่มีพิกัดเขตที่ยืนยันแล้ว",
      blocked_no_verified_depot_geocode: "ยังไม่มีพิกัดคลังที่ยืนยันแล้ว",
      blocked_verified_depot_missing_canonical_origin:
        "พิกัดคลังยืนยันแล้ว แต่ยังไม่เชื่อมกับรหัสคลังต้นทางหลัก",
      blocked_status_contract_mismatch:
        "บริการคำนวณส่งสถานะไม่ตรงกับรูปแบบที่ระบบรองรับ",
      blocked_road_route_evidence_contract_missing:
        "ระบบยังไม่รองรับการบันทึกหลักฐานเส้นทางถนน",
      blocked_operational_writes_locked:
        "ยังไม่เปิดให้คำนวณหรือเปลี่ยนสถานะงาน",
      blocked_route_master_data_not_ready:
        "ข้อมูลหลักสำหรับจัดเส้นทางยังไม่ครบ",
      blocked_no_exact_locked_plan_with_verified_depot_and_fleet:
        "ยังไม่มีแผนที่ล็อกแล้วและผ่านการตรวจพิกัด คลัง บรรจุภัณฑ์ และรถครบทั้งแผน",
      blocked_no_recent_optimization_worker_heartbeat:
        "ยังไม่ได้รับสัญญาณการทำงานล่าสุดจากบริการ OR-Tools + Valhalla",
      ready_valhalla_exact_locked_plan_queue:
        "พร้อมส่งแผนที่ล็อกแล้วทั้งชุดให้ Valhalla + OR-Tools คำนวณ",
      blocked_route_plan_to_trip_activation_not_configured:
        "สร้างแผนเส้นทางพร้อมหลักฐานได้แล้ว ยังไม่เปิดให้สร้างเที่ยวรถจากแผน",
      unknown_route_readiness: "ระบบยังไม่ส่งสถานะความพร้อมของเส้นทาง",
      unknown_worker_readiness: "ระบบยังไม่ส่งสถานะบริการคำนวณ",
      unknown_persistence_readiness:
        "ระบบยังไม่ส่งสถานะการบันทึกเที่ยวรถ",
    }[status] ?? status
  );
}

function TransportReadinessPanel({
  readiness,
  source,
}: {
  readiness: TransportReadiness | null;
  source: DataSource;
}) {
  if (source !== "supabase" || !readiness) {
    return (
      <section
        className="panel transport-readiness-panel blocked"
        aria-labelledby="transport-readiness-title"
      >
        <div className="panel-title">
          <div>
            <span>ความพร้อมใช้งาน</span>
            <h3 id="transport-readiness-title">ยังไม่ยืนยันความพร้อม</h3>
          </div>
          <span className="transport-data-state unverified">ยังไม่พร้อม</span>
        </div>
        <p>
          ไม่มีผลจาก <code>/v1/transport/readiness</code> จึงยังไม่เปิดให้คำนวณเส้นทาง ใช้คลังต้นทาง หรือบันทึกเที่ยวรถ
        </p>
      </section>
    );
  }

  const items = [
    {
      key: "operational-writes",
      label: "การคำนวณและเปลี่ยนสถานะงาน",
      state: readiness.operationalWritesEnabled ? "ready" : "blocked",
      detail: readiness.operationalWritesEnabled
        ? "เปิดให้คำนวณและเปลี่ยนสถานะงานแล้ว"
        : "ยังไม่เปิดให้คำนวณเส้นทางหรือเปลี่ยนสถานะงาน",
      status: readiness.operationalWritesEnabled
        ? "operational_writes_enabled"
        : "production_not_ready",
    },
    {
      key: "canonical-route-gate",
      label: "ข้อมูลเส้นทางและคลังต้นทาง",
      state: readiness.routeReady ? "ready" : "blocked",
      detail: readinessText(readiness.routeReadinessStatus),
      status: readiness.routeReadinessStatus,
    },
    {
      key: "road-engine-runtime",
      label: "บริการคำนวณเส้นทางถนน",
      state: "unknown",
      detail:
        "ยังไม่ยืนยันการตั้งค่าบริการ ต้องคำนวณสำเร็จและได้รับแนวเส้นทางถนนก่อน",
      status: "not_attested_by_transport_readiness",
    },
    {
      key: "optimization-worker",
      label: "บริการคำนวณแผนด้วย OR-Tools + Valhalla",
      state: readiness.optimizationWorkerReady ? "ready" : "blocked",
      detail: `${readinessText(
        readiness.optimizationWorkerStatus,
      )} การทดลองเส้นทางแยกจากงานคำนวณแผนทั้งชุด`,
      status: readiness.optimizationWorkerStatus,
    },
    {
      key: "trip-persistence",
      label: "การบันทึกเที่ยวรถและหลักฐานเส้นทาง",
      state: readiness.tripPersistenceReady ? "ready" : "blocked",
      detail: readinessText(readiness.tripPersistenceStatus),
      status: readiness.tripPersistenceStatus,
    },
  ] as const;

  return (
    <section
      className="panel transport-readiness-panel"
      aria-labelledby="transport-readiness-title"
    >
      <div className="panel-title">
        <div>
          <span>ความพร้อมใช้งาน</span>
          <h3 id="transport-readiness-title">ผลตรวจความพร้อมของระบบขนส่ง</h3>
        </div>
        <span
          className={`transport-data-state ${
            readiness.routeReady ? "verified" : "quarantined"
          }`}
        >
          {readiness.routeReady ? "พร้อมจัดเส้นทาง" : "ยังจัดเส้นทางไม่ได้"}
        </span>
      </div>
      <div className="transport-readiness-grid">
        {items.map((item) => (
          <article
            key={item.key}
            className={item.state}
            data-readiness-key={item.key}
          >
            <div>
              <strong>{item.label}</strong>
              <span>{item.state}</span>
            </div>
            <p>{item.detail}</p>
            <code>{item.status}</code>
          </article>
        ))}
      </div>
      <div className="transport-depot-readiness">
        <strong>ความพร้อมของคลัง</strong>
        {readiness.warehouseRouteReadiness.length ? (
          readiness.warehouseRouteReadiness.map((depot) => (
            <span
              key={depot.warehouseCode}
              className={`transport-data-state ${
                depot.routeEligible ? "verified" : "quarantined"
              }`}
              title={`geocode=${depot.geocodeStatus}; canonical_origin=${depot.canonicalOriginReady}`}
            >
              {depot.warehouseCode}:{" "}
              {depot.routeEligible
                ? "พร้อม"
                : depot.geocodeStatus !== "verified"
                  ? `พิกัด ${depot.geocodeStatus}`
                  : "ยังไม่เชื่อมกับคลังต้นทางหลัก"}
            </span>
          ))
        ) : (
          <span className="transport-data-state unverified">
            ยังไม่มีผลตรวจความพร้อมของคลัง
          </span>
        )}
      </div>
    </section>
  );
}

function tripHasStatus(trip: TTrip, raw: string, translated: string) {
  return trip.status === raw || trip.status.includes(translated);
}

function TransportDashboard({ data }: { data: TransportData }) {
  const [selectedId, setSelectedId] = useState("");
  const selected = data.vehicles.find((vehicle) => vehicle.id === selectedId) ?? data.vehicles[0] ?? null;
  const planned = data.trips.filter((trip) => tripHasStatus(trip, "planned", "วางแผน"));
  const done = data.trips.filter((trip) => tripHasStatus(trip, "completed", "ส่งครบ"));
  const availabilityKnown = data.vehicles.some((vehicle) => vehicle.availability !== "unknown");
  const available = data.vehicles.filter((vehicle) => vehicle.availability === "available").length;
  const points = Object.values(data.geo).filter((point) => point.verificationStatus === "verified" && hasValidCoordinates(point)).map((point) => ({
    id: point.ref, name: point.name, lat: point.lat, lon: point.lon,
    isDepot: point.isWarehouse, verificationStatus: point.verificationStatus,
    routeEligible: point.routeEligible,
  }));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["รถที่เปิดใช้งานในทะเบียน", data.vehicles.filter((vehicle) => vehicle.active).length, availabilityKnown ? `ยืนยันว่าพร้อม ${available}` : "ยังไม่ทราบ availability"],
          ["เที่ยวรอออก", planned.length, "สถานะวางแผน"],
          ["เขตรอจัดส่ง", data.queue.length, "จาก dispatch queue"],
          ["ส่งครบสะสม", done.length, "จากประวัติเที่ยวรถ"],
        ].map(([label, count, note]) => (
          <section key={label} className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{formatNumber(count)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{note}</p>
          </section>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm xl:col-span-2">
          <h2 className="text-base font-semibold">แผนที่จุดบริการ</h2>
          <p className="mt-1 text-xs text-muted-foreground">พิกัดคลังและเขตจากระบบ · ไม่มีข้อมูลตำแหน่งรถสด</p>
          <div className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
            <TransportRoadMap points={points} />
          </div>
        </section>
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          {selected ? <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><h2 className="text-base font-semibold">{selected.code}</h2><p className="mt-1 text-xs text-muted-foreground">{selected.plate}</p></div>
              <span className={`transport-data-state ${selected.availability === "available" ? "verified" : selected.availability === "unavailable" ? "quarantined" : "unverified"}`}>
                {selected.availability === "available" ? "ยืนยันว่าพร้อม" : selected.availability === "unavailable" ? "ไม่พร้อม" : "ยังไม่ทราบ"}
              </span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              {[
                ["คนขับ", selected.driver],
                ["คลังประจำ", selected.currentWarehouse],
                ["น้ำหนักบรรทุก", `${formatNumber(selected.maxWt)} กก.`],
                ["อัตราน้ำมัน", `${selected.fuelRate} กม./ล.`],
              ].map(([label, value]) => <div key={label} className="rounded-lg border border-border bg-background p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm font-medium">{value}</p></div>)}
            </div>
            {selected.availabilityEvidence && <p className="mt-4 rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">{selected.availabilityEvidence}</p>}
          </> : <p className="text-sm text-muted-foreground">ยังไม่มีรถในทะเบียน</p>}
        </section>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="p-5"><h2 className="text-base font-semibold">ทะเบียนรถ</h2><p className="mt-1 text-xs text-muted-foreground">เลือกคันรถเพื่อดูรายละเอียดและหลักฐาน</p></div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-border bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-5 py-3">รถ</th><th className="px-3 py-3">คนขับ</th><th className="px-3 py-3">สถานะ</th><th className="px-5 py-3 text-right">บรรทุกสูงสุด</th></tr></thead>
              <tbody>{data.vehicles.map((vehicle) => <tr key={vehicle.id} onClick={() => setSelectedId(vehicle.id)} data-selected={selected?.id === vehicle.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40 data-[selected=true]:bg-accent/30"><td className="px-5 py-3"><strong className="block font-medium">{vehicle.code}</strong><span className="text-xs text-muted-foreground">{vehicle.plate}</span></td><td className="px-3 py-3">{vehicle.driver}</td><td className="px-3 py-3"><span className={`transport-data-state ${vehicle.availability === "available" ? "verified" : vehicle.availability === "unavailable" ? "quarantined" : "unverified"}`}>{vehicle.availability === "available" ? "พร้อม" : vehicle.availability === "unavailable" ? "ไม่พร้อม" : "ไม่ทราบ"}</span></td><td className="px-5 py-3 text-right tabular-nums">{formatNumber(vehicle.maxWt)} กก.</td></tr>)}</tbody>
            </table>
            {!data.vehicles.length && <p className="p-6 text-center text-sm text-muted-foreground">ยังไม่มีข้อมูลรถ</p>}
          </div>
        </section>
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="text-base font-semibold">เที่ยวรถในระบบ</h2>
          <p className="mt-1 text-xs text-muted-foreground">สถานะจากประวัติเที่ยวรถจริง</p>
          <div className="mt-4 space-y-3">{data.trips.slice(0, 6).map((trip) => <div key={trip.id} className="rounded-lg border border-border bg-background p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{trip.code}</strong><span className="text-xs font-medium text-primary">{trip.status}</span></div><p className="mt-1 text-xs text-muted-foreground">{trip.vehicle} · {trip.warehouse} · {trip.route.length} จุดส่ง</p><p className="mt-2 text-xs text-muted-foreground">{trip.dist > 0 ? `${formatNumber(trip.dist, 1)} กม.` : "ยังไม่มีระยะทางที่ยืนยัน"}</p></div>)}{!data.trips.length && <p className="text-sm text-muted-foreground">ยังไม่มีเที่ยวรถที่บันทึกในระบบ</p>}</div>
        </section>
      </div>
    </div>
  );
}

type CanonicalRoadResult = RoadOptimizationResult & {
  replenishmentPlanId?: string;
  coordinateProvenance?: {
    depot?: {
      id?: string;
      verifiedAt?: string | null;
      sourceReference?: string | null;
      sourceChecksumSha256?: string | null;
      sourceRowNumber?: number | null;
    };
    stops?: Array<{
      id?: string;
      verifiedAt?: string | null;
      sourceReference?: string | null;
      sourceChecksumSha256?: string | null;
      sourceRowNumber?: number | null;
    }>;
  };
  monetaryTollEstimateAvailable?: false;
  monetaryTollEstimateStatus?: string;
};

type OptimizeRoad = (
  depot: TGeo,
  stops: TGeo[],
  planId: string,
  avoidTolls: boolean,
) => Promise<RoadOptimizationResult>;

function hasCanonicalProvenance(
  result: CanonicalRoadResult,
  planId: string,
  stops: string[],
) {
  const provenanceIds =
    result.coordinateProvenance?.stops
      ?.map((point) => point.id)
      .filter((id): id is string => Boolean(id)) ?? [];
  const provenancePoints = [
    result.coordinateProvenance?.depot,
    ...(result.coordinateProvenance?.stops ?? []),
  ];
  return (
    result.engineMode === "configured" &&
    Boolean(result.dataVersion) &&
    result.replenishmentPlanId === planId &&
    Boolean(result.coordinateProvenance?.depot?.id) &&
    provenancePoints.every(
      (point) =>
        Boolean(point?.verifiedAt) &&
        Boolean(point?.sourceReference) &&
        /^[0-9a-f]{64}$/.test(point?.sourceChecksumSha256 ?? "") &&
        Number.isInteger(point?.sourceRowNumber) &&
        Number(point?.sourceRowNumber) > 0,
    ) &&
    sameStopSet(stops, provenanceIds)
  );
}

function RoadEvidence({ result }: { result: CanonicalRoadResult }) {
  const costUnit = result.objective === "duration" ? "วินาที" : "เมตร";
  const stopSources = [
    ...new Set(
      result.coordinateProvenance?.stops
        ?.map((point) => point.sourceReference)
        .filter((source): source is string => Boolean(source)) ?? [],
    ),
  ];
  return (
    <dl className="transport-road-evidence" aria-label="หลักฐานผลคำนวณเส้นทาง">
      <div>
        <dt>เกณฑ์คำนวณ</dt>
        <dd>
          {result.objective === "duration" ? "เวลา" : "ระยะทาง"} · cost เป็น{" "}
          {costUnit}
        </dd>
      </div>
      <div>
        <dt>ลำดับเดิมเทียบกับลำดับที่ดีที่สุดที่พบ</dt>
        <dd>
          {formatNumber(result.baselineCost, 1)} →{" "}
          {formatNumber(result.optimizedCost, 1)} {costUnit}
        </dd>
      </div>
      <div>
        <dt>เวลาคำนวณ / เวอร์ชันข้อมูล</dt>
        <dd>
          {formatDateTime(result.generatedAt)} ·{" "}
          {result.dataVersion || "บริการไม่ได้ส่งเวอร์ชันข้อมูล"} ·{" "}
          {result.dataVersionSource}
        </dd>
      </div>
      <div>
        <dt>ที่มาของพิกัด</dt>
        <dd>
          คลัง:{" "}
          {result.coordinateProvenance?.depot?.sourceReference ||
            "ไม่พบแหล่งอ้างอิง"}
          {" · "}
          จุดส่ง:{" "}
          {stopSources.length
            ? stopSources.join(", ")
            : "ไม่พบแหล่งอ้างอิง"}
        </dd>
      </div>
      <div>
        <dt>บริการ / วิธีคำนวณ</dt>
        <dd>
          {result.provider}/{result.profile} · {result.engineMode} ·{" "}
          {result.algorithm}
        </dd>
      </div>
    </dl>
  );
}

function TransportPlanner({
  data,
  source,
  actorId,
  onOptimize,
  onQueueJob,
  onReadJob,
}: {
  data: TransportData;
  source: DataSource;
  actorId: string;
  onOptimize: OptimizeRoad;
  onQueueJob: (
    planId: string,
    idempotencyKey: string,
  ) => Promise<RouteOptimizationJob>;
  onReadJob: (routeJobId: string) => Promise<RouteOptimizationJob>;
}) {
  const groups = useMemo(() => queueGroups(data.queue), [data.queue]);
  const eligibleGroups = useMemo(
    () => groups.filter((group) => group.routeEligible),
    [groups],
  );
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const activeGroup =
    eligibleGroups.find((group) => group.key === selectedGroupKey) ??
    eligibleGroups[0] ??
    null;
  const [selected, setSelected] = useState<string[]>([]);
  const [preferredVehicleId, setPreferredVehicleId] = useState("");
  const [maxStops, setMaxStops] = useState(6);
  const [avoidTolls, setAvoidTolls] = useState(false);
  const [msg, setMsg] = useState("");
  const [roadState, setRoadState] = useState<{
    signature: string;
    result: CanonicalRoadResult | null;
    error: string;
    loading: boolean;
  }>({ signature: "", result: null, error: "", loading: false });
  const [jobState, setJobState] = useState<{
    groupKey: string;
    planId: string;
    requestId: string;
    attemptStatus: OptimizationAttemptStatus | null;
    job: RouteOptimizationJob | null;
    loading: boolean;
    error: string;
  }>({
    groupKey: "",
    planId: "",
    requestId: "",
    attemptStatus: null,
    job: null,
    loading: false,
    error: "",
  });

  const warehouse = activeGroup?.warehouse ?? "";
  const planId = activeGroup?.planId ?? null;
  const groupRows = useMemo(() => activeGroup?.rows ?? [], [activeGroup]);
  const servable = useMemo(
    () => groupRows.map((row) => row.districtRef),
    [groupRows],
  );
  const availableVehicles = useMemo(
    () =>
      data.vehicles.filter(
        (vehicle) =>
          vehicle.active &&
          vehicle.availability === "available" &&
          vehicle.currentWarehouse === warehouse,
      ),
    [data.vehicles, warehouse],
  );
  const preferredVehicle =
    availableVehicles.find((vehicle) => vehicle.id === preferredVehicleId) ??
    availableVehicles[0] ??
    null;
  const selectionSignature = JSON.stringify({
    group: activeGroup?.key ?? "",
    warehouse,
    stops: [...selected].sort(),
    avoidTolls,
  });
  const roadCurrent =
    roadState.signature === selectionSignature ? roadState.result : null;
  const demoRoute =
    source === "demo" && roadCurrent
      ? planRoute("คลองเตย", roadCurrent.order)
      : null;
  const previewOrder = roadCurrent?.order ?? selected;
  const depot = depotForWarehouse(data, warehouse);
  const fleet = useMemo(
    () =>
      allocateFleet(
        roadCurrent?.order ?? [],
        groupRows,
        availableVehicles,
        preferredVehicle?.id ?? "",
        maxStops,
      ),
    [
      availableVehicles,
      groupRows,
      maxStops,
      preferredVehicle?.id,
      roadCurrent?.order,
    ],
  );
  const geoCounts = useMemo(
    () =>
      Object.values(data.geo).reduce(
        (counts, point) => {
          counts[point.verificationStatus] += 1;
          if (point.routeEligible && hasValidCoordinates(point)) {
            counts.routeEligible += 1;
          }
          return counts;
        },
        { verified: 0, candidate: 0, quarantined: 0, routeEligible: 0 },
      ),
    [data.geo],
  );
  const points = useMemo(
    () => mapPoints(data, warehouse, selected, previewOrder),
    [data, previewOrder, selected, warehouse],
  );
  const roadIsCanonical =
    Boolean(roadCurrent && planId) &&
    hasCanonicalProvenance(
      roadCurrent as CanonicalRoadResult,
      planId as string,
      selected,
    );
  const planEligibilityAttested =
    data.readiness?.optimizationEligiblePlanIdsAttested === true;
  const planQueueEligible = Boolean(
    planId &&
      planEligibilityAttested &&
      data.readiness?.optimizationEligiblePlanIds.includes(planId),
  );
  const planQueueBlocker = !planId
    ? "ยังไม่ได้เลือกแผนที่ล็อกแล้ว"
    : !planEligibilityAttested
      ? "ยังตรวจไม่ได้ว่าแผนใดพร้อมคำนวณ ระบบจึงยังไม่รับงาน"
      : !planQueueEligible
        ? `แผน ${activeGroup?.planNumber ?? planId} ไม่อยู่ในรายการแผนที่พร้อมคำนวณ จึงยังส่งงานไม่ได้`
        : "";
  const queueGatesReady =
    source === "supabase" &&
    data.readiness?.operationalWritesEnabled === true &&
    data.readiness?.routeReady === true &&
    data.readiness?.optimizationWorkerReady === true &&
    planQueueEligible;
  const attemptActive =
    jobState.attemptStatus === "queued" ||
    jobState.attemptStatus === "running" ||
    (jobState.attemptStatus === "submitting" &&
      (jobState.loading || !jobState.error));
  const attemptSucceeded = jobState.attemptStatus === "succeeded";
  const attemptCanRestart =
    jobState.attemptStatus === "failed" ||
    jobState.attemptStatus === "cancelled";
  const chooseGroup = (key: string) => {
    if (jobState.loading) return;
    setSelectedGroupKey(key);
    setSelected([]);
    setPreferredVehicleId("");
    setMsg("");
    setJobState({
      groupKey: key,
      planId: "",
      requestId: "",
      attemptStatus: null,
      job: null,
      loading: false,
      error: "",
    });
  };
  const toggle = (id: string) => {
    if (!servable.includes(id)) {
      setMsg("จุดส่งนี้อยู่นอกแผนและคลังที่เลือก");
      return;
    }
    const point = data.geo[id];
    if (
      !point ||
      point.verificationStatus !== "verified" ||
      !point.routeEligible ||
      !hasValidCoordinates(point)
    ) {
      setMsg(
        point?.verificationStatus === "verified" &&
          !hasValidCoordinates(point)
          ? `พิกัด ${id} ยืนยันแล้ว แต่ข้อมูลละติจูดหรือลองจิจูดไม่ครบ`
          : point?.verificationStatus === "verified"
          ? `พิกัด ${id} ยืนยันแล้ว แต่ยังไม่เชื่อมกับรหัสสถานที่หลัก จึงจัดเส้นทางไม่ได้`
          : `พิกัด ${id} ยังไม่ผ่านการยืนยัน จึงยังคำนวณเส้นทางไม่ได้`,
      );
      return;
    }
    setMsg("");
    setSelected((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : [...current, id],
    );
  };

  const optimize = async () => {
    if (source !== "supabase" && source !== "demo") {
      setRoadState({
        signature: selectionSignature,
        result: null,
        error:
          "ข้อมูลขนส่งยังไม่พร้อม จึงยังคำนวณเส้นทางถนนไม่ได้",
        loading: false,
      });
      return;
    }
    if (source !== "demo" && !data.readiness?.operationalWritesEnabled) {
      setRoadState({
        signature: selectionSignature,
        result: null,
        error:
          "ยังไม่เปิดให้คำนวณเส้นทาง (production_not_ready)",
        loading: false,
      });
      return;
    }
    if (source !== "demo" && !data.readiness?.routeReady) {
      setRoadState({
        signature: selectionSignature,
        result: null,
        error: `ข้อมูลเส้นทางหลักยังไม่พร้อม: ${readinessText(
          data.readiness?.routeReadinessStatus ?? "unknown_route_readiness",
        )}`,
        loading: false,
      });
      return;
    }
    if (!planId || !activeGroup) {
      setRoadState({
        signature: selectionSignature,
        result: null,
        error: "กรุณาเลือกแผนการจ่ายที่ล็อกแล้วและมีรหัสแผนถูกต้อง",
        loading: false,
      });
      return;
    }
    if (
      !depot ||
      depot.verificationStatus !== "verified" ||
      !depot.routeEligible ||
      !hasValidCoordinates(depot)
    ) {
      setRoadState({
        signature: selectionSignature,
        result: null,
        error: `คลัง ${warehouse || "ที่เลือก"} อาจยืนยันพิกัดแล้ว แต่ยังไม่เชื่อมกับรหัสคลังและต้นทางหลัก จึงจัดเส้นทางไม่ได้`,
        loading: false,
      });
      return;
    }
    const stopPoints = selected.map((id) => data.geo[id]).filter(Boolean);
    if (
      !selected.length ||
      stopPoints.length !== selected.length ||
      stopPoints.some(
        (point) =>
          point.verificationStatus !== "verified" ||
          !point.routeEligible ||
          !hasValidCoordinates(point),
      )
    ) {
      setRoadState({
        signature: selectionSignature,
        result: null,
        error: "เลือกอย่างน้อย 1 จุด โดยทุกจุดต้องมีพิกัดที่ยืนยันแล้ว",
        loading: false,
      });
      return;
    }
    setMsg("");
    setRoadState({
      signature: selectionSignature,
      result: null,
      error: "",
      loading: true,
    });
    try {
      const result = (await onOptimize(
        depot,
        stopPoints,
        planId,
        avoidTolls,
      )) as CanonicalRoadResult;
      if (
        !sameStopSet(selected, result.order) ||
        result.geometry?.type !== "LineString" ||
        result.geometry.coordinates.length < 2 ||
        !Number.isFinite(result.distanceKm) ||
        !Number.isFinite(result.durationMinutes)
      ) {
        throw new Error("ผลคำนวณไม่ครบ หรือจุดส่งไม่ตรงกับที่เลือก");
      }
      setRoadState({
        signature: selectionSignature,
        result,
        error: "",
        loading: false,
      });
    } catch (error) {
      setRoadState({
        signature: selectionSignature,
        result: null,
        error:
          error instanceof Error
            ? error.message
            : "ไม่สามารถคำนวณเส้นทางบนถนนจริงได้",
        loading: false,
      });
    }
  };

  const queueJob = async () => {
    if (!activeGroup || !planId) {
      setJobState((current) => ({
        ...current,
        error: "กรุณาเลือกแผนการจ่ายที่ล็อกแล้วก่อนส่งไปคำนวณ",
      }));
      return;
    }
    if (
      !queueGatesReady
    ) {
      setJobState((current) => ({
        ...current,
        error: planQueueBlocker
          ? planQueueBlocker
          : "ยังส่งงานไม่ได้ ต้องเปิดสิทธิ์บันทึก ตรวจข้อมูลเส้นทางหลัก และยืนยันความพร้อมของบริการคำนวณให้ครบก่อน",
      }));
      return;
    }
    if (attemptActive || attemptSucceeded) {
      setJobState((current) => ({
        ...current,
        error: attemptSucceeded
          ? "แผนนี้คำนวณสำเร็จแล้ว ผลลัพธ์แก้ไขไม่ได้และจะไม่ส่งงานซ้ำ"
          : "แผนนี้กำลังคำนวณ ระบบจะติดตามงานเดิมต่อ",
      }));
      return;
    }
    if (
      attemptCanRestart &&
      !window.confirm(
        `งานเดิมเป็น ${jobState.attemptStatus} ต้องการเริ่มคำนวณใหม่โดยใช้รหัสคำขอ (X-Request-ID) ใหม่หรือไม่?`,
      )
    ) {
      return;
    }
    const resumeInterruptedSubmission =
      jobState.groupKey === activeGroup.key &&
      jobState.planId === planId &&
      jobState.attemptStatus === "submitting" &&
      Boolean(jobState.requestId);
    const requestId = resumeInterruptedSubmission
      ? jobState.requestId
      : crypto.randomUUID();
    const submittingAttempt: PersistedOptimizationAttempt = {
      version: 1,
      planId,
      groupKey: activeGroup.key,
      requestId,
      routeJobId: null,
      status: "submitting",
      updatedAt: new Date().toISOString(),
    };
    writeOptimizationAttempt(actorId, submittingAttempt);
    setJobState({
      groupKey: activeGroup.key,
      planId,
      requestId,
      attemptStatus: "submitting",
      job: null,
      loading: true,
      error: "",
    });
    try {
      const job = await onQueueJob(planId, requestId);
      const status = assertJobMatchesPlan(job, planId);
      writeOptimizationAttempt(actorId, {
        ...submittingAttempt,
        routeJobId: job.route_job_id,
        status,
        updatedAt: new Date().toISOString(),
      });
      setJobState({
        groupKey: activeGroup.key,
        planId,
        requestId,
        attemptStatus: status,
        job,
        loading: false,
        error: "",
      });
    } catch (error) {
      setJobState({
        groupKey: activeGroup.key,
        planId,
        requestId,
        attemptStatus: "submitting",
        job: null,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "ส่งแผนที่ล็อกแล้วไปคำนวณไม่สำเร็จ",
      });
    }
  };

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      if (!activeGroup?.key || !planId || !uuidPattern.test(actorId)) {
        if (!cancelled) {
          setJobState({
            groupKey: activeGroup?.key ?? "",
            planId: planId ?? "",
            requestId: "",
            attemptStatus: null,
            job: null,
            loading: false,
            error: "",
          });
        }
        return;
      }
      const stored = readOptimizationAttempt(actorId, planId);
      if (!stored) {
        if (!cancelled) {
          setJobState({
            groupKey: activeGroup.key,
            planId,
            requestId: "",
            attemptStatus: null,
            job: null,
            loading: false,
            error: "",
          });
        }
        return;
      }

      const placeholder: RouteOptimizationJob | null = stored.routeJobId
        ? {
            route_job_id: stored.routeJobId,
            job_id: "",
            replenishment_plan_id: planId,
            algorithm_version: "กำลังอัปเดตสถานะงาน",
            matrix_source: "valhalla",
            status: stored.status,
          }
        : null;
      if (!cancelled) {
        setJobState({
          groupKey: activeGroup.key,
          planId,
          requestId: stored.requestId,
          attemptStatus: stored.status,
          job: placeholder,
          loading: true,
          error: "",
        });
      }

      try {
        let job: RouteOptimizationJob;
        if (stored.routeJobId) {
          job = await onReadJob(stored.routeJobId);
        } else if (stored.status === "submitting" && queueGatesReady) {
          // The POST response may have been lost during navigation/reload.
          // Reusing the persisted request ID resumes the actor-scoped
          // idempotent request and cannot create a second logical job.
          job = await onQueueJob(planId, stored.requestId);
        } else {
          if (!cancelled) {
            setJobState((current) => ({
              ...current,
              loading: false,
              error: planQueueBlocker
                ? `บันทึกคำขอเดิมไว้แล้ว แต่ยังทำต่อไม่ได้: ${planQueueBlocker}`
                : "บันทึกคำขอเดิมไว้แล้ว ระบบจะทำต่อเมื่อบริการพร้อม",
            }));
          }
          return;
        }
        const status = assertJobMatchesPlan(
          job,
          planId,
          stored.routeJobId ?? undefined,
        );
        writeOptimizationAttempt(actorId, {
          version: 1,
          planId,
          groupKey: activeGroup.key,
          requestId: stored.requestId,
          routeJobId: job.route_job_id,
          status,
          updatedAt: new Date().toISOString(),
        });
        if (!cancelled) {
          setJobState({
            groupKey: activeGroup.key,
            planId,
            requestId: stored.requestId,
            attemptStatus: status,
            job,
            loading: false,
            error: "",
          });
        }
      } catch (error) {
        if (!cancelled) {
          setJobState((current) => ({
            ...current,
            loading: false,
            error:
              error instanceof Error
                ? `ดำเนินงานเดิมต่อไม่สำเร็จ: ${error.message}`
                : "ดำเนินงานคำนวณเดิมต่อไม่สำเร็จ",
          }));
        }
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [
    activeGroup?.key,
    actorId,
    onQueueJob,
    onReadJob,
    planId,
    planQueueBlocker,
    queueGatesReady,
  ]);

  const routeJobId = jobState.job?.route_job_id ?? "";
  const routeJobStatus = jobState.attemptStatus ?? "";
  useEffect(() => {
    if (
      !routeJobId ||
      ["succeeded", "failed", "cancelled"].includes(routeJobStatus)
    ) {
      return;
    }
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void onReadJob(routeJobId)
        .then((job) => {
          if (!planId || !activeGroup?.key) {
            throw new Error("ไม่พบแผนที่กำลังติดตาม");
          }
          const status = assertJobMatchesPlan(job, planId, routeJobId);
          writeOptimizationAttempt(actorId, {
            version: 1,
            planId,
            groupKey: activeGroup.key,
            requestId: jobState.requestId,
            routeJobId,
            status,
            updatedAt: new Date().toISOString(),
          });
          setJobState((current) =>
            current.job?.route_job_id === routeJobId
              ? { ...current, attemptStatus: status, job, error: "" }
              : current,
          );
        })
        .catch((error) => {
          setJobState((current) =>
            current.job?.route_job_id === routeJobId
              ? {
                  ...current,
                  error:
                    error instanceof Error
                      ? `อ่านสถานะงานไม่สำเร็จ: ${error.message}`
                      : "อ่านสถานะงานคำนวณไม่สำเร็จ",
                }
              : current,
          );
        })
        .finally(() => {
          inFlight = false;
        });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [
    activeGroup?.key,
    actorId,
    jobState.requestId,
    onReadJob,
    planId,
    routeJobId,
    routeJobStatus,
  ]);

  return (
    <div className="stack transport-workspace">
      <section className="transport-control-panel" aria-labelledby="route-scope-title">
        <div>
          <span>ขอบเขตแผนที่ล็อก</span>
          <h2 id="route-scope-title">เลือกแผนและคลังเป็นกลุ่มเดียว</h2>
          <p>ระบบไม่อนุญาตให้รวมเขตจากคนละแผนการจ่าย หรือคนละคลังในเที่ยวเดียว</p>
        </div>
        <label>
          แผนและคลัง
          <select
            value={activeGroup?.key ?? ""}
            onChange={(event) => chooseGroup(event.target.value)}
            disabled={!eligibleGroups.length || jobState.loading}
          >
            {!eligibleGroups.length && (
              <option value="">ยังไม่มีแผนที่ล็อกแล้วและพร้อมจัดเส้นทาง</option>
            )}
            {groups.map((group) => (
              <option
                key={group.key}
                value={group.key}
                disabled={!group.routeEligible}
              >
                {group.planNumber} · {group.warehouse || "ไม่พบคลัง"} ·{" "}
                {group.rows.length} เขต
                {group.blocker ? ` · BLOCKED: ${group.blocker}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          รถเที่ยวแรก
          <select
            value={preferredVehicle?.id ?? ""}
            onChange={(event) => setPreferredVehicleId(event.target.value)}
            disabled={!availableVehicles.length}
          >
            {!availableVehicles.length && (
              <option value="">ยังไม่มีข้อมูลยืนยันความพร้อมของรถ</option>
            )}
            {availableVehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.code} · {formatNumber(vehicle.maxWt)} กก.
              </option>
            ))}
          </select>
        </label>
        <label>
          จุดสูงสุดต่อเที่ยว
          <input
            type="number"
            min={1}
            max={18}
            value={maxStops}
            onChange={(event) => {
              setMaxStops(
                Math.min(18, Math.max(1, Number(event.target.value) || 1)),
              );
            }}
          />
        </label>
        <label className="transport-check">
          <input
            type="checkbox"
            checked={avoidTolls}
            onChange={(event) => setAvoidTolls(event.target.checked)}
          />
          หลีกเลี่ยงทางเก็บค่าผ่านทาง หากบริการคำนวณรองรับ
        </label>
      </section>
      {groups.some((group) => !group.routeEligible) && (
        <aside className="transport-group-blockers" role="note">
          <strong>กลุ่มที่ถูกหยุดก่อนเลือก</strong>
          <ul>
            {groups
              .filter((group) => !group.routeEligible)
              .map((group) => (
                <li key={group.key}>
                  {group.planNumber} · {group.warehouse || "ไม่พบคลัง"}:{" "}
                  {group.blocker}
                </li>
              ))}
          </ul>
        </aside>
      )}

      <section className="panel">
        <div className="panel-title">
          <div>
            <span>งานในกลุ่มที่เลือกเท่านั้น</span>
            <h3>
              {activeGroup
                ? `${activeGroup.planNumber} · ${activeGroup.warehouse}`
                : "ยังไม่มีแผนที่ล็อกแล้ว"}
            </h3>
          </div>
          <b>{selected.length}/{groupRows.length} เขต</b>
        </div>
        <div className="live-table-wrap">
          <table className="live-table transport-queue-table">
            <caption className="sr-only">
              จุดส่งในแผนการจ่ายและคลังที่เลือก
            </caption>
            <thead>
              <tr>
                <th scope="col">เขต</th>
                <th scope="col">รายการ / ปริมาณ</th>
                <th scope="col">น้ำหนัก</th>
                <th scope="col">พิกัด</th>
                <th scope="col">เลือก</th>
              </tr>
            </thead>
            <tbody>
              {groupRows.map((row) => {
                const point = data.geo[row.districtRef];
                const verified = point?.verificationStatus === "verified";
                const coordinateReady = hasValidCoordinates(point);
                const routeReady =
                  row.routeEligible &&
                  verified &&
                  point.routeEligible &&
                  coordinateReady;
                const weightReady =
                  row.weightComplete && row.estimatedWeightKg != null;
                return (
                  <tr key={`${activeGroup?.key}:${row.districtRef}`}>
                    <td>
                      <span>
                        <strong>{row.districtName}</strong>
                        <small>{row.districtRef} · {row.districtId}</small>
                      </span>
                    </td>
                    <td>
                      {formatNumber(row.lineCount)} รายการ ·{" "}
                      {row.totalQty == null
                        ? "หลายหน่วย / —"
                        : `${formatNumber(row.totalQty, 2)} หน่วย`}
                    </td>
                    <td>
                      <span className={`transport-data-state ${weightReady ? "verified" : "quarantined"}`}>
                        {weightReady
                          ? `${formatNumber(row.estimatedWeightKg, 1)} กก.`
                          : "ข้อมูลไม่ครบ"}
                      </span>
                    </td>
                    <td>
                      <span className={`transport-data-state ${routeReady ? "verified" : "quarantined"}`}>
                        {routeReady
                          ? "พิกัดยืนยันแล้ว พร้อมจัดเส้นทาง"
                          : !row.routeEligible
                            ? "คิวจัดส่งระบุว่ายังจัดเส้นทางไม่ได้ (route_eligible=false)"
                          : verified && !coordinateReady
                            ? "พิกัดยืนยันแล้ว แต่ละติจูดหรือลองจิจูดไม่ครบ"
                          : verified
                            ? "พิกัดยืนยันแล้ว แต่ยังไม่เชื่อมกับรหัสสถานที่หลัก"
                            : point?.verificationStatus ?? "ไม่พบพิกัด"}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="table-action"
                        aria-pressed={selected.includes(row.districtRef)}
                        disabled={!routeReady}
                        onClick={() => toggle(row.districtRef)}
                      >
                        {selected.includes(row.districtRef) ? "นำออก" : "เพิ่มจุดส่ง"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!groupRows.length && (
                <tr>
                  <td colSpan={5}>ยังไม่มีงานจากแผนที่ล็อกแล้วและพร้อมจัดส่ง</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dashboard-main transport-planner-grid">
        <article className="panel">
          <div className="panel-title">
            <div>
              <span>พรีวิวเส้นทาง</span>
              <h3>
                {source === "demo"
                  ? "เส้นทางจำลองเพื่อทดสอบการตัดสินใจ"
                  : "เส้นทางบนถนนจริง"}
              </h3>
            </div>
            <div className="transport-geo-summary" aria-label="สถานะพิกัด">
              <span className="verified">{geoCounts.verified} verified</span>
              <span className="verified">{geoCounts.routeEligible} route-ready</span>
              <span className="candidate">{geoCounts.candidate} candidate</span>
              <span className="quarantined">{geoCounts.quarantined} quarantined</span>
            </div>
          </div>
          <div className="transport-map-frame">
            <TransportRoadMap
              points={points}
              geometry={(roadCurrent?.geometry as RoadGeometry | undefined) ?? null}
              onPick={toggle}
            />
          </div>
        </article>

        <article className="panel transport-route-result">
          <div className="panel-title">
            <div>
              <span>ผลการจัดลำดับ</span>
              <h3>ผลลัพธ์ที่ดีที่สุดที่พบ</h3>
            </div>
            <span className={`transport-data-state ${roadIsCanonical ? "verified" : "unverified"}`}>
              {roadIsCanonical ? "canonical preview" : "รอผลจากข้อมูลเส้นทางหลัก"}
            </span>
          </div>
          <div className="transport-result-grid">
            <article>
              <span>ระยะทางถนน</span>
              <strong>{roadCurrent ? formatNumber(roadCurrent.distanceKm, 1) : "—"}</strong>
              <small>กม. · ไปและกลับคลัง</small>
            </article>
            <article>
              <span>เวลาเดินทาง</span>
              <strong>{roadCurrent ? formatNumber(roadCurrent.durationMinutes, 1) : "—"}</strong>
              <small>นาที · ไม่รวมเวลาขนถ่าย</small>
            </article>
            <article>
              <span>ดีขึ้นจากลำดับเดิม</span>
              <strong>{roadCurrent ? `${formatNumber(roadCurrent.improvementPercent, 1)}%` : "—"}</strong>
              <small>ผลนี้เป็นลำดับที่ดีที่สุดที่วิธีคำนวณพบ อาจมีลำดับอื่นที่ดีกว่า</small>
            </article>
            <article className="toll-unavailable">
              <span>ค่าผ่านทาง</span>
              <strong>ยังไม่คำนวณ</strong>
              <small>รออัตราค่าผ่านทางที่อนุมัติแล้ว</small>
            </article>
          </div>
          <div className="transport-route-copy">
            <p>
              <strong>ลำดับ:</strong>{" "}
              {roadCurrent?.order.length
                ? `คลัง → ${roadCurrent.order.join(" → ")} → คลัง`
                : "เลือกจุดส่งแล้วกดคำนวณถนนจริง"}
            </p>
            <p>
              <strong>เครื่องมือ:</strong>{" "}
              {roadCurrent
                ? `${roadCurrent.provider}/${roadCurrent.profile} · ${
                    roadCurrent.engineMode === "configured"
                      ? "configured"
                      : "ข้อมูลทดสอบ ห้ามบันทึกลงระบบจริง"
                  }`
                : "ยังไม่มีผลลัพธ์"}
            </p>
            {roadCurrent && <RoadEvidence result={roadCurrent} />}
            {roadState.error && (
              <p className="transport-inline-error" role="alert">
                {roadState.error}
              </p>
            )}
            {fleet.error && selected.length > 0 && roadCurrent && (
              <p className="transport-inline-error" role="alert">
                {fleet.error}
              </p>
            )}
            {!fleet.error && fleet.chunks.length > 0 && (
              <div className="transport-load-list">
                <strong>
                  ทดลองแบ่งเที่ยวตามน้ำหนักได้ {fleet.chunks.length} เที่ยว ·{" "}
                  {formatNumber(fleet.totalWeightKg, 1)} กก.
                </strong>
                <small>
                  การแบ่งเที่ยวนี้ยังไม่ได้ใช้ OR-Tools และยังไม่รวมปริมาตร พาเลท ช่วงเวลาส่ง หรือกะรถ
                </small>
                <ol>
                  {fleet.chunks.map((trip) => (
                    <li key={trip.vehicle.id}>
                      {trip.vehicle.code}: {trip.stops.join(" → ")} ·{" "}
                      {formatNumber(trip.weightKg, 1)}/
                      {formatNumber(trip.vehicle.maxWt)} กก.
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {demoRoute && !fleet.error && (
              <div className="transport-load-list">
                <strong>เปรียบเทียบวิธีจัดส่ง</strong>
                <small>
                  ใช้ประกอบการตัดสินใจของผู้วางแผน ระบบไม่อนุมัติหรือสร้างเที่ยวรถให้อัตโนมัติ
                </small>
                <ol>
                  <li>
                    คลังกลางส่ง: {fleet.chunks.length} เที่ยว · ระยะทางประมาณ{" "}
                    {formatNumber(demoRoute.totalDist, 1)} กม. · น้ำมันประมาณ{" "}
                    {formatNumber(demoRoute.fuelCost, 2)} บาท · ค่าทางด่วนประมาณ{" "}
                    {formatNumber(demoRoute.totalToll)} บาท
                  </li>
                  <li>
                    เขตมารับเอง: ลดภาระรถคลังกลาง แต่ต้องนัดหมายรถเขตและบันทึกผู้มารับเป็นรายเขต
                  </li>
                  <li>
                    ก่อนล็อกแผนขนส่ง ต้องยืนยันพาเลทหรือกล่อง น้ำหนักจริง พื้นที่วาง และข้อจำกัดเรื่องไม่มีอุปกรณ์ยก
                  </li>
                </ol>
              </div>
            )}
            <div className="transport-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={
                  roadState.loading ||
                  !selected.length ||
                  (source !== "demo" &&
                    (data.readiness?.operationalWritesEnabled !== true ||
                      data.readiness?.routeReady !== true))
                }
                onClick={() => void optimize()}
              >
                {roadState.loading
                  ? "กำลังคำนวณ…"
                  : source === "demo"
                    ? "ทดลองจัดลำดับเส้นทาง"
                    : "คำนวณเส้นทางบนถนน"}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={
                  jobState.loading ||
                  attemptActive ||
                  attemptSucceeded ||
                  !activeGroup?.planId ||
                  !queueGatesReady
                }
                aria-describedby="transport-queue-hint transport-save-hint"
                onClick={() => void queueJob()}
              >
                {jobState.loading
                  ? "กำลังส่งหรือดำเนินงานคำนวณต่อ…"
                  : attemptSucceeded
                    ? "คำนวณแผนเส้นทางแล้ว ผลลัพธ์แก้ไขไม่ได้"
                    : attemptCanRestart
                      ? "เริ่มคำนวณใหม่ด้วยรหัสคำขอใหม่"
                      : jobState.attemptStatus === "submitting"
                        ? "ดำเนินงานเดิมต่อด้วยรหัสคำขอเดิม"
                        : attemptActive
                          ? "กำลังติดตามงานเดิม"
                          : "ส่งแผนทั้งชุดให้ OR-Tools + Valhalla คำนวณ"}
              </button>
            </div>
            <p id="transport-queue-hint" className="transport-queue-hint">
              ส่งแผนที่ล็อกแล้วทั้งชุดของ {activeGroup?.planNumber ?? "แผนที่เลือก"}
              ไปคำนวณ จุดที่เลือกบนแผนที่ใช้ทดลองจัดลำดับเท่านั้น งานคำนวณจริงใช้แผนทั้งชุด
            </p>
            <p id="transport-save-hint" className="transport-save-hint">
              เมื่อคำนวณสำเร็จ ระบบจะสร้างแผนเส้นทางพร้อมหลักฐานถนนจาก Valhalla ขณะนี้ยังไม่เปิดให้สร้างเที่ยวรถจากแผน
            </p>
            {planId && planQueueBlocker && (
              <p className="transport-inline-error" role="note">
                ผลตรวจแผนก่อนส่งคำนวณ: {planQueueBlocker}
              </p>
            )}
            {jobState.requestId && !jobState.job && (
              <aside className="transport-job-status submitting" role="status">
                <strong>บันทึกคำขอของแผนนี้ไว้ในรอบการใช้งานแล้ว</strong>
                <p>
                  ระบบจะใช้รหัสคำขอ (X-Request-ID) เดิมเพื่อดำเนินงานต่อ เริ่มคำขอใหม่ได้เมื่องานเดิมล้มเหลวหรือถูกยกเลิกแล้ว
                </p>
                <code>{jobState.requestId}</code>
              </aside>
            )}
            {jobState.job && (
              <aside
                className={`transport-job-status ${jobState.attemptStatus ?? jobState.job.status}`}
                role="status"
                aria-live="polite"
              >
                <div>
                  <strong>
                    งาน {jobState.attemptStatus ?? jobState.job.status} · {jobState.job.matrix_source}
                  </strong>
                  <span>{jobState.job.algorithm_version}</span>
                </div>
                <code>{jobState.job.route_job_id}</code>
                <p>
                  {jobState.attemptStatus === "succeeded"
                    ? `สร้างแผนเส้นทาง ${jobState.job.route_plan_id ?? "แล้ว"} ผลลัพธ์แก้ไขไม่ได้ และรอตรวจสอบก่อนเปิดใช้งาน`
                    : jobState.attemptStatus === "failed"
                      ? jobState.job.error?.message ??
                        "งานล้มเหลว กรุณาตรวจบันทึกของบริการคำนวณก่อนเริ่มใหม่ด้วยรหัสคำขอใหม่"
                      : jobState.attemptStatus === "cancelled"
                        ? "งานถูกยกเลิก เริ่มใหม่ได้ด้วยรหัสคำขอใหม่เท่านั้น"
                        : "ระบบอัปเดตสถานะงานทุก 3 วินาที"}
                </p>
              </aside>
            )}
            {jobState.error && (
              <p className="transport-inline-error" role="alert">
                {jobState.error}
              </p>
            )}
            {msg && (
              <p className="transport-feedback" role="status" aria-live="polite">
                {msg}
              </p>
            )}
          </div>
        </article>
      </section>
    </div>
  );
}

function TransportMap({
  data,
  source,
  canMutate,
  onOptimize,
}: {
  data: TransportData;
  source: DataSource;
  canMutate: boolean;
  onOptimize: OptimizeRoad;
}) {
  const groups = useMemo(() => queueGroups(data.queue), [data.queue]);
  const eligibleGroups = useMemo(
    () => groups.filter((routeGroup) => routeGroup.routeEligible),
    [groups],
  );
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const group =
    eligibleGroups.find((routeGroup) => routeGroup.key === selectedGroupKey) ??
    eligibleGroups[0] ??
    null;
  const [picked, setPicked] = useState<string | null>(null);
  const [road, setRoad] = useState<CanonicalRoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const warehouse = group?.warehouse ?? "";
  const depot = depotForWarehouse(data, warehouse);
  const pickedGeo = picked ? data.geo[picked] : null;
  const points = useMemo(
    () =>
      mapPoints(
        data,
        warehouse,
        picked ? [picked] : [],
        road?.order ?? (picked ? [picked] : []),
      ),
    [data, picked, road?.order, warehouse],
  );

  const choosePoint = (id: string) => {
    if (!group?.rows.some((row) => row.districtRef === id)) {
      setError("จุดนี้อยู่นอกแผนและคลังที่เลือก");
      return;
    }
    setPicked(id);
    setRoad(null);
    setError("");
  };
  const preview = async () => {
    if (!canMutate) {
      setError("คุณดูข้อมูลขนส่งได้ แต่ไม่มีสิทธิ์คำนวณเส้นทาง");
      return;
    }
    if (source !== "demo" && !data.readiness?.operationalWritesEnabled) {
      setError(
        "ยังไม่เปิดให้คำนวณเส้นทาง (production_not_ready)",
      );
      return;
    }
    if (source !== "demo" && !data.readiness?.routeReady) {
      setError(
        `ข้อมูลเส้นทางหลักยังไม่พร้อม: ${readinessText(
          data.readiness?.routeReadinessStatus ?? "unknown_route_readiness",
        )}`,
      );
      return;
    }
    if (
      (source !== "supabase" && source !== "demo") ||
      !group?.planId ||
      !depot ||
      depot.verificationStatus !== "verified" ||
      !depot.routeEligible ||
      !hasValidCoordinates(depot) ||
      !pickedGeo ||
      pickedGeo.verificationStatus !== "verified" ||
      !pickedGeo.routeEligible ||
      !hasValidCoordinates(pickedGeo)
    ) {
      setError("ต้องเลือกแผนที่ล็อกแล้วและพิกัดที่ยืนยันแล้วก่อนคำนวณเส้นทางถนน");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = (await onOptimize(
        depot,
        [pickedGeo],
        group.planId,
        false,
      )) as CanonicalRoadResult;
      if (!sameStopSet([pickedGeo.ref], result.order)) {
        throw new Error("ผลลัพธ์จาก routing engine ไม่ตรงกับจุดที่เลือก");
      }
      setRoad(result);
    } catch (previewError) {
      setRoad(null);
      setError(
        previewError instanceof Error
          ? previewError.message
          : "คำนวณเส้นทางไม่สำเร็จ",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stack transport-workspace">
      <section className="filter-bar transport-map-controls">
        <label>
          แผนและคลัง
          <select
            value={group?.key ?? ""}
            onChange={(event) => {
              setSelectedGroupKey(event.target.value);
              setPicked(null);
              setRoad(null);
              setError("");
            }}
            disabled={!eligibleGroups.length}
          >
            {!eligibleGroups.length && (
              <option value="">ยังไม่มีแผนที่ล็อกแล้วและพร้อมจัดเส้นทาง</option>
            )}
            {groups.map((option) => (
              <option
                key={option.key}
                value={option.key}
                disabled={!option.routeEligible}
              >
                {option.planNumber} · {option.warehouse || "ไม่พบคลัง"}
                {option.blocker ? ` · BLOCKED: ${option.blocker}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          จุดส่ง
          <select
            value={picked ?? ""}
            onChange={(event) => choosePoint(event.target.value)}
            disabled={!group}
          >
            <option value="">เลือกเขตปลายทาง</option>
            {group?.rows.map((row) => (
              <option
                key={`${group.key}:${row.districtRef}`}
                value={row.districtRef}
                disabled={
                  !row.routeEligible ||
                  data.geo[row.districtRef]?.verificationStatus !== "verified" ||
                  !data.geo[row.districtRef]?.routeEligible ||
                  !hasValidCoordinates(data.geo[row.districtRef])
                }
              >
                {row.districtName} · {row.districtRef}
              </option>
            ))}
          </select>
        </label>
        {canMutate ? (
          <button
            type="button"
            className="btn primary"
            disabled={
              !picked ||
              loading ||
              (source !== "supabase" && source !== "demo") ||
              (source !== "demo" &&
                (data.readiness?.operationalWritesEnabled !== true ||
                  data.readiness?.routeReady !== true))
            }
            onClick={() => void preview()}
          >
            {loading
              ? "กำลังคำนวณ…"
              : source === "demo"
                ? "ทดลองเส้นทาง"
                : "ดูเส้นทางถนน"}
          </button>
        ) : (
          <p className="transport-read-only-note" role="note">
            คุณดูข้อมูลได้ ผู้ดูแลระบบและผู้วางแผนเท่านั้นที่คำนวณเส้นทางใหม่ได้
          </p>
        )}
      </section>
      {groups.some((routeGroup) => !routeGroup.routeEligible) && (
        <aside className="transport-group-blockers" role="note">
          <strong>กลุ่มที่จัดเส้นทางไม่ได้</strong>
          <ul>
            {groups
              .filter((routeGroup) => !routeGroup.routeEligible)
              .map((routeGroup) => (
                <li key={routeGroup.key}>
                  {routeGroup.planNumber} ·{" "}
                  {routeGroup.warehouse || "ไม่พบคลัง"}: {routeGroup.blocker}
                </li>
              ))}
          </ul>
        </aside>
      )}
      {error && (
        <aside className="transport-inline-error transport-map-error" role="alert">
          {error}
        </aside>
      )}
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>แผนที่ฐานและเส้นทางจาก OSM</span>
            <h3>{warehouse || "ยังไม่ได้เลือกคลัง"}</h3>
          </div>
          {pickedGeo && (
            <span className={`transport-data-state ${pickedGeo.verificationStatus}`}>
              {pickedGeo.verificationStatus}
            </span>
          )}
        </div>
        <div className="transport-map-frame">
          <TransportRoadMap
            points={points}
            geometry={(road?.geometry as RoadGeometry | undefined) ?? null}
            onPick={choosePoint}
          />
        </div>
      </section>
      {picked && (
        <>
          <section className="transport-result-grid" aria-label="ผลเส้นทางถนน">
            <article>
              <span>ปลายทาง</span>
              <strong>{pickedGeo?.name ?? picked}</strong>
              <small>{picked}</small>
            </article>
            <article>
              <span>ระยะทางถนนไป-กลับ</span>
              <strong>{road ? formatNumber(road.distanceKm, 1) : "—"}</strong>
              <small>กม.</small>
            </article>
            <article>
              <span>เวลาเดินทาง</span>
              <strong>{road ? formatNumber(road.durationMinutes, 1) : "—"}</strong>
              <small>นาที</small>
            </article>
            <article className="toll-unavailable">
              <span>ค่าผ่านทาง</span>
              <strong>ยังไม่คำนวณ</strong>
              <small>รออัตราค่าผ่านทางที่อนุมัติแล้ว</small>
            </article>
          </section>
          {road && <RoadEvidence result={road} />}
        </>
      )}
    </div>
  );
}

type CancelLegacyTrip = (tripId: string) => Promise<void>;

function TransportHistory({
  data,
  source,
  canMutate,
  onCancel,
}: {
  data: TransportData;
  source: DataSource;
  canMutate: boolean;
  onCancel: CancelLegacyTrip;
}) {
  const [filter, setFilter] = useState("");
  const [pendingTripId, setPendingTripId] = useState("");
  const [feedback, setFeedback] = useState("");
  const rows = data.trips.filter(
    (t) =>
      !filter ||
      `${t.code} ${t.batch ?? ""} ${t.vehicle} ${t.driver} ${t.warehouse}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const cancelTrip = async (trip: TTrip) => {
    if (!canMutate) {
      setFeedback("สิทธิ์นี้อ่านประวัติได้ แต่ยกเลิกเที่ยวรถไม่ได้");
      return;
    }
    if (
      !window.confirm(
        `ยืนยันยกเลิกเที่ยว ${trip.code} หรือไม่? ระบบจะบันทึกสถานะยกเลิกในเที่ยวรถจริง`,
      )
    ) {
      return;
    }
    setPendingTripId(trip.id);
    setFeedback("");
    try {
      await onCancel(trip.id);
      setFeedback(`ยกเลิกเที่ยว ${trip.code} แล้ว`);
    } catch (cancelError) {
      setFeedback(
        cancelError instanceof Error
          ? cancelError.message
          : "ยกเลิกเที่ยวรถไม่สำเร็จ",
      );
    } finally {
      setPendingTripId("");
    }
  };
  return (
    <div className="stack">
      <aside className="transport-history-warning" role="note">
        <strong>ประวัติเดิมชุดนี้ใช้เพื่ออ้างอิง ยังไม่มีหลักฐานเส้นทางที่ยืนยันแล้ว</strong>
        <p>
          ประวัติเที่ยวรถยังไม่มีหลักฐานเส้นทางถนนที่ยืนยันได้ ระยะทาง เวลา และค่าใช้จ่ายจึงใช้เพื่ออ้างอิงเท่านั้น ยังเปลี่ยนสถานะเป็นออกรถหรือส่งครบไม่ได้ ผู้ดูแลระบบและผู้วางแผนยกเลิกได้เฉพาะเที่ยวที่ยังไม่สิ้นสุด
        </p>
      </aside>
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
                <th>หลักฐาน / การดำเนินการ</th>
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
                  <td>
                    {formatNumber(t.dist, 1)} กม.
                    <small>ข้อมูลเดิม ยังไม่มีหลักฐานเส้นทางถนน</small>
                  </td>
                  <td>
                    {formatNumber(t.fuel, 2)}
                    {t.fuelActual != null ? ` / ${formatNumber(t.fuelActual, 2)}` : " / —"}
                  </td>
                  <td>{t.date}</td>
                  <td>
                    <TBadge>{mapStatus(t.status)}</TBadge>
                  </td>
                  <td>
                    <span className="transport-data-state unverified">
                      ข้อมูลอ้างอิง ยังไม่ยืนยัน
                    </span>
                    {(tripHasStatus(t, "planned", "วางแผน") ||
                      tripHasStatus(t, "dispatched", "ออกรถแล้ว")) &&
                    canMutate &&
                    source === "supabase" &&
                    uuidPattern.test(t.id) ? (
                      <button
                        type="button"
                        className="table-action danger"
                        disabled={
                          Boolean(pendingTripId) ||
                          data.readiness?.operationalWritesEnabled !== true
                        }
                        title={
                          data.readiness?.operationalWritesEnabled === true
                            ? "ยกเลิกเที่ยวจากประวัติเดิม"
                            : "Operational POST gate ถูกล็อก"
                        }
                        onClick={() => void cancelTrip(t)}
                      >
                        {pendingTripId === t.id
                          ? "กำลังยกเลิก…"
                          : data.readiness?.operationalWritesEnabled === true
                            ? "ยกเลิกเที่ยว"
                            : "ยังยกเลิกไม่ได้"}
                      </button>
                    ) : (
                      <small>
                        {canMutate
                          ? "ยังเปลี่ยนเป็นออกรถหรือส่งครบไม่ได้"
                          : "อ่านอย่างเดียวตามสิทธิ์"}
                      </small>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10}>ไม่พบเที่ยวรถ</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {feedback && (
        <p
          className="transport-feedback"
          role="status"
          aria-live="polite"
        >
          {feedback}
        </p>
      )}
    </div>
  );
}

export function TransportModule({
  view,
  token,
  role,
  actorId,
  demoMode = false,
}: {
  view: TransportView;
  token: string | null;
  role: Role;
  actorId: string;
  demoMode?: boolean;
}) {
  const {
    data,
    source,
    loading,
    loadError,
    reload,
    optimizeRoad,
    cancelLegacyTrip,
    queueOptimizationJob,
    readOptimizationJob,
  } = useTransportData(token, role, demoMode);
  const canMutate = canMutateTransport(role);
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
      <SourceTag
        source={source}
        loading={loading}
        error={loadError}
        onRetry={() => void reload()}
      />
      {source !== "error" && !canMutate && (
        <aside className="transport-read-only-note" role="note">
          <strong>โหมดอ่านอย่างเดียว</strong>
          <p>
            สิทธิ์ {role} อ่านภาพรวม แผนที่ และประวัติได้เท่านั้น
            {role === "district"
              ? " ระบบแสดงคิวจัดส่งและเที่ยวรถเฉพาะเขตที่คุณมีสิทธิ์เข้าถึง"
              : " บทบาทนี้ไม่มีสิทธิ์ส่งแผนไปคำนวณหรือเปลี่ยนสถานะเที่ยวรถ"}
          </p>
        </aside>
      )}
      {source !== "error" && source !== "demo" && (
        <TransportReadinessPanel
          readiness={data.readiness}
          source={source}
        />
      )}
      {source !== "error" && view === "dashboard" && (
        <TransportDashboard data={data} />
      )}
      {source !== "error" && view === "planner" && canMutate && (
        <TransportPlanner
          data={data}
          source={source}
          actorId={actorId}
          onOptimize={optimizeRoad}
          onQueueJob={queueOptimizationJob}
          onReadJob={readOptimizationJob}
        />
      )}
      {source !== "error" && view === "planner" && !canMutate && (
        <aside className="runtime-message warning" role="status">
          <i>!</i>
          <div>
            <strong>คุณไม่มีสิทธิ์วางแผนหรือส่งงานขนส่งไปคำนวณ</strong>
            <p>กลับไปยังภาพรวม แผนที่ หรือประวัติแบบอ่านอย่างเดียว</p>
          </div>
        </aside>
      )}
      {source !== "error" && view === "map" && (
        <TransportMap
          data={data}
          source={source}
          canMutate={canMutate}
          onOptimize={optimizeRoad}
        />
      )}
      {source !== "error" && view === "history" && (
        <TransportHistory
          data={data}
          source={source}
          canMutate={canMutate}
          onCancel={cancelLegacyTrip}
        />
      )}
    </>
  );
}
