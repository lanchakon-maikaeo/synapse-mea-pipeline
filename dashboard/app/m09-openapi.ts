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
    version: "1.1.0",
    description:
      "Production warehouse operations API. Forecasting, routing and RAG are excluded from this release.",
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
    "/v1/operations/alerts": get("Operations alerts"),
  },
};
