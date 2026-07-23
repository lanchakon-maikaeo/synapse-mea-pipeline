from __future__ import annotations

from decimal import Decimal
from datetime import date
from uuid import UUID

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class FlexibleRecord(BaseModel):
    model_config = ConfigDict(extra="allow")


class ErrorDetail(BaseModel):
    code: str
    message: str
    request_id: str
    details: Any | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "synapse-api"
    version: str = "v1"


class ReadinessHealthResponse(HealthResponse):
    database: str = "ready"


class CurrentUserResponse(BaseModel):
    user_id: UUID
    role: str
    district_id: str | None


class ContractStatusResponse(FlexibleRecord):
    contract_id: int
    purchase_order: int
    contract_status: str
    source_item_count: int


class DataQualitySummaryResponse(FlexibleRecord):
    batch_id: UUID
    source_entity: str
    rule_code: str
    severity: str
    issue_count: int


class MaterialReferenceResponse(FlexibleRecord):
    material_id: str
    material_name: str | None = None
    unit: str | None = None


class DistrictReferenceResponse(FlexibleRecord):
    district_id: str
    sap_plant_code: str
    district_name_th: str


class VmiInputSubmissionResponse(FlexibleRecord):
    submission_id: UUID
    batch_id: UUID
    material_id: str
    district_id: str
    input_month_count: int
    status: str
    created_at: datetime


class StockHealthResponse(FlexibleRecord):
    material_id: str
    district_id: str
    current_stock_qty: Decimal
    health_band: str


class ReplenishmentQueueResponse(FlexibleRecord):
    replenishment_plan_id: UUID
    replenishment_item_id: UUID
    material_id: str
    district_id: str
    plan_status: str
    item_status: str


class ForecastResultResponse(FlexibleRecord):
    forecast_run_id: UUID
    material_id: str
    district_id: str
    forecast_period: date
    model_version: str
    predicted_quantity: Decimal


class ForecastMonitoringResponse(FlexibleRecord):
    forecast_run_id: UUID
    status: str
    created_at: datetime


class JobStatusResponse(FlexibleRecord):
    job_id: UUID
    job_type: str
    status: str
    attempt_count: int
    max_attempts: int


class RouteSummaryResponse(FlexibleRecord):
    route_plan_id: UUID
    status: str
    solver_status: str
    served_stop_count: int
    unserved_stop_count: int


class RoutePlanDetailResponse(BaseModel):
    summary: RouteSummaryResponse
    geojson: dict[str, Any] | None


class Wave3ReadinessResponse(FlexibleRecord):
    forecast_operational_ready: bool
    route_operational_ready: bool
    checked_at: datetime


class OperationsHealthResponse(FlexibleRecord):
    open_alert_count: int
    failed_job_count_24h: int
    stale_source_count: int
    latest_backup_status: str | None


class SystemAlertResponse(FlexibleRecord):
    alert_id: UUID
    alert_type: str
    severity: str
    status: str
    message: str
    created_at: datetime


class ReplenishmentRunRequest(BaseModel):
    snapshot_cutoff_at: str | None = None


class VmiDemandPoint(BaseModel):
    period: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    demand_quantity: Decimal = Field(ge=0)
    stockout_days: int = Field(default=0, ge=0, le=31)
    lead_time_days: Decimal | None = Field(default=None, ge=0)


class VmiInputRequest(BaseModel):
    material_id: str = Field(min_length=1, max_length=100)
    district_id: str = Field(pattern=r"^55(0[1-9]|1[0-8])$")
    snapshot_at: datetime
    current_stock: Decimal = Field(ge=0)
    source_note: str = Field(min_length=3, max_length=500)
    history: list[VmiDemandPoint] = Field(min_length=3, max_length=36)
    run_replenishment: bool = False


class ConfirmItemRequest(BaseModel):
    confirmed_qty: Decimal = Field(ge=0)
    reason: str = Field(min_length=1, max_length=1000)


class RunResponse(BaseModel):
    replenishment_run_id: UUID


class PlanResponse(BaseModel):
    replenishment_plan_id: UUID


class ForecastRunRequest(BaseModel):
    training_end: date
    training_start: date | None = None
    horizon_months: int = Field(default=3, ge=1, le=24)


class ForecastRunResponse(BaseModel):
    forecast_run_id: UUID


class RouteJobRequest(BaseModel):
    replenishment_plan_id: UUID
    forecast_run_id: UUID | None = None
    matrix_source: str = Field(default="valhalla", pattern="^(valhalla|haversine-test)$")


class RouteJobResponse(BaseModel):
    route_job_id: UUID


class RouteReviewRequest(BaseModel):
    decision: str = Field(pattern="^(approved|rejected)$")
    reason: str | None = Field(default=None, max_length=1000)


class RoutePlanResponse(BaseModel):
    route_plan_id: UUID
