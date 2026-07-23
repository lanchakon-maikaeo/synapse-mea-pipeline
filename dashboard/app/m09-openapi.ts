const jsonResponse = {
  description: "Successful response",
  content: { "application/json": { schema: {} } },
};

const errorResponses = {
  "401": { description: "Unauthorized" },
  "403": { description: "Forbidden" },
  "422": { description: "Validation error" },
  "429": { description: "Rate limited" },
};

const get = (summary: string, secured = true) => ({
  get: {
    summary,
    ...(secured ? { security: [{ bearerAuth: [] }] } : {}),
    responses: { "200": jsonResponse, ...errorResponses },
  },
});

const post = (summary: string, status = "200") => ({
  post: {
    summary,
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: false,
      content: { "application/json": { schema: { type: "object" } } },
    },
    responses: { [status]: jsonResponse, ...errorResponses },
  },
});

export const m09OpenApi = {
  openapi: "3.1.0",
  info: {
    title: "SYNAPSE API",
    version: "1.0.0",
    description:
      "Serverless same-origin API for SYNAPSE release 1.0.0-non-ai",
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
    "/v1/reference/districts": get("Supabase district master"),
    "/v1/data-inputs/vmi": {
      get: get("Recent governed VMI inputs").get,
      post: post("Publish stock and demand observations", "201").post,
    },
    "/v1/data-inputs/vmi/context": get("Existing Supabase VMI context"),
    "/v1/stock-health": get("Stock health"),
    "/v1/replenishment/queue": get("Replenishment queue"),
    "/v1/replenishment/runs": post("Create replenishment run", "201"),
    "/v1/replenishment/items/{item_id}/confirm": post(
      "Confirm replenishment item",
    ),
    "/v1/replenishment/plans/{plan_id}/approve": post(
      "Approve replenishment plan",
    ),
    "/v1/forecasts/latest": get("Latest forecasts"),
    "/v1/forecasts/monitoring": get("Forecast monitoring"),
    "/v1/forecasts/runs": post("Queue forecast run", "202"),
    "/v1/jobs": get("Background jobs"),
    "/v1/jobs/{job_id}": get("Background job status"),
    "/v1/routes/jobs": post("Queue route job", "202"),
    "/v1/routes/plans": get("Route plans"),
    "/v1/routes/plans/{route_plan_id}": get("Route plan detail"),
    "/v1/routes/plans/{route_plan_id}/review": post("Review route plan"),
    "/v1/wave3/readiness": get("Wave 3 readiness"),
    "/v1/operations/health": get("Operations health"),
    "/v1/operations/alerts": get("Operations alerts"),
  },
};
