CREATE TYPE "ops"."allocation_status" AS ENUM('PROPOSED', 'RESERVED', 'PICKED', 'ISSUED', 'RELEASED');--> statement-breakpoint
CREATE TYPE "ops"."approval_stage" AS ENUM('PLANNER', 'ACADEMIC_OFFICER');--> statement-breakpoint
CREATE TYPE "ops"."plan_status" AS ENUM('DRAFT', 'CALCULATED', 'DISTRICT_REVIEW', 'PLANNER_APPROVED', 'ACADEMIC_APPROVED', 'LOCKED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "ops"."recommendation_method" AS ENUM('POLICY_ONLY', 'HISTORY_ASSISTED', 'MANUAL_REVIEW');--> statement-breakpoint
CREATE TYPE "ops"."request_risk_level" AS ENUM('NORMAL', 'WATCH', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "ops"."review_decision" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "ops"."district_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"recommendation_id" uuid,
	"original_qty" numeric(20, 3) NOT NULL,
	"requested_qty" numeric(20, 3) NOT NULL,
	"delta_percent" numeric(12, 4),
	"projected_months" numeric(12, 3),
	"risk_level" "ops"."request_risk_level" DEFAULT 'NORMAL' NOT NULL,
	"risk_signals" jsonb NOT NULL,
	"reason" text NOT NULL,
	"requested_by_name" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"decision" "ops"."review_decision" DEFAULT 'PENDING' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "district_change_requests_qty_nonnegative" CHECK ("ops"."district_change_requests"."original_qty" >= 0 and "ops"."district_change_requests"."requested_qty" >= 0 and ("ops"."district_change_requests"."projected_months" is null or "ops"."district_change_requests"."projected_months" >= 0)),
	CONSTRAINT "district_change_requests_reason_present" CHECK (length(trim("ops"."district_change_requests"."reason")) >= 10 and length(trim("ops"."district_change_requests"."requested_by_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "ops"."fifo_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"receipt_lot_id" uuid NOT NULL,
	"handling_unit_id" uuid NOT NULL,
	"allocation_sequence" integer NOT NULL,
	"allocated_qty" numeric(20, 3) NOT NULL,
	"remain_before_qty" numeric(20, 3) NOT NULL,
	"remain_after_qty" numeric(20, 3) NOT NULL,
	"status" "ops"."allocation_status" DEFAULT 'PROPOSED' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fifo_allocations_values_valid" CHECK ("ops"."fifo_allocations"."allocation_sequence" > 0 and "ops"."fifo_allocations"."allocated_qty" > 0 and "ops"."fifo_allocations"."remain_before_qty" >= 0 and "ops"."fifo_allocations"."remain_after_qty" >= 0 and "ops"."fifo_allocations"."remain_after_qty" = "ops"."fifo_allocations"."remain_before_qty" - "ops"."fifo_allocations"."allocated_qty")
);
--> statement-breakpoint
CREATE TABLE "ops"."plan_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"stage" "ops"."approval_stage" NOT NULL,
	"decision_sequence" integer DEFAULT 1 NOT NULL,
	"decision" "ops"."review_decision" NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_approvals_sequence_positive" CHECK ("ops"."plan_approvals"."decision_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "ops"."quantity_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"method" "ops"."recommendation_method" NOT NULL,
	"engine_version" varchar(50) NOT NULL,
	"history_start_date" date,
	"history_end_date" date,
	"history_sample_size" integer DEFAULT 0 NOT NULL,
	"last_issued_qty" numeric(20, 3),
	"mean_issued_qty" numeric(20, 3),
	"median_issued_qty" numeric(20, 3),
	"p90_issued_qty" numeric(20, 3),
	"lower_bound_qty" numeric(20, 3),
	"recommended_qty" numeric(20, 3) NOT NULL,
	"upper_bound_qty" numeric(20, 3),
	"confidence_score" numeric(5, 4),
	"evidence" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quantity_recommendations_values_valid" CHECK ("ops"."quantity_recommendations"."history_sample_size" >= 0 and "ops"."quantity_recommendations"."recommended_qty" >= 0 and ("ops"."quantity_recommendations"."confidence_score" is null or ("ops"."quantity_recommendations"."confidence_score" >= 0 and "ops"."quantity_recommendations"."confidence_score" <= 1)))
);
--> statement-breakpoint
CREATE TABLE "ops"."replenishment_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"district_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"district_stock_qty" numeric(20, 3) NOT NULL,
	"cmp_qty" numeric(20, 3) NOT NULL,
	"months_remaining" numeric(12, 3),
	"min_target_qty" numeric(20, 3),
	"max_target_qty" numeric(20, 3),
	"policy_suggested_qty" numeric(20, 3),
	"final_approved_qty" numeric(20, 3),
	"requires_special_approval" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replenishment_plan_items_nonnegative" CHECK ("ops"."replenishment_plan_items"."district_stock_qty" >= 0 and "ops"."replenishment_plan_items"."cmp_qty" >= 0 and ("ops"."replenishment_plan_items"."months_remaining" is null or "ops"."replenishment_plan_items"."months_remaining" >= 0) and ("ops"."replenishment_plan_items"."min_target_qty" is null or "ops"."replenishment_plan_items"."min_target_qty" >= 0) and ("ops"."replenishment_plan_items"."max_target_qty" is null or "ops"."replenishment_plan_items"."max_target_qty" >= 0) and ("ops"."replenishment_plan_items"."policy_suggested_qty" is null or "ops"."replenishment_plan_items"."policy_suggested_qty" >= 0) and ("ops"."replenishment_plan_items"."final_approved_qty" is null or "ops"."replenishment_plan_items"."final_approved_qty" >= 0))
);
--> statement-breakpoint
CREATE TABLE "ops"."replenishment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_no" varchar(50) NOT NULL,
	"week_start_date" date NOT NULL,
	"warehouse_location_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"version_no" integer DEFAULT 1 NOT NULL,
	"status" "ops"."plan_status" DEFAULT 'DRAFT' NOT NULL,
	"source_stock_batch_id" uuid,
	"source_usage_batch_id" uuid,
	"created_by" text NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replenishment_plans_version_positive" CHECK ("ops"."replenishment_plans"."version_no" > 0)
);
--> statement-breakpoint
ALTER TABLE "ops"."district_change_requests" ADD CONSTRAINT "district_change_requests_plan_item_id_replenishment_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "ops"."replenishment_plan_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."district_change_requests" ADD CONSTRAINT "district_change_requests_recommendation_id_quantity_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "ops"."quantity_recommendations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."fifo_allocations" ADD CONSTRAINT "fifo_allocations_plan_item_id_replenishment_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "ops"."replenishment_plan_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."fifo_allocations" ADD CONSTRAINT "fifo_allocations_receipt_lot_id_receipt_lots_id_fk" FOREIGN KEY ("receipt_lot_id") REFERENCES "core"."receipt_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."fifo_allocations" ADD CONSTRAINT "fifo_allocations_handling_unit_id_handling_units_id_fk" FOREIGN KEY ("handling_unit_id") REFERENCES "core"."handling_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."plan_approvals" ADD CONSTRAINT "plan_approvals_plan_id_replenishment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "ops"."replenishment_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."quantity_recommendations" ADD CONSTRAINT "quantity_recommendations_plan_item_id_replenishment_plan_items_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "ops"."replenishment_plan_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plan_items" ADD CONSTRAINT "replenishment_plan_items_plan_id_replenishment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "ops"."replenishment_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plan_items" ADD CONSTRAINT "replenishment_plan_items_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "core"."districts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plan_items" ADD CONSTRAINT "replenishment_plan_items_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "core"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plans" ADD CONSTRAINT "replenishment_plans_warehouse_location_id_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "core"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plans" ADD CONSTRAINT "replenishment_plans_policy_id_calculation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "ops"."calculation_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plans" ADD CONSTRAINT "replenishment_plans_source_stock_batch_id_import_batches_id_fk" FOREIGN KEY ("source_stock_batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plans" ADD CONSTRAINT "replenishment_plans_source_usage_batch_id_import_batches_id_fk" FOREIGN KEY ("source_usage_batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "district_change_requests_queue_idx" ON "ops"."district_change_requests" USING btree ("decision","risk_level","created_at");--> statement-breakpoint
CREATE INDEX "district_change_requests_item_idx" ON "ops"."district_change_requests" USING btree ("plan_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fifo_allocations_item_sequence_uq" ON "ops"."fifo_allocations" USING btree ("plan_item_id","allocation_sequence");--> statement-breakpoint
CREATE INDEX "fifo_allocations_unit_status_idx" ON "ops"."fifo_allocations" USING btree ("handling_unit_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_approvals_stage_sequence_uq" ON "ops"."plan_approvals" USING btree ("plan_id","stage","decision_sequence");--> statement-breakpoint
CREATE INDEX "plan_approvals_plan_time_idx" ON "ops"."plan_approvals" USING btree ("plan_id","decided_at");--> statement-breakpoint
CREATE INDEX "quantity_recommendations_item_time_idx" ON "ops"."quantity_recommendations" USING btree ("plan_item_id","generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_plan_items_scope_uq" ON "ops"."replenishment_plan_items" USING btree ("plan_id","district_id","material_id");--> statement-breakpoint
CREATE INDEX "replenishment_plan_items_district_idx" ON "ops"."replenishment_plan_items" USING btree ("district_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_plans_no_version_uq" ON "ops"."replenishment_plans" USING btree ("plan_no","version_no");--> statement-breakpoint
CREATE INDEX "replenishment_plans_week_status_idx" ON "ops"."replenishment_plans" USING btree ("week_start_date","status");
--> statement-breakpoint
CREATE TRIGGER "replenishment_plans_set_updated_at"
BEFORE UPDATE ON "ops"."replenishment_plans"
FOR EACH ROW EXECUTE FUNCTION "ops"."set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "replenishment_plan_items_set_updated_at"
BEFORE UPDATE ON "ops"."replenishment_plan_items"
FOR EACH ROW EXECUTE FUNCTION "ops"."set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "quantity_recommendations_append_only"
BEFORE UPDATE OR DELETE ON "ops"."quantity_recommendations"
FOR EACH ROW EXECUTE FUNCTION "ops"."reject_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "plan_approvals_append_only"
BEFORE UPDATE OR DELETE ON "ops"."plan_approvals"
FOR EACH ROW EXECUTE FUNCTION "ops"."reject_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "fifo_allocations_append_only"
BEFORE UPDATE OR DELETE ON "ops"."fifo_allocations"
FOR EACH ROW EXECUTE FUNCTION "ops"."reject_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "replenishment_plans_audit"
AFTER INSERT OR UPDATE OR DELETE ON "ops"."replenishment_plans"
FOR EACH ROW EXECUTE FUNCTION "audit"."capture_core_change"();
--> statement-breakpoint
CREATE TRIGGER "replenishment_plan_items_audit"
AFTER INSERT OR UPDATE OR DELETE ON "ops"."replenishment_plan_items"
FOR EACH ROW EXECUTE FUNCTION "audit"."capture_core_change"();
--> statement-breakpoint
CREATE TRIGGER "district_change_requests_audit"
AFTER INSERT OR UPDATE OR DELETE ON "ops"."district_change_requests"
FOR EACH ROW EXECUTE FUNCTION "audit"."capture_core_change"();
--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."replenishment_plan_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."quantity_recommendations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."district_change_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."plan_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."fifo_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE VIEW "analytics"."v_issue_traceback" AS
SELECT
  allocation.id AS allocation_id,
  plan.plan_no,
  plan.version_no AS plan_version,
  plan.status AS plan_status,
  district.district_code,
  district.name_th AS district_name_th,
  material.material_code,
  material.description AS material_description,
  item.final_approved_qty,
  allocation.allocation_sequence,
  allocation.allocated_qty,
  allocation.remain_before_qty,
  allocation.remain_after_qty,
  allocation.status AS allocation_status,
  handling_unit.handling_unit_code,
  handling_unit.unit_type,
  receipt_lot.lot_code,
  receipt_lot.fifo_date,
  receipt_lot.receipt_sequence AS delivery_installment,
  contract.purchase_order_no,
  contract.contract_no,
  contract_item.po_item_no,
  contract_item.installment_no,
  vendor.alias_code AS vendor_alias,
  vendor.display_name AS vendor_display_name
FROM "ops"."fifo_allocations" allocation
JOIN "ops"."replenishment_plan_items" item ON item.id = allocation.plan_item_id
JOIN "ops"."replenishment_plans" plan ON plan.id = item.plan_id
JOIN "core"."districts" district ON district.id = item.district_id
JOIN "core"."materials" material ON material.id = item.material_id
JOIN "core"."handling_units" handling_unit ON handling_unit.id = allocation.handling_unit_id
JOIN "core"."receipt_lots" receipt_lot ON receipt_lot.id = allocation.receipt_lot_id
LEFT JOIN "core"."contract_items" contract_item ON contract_item.id = receipt_lot.contract_item_id
LEFT JOIN "core"."contracts" contract ON contract.id = contract_item.contract_id
LEFT JOIN "core"."vendor_aliases" vendor ON vendor.id = contract.vendor_alias_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW "analytics"."v_quantity_suggestion_evidence" AS
SELECT
  recommendation.id AS recommendation_id,
  plan.plan_no,
  plan.version_no AS plan_version,
  district.district_code,
  material.material_code,
  item.district_stock_qty,
  item.cmp_qty,
  item.months_remaining,
  item.policy_suggested_qty,
  recommendation.method,
  recommendation.engine_version,
  recommendation.history_start_date,
  recommendation.history_end_date,
  recommendation.history_sample_size,
  recommendation.last_issued_qty,
  recommendation.mean_issued_qty,
  recommendation.median_issued_qty,
  recommendation.p90_issued_qty,
  recommendation.lower_bound_qty,
  recommendation.recommended_qty,
  recommendation.upper_bound_qty,
  recommendation.confidence_score,
  recommendation.evidence,
  recommendation.generated_at
FROM "ops"."quantity_recommendations" recommendation
JOIN "ops"."replenishment_plan_items" item ON item.id = recommendation.plan_item_id
JOIN "ops"."replenishment_plans" plan ON plan.id = item.plan_id
JOIN "core"."districts" district ON district.id = item.district_id
JOIN "core"."materials" material ON material.id = item.material_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW "analytics"."v_abnormal_request_queue" AS
SELECT
  request.id AS request_id,
  request.decision,
  request.risk_level,
  request.risk_signals,
  request.original_qty,
  request.requested_qty,
  request.delta_percent,
  request.projected_months,
  request.reason,
  request.requested_by_name,
  request.requested_by_user_id,
  request.created_at,
  request.reviewed_by,
  request.reviewed_at,
  request.review_reason,
  plan.plan_no,
  plan.version_no AS plan_version,
  district.district_code,
  district.name_th AS district_name_th,
  material.material_code,
  item.district_stock_qty,
  item.cmp_qty,
  item.max_target_qty,
  item.requires_special_approval,
  recommendation.median_issued_qty,
  recommendation.p90_issued_qty,
  recommendation.history_sample_size
FROM "ops"."district_change_requests" request
JOIN "ops"."replenishment_plan_items" item ON item.id = request.plan_item_id
JOIN "ops"."replenishment_plans" plan ON plan.id = item.plan_id
JOIN "core"."districts" district ON district.id = item.district_id
JOIN "core"."materials" material ON material.id = item.material_id
LEFT JOIN "ops"."quantity_recommendations" recommendation ON recommendation.id = request.recommendation_id;
