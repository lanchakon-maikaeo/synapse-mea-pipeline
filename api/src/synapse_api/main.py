from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
import secrets
import time
from typing import Annotated, Any, Callable
from uuid import UUID, uuid4

import jwt
from jwt import PyJWKClient
import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .models import (
    ConfirmItemRequest,
    ContractStatusResponse,
    CurrentUserResponse,
    DataQualitySummaryResponse,
    DistrictReferenceResponse,
    ErrorResponse,
    FlexibleRecord,
    ForecastMonitoringResponse,
    ForecastResultResponse,
    ForecastRunRequest,
    ForecastRunResponse,
    HealthResponse,
    JobStatusResponse,
    MaterialReferenceResponse,
    OperationsHealthResponse,
    PlanResponse,
    ReadinessHealthResponse,
    ReplenishmentQueueResponse,
    ReplenishmentRunRequest,
    RouteJobRequest,
    RouteJobResponse,
    RoutePlanDetailResponse,
    RoutePlanResponse,
    RouteReviewRequest,
    RouteSummaryResponse,
    RunResponse,
    StockHealthResponse,
    SystemAlertResponse,
    VmiInputRequest,
    VmiInputSubmissionResponse,
    Wave3ReadinessResponse,
)
from .observability import ApiMetrics, SlidingWindowRateLimiter, log_event
from .settings import Settings


@dataclass(frozen=True)
class CurrentUser:
    user_id: UUID
    role: str
    district_id: str | None


