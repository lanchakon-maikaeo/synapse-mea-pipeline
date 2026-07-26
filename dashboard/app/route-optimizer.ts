const MAX_STOPS = 18;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ROAD_METRIC = 1_000_000_000;
const MAX_WAYPOINT_SNAP_METERS = 1_000;
const MAX_GEOMETRY_WAYPOINT_METERS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEMO_ENGINE_URL = "https://router.project-osrm.org";
const PUBLIC_COMMUNITY_ENGINE_HOSTS = new Set([
  "router.project-osrm.org",
  "routing.openstreetmap.de",
]);
const IMMUTABLE_DATA_VERSION =
  /^[a-z0-9][a-z0-9._-]{0,127}-sha256-[0-9a-f]{64}$/;
let activeRoadOptimizations = 0;

export type RoadPoint = {
  id: string;
  lat: number;
  lon: number;
};

export type RoadOptimizationRequest = {
  depot: RoadPoint;
  stops: RoadPoint[];
  objective?: "duration" | "distance";
  avoidTolls?: boolean;
};

export type CanonicalRoadGate = {
  authorized: true;
  request_id?: string;
  replenishment_plan_id: string;
  depot: RoadPoint & {
    district_ref?: string;
    warehouse_code?: string;
    verified_at?: string;
    source_reference?: string;
    source_checksum_sha256?: string;
    source_row_number?: number;
  };
  stops: Array<
    RoadPoint & {
      district_ref?: string;
      district_id?: string;
      verified_at?: string;
      source_reference?: string;
      source_checksum_sha256?: string;
      source_row_number?: number;
    }
  >;
  objective: "duration" | "distance";
  avoid_tolls: boolean;
  monetary_toll_estimate_available?: false;
  monetary_toll_estimate_status?: string;
};

export type RoadOptimizationResult = {
  provider: "osrm";
  engineMode: "configured" | "development-demo";
  profile: string;
  algorithm: "road-matrix-nearest-neighbour-2opt";
  objective: "duration" | "distance";
  order: string[];
  distanceKm: number;
  durationMinutes: number;
  baselineCost: number;
  optimizedCost: number;
  improvementPercent: number;
  geometry: {
    type: "LineString";
    coordinates: Array<[number, number]>;
  };
  dataVersion: string | null;
  dataVersionSource:
    | "engine-response"
    | "configured-release"
    | "unavailable-development";
  generatedAt: string;
};

type MatrixResponse = {
  code?: string;
  message?: string;
  distances?: Array<Array<number | null>>;
  durations?: Array<Array<number | null>>;
  data_version?: string;
};

type RouteResponse = {
  code?: string;
  message?: string;
  data_version?: string;
  waypoints?: Array<{
    location?: [number, number];
    distance?: number;
  }>;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: {
      type?: string;
      coordinates?: Array<[number, number]>;
    };
  }>;
};

export class RoutingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "RoutingError";
    this.status = status;
    this.code = code;
  }
}

export function roadRequestFromCanonicalGate(value: unknown): {
  request: Required<RoadOptimizationRequest>;
  gate: CanonicalRoadGate;
} {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      (value as { authorized?: unknown }).authorized !== true
    ) {
      throw new Error("authorization marker is missing");
    }
    const gate = value as Partial<CanonicalRoadGate>;
    if (
      typeof gate.replenishment_plan_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        gate.replenishment_plan_id,
      ) ||
      (gate.objective !== "duration" && gate.objective !== "distance") ||
      typeof gate.avoid_tolls !== "boolean"
    ) {
      throw new Error("canonical plan metadata is invalid");
    }
    const request = validateRoadOptimizationRequest({
      depot: gate.depot,
      stops: gate.stops,
      objective: gate.objective,
      avoidTolls: gate.avoid_tolls,
    });
    return { request, gate: gate as CanonicalRoadGate };
  } catch {
    throw new RoutingError(
      502,
      "canonical_geocode_invalid",
      "Transport authorization gate returned invalid canonical route data",
    );
  }
}

