const jsonResponse = {
  description: "Successful response",
  content: { "application/json": { schema: {} } },
};

const errorResponses = {
  "401": { description: "Unauthorized" },
  "403": { description: "Forbidden" },
  "409": { description: "State or evidence conflict" },
  "410": { description: "Retired or fail-closed operation" },
  "413": { description: "Payload too large" },
  "422": { description: "Validation error" },
  "423": { description: "Production operational writes are locked" },
  "429": { description: "Rate limited" },
  "500": { description: "Internal error" },
  "502": { description: "Invalid or unavailable upstream response" },
  "503": { description: "Dependency or production configuration unavailable" },
};

const requestIdHeader = {
  name: "X-Request-ID",
  in: "header",
  required: true,
  description:
    "Actor-scoped idempotency key. Reuse it only to resume the same plan request; a retry after a terminal failure or cancellation requires a new value.",
  schema: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z0-9_-]+$",
  },
};

const responseRequestIdHeader = {
  description: "Request correlation identifier",
  schema: { type: "string", minLength: 1, maxLength: 64 },
};

const routeOptimizationJobResponse = (description: string) => ({
  description,
  headers: { "X-Request-ID": responseRequestIdHeader },
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/RouteOptimizationJob" },
    },
  },
});

const routeOptimizationNotFound = {
  description: "Actor-owned route optimization job not found",
  headers: { "X-Request-ID": responseRequestIdHeader },
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiError" },
    },
  },
};

const get = (summary: string, secured = true) => ({
  get: {
    summary,
    ...(secured ? { security: [{ bearerAuth: [] }] } : {}),
    responses: { "200": jsonResponse, ...errorResponses },
  },
});

const post = (
  summary: string,
  status = "200",
  schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: true,
  },
) => ({
  post: {
    summary,
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: { "application/json": { schema } },
    },
    responses: { [status]: jsonResponse, ...errorResponses },
  },
});

const blockedPost = (summary: string, description: string) => ({
  post: {
    ...post(summary).post,
    responses: {
      ...errorResponses,
      "410": { description },
    },
  },
});