def create_app(
    settings: Settings | None = None,
    connection_factory: Callable[[], Any] | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_environment()
    limiter = SlidingWindowRateLimiter(resolved_settings.rate_limit_per_minute)
    metrics = ApiMetrics()
    jwks_client = PyJWKClient(resolved_settings.supabase_jwks_url, lifespan=300) if resolved_settings.supabase_jwks_url else None
    expected_issuer = f"{resolved_settings.supabase_url}/auth/v1" if resolved_settings.supabase_url else None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = resolved_settings
        yield

    error_responses = {
        401: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        423: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    }
    app = FastAPI(
        title="SYNAPSE API",
        version="1.0.0",
        lifespan=lifespan,
        responses=error_responses,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def connect():
        if connection_factory is not None:
            return connection_factory()
        return psycopg.connect(resolved_settings.database_url, row_factory=dict_row)

    def request_id(request: Request) -> str:
        return getattr(request.state, "request_id", "unknown")

    def error_payload(request: Request, code: str, message: str, details: Any = None) -> dict:
        return {"error": {"code": code, "message": message, "request_id": request_id(request), "details": details}}

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        code = {
            400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
            409: "conflict", 413: "payload_too_large", 423: "production_not_ready",
            429: "rate_limited", 503: "service_unavailable",
        }.get(exc.status_code, "http_error")
        return JSONResponse(error_payload(request, code, str(exc.detail)), status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(
            error_payload(request, "validation_error", "Request validation failed", exc.errors()),
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    @app.exception_handler(Exception)
    async def unexpected_exception_handler(request: Request, exc: Exception):
        log_event("unhandled_exception", request_id=request_id(request), path=request.url.path, error_type=type(exc).__name__)
        return JSONResponse(
            error_payload(request, "internal_error", "An unexpected error occurred"),
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    @app.middleware("http")
    async def operational_middleware(request: Request, call_next):
        supplied_id = request.headers.get("X-Request-ID", "")
        request.state.request_id = supplied_id if supplied_id and len(supplied_id) <= 64 and supplied_id.replace("-", "").replace("_", "").isalnum() else str(uuid4())
        started = time.perf_counter()
        path = request.url.path
        exempt = path in ("/health", "/health/ready", "/metrics", "/openapi.json") or path.startswith("/docs")
        if request.method in ("POST", "PUT", "PATCH"):
            body = await request.body()
            if len(body) > resolved_settings.max_request_body_bytes:
                response = JSONResponse(
                    error_payload(request, "payload_too_large", "Request body exceeds configured limit"),
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                )
                response.headers["X-Request-ID"] = request.state.request_id
                return response
        client_key = request.client.host if request.client else "unknown"
        if not exempt and not limiter.allow(client_key):
            response = JSONResponse(
                error_payload(request, "rate_limited", "Too many requests"),
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                headers={"Retry-After": "60"},
            )
        else:
            response = await call_next(request)
        duration = time.perf_counter() - started
        metrics.observe(request.method, path, response.status_code, duration)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        log_event(
            "api_request",
            request_id=request.state.request_id,
            environment=resolved_settings.environment,
            method=request.method,
            path=path,
            status=response.status_code,
            duration_ms=round(duration * 1000, 2),
        )
        return response

    def current_user(authorization: Annotated[str | None, Header()] = None) -> CurrentUser:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
        token = authorization.removeprefix("Bearer ")
        try:
            header = jwt.get_unverified_header(token)
            algorithm = header.get("alg")
            decode_options: dict[str, Any] = {"audience": "authenticated"}
            if expected_issuer:
                decode_options["issuer"] = expected_issuer
            if algorithm == "HS256" and resolved_settings.supabase_jwt_secret:
                claims = jwt.decode(token, resolved_settings.supabase_jwt_secret, algorithms=["HS256"], **decode_options)
            elif algorithm in ("ES256", "RS256") and jwks_client is not None:
                signing_key = jwks_client.get_signing_key_from_jwt(token)
                claims = jwt.decode(token, signing_key.key, algorithms=[algorithm], **decode_options)
            else:
                raise jwt.InvalidAlgorithmError("Unsupported or unconfigured JWT algorithm")
            user_id = UUID(claims["sub"])
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from exc
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select role::text, district_id from public.user_profiles where user_id = %s and is_active", (str(user_id),))
            profile = cursor.fetchone()
        if not profile:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No application role is assigned")
        return CurrentUser(user_id=user_id, role=profile["role"], district_id=profile["district_id"])

    def require_roles(*allowed: str):
        def dependency(user: CurrentUser = Depends(current_user)) -> CurrentUser:
            if user.role not in allowed:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient application role")
            return user
        return dependency

    def set_request_user(cursor, user: CurrentUser) -> None:
        cursor.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user.user_id),))
        cursor.execute("select set_config('request.jwt.claim.role', 'authenticated', true)")

    @app.get("/health", response_model=HealthResponse, tags=["operations"])
    def health() -> HealthResponse:
        return HealthResponse()

    @app.get("/health/ready", response_model=ReadinessHealthResponse, tags=["operations"])
    def readiness_health() -> ReadinessHealthResponse:
        try:
            with connect() as connection, connection.cursor() as cursor:
                cursor.execute("select 1 as ok")
                cursor.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database is not ready") from exc
        return ReadinessHealthResponse()

    @app.get("/metrics", response_class=PlainTextResponse, include_in_schema=False)
    def prometheus_metrics(
        x_metrics_token: Annotated[str | None, Header(alias="X-Metrics-Token")] = None,
        authorization: Annotated[str | None, Header()] = None,
    ) -> str:
        if not resolved_settings.metrics_token:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Metrics token is not configured")
        supplied = x_metrics_token
        if not supplied and authorization and authorization.startswith("Bearer "):
            supplied = authorization.removeprefix("Bearer ")
        if not supplied or not secrets.compare_digest(supplied, resolved_settings.metrics_token):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid metrics token")
        return metrics.render()

    @app.get("/v1/me", response_model=CurrentUserResponse, tags=["identity"])
    def me(user: CurrentUser = Depends(current_user)) -> CurrentUserResponse:
        return CurrentUserResponse(user_id=user.user_id, role=user.role, district_id=user.district_id)

    @app.get("/v1/contracts", response_model=list[ContractStatusResponse], tags=["contracts"])
    def contracts(
        search: str | None = Query(default=None, max_length=100),
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        user: CurrentUser = Depends(require_roles("admin", "planner", "viewer")),
    ) -> list[dict]:
        query = "select * from analytics.v_contract_status"
        params: list[Any] = []
        if search:
            query += " where purchase_order::text ilike %s or coalesce(contract_number,'') ilike %s or coalesce(vendor_name,'') ilike %s"
            term = f"%{search}%"
            params.extend([term, term, term])
        query += " order by updated_at desc, purchase_order limit %s offset %s"
        params.extend([limit, offset])
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, tuple(params))
            return list(cursor.fetchall())

    @app.get("/v1/data-quality", response_model=list[DataQualitySummaryResponse], tags=["data-quality"])
    def data_quality(
        limit: int = Query(default=100, ge=1, le=500),
        user: CurrentUser = Depends(require_roles("admin", "planner", "viewer")),
    ) -> list[dict]:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select * from analytics.v_data_quality_summary order by last_detected_at desc limit %s", (limit,))
            return list(cursor.fetchall())

    @app.get("/v1/reference/materials", response_model=list[MaterialReferenceResponse], tags=["reference"])
    def material_references(
        search: str | None = Query(default=None, max_length=100),
        limit: int = Query(default=1000, ge=1, le=2000),
        user: CurrentUser = Depends(current_user),
    ) -> list[dict]:
        query = "select material_id, sap_material_id, material_name, category, unit, lot_size, moq, data_quality_status from core.materials"
        params: list[Any] = []
        if search:
            query += " where material_id ilike %s or coalesce(material_name,'') ilike %s"
            params.extend([f"%{search}%", f"%{search}%"])
        query += " order by is_vmi desc, material_id limit %s"
        params.append(limit)
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, tuple(params))
            return list(cursor.fetchall())

    @app.get("/v1/warehouse-stock", response_model=list[FlexibleRecord], tags=["stock"])
    def warehouse_stock(
        request: Request,
        limit: int = Query(default=500, ge=1, le=1000),
        user: CurrentUser = Depends(current_user),
    ) -> list[dict]:
        with connect() as connection, connection.cursor() as cursor:
            set_request_user(cursor, user)
            cursor.execute(
                "select public.m11_legacy_dispatch('GET', '/v1/warehouse-stock', %s::jsonb, '{}'::jsonb, %s) as result",
                (Jsonb({"limit": str(limit)}), request_id(request)),
            )
            result = cursor.fetchone()["result"]
        return result["body"]

    @app.get("/v1/data-sources/legacy/status", response_model=FlexibleRecord, tags=["operations"])
    def legacy_source_status(request: Request, user: CurrentUser = Depends(current_user)) -> dict:
        with connect() as connection, connection.cursor() as cursor:
            set_request_user(cursor, user)
            cursor.execute(
                "select public.m11_legacy_dispatch('GET', '/v1/data-sources/legacy/status', '{}'::jsonb, '{}'::jsonb, %s) as result",
                (request_id(request),),
            )
            result = cursor.fetchone()["result"]
        return result["body"]

    @app.post("/v1/admin/import/legacy", response_model=FlexibleRecord, tags=["data-input"])
    def import_legacy_source(
        request: Request,
        payload: dict[str, Any],
        user: CurrentUser = Depends(require_roles("admin")),
    ) -> dict:
        with connect() as connection, connection.cursor() as cursor:
            set_request_user(cursor, user)
            cursor.execute(
                "select public.m11_legacy_dispatch('POST', '/v1/admin/import/legacy', '{}'::jsonb, %s::jsonb, %s) as result",
                (Jsonb(payload), request_id(request)),
            )
            result = cursor.fetchone()["result"]
        if int(result.get("status", 500)) >= 400:
            raise HTTPException(status_code=int(result["status"]), detail=result.get("body", {}).get("error", {}).get("message", "Legacy import failed"))
        return result["body"]

    @app.get("/v1/reference/districts", response_model=list[DistrictReferenceResponse], tags=["reference"])
    def district_references(user: CurrentUser = Depends(current_user)) -> list[dict]:
        query = "select district_id, sap_plant_code, district_name_th from core.districts where is_active"
        params: tuple = ()
        if user.role == "district":
            query += " and district_id=%s"
            params = (user.district_id,)
        query += " order by district_id"
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, params)
            return list(cursor.fetchall())

    @app.get("/v1/data-inputs/vmi", response_model=list[VmiInputSubmissionResponse], tags=["data-input"])
    def vmi_input_submissions(
        limit: int = Query(default=50, ge=1, le=200),
        user: CurrentUser = Depends(current_user),
    ) -> list[dict]:
        query = """
          select s.submission_id, s.batch_id, s.material_id, m.material_name,
                 s.district_id, d.district_name_th, s.source_note, s.input_month_count,
                 s.stock_snapshot_id, s.usage_rate_id, s.replenishment_run_id,
                 s.submitted_by, s.status, s.created_at
          from ops.web_input_submissions s
          join core.materials m using (material_id)
          join core.districts d using (district_id)
        """
        params: list[Any] = []
        if user.role == "district":
            query += " where s.district_id=%s"
            params.append(user.district_id)
        query += " order by s.created_at desc limit %s"
        params.append(limit)
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, tuple(params))
            return list(cursor.fetchall())

    @app.get("/v1/data-inputs/vmi/context", response_model=FlexibleRecord, tags=["data-input"])
    def vmi_input_context(
        material_id: str = Query(min_length=1, max_length=100),
        district_id: str = Query(pattern=r"^55(0[1-9]|1[0-8])$"),
        user: CurrentUser = Depends(current_user),
    ) -> dict:
        if user.role == "district" and user.district_id != district_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="District scope does not match the user profile")
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select material_id, material_name, unit, lot_size, moq, data_quality_status from core.materials where material_id=%s", (material_id,))
            material = cursor.fetchone()
            cursor.execute("select district_id, sap_plant_code, district_name_th from core.districts where district_id=%s and is_active", (district_id,))
            district = cursor.fetchone()
            if not material or not district:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Material or district was not found")
            cursor.execute("""
              select ss.quantity_on_hand, ss.snapshot_at, ss.source_batch_id
              from core.stock_snapshots ss join core.locations l using (location_id)
              where ss.material_id=%s and l.district_id=%s order by ss.snapshot_at desc limit 1
            """, (material_id, district_id))
            stock = cursor.fetchone()
            cursor.execute("""
              select cmp_monthly, avg_4m, avg_6m, avg_12m, as_of_date, source_batch_id
              from core.usage_rates where material_id=%s and district_id=%s order by as_of_date desc limit 1
            """, (material_id, district_id))
            usage_rate = cursor.fetchone()
            cursor.execute("""
              select period_start, demand_quantity, stockout_days, lead_time_days, source_batch_id
              from analytics.demand_monthly_features
              where material_id=%s and district_id=%s and feature_version='monthly-demand-v1'
              order by period_start desc limit 36
            """, (material_id, district_id))
            history = list(reversed(cursor.fetchall()))
        return {"material": material, "district": district, "stock": stock, "usage_rate": usage_rate, "history": history}

    @app.post("/v1/data-inputs/vmi", response_model=FlexibleRecord, status_code=status.HTTP_201_CREATED, tags=["data-input"])
    def publish_vmi_input(payload: VmiInputRequest, user: CurrentUser = Depends(require_roles("admin", "planner"))) -> dict:
        periods = [point.period for point in payload.history]
        if len(set(periods)) != len(periods):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="History contains duplicate months")
        with connect() as connection, connection.cursor() as cursor:
            set_request_user(cursor, user)
            cursor.execute("select core.publish_vmi_web_input(%s::jsonb) as result", (Jsonb(payload.model_dump(mode="json")),))
            return cursor.fetchone()["result"]

    @app.get("/v1/stock-health", response_model=list[StockHealthResponse], tags=["stock"])
    def stock_health(user: CurrentUser = Depends(current_user)) -> list[dict]:
        query = "select * from analytics.v_stock_health"
        params: tuple = ()
        if user.role == "district":
            query += " where district_id = %s"
            params = (user.district_id,)
        query += " order by months_available nulls last, district_id, material_id"
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, params)
            return list(cursor.fetchall())

    @app.get("/v1/replenishment/queue", response_model=list[ReplenishmentQueueResponse], tags=["replenishment"])
    def replenishment_queue(user: CurrentUser = Depends(current_user)) -> list[dict]:
        query = "select * from analytics.v_replenishment_queue"
        params: tuple = ()
        if user.role == "district":
            query += " where district_id = %s"
            params = (user.district_id,)
        query += " order by priority_score desc, district_id, material_id"
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, params)
            return list(cursor.fetchall())

    @app.post("/v1/replenishment/runs", response_model=RunResponse, status_code=status.HTTP_201_CREATED, tags=["replenishment"])
    def create_run(payload: ReplenishmentRunRequest, user: CurrentUser = Depends(require_roles("admin", "planner"))) -> RunResponse:
        with connect() as connection, connection.cursor() as cursor:
            set_request_user(cursor, user)
            cursor.execute("select core.create_replenishment_run(%s::timestamptz) as replenishment_run_id", (payload.snapshot_cutoff_at,))
            row = cursor.fetchone()
        return RunResponse(replenishment_run_id=row["replenishment_run_id"])

    @app.post("/v1/replenishment/items/{item_id}/confirm", tags=["replenishment"])
    def confirm_item(item_id: UUID, payload: ConfirmItemRequest, user: CurrentUser = Depends(require_roles("admin", "planner", "district"))) -> dict:
        with connect() as connection, connection.cursor() as cursor:
            set_request_user(cursor, user)
            cursor.execute("select to_jsonb(core.confirm_replenishment_item(%s, %s, %s)) as item", (str(item_id), payload.confirmed_qty, payload.reason))
            return cursor.fetchone()["item"]

    @app.post("/v1/replenishment/plans/{plan_id}/approve", response_model=PlanResponse, tags=["replenishment"])
    def approve_plan(plan_id: UUID, user: CurrentUser = Depends(require_roles("admin", "planner"))) -> PlanResponse:
        with connect() as connection, connection.cursor() as cursor:
            set_request_user(cursor, user)
            cursor.execute("select (core.approve_replenishment_plan(%s)).replenishment_plan_id", (str(plan_id),))
            row = cursor.fetchone()
        return PlanResponse(replenishment_plan_id=row["replenishment_plan_id"])

    @app.get("/v1/forecasts/latest", response_model=list[ForecastResultResponse], tags=["forecast"])
    def latest_forecasts(user: CurrentUser = Depends(current_user)) -> list[dict]:
        query = "select * from analytics.v_latest_forecasts"
        params: tuple = ()
        if user.role == "district":
            query += " where district_id = %s"
            params = (user.district_id,)
        query += " order by forecast_period, district_id, material_id"
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, params)
            return list(cursor.fetchall())

    @app.get("/v1/forecasts/monitoring", response_model=list[ForecastMonitoringResponse], tags=["forecast"])
    def forecast_monitoring(user: CurrentUser = Depends(require_roles("admin", "planner", "viewer"))) -> list[dict]:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select * from analytics.v_forecast_monitoring order by created_at desc nulls last")
            return list(cursor.fetchall())

    @app.post("/v1/forecasts/runs", response_model=ForecastRunResponse, status_code=status.HTTP_202_ACCEPTED, tags=["forecast"])
    def queue_forecast(payload: ForecastRunRequest, user: CurrentUser = Depends(require_roles("admin", "planner"))) -> ForecastRunResponse:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select forecast_operational_ready from analytics.v_wave3_readiness")
            if not cursor.fetchone()["forecast_operational_ready"]:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Forecast history is not operationally ready")
            set_request_user(cursor, user)
            cursor.execute(
                "select analytics.queue_forecast_run(%s, %s, %s) as forecast_run_id",
                (payload.training_end, payload.horizon_months, payload.training_start),
            )
            row = cursor.fetchone()
        return ForecastRunResponse(forecast_run_id=row["forecast_run_id"])

    @app.get("/v1/jobs", response_model=list[JobStatusResponse], tags=["jobs"])
    def jobs(
        job_status_filter: str | None = Query(default=None, alias="status", pattern="^(queued|running|succeeded|failed|cancelled)$"),
        limit: int = Query(default=50, ge=1, le=200),
        user: CurrentUser = Depends(require_roles("admin", "planner", "viewer")),
    ) -> list[dict]:
        query = "select job_id, job_type, status, attempt_count, max_attempts, result, error_message, created_at, started_at, finished_at from ops.background_jobs"
        params: list[Any] = []
        if job_status_filter:
            query += " where status=%s"
            params.append(job_status_filter)
        query += " order by created_at desc limit %s"
        params.append(limit)
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(query, tuple(params))
            return list(cursor.fetchall())

    @app.get("/v1/jobs/{job_id}", response_model=JobStatusResponse, tags=["jobs"])
    def job_status(job_id: UUID, user: CurrentUser = Depends(require_roles("admin", "planner", "viewer"))) -> dict:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "select job_id, job_type, status, attempt_count, max_attempts, result, error_message, created_at, started_at, finished_at from ops.background_jobs where job_id=%s",
                (str(job_id),),
            )
            row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
        return row

    @app.post("/v1/routes/jobs", response_model=RouteJobResponse, status_code=status.HTTP_202_ACCEPTED, tags=["routes"])
    def queue_route(
        request: Request,
        payload: RouteJobRequest,
        user: CurrentUser = Depends(require_roles("admin", "planner")),
    ) -> RouteJobResponse:
        try:
            with connect() as connection, connection.cursor() as cursor:
                set_request_user(cursor, user)
                cursor.execute(
                    "select core.queue_route_job(%s, %s, %s, %s) as route_job_id",
                    (
                        str(payload.replenishment_plan_id),
                        str(payload.forecast_run_id) if payload.forecast_run_id else None,
                        payload.matrix_source,
                        request_id(request),
                    ),
                )
                row = cursor.fetchone()
        except psycopg.errors.CheckViolation as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Route job failed governed locked-plan, geocode or fleet preflight",
            ) from exc
        except psycopg.errors.UniqueViolation as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Request ID is already bound to a different route-job request",
            ) from exc
        except psycopg.errors.ObjectNotInPrerequisiteState as exc:
            raise HTTPException(
                status_code=423,
                detail="Operational writes are locked until Production cutover gates pass",
            ) from exc
        except psycopg.errors.InsufficientPrivilege as exc:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only planner or admin may queue routes",
            ) from exc
        return RouteJobResponse(route_job_id=row["route_job_id"])

    @app.get("/v1/routes/plans", response_model=list[RouteSummaryResponse], tags=["routes"])
    def route_plans(
        limit: int = Query(default=50, ge=1, le=200),
        user: CurrentUser = Depends(require_roles("admin", "planner", "viewer")),
    ) -> list[dict]:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select * from analytics.v_route_plan_summary order by created_at desc limit %s", (limit,))
            return list(cursor.fetchall())

    @app.get("/v1/routes/plans/{route_plan_id}", response_model=RoutePlanDetailResponse, tags=["routes"])
    def route_plan(route_plan_id: UUID, user: CurrentUser = Depends(require_roles("admin", "planner", "viewer"))) -> dict:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select * from analytics.v_route_plan_summary where route_plan_id=%s", (str(route_plan_id),))
            summary = cursor.fetchone()
            if not summary:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Route plan not found")
            cursor.execute("select geojson from analytics.v_route_plan_geojson where route_plan_id=%s", (str(route_plan_id),))
            geojson = cursor.fetchone()
        return {"summary": summary, "geojson": geojson["geojson"] if geojson else None}

    @app.post("/v1/routes/plans/{route_plan_id}/review", response_model=RoutePlanResponse, tags=["routes"])
    def review_route(route_plan_id: UUID, payload: RouteReviewRequest, user: CurrentUser = Depends(require_roles("admin", "planner"))) -> RoutePlanResponse:
        with connect() as connection, connection.cursor() as cursor:
            set_request_user(cursor, user)
            cursor.execute(
                "select (core.review_route_plan(%s, %s, %s)).route_plan_id",
                (str(route_plan_id), payload.decision, payload.reason),
            )
            row = cursor.fetchone()
        return RoutePlanResponse(route_plan_id=row["route_plan_id"])

    @app.get("/v1/wave3/readiness", response_model=Wave3ReadinessResponse, tags=["operations"])
    def wave3_readiness(user: CurrentUser = Depends(require_roles("admin", "planner", "viewer"))) -> dict:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select * from analytics.v_wave3_readiness")
            return cursor.fetchone()

    @app.get("/v1/operations/health", response_model=OperationsHealthResponse, tags=["operations"])
    def operations_health(user: CurrentUser = Depends(require_roles("admin", "planner", "viewer"))) -> dict:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("select * from analytics.v_operations_health")
            return cursor.fetchone()

    @app.get("/v1/operations/alerts", response_model=list[SystemAlertResponse], tags=["operations"])
    def operations_alerts(
        limit: int = Query(default=50, ge=1, le=200),
        user: CurrentUser = Depends(require_roles("admin", "planner")),
    ) -> list[dict]:
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "select alert_id, alert_type, severity, status, message, details, created_at, acknowledged_at from ops.system_alerts order by created_at desc limit %s",
                (limit,),
            )
            return list(cursor.fetchall())

    return app


app = create_app()