function finiteCoordinate(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function haversineMeters(
  first: [number, number],
  second: [number, number],
) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const [firstLon, firstLat] = first;
  const [secondLon, secondLat] = second;
  const deltaLat = radians(secondLat - firstLat);
  const deltaLon = radians(secondLon - firstLon);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(firstLat)) *
      Math.cos(radians(secondLat)) *
      Math.sin(deltaLon / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateOrderedRoadGeometry(
  payload: RouteResponse,
  requestedPoints: RoadPoint[],
  coordinates: Array<[number, number]>,
) {
  if (
    !Array.isArray(payload.waypoints) ||
    payload.waypoints.length !== requestedPoints.length
  ) {
    throw new RoutingError(
      502,
      "routing_waypoints_invalid",
      "Road engine did not return every ordered waypoint",
    );
  }
  const snapped = payload.waypoints.map((waypoint, index) => {
    const location = waypoint?.location;
    if (
      !Array.isArray(location) ||
      location.length !== 2 ||
      !finiteCoordinate(location[0], -180, 180) ||
      !finiteCoordinate(location[1], -90, 90) ||
      typeof waypoint.distance !== "number" ||
      !Number.isFinite(waypoint.distance) ||
      waypoint.distance < 0 ||
      waypoint.distance > MAX_WAYPOINT_SNAP_METERS
    ) {
      throw new RoutingError(
        502,
        "routing_waypoints_invalid",
        "Road engine returned an invalid snapped waypoint",
      );
    }
    const requested: [number, number] = [
      requestedPoints[index].lon,
      requestedPoints[index].lat,
    ];
    if (haversineMeters(requested, location) > MAX_WAYPOINT_SNAP_METERS) {
      throw new RoutingError(
        502,
        "routing_waypoints_invalid",
        "Road engine snapped a waypoint too far from canonical coordinates",
      );
    }
    return location;
  });

  let geometryIndex = 0;
  for (const waypoint of snapped) {
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = geometryIndex; index < coordinates.length; index += 1) {
      const distance = haversineMeters(waypoint, coordinates[index]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    if (
      nearestIndex < geometryIndex ||
      nearestDistance > MAX_GEOMETRY_WAYPOINT_METERS
    ) {
      throw new RoutingError(
        502,
        "routing_geometry_order_invalid",
        "Road geometry does not traverse the requested waypoint order",
      );
    }
    geometryIndex = nearestIndex;
  }
}

function normalizedPoint(value: unknown, label: string): RoadPoint {
  if (!value || typeof value !== "object") {
    throw new RoutingError(422, "validation_error", `${label} must be an object`);
  }
  const point = value as Partial<RoadPoint>;
  const id = typeof point.id === "string" ? point.id.trim() : "";
  if (!id || id.length > 80 || !/^[A-Za-z0-9ก-๙._ -]+$/u.test(id)) {
    throw new RoutingError(422, "validation_error", `${label}.id is invalid`);
  }
  if (!finiteCoordinate(point.lat, -90, 90) || !finiteCoordinate(point.lon, -180, 180)) {
    throw new RoutingError(422, "validation_error", `${label} coordinates are invalid`);
  }
  return { id, lat: point.lat as number, lon: point.lon as number };
}

export function validateRoadOptimizationRequest(value: unknown): Required<RoadOptimizationRequest> {
  if (!value || typeof value !== "object") {
    throw new RoutingError(422, "validation_error", "Request body must be an object");
  }
  const request = value as Partial<RoadOptimizationRequest>;
  const depot = normalizedPoint(request.depot, "depot");
  if (!Array.isArray(request.stops) || request.stops.length < 1 || request.stops.length > MAX_STOPS) {
    throw new RoutingError(
      422,
      "validation_error",
      `stops must contain between 1 and ${MAX_STOPS} destinations`,
    );
  }
  const stops = request.stops.map((stop, index) => normalizedPoint(stop, `stops[${index}]`));
  const ids = new Set(stops.map((stop) => stop.id));
  if (ids.size !== stops.length || ids.has(depot.id)) {
    throw new RoutingError(422, "validation_error", "Depot and destination ids must be unique");
  }
  const coordinateKeys = [depot, ...stops].map(
    (point) => `${point.lat.toFixed(7)},${point.lon.toFixed(7)}`,
  );
  if (new Set(coordinateKeys).size !== coordinateKeys.length) {
    throw new RoutingError(
      422,
      "validation_error",
      "Depot and destination coordinates must be unique",
    );
  }
  const objective = request.objective ?? "duration";
  if (objective !== "duration" && objective !== "distance") {
    throw new RoutingError(422, "validation_error", "objective must be duration or distance");
  }
  return {
    depot,
    stops,
    objective,
    avoidTolls: request.avoidTolls === true,
  };
}

function routeCost(matrix: number[][], order: number[]) {
  let total = 0;
  let previous = 0;
  for (const node of order) {
    total += matrix[previous][node];
    previous = node;
  }
  return total + matrix[previous][0];
}

function nearestNeighbour(matrix: number[][]) {
  const remaining = new Set(Array.from({ length: matrix.length - 1 }, (_, index) => index + 1));
  const order: number[] = [];
  let current = 0;
  while (remaining.size > 0) {
    let bestNode = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const node of remaining) {
      const cost = matrix[current][node];
      if (cost < bestCost || (cost === bestCost && node < bestNode)) {
        bestNode = node;
        bestCost = cost;
      }
    }
    if (bestNode < 0) {
      throw new RoutingError(502, "routing_unreachable", "Road engine returned an unreachable stop");
    }
    order.push(bestNode);
    remaining.delete(bestNode);
    current = bestNode;
  }
  return order;
}

export function optimizeMatrixOrder(matrix: number[][]) {
  const size = matrix.length;
  if (
    size < 2 ||
    matrix.some(
      (row) =>
        row.length !== size ||
        row.some(
          (cell) =>
            !Number.isFinite(cell) ||
            cell < 0 ||
            cell > MAX_ROAD_METRIC,
        ),
    )
  ) {
    throw new RoutingError(502, "routing_invalid_matrix", "Road engine returned an invalid matrix");
  }

  let order = nearestNeighbour(matrix);
  let improved = true;
  let passes = 0;
  while (improved && passes < 60) {
    improved = false;
    passes += 1;
    const currentCost = routeCost(matrix, order);
    for (let start = 0; start < order.length - 1; start += 1) {
      for (let end = start + 1; end < order.length; end += 1) {
        const candidate = [
          ...order.slice(0, start),
          ...order.slice(start, end + 1).reverse(),
          ...order.slice(end + 1),
        ];
        if (routeCost(matrix, candidate) + 0.001 < currentCost) {
          order = candidate;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return order;
}

function matrixOf(value: Array<Array<number | null>> | undefined, size: number, label: string) {
  if (
    !value ||
    value.length !== size ||
    value.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== size ||
        row.some(
          (cell) =>
            typeof cell !== "number" ||
            !Number.isFinite(cell) ||
            cell < 0 ||
            cell > MAX_ROAD_METRIC,
        ),
    )
  ) {
    throw new RoutingError(
      502,
      "routing_unreachable",
      `Road engine did not return a complete ${label} matrix`,
    );
  }
  return value as number[][];
}

function engineConfig() {
  const configured = process.env.ROUTING_ENGINE_URL?.trim();
  const isProduction = process.env.NODE_ENV === "production";
  if (!configured && isProduction) {
    throw new RoutingError(
      503,
      "routing_not_configured",
      "Road routing is not configured for this production environment",
    );
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(configured || DEMO_ENGINE_URL);
  } catch {
    throw new RoutingError(
      500,
      "routing_configuration_error",
      "ROUTING_ENGINE_URL must be a valid absolute URL",
    );
  }
  if (baseUrl.username || baseUrl.password) {
    throw new RoutingError(
      500,
      "routing_configuration_error",
      "ROUTING_ENGINE_URL must not contain credentials",
    );
  }
  const localHttp =
    baseUrl.protocol === "http:" &&
    (baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1");
  const productionLoopback =
    baseUrl.hostname === "localhost" ||
    baseUrl.hostname === "127.0.0.1" ||
    baseUrl.hostname === "::1";
  if (
    isProduction &&
    (baseUrl.protocol !== "https:" ||
      productionLoopback ||
      PUBLIC_COMMUNITY_ENGINE_HOSTS.has(baseUrl.hostname.toLowerCase()))
  ) {
    throw new RoutingError(
      503,
      "routing_engine_not_controlled",
      "Production road routing must use a controlled HTTPS engine",
    );
  }
  if (baseUrl.protocol !== "https:" && !localHttp) {
    throw new RoutingError(
      500,
      "routing_configuration_error",
      "ROUTING_ENGINE_URL must use HTTPS, except for a loopback development service",
    );
  }
  const profile = (process.env.ROUTING_ENGINE_PROFILE?.trim() || "driving").toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(profile)) {
    throw new RoutingError(500, "routing_configuration_error", "Invalid routing profile");
  }
  const authToken = process.env.ROUTING_ENGINE_AUTH_TOKEN?.trim() || null;
  if (
    authToken &&
    (authToken.length > 4096 || /[\r\n]/.test(authToken))
  ) {
    throw new RoutingError(
      500,
      "routing_configuration_error",
      "ROUTING_ENGINE_AUTH_TOKEN is invalid",
    );
  }
  const configuredDataVersion =
    process.env.ROUTING_ENGINE_DATA_VERSION?.trim() || null;
  if (
    configuredDataVersion &&
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/.test(configuredDataVersion)
  ) {
    throw new RoutingError(
      500,
      "routing_configuration_error",
      "ROUTING_ENGINE_DATA_VERSION is invalid",
    );
  }
  if (isProduction && !configuredDataVersion) {
    throw new RoutingError(
      503,
      "routing_data_version_not_configured",
      "Road routing data version is not configured for this production environment",
    );
  }
  if (
    isProduction &&
    configuredDataVersion &&
    !IMMUTABLE_DATA_VERSION.test(configuredDataVersion)
  ) {
    throw new RoutingError(
      503,
      "routing_data_version_not_immutable",
      "Production road routing data version must be <lowercase-label>-sha256-<64 lowercase hex>",
    );
  }
  const requestedTimeout = Number(process.env.ROUTING_ENGINE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(30_000, Math.max(1_000, Math.round(requestedTimeout)))
    : DEFAULT_TIMEOUT_MS;
  return {
    baseUrl,
    profile,
    timeoutMs,
    authorization:
      configured && authToken
        ? `Bearer ${authToken}`
        : null,
    engineMode: configured ? ("configured" as const) : ("development-demo" as const),
    configuredDataVersion,
  };
}

function responseDataVersion(value: unknown, label: string) {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/.test(value)
  ) {
    throw new RoutingError(
      502,
      "routing_data_version_invalid",
      `Road engine returned an invalid ${label} data version`,
    );
  }
  return value;
}

function serviceUrl(
  baseUrl: URL,
  service: "table" | "route",
  profile: string,
  points: RoadPoint[],
  search: URLSearchParams,
) {
  const coordinates = points
    .map((point) => `${point.lon.toFixed(8)},${point.lat.toFixed(8)}`)
    .join(";");
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${service}/v1/${profile}/${coordinates}`;
  url.search = search.toString();
  return url;
}

async function fetchJson<T>(
  url: URL,
  timeoutMs: number,
  fetcher: typeof fetch,
  authorization: string | null,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        Accept: "application/json",
        "X-Client-Id": "mea-synapse-road-preview",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new RoutingError(
      503,
      timedOut ? "routing_timeout" : "routing_unavailable",
      timedOut ? "Road engine timed out" : "Road engine is unavailable",
    );
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new RoutingError(502, "routing_response_too_large", "Road engine response is too large");
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RoutingError(
          502,
          "routing_response_too_large",
          "Road engine response is too large",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  let payload: T;
  try {
    payload = JSON.parse(text) as T;
  } catch {
    throw new RoutingError(502, "routing_invalid_response", "Road engine returned invalid JSON");
  }
  if (!response.ok) {
    throw new RoutingError(
      502,
      "routing_upstream_error",
      "Road engine rejected the request",
    );
  }
  return payload;
}

export async function optimizeRoadRoute(
  value: unknown,
  fetcher: typeof fetch = fetch,
): Promise<RoadOptimizationResult> {
  const request = validateRoadOptimizationRequest(value);
  const configuredConcurrency = Number(
    process.env.ROUTING_ENGINE_MAX_CONCURRENCY ?? "4",
  );
  const maxConcurrency = Number.isInteger(configuredConcurrency)
    ? Math.min(32, Math.max(1, configuredConcurrency))
    : 4;
  if (activeRoadOptimizations >= maxConcurrency) {
    throw new RoutingError(
      503,
      "routing_busy",
      "Road optimizer is at its configured concurrency limit",
    );
  }
  activeRoadOptimizations += 1;
  try {
    const {
      baseUrl,
      profile,
      timeoutMs,
      authorization,
      engineMode,
      configuredDataVersion,
    } = engineConfig();
    const points = [request.depot, ...request.stops];
    const tableSearch = new URLSearchParams({
      annotations: "distance,duration",
    });
    if (request.avoidTolls) {
      tableSearch.set("exclude", "toll");
    }
    const tableUrl = serviceUrl(
      baseUrl,
      "table",
      profile,
      points,
      tableSearch,
    );
    const matrixPayload = await fetchJson<MatrixResponse>(
      tableUrl,
      timeoutMs,
      fetcher,
      authorization,
    );
    if (matrixPayload.code !== "Ok") {
      throw new RoutingError(
        502,
        "routing_upstream_error",
        "Road engine could not build a route matrix",
      );
    }
    const distances = matrixOf(matrixPayload.distances, points.length, "distance");
    const durations = matrixOf(matrixPayload.durations, points.length, "duration");
    const objectiveMatrix =
      request.objective === "distance" ? distances : durations;
    const baselineOrder = Array.from(
      { length: request.stops.length },
      (_, index) => index + 1,
    );
    const heuristicOrder = optimizeMatrixOrder(objectiveMatrix);
    const optimizedOrder =
      routeCost(objectiveMatrix, heuristicOrder) <=
      routeCost(objectiveMatrix, baselineOrder)
        ? heuristicOrder
        : baselineOrder;
    const optimizedPoints = [
      request.depot,
      ...optimizedOrder.map((index) => points[index]),
      request.depot,
    ];
    const routeSearch = new URLSearchParams({
      alternatives: "false",
      overview: "full",
      geometries: "geojson",
      steps: "false",
    });
    if (request.avoidTolls) {
      routeSearch.set("exclude", "toll");
    }
    const routeUrl = serviceUrl(
      baseUrl,
      "route",
      profile,
      optimizedPoints,
      routeSearch,
    );
    const routePayload = await fetchJson<RouteResponse>(
      routeUrl,
      timeoutMs,
      fetcher,
      authorization,
    );
    const route = routePayload.routes?.[0];
    const geometry = route?.geometry;
    if (
      routePayload.code !== "Ok" ||
      typeof route?.distance !== "number" ||
      !Number.isFinite(route.distance) ||
      route.distance < 0 ||
      route.distance > MAX_ROAD_METRIC ||
      typeof route.duration !== "number" ||
      !Number.isFinite(route.duration) ||
      route.duration < 0 ||
      route.duration > MAX_ROAD_METRIC ||
      geometry?.type !== "LineString" ||
      !Array.isArray(geometry.coordinates) ||
      geometry.coordinates.length < 2 ||
      geometry.coordinates.some(
        (coordinate) =>
          !Array.isArray(coordinate) ||
          coordinate.length !== 2 ||
          !finiteCoordinate(coordinate[0], -180, 180) ||
          !finiteCoordinate(coordinate[1], -90, 90),
      )
    ) {
      throw new RoutingError(
        502,
        "routing_invalid_response",
        "Road engine returned an invalid route",
      );
    }
    validateOrderedRoadGeometry(
      routePayload,
      optimizedPoints,
      geometry.coordinates,
    );
    const baselineCost = routeCost(objectiveMatrix, baselineOrder);
    const optimizedCost = routeCost(objectiveMatrix, optimizedOrder);
    const matrixDataVersion = responseDataVersion(
      matrixPayload.data_version,
      "matrix",
    );
    const routeDataVersion = responseDataVersion(
      routePayload.data_version,
      "route",
    );
    if (
      matrixDataVersion &&
      routeDataVersion &&
      matrixDataVersion !== routeDataVersion
    ) {
      throw new RoutingError(
        502,
        "routing_data_version_mismatch",
        "Road engine changed data versions during optimization",
      );
    }
    const engineDataVersion = routeDataVersion ?? matrixDataVersion;
    if (
      configuredDataVersion &&
      engineDataVersion &&
      configuredDataVersion !== engineDataVersion
    ) {
      throw new RoutingError(
        502,
        "routing_data_version_mismatch",
        "Road engine data version does not match the configured release",
      );
    }
    return {
      provider: "osrm",
      engineMode,
      profile,
      algorithm: "road-matrix-nearest-neighbour-2opt",
      objective: request.objective,
      order: optimizedOrder.map((index) => points[index].id),
      distanceKm: Math.round((route.distance / 1000) * 10) / 10,
      durationMinutes: Math.round(route.duration / 6) / 10,
      baselineCost: Math.round(baselineCost),
      optimizedCost: Math.round(optimizedCost),
      improvementPercent:
        baselineCost > 0
          ? Math.round(
              ((baselineCost - optimizedCost) / baselineCost) * 1000,
            ) / 10
          : 0,
      geometry: {
        type: "LineString",
        coordinates: geometry.coordinates,
      },
      dataVersion: engineDataVersion ?? configuredDataVersion,
      dataVersionSource: engineDataVersion
        ? "engine-response"
        : configuredDataVersion
          ? "configured-release"
          : "unavailable-development",
      generatedAt: new Date().toISOString(),
    };
  } finally {
    activeRoadOptimizations -= 1;
  }
}
