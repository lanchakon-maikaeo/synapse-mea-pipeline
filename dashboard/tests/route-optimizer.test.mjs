import assert from "node:assert/strict";
import test from "node:test";

import {
  optimizeMatrixOrder,
  optimizeRoadRoute,
  roadRequestFromCanonicalGate,
  RoutingError,
  validateRoadOptimizationRequest,
} from "../app/route-optimizer.ts";

const controlledDataVersion = `osm-thailand-2026-07-25-sha256-${"a".repeat(64)}`;
const driftedDataVersion = `osm-thailand-2026-07-26-sha256-${"b".repeat(64)}`;

test("canonical gate replaces all client coordinate authority", () => {
  const canonical = roadRequestFromCanonicalGate({
    authorized: true,
    replenishment_plan_id: "13000000-0000-4000-8000-000000000201",
    depot: {
      id: "เมืองใหม่",
      lat: 13.55760333,
      lon: 100.7707226,
      source_reference: "districts.csv#sha256=fe97",
    },
    stops: [
      {
        id: "5501",
        lat: 13.81895,
        lon: 100.6441,
        source_reference: "districts.csv#sha256=fe97",
      },
    ],
    objective: "duration",
    avoid_tolls: false,
    monetary_toll_estimate_available: false,
  });

  assert.equal(canonical.request.depot.lat, 13.55760333);
  assert.equal(canonical.request.stops[0].lon, 100.6441);
  assert.equal(
    canonical.gate.replenishment_plan_id,
    "13000000-0000-4000-8000-000000000201",
  );
});

test("canonical gate fails closed when plan metadata is absent", () => {
  assert.throws(
    () =>
      roadRequestFromCanonicalGate({
        authorized: true,
        depot: { id: "เมืองใหม่", lat: 13.55760333, lon: 100.7707226 },
        stops: [{ id: "5501", lat: 13.81895, lon: 100.6441 }],
        objective: "duration",
        avoid_tolls: false,
      }),
    (error) =>
      error instanceof RoutingError &&
      error.code === "canonical_geocode_invalid",
  );
});

test("road optimizer validates bounded, unique coordinates", () => {
  const parsed = validateRoadOptimizationRequest({
    depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
    stops: [
      { id: "5501", lat: 13.75, lon: 100.52 },
      { id: "5502", lat: 13.81, lon: 100.49 },
    ],
    objective: "distance",
  });
  assert.equal(parsed.objective, "distance");
  assert.equal(parsed.stops.length, 2);

  assert.throws(
    () =>
      validateRoadOptimizationRequest({
        depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
        stops: [
          { id: "5501", lat: 13.75, lon: 100.52 },
          { id: "5501", lat: 13.81, lon: 100.49 },
        ],
      }),
    (error) => error instanceof RoutingError && error.code === "validation_error",
  );

  assert.throws(
    () =>
      validateRoadOptimizationRequest({
        depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
        stops: [{ id: "5501", lat: 13.72, lon: 100.55 }],
      }),
    (error) => error instanceof RoutingError && error.code === "validation_error",
  );
});

test("matrix optimizer returns a complete depot-to-depot visit order", () => {
  const matrix = [
    [0, 8, 2, 7],
    [8, 0, 3, 2],
    [2, 3, 0, 6],
    [7, 2, 6, 0],
  ];
  const order = optimizeMatrixOrder(matrix);
  assert.deepEqual(new Set(order), new Set([1, 2, 3]));
  assert.equal(order.length, 3);
});

test("matrix optimizer rejects null, negative and incomplete road costs", () => {
  for (const matrix of [
    [
      [0, null],
      [1, 0],
    ],
    [
      [0, -1],
      [1, 0],
    ],
    [
      [0, Number.MAX_VALUE],
      [1, 0],
    ],
    [[0, 1], [1]],
  ]) {
    assert.throws(
      () => optimizeMatrixOrder(matrix),
      (error) =>
        error instanceof RoutingError &&
        error.code === "routing_invalid_matrix",
    );
  }
});