export const m09OpenApi = {
  openapi: "3.1.0",
  info: {
    title: "SYNAPSE API",
    version: "1.3.0",
    description:
      "Production warehouse and governed transport API, including the Valhalla + OR-Tools optimization queue. Forecasting, legacy route-job namespaces and RAG remain excluded.",
  },
  servers: [{ url: "/api" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Supabase JWT",
      },
    },
    schemas: {
      ApiError: {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: {
          error: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "request_id", "details"],
            properties: {
              code: { type: "string", minLength: 1 },
              message: { type: "string", minLength: 1 },
              request_id: { type: "string", minLength: 1, maxLength: 64 },
              details: {},
            },
          },
        },
      },
      QueueRouteOptimizationRequest: {
        type: "object",
        additionalProperties: false,
        required: ["replenishment_plan_id"],
        properties: {
          replenishment_plan_id: { type: "string", format: "uuid" },
          forecast_run_id: {
            oneOf: [
              { type: "string", format: "uuid" },
              { type: "null" },
            ],
          },
          matrix_source: {
            type: "string",
            enum: ["valhalla"],
            default: "valhalla",
          },
        },
      },
      RouteOptimizationJobError: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "retryable"],
        properties: {
          code: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1 },
          retryable: { type: "boolean" },
        },
      },
      RouteOptimizationJob: {
        type: "object",
        additionalProperties: false,
        required: [
          "route_job_id",
          "job_id",
          "replenishment_plan_id",
          "algorithm_version",
          "matrix_source",
          "status",
        ],
        properties: {
          route_job_id: { type: "string", format: "uuid" },
          job_id: { type: "string", format: "uuid" },
          replenishment_plan_id: { type: "string", format: "uuid" },
          forecast_run_id: {
            oneOf: [
              { type: "string", format: "uuid" },
              { type: "null" },
            ],
          },
          algorithm_version: { type: "string", minLength: 1 },
          matrix_source: { type: "string", enum: ["valhalla"] },
          status: {
            type: "string",
            enum: ["queued", "running", "succeeded", "failed", "cancelled"],
          },
          attempt_count: { type: "integer", minimum: 0 },
          max_attempts: { type: "integer", minimum: 1 },
          result: {
            oneOf: [
              { type: "object", additionalProperties: true },
              { type: "null" },
            ],
          },
          error: {
            oneOf: [
              { $ref: "#/components/schemas/RouteOptimizationJobError" },
              { type: "null" },
            ],
          },
          route_plan_id: {
            oneOf: [
              { type: "string", format: "uuid" },
              { type: "null" },
            ],
          },
          route_plan_status: {
            oneOf: [{ type: "string" }, { type: "null" }],
          },
          created_at: { type: "string", format: "date-time" },
          started_at: {
            oneOf: [
              { type: "string", format: "date-time" },
              { type: "null" },
            ],
          },
          finished_at: {
            oneOf: [
              { type: "string", format: "date-time" },
              { type: "null" },
            ],
          },
          idempotent_replay: { type: "boolean" },
        },
      },
    },
  },
  paths: {
    "/health": get("Process health", false),
    "/health/ready": get("Supabase database readiness", false),
    "/v1/me": get("Current application identity"),
    "/v1/contracts": get("Contract status"),
    "/v1/data-quality": get("Data quality summary"),
    "/v1/reference/materials": get("Supabase material master"),
    "/v1/warehouse-stock": get("Latest real warehouse stock snapshots"),
    "/v1/data-sources/legacy/status": get(
      "Legacy actual-source lineage and readiness",
    ),
    "/v1/admin/import/legacy": post(
      "Import a governed chunk from a legacy actual source",
    ),
    "/v1/admin/packaging-profiles": {
      get: get("Published FIFO packaging master profiles").get,
      post: post("Upsert packaging dimensions, pallet capacity and weight").post,
    },
    "/v1/admin/fifo-opening": post(
      "Publish packaging master, opening handling units and warehouse stock snapshot",
      "201",
    ),
    "/v1/reference/districts": get("Supabase district master"),
    "/v1/data-inputs/vmi": {
      get: get("Recent governed VMI inputs").get,
      post: post("Publish stock and demand observations", "201").post,
    },
    "/v1/data-inputs/vmi/context": get("Existing Supabase VMI context"),
    "/v1/stock-health": get("Stock health"),
    "/v1/replenishment/queue": get("Weekly replenishment queue"),
    "/v1/replenishment/recommendations": get(
      "Rule-based quantity recommendations with evidence",
    ),
    "/v1/replenishment/change-requests": get(
      "District quantity changes and abnormal-request review",
    ),
    "/v1/replenishment/approvals": get("Immutable plan approval timeline"),
    "/v1/replenishment/runs": post("Create weekly replenishment run", "201"),
    "/v1/replenishment/items/{item_id}/respond": post(
      "Confirm, reject or change a district replenishment item",
    ),
    "/v1/replenishment/change-requests/{change_request_id}/review": post(
      "Review a district quantity change",
    ),
    "/v1/replenishment/plans/{plan_id}/approve": post(
      "Advance Planner or Academic approval",
    ),
    "/v1/replenishment/plans/{plan_id}/cancel": post(
      "Cancel a plan and release reservations",
    ),
    "/v1/replenishment/plans/{plan_id}/version": post(
      "Create a governed version from a locked plan",
      "201",
    ),
    "/v1/replenishment/plans/{plan_id}/issue": post(
      "Issue a locked weekly plan",
    ),
    "/v1/inventory/fifo": get("Traceable FIFO handling-unit queue"),
    "/v1/inventory/handling-units": get(
      "All handling units, including blocked opening stock",
    ),
    "/v1/inventory/receipt-options": get(
      "Current contract items eligible for receipt",
    ),
    "/v1/inventory/receipts": post("Receive a handling unit", "201"),
    "/v1/inventory/returns": post(
      "Return or quarantine an issued quantity",
      "201",
    ),
    "/v1/inventory/handling-units/{handling_unit_id}/reconcile": post(
      "Reconcile OPENING_UNKNOWN stock",
    ),
    "/v1/ad-hoc/issues": {
      get: get("Ad-hoc issue queue").get,
      post: post("Create a separate ad-hoc issue", "201").post,
    },
    "/v1/ad-hoc/issues/{ad_hoc_issue_id}/approve": post(
      "Approve and reserve an ad-hoc issue",
    ),
    "/v1/ad-hoc/issues/{ad_hoc_issue_id}/issue": post(
      "Issue an approved ad-hoc request",
    ),
    "/v1/traceability": get(
      "Forward and reverse issue traceback from district to vendor",
    ),
    "/v1/operations/health": get("Operations health"),
    "/v1/operations/readiness": get(
      "Production data, identity, recovery and cutover gates",
    ),
    "/v1/operations/alerts": get("Operations alerts"),
    "/v1/transport/warehouses": get("Active transport depots"),
    "/v1/transport/readiness": get(
      "Transport geocode, fleet, tariff and optimizer readiness",
    ),
    "/v1/transport/geo": get(
      "Governed transport locations and coordinate verification state",
    ),
    "/v1/transport/vehicles": get("Active governed transport fleet"),
    "/v1/transport/route-matrix": get(
      "Legacy radial route references; not road-route evidence",
    ),
    "/v1/transport/dispatch-queue": get(
      "Locked replenishment demand eligible for transport planning",
    ),
    "/v1/transport/trips": {
      get: get("Recent transport trips").get,
      post: blockedPost(
        "Trip creation is fail-closed pending reviewed route-plan activation",
        "Route plans can retain road evidence, but route-plan to trip activation is not configured",
      ).post,
    },
    "/v1/transport/trips/{trip_id}/status": post(
      "Apply a legal transition only to road-verified trips; legacy trips may only be cancelled",
    ),
    "/v1/transport/optimize": post(
      "Build an authenticated heuristic preview from a real-road matrix",
      "200",
      {
        type: "object",
        additionalProperties: false,
        required: [
          "replenishment_plan_id",
          "depot",
          "stops",
          "objective",
          "avoidTolls",
        ],
        properties: {
          replenishment_plan_id: { type: "string", format: "uuid" },
          depot: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string", minLength: 1 } },
          },
          stops: {
            type: "array",
            minItems: 1,
            maxItems: 18,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id"],
              properties: { id: { type: "string", minLength: 1 } },
            },
          },
          objective: { type: "string", enum: ["duration", "distance"] },
          avoidTolls: { type: "boolean" },
        },
      },
    ),
    "/v1/transport/optimization-jobs": {
      post: {
        summary:
          "Queue one exact locked replenishment plan for governed Valhalla + OR-Tools optimization",
        security: [{ bearerAuth: [] }],
        parameters: [requestIdHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/QueueRouteOptimizationRequest",
              },
            },
          },
        },
        responses: {
          ...errorResponses,
          "202": routeOptimizationJobResponse(
            "Route optimization job accepted or idempotently resumed",
          ),
        },
      },
    },
    "/v1/transport/optimization-jobs/{route_job_id}": {
      get: {
        summary:
          "Read an actor-owned governed route optimization job and its route-plan result",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "route_job_id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          ...errorResponses,
          "200": routeOptimizationJobResponse(
            "Current governed route optimization job state",
          ),
          "404": routeOptimizationNotFound,
        },
      },
    },
  },
};