test("road optimizer uses OSRM matrix order and returns road geometry", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  const previousToken = process.env.ROUTING_ENGINE_AUTH_TOKEN;
  process.env.ROUTING_ENGINE_URL = "https://routing.example.test";
  process.env.ROUTING_ENGINE_AUTH_TOKEN = "test-gateway-token";
  const seen = [];
  const replies = [
    {
      code: "Ok",
      data_version: "2026-07-25T00:00:00Z",
      distances: [
        [0, 8000, 2000],
        [8000, 0, 3000],
        [2000, 3000, 0],
      ],
      durations: [
        [0, 900, 240],
        [900, 0, 360],
        [240, 360, 0],
      ],
    },
    {
      code: "Ok",
      waypoints: [
        { location: [100.55, 13.72], distance: 0 },
        { location: [100.49, 13.81], distance: 0 },
        { location: [100.52, 13.75], distance: 0 },
        { location: [100.55, 13.72], distance: 0 },
      ],
      routes: [
        {
          distance: 13_400,
          duration: 1_620,
          geometry: {
            type: "LineString",
            coordinates: [
              [100.55, 13.72],
              [100.49, 13.81],
              [100.52, 13.75],
              [100.55, 13.72],
            ],
          },
        },
      ],
    },
  ];
  const fetcher = async (url, options) => {
    seen.push({ url: String(url), options });
    return Response.json(replies.shift());
  };

  try {
    const result = await optimizeRoadRoute(
      {
        depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
        stops: [
          { id: "5501", lat: 13.75, lon: 100.52 },
          { id: "5502", lat: 13.81, lon: 100.49 },
        ],
        avoidTolls: true,
      },
      fetcher,
    );
    assert.deepEqual(result.order, ["5502", "5501"]);
    assert.equal(result.distanceKm, 13.4);
    assert.equal(result.durationMinutes, 27);
    assert.equal(result.engineMode, "configured");
    assert.equal(result.dataVersion, "2026-07-25T00:00:00Z");
    assert.equal(result.dataVersionSource, "engine-response");
    assert.equal(result.geometry.type, "LineString");
    assert.match(seen[0].url, /\/table\/v1\/driving\//);
    assert.match(seen[0].url, /100\.55000000,13\.72000000/);
    assert.match(seen[0].url, /exclude=toll/);
    assert.match(seen[1].url, /\/route\/v1\/driving\//);
    assert.match(seen[1].url, /exclude=toll/);
    assert.equal(
      seen[0].options.headers.Authorization,
      "Bearer test-gateway-token",
    );
    assert.equal(seen[0].options.redirect, "error");
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.ROUTING_ENGINE_AUTH_TOKEN;
    else process.env.ROUTING_ENGINE_AUTH_TOKEN = previousToken;
  }
});

test("production road preview requires immutable routing data version", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  const previousDataVersion = process.env.ROUTING_ENGINE_DATA_VERSION;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.ROUTING_ENGINE_URL = "https://routing.example.test";
  delete process.env.ROUTING_ENGINE_DATA_VERSION;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      () =>
        optimizeRoadRoute(
          {
            depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
            stops: [{ id: "5501", lat: 13.75, lon: 100.52 }],
          },
          async () => {
            throw new Error("fetch must not run");
          },
        ),
      (error) =>
        error instanceof RoutingError &&
        error.code === "routing_data_version_not_configured",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
    if (previousDataVersion === undefined) {
      delete process.env.ROUTING_ENGINE_DATA_VERSION;
    } else {
      process.env.ROUTING_ENGINE_DATA_VERSION = previousDataVersion;
    }
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test("production road preview rejects a release label without a SHA-256 identity", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  const previousDataVersion = process.env.ROUTING_ENGINE_DATA_VERSION;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.ROUTING_ENGINE_URL = "https://routing.example.test";
  process.env.ROUTING_ENGINE_DATA_VERSION = "osm-thailand-2026-07-25";
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      () =>
        optimizeRoadRoute(
          {
            depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
            stops: [{ id: "5501", lat: 13.75, lon: 100.52 }],
          },
          async () => {
            throw new Error("fetch must not run");
          },
        ),
      (error) =>
        error instanceof RoutingError &&
        error.code === "routing_data_version_not_immutable",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
    if (previousDataVersion === undefined) {
      delete process.env.ROUTING_ENGINE_DATA_VERSION;
    } else {
      process.env.ROUTING_ENGINE_DATA_VERSION = previousDataVersion;
    }
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test("production road preview fails closed without a controlled engine", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  const previousEnvironment = process.env.NODE_ENV;
  delete process.env.ROUTING_ENGINE_URL;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      () =>
        optimizeRoadRoute(
          {
            depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
            stops: [{ id: "5501", lat: 13.75, lon: 100.52 }],
          },
          async () => {
            throw new Error("fetch must not run");
          },
        ),
      (error) =>
        error instanceof RoutingError &&
        error.code === "routing_not_configured",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test("production road preview rejects public community and loopback engines", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  const previousDataVersion = process.env.ROUTING_ENGINE_DATA_VERSION;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.ROUTING_ENGINE_DATA_VERSION = controlledDataVersion;
  process.env.NODE_ENV = "production";
  try {
    for (const engineUrl of [
      "https://router.project-osrm.org",
      "http://127.0.0.1:5000",
    ]) {
      process.env.ROUTING_ENGINE_URL = engineUrl;
      await assert.rejects(
        () =>
          optimizeRoadRoute(
            {
              depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
              stops: [{ id: "5501", lat: 13.75, lon: 100.52 }],
            },
            async () => {
              throw new Error("fetch must not run");
            },
          ),
        (error) =>
          error instanceof RoutingError &&
          error.code === "routing_engine_not_controlled",
      );
    }
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
    if (previousDataVersion === undefined) {
      delete process.env.ROUTING_ENGINE_DATA_VERSION;
    } else {
      process.env.ROUTING_ENGINE_DATA_VERSION = previousDataVersion;
    }
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test("production road preview rejects engine data-version drift", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  const previousDataVersion = process.env.ROUTING_ENGINE_DATA_VERSION;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.ROUTING_ENGINE_URL = "https://routing.example.test";
  process.env.ROUTING_ENGINE_DATA_VERSION = controlledDataVersion;
  process.env.NODE_ENV = "production";
  const replies = [
    {
      code: "Ok",
      data_version: driftedDataVersion,
      distances: [
        [0, 1000],
        [1000, 0],
      ],
      durations: [
        [0, 120],
        [120, 0],
      ],
    },
    {
      code: "Ok",
      data_version: driftedDataVersion,
      waypoints: [
        { location: [100.55, 13.72], distance: 0 },
        { location: [100.52, 13.75], distance: 0 },
        { location: [100.55, 13.72], distance: 0 },
      ],
      routes: [
        {
          distance: 2000,
          duration: 240,
          geometry: {
            type: "LineString",
            coordinates: [
              [100.55, 13.72],
              [100.52, 13.75],
              [100.55, 13.72],
            ],
          },
        },
      ],
    },
  ];
  try {
    await assert.rejects(
      () =>
        optimizeRoadRoute(
          {
            depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
            stops: [{ id: "5501", lat: 13.75, lon: 100.52 }],
          },
          async () => Response.json(replies.shift()),
        ),
      (error) =>
        error instanceof RoutingError &&
        error.code === "routing_data_version_mismatch",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
    if (previousDataVersion === undefined) {
      delete process.env.ROUTING_ENGINE_DATA_VERSION;
    } else {
      process.env.ROUTING_ENGINE_DATA_VERSION = previousDataVersion;
    }
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
});

test("road optimizer rejects an unreachable cell instead of treating it as zero", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  process.env.ROUTING_ENGINE_URL = "https://routing.example.test";
  const fetcher = async () =>
    Response.json({
      code: "Ok",
      distances: [
        [0, null],
        [1000, 0],
      ],
      durations: [
        [0, null],
        [120, 0],
      ],
    });

  try {
    await assert.rejects(
      () =>
        optimizeRoadRoute(
          {
            depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
            stops: [{ id: "5501", lat: 13.75, lon: 100.52 }],
          },
          fetcher,
        ),
      (error) =>
        error instanceof RoutingError &&
        error.code === "routing_unreachable",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
  }
});

test("road optimizer rejects geometry that does not traverse ordered waypoints", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  process.env.ROUTING_ENGINE_URL = "https://routing.example.test";
  const replies = [
    {
      code: "Ok",
      distances: [
        [0, 1000],
        [1000, 0],
      ],
      durations: [
        [0, 120],
        [120, 0],
      ],
    },
    {
      code: "Ok",
      waypoints: [
        { location: [100.55, 13.72], distance: 0 },
        { location: [100.52, 13.75], distance: 0 },
        { location: [100.55, 13.72], distance: 0 },
      ],
      routes: [
        {
          distance: 2000,
          duration: 240,
          geometry: {
            type: "LineString",
            coordinates: [
              [100.55, 13.72],
              [100.70, 13.90],
              [100.55, 13.72],
            ],
          },
        },
      ],
    },
  ];
  try {
    await assert.rejects(
      () =>
        optimizeRoadRoute(
          {
            depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
            stops: [{ id: "5501", lat: 13.75, lon: 100.52 }],
          },
          async () => Response.json(replies.shift()),
        ),
      (error) =>
        error instanceof RoutingError &&
        error.code === "routing_geometry_order_invalid",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
  }
});

test("road optimizer does not relay external engine diagnostics to clients", async () => {
  const previousUrl = process.env.ROUTING_ENGINE_URL;
  process.env.ROUTING_ENGINE_URL = "https://routing.example.test";
  try {
    await assert.rejects(
      () =>
        optimizeRoadRoute(
          {
            depot: { id: "WH-KT", lat: 13.72, lon: 100.55 },
            stops: [{ id: "5501", lat: 13.75, lon: 100.52 }],
          },
          async () =>
            Response.json(
              {
                code: "InvalidQuery",
                message: "private gateway topology and stack trace",
              },
              { status: 400 },
            ),
        ),
      (error) =>
        error instanceof RoutingError &&
        error.code === "routing_upstream_error" &&
        error.message === "Road engine rejected the request" &&
        !error.message.includes("topology"),
    );
  } finally {
    if (previousUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = previousUrl;
  }
});
