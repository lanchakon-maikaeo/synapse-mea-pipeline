CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE SCHEMA "core";
--> statement-breakpoint
CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE SCHEMA "raw";
--> statement-breakpoint
CREATE TYPE "core"."handling_unit_status" AS ENUM('AVAILABLE', 'RESERVED', 'EMPTY', 'QUARANTINE', 'CLOSED');--> statement-breakpoint
CREATE TYPE "core"."handling_unit_type" AS ENUM('FULL_PALLET', 'BOX', 'CRATE', 'BUNDLE', 'LOOSE', 'LONG_MATERIAL');--> statement-breakpoint
CREATE TYPE "raw"."import_entity_type" AS ENUM('STOCK', 'USAGE', 'CONTRACT', 'VENDOR');--> statement-breakpoint
CREATE TYPE "raw"."import_status" AS ENUM('RECEIVED', 'VALIDATING', 'ACCEPTED', 'PARTIAL', 'REJECTED');--> statement-breakpoint
CREATE TYPE "ops"."issue_severity" AS ENUM('INFO', 'WARNING', 'ERROR');--> statement-breakpoint
CREATE TYPE "core"."location_type" AS ENUM('WAREHOUSE', 'DISTRICT');--> statement-breakpoint
CREATE TYPE "core"."movement_type" AS ENUM('OPENING', 'RECEIPT', 'RESERVE', 'RELEASE', 'ISSUE', 'RETURN', 'TRANSFER', 'ADJUSTMENT', 'QUARANTINE');--> statement-breakpoint
CREATE TYPE "core"."packaging_quality" AS ENUM('DUMMY', 'ESTIMATED', 'VERIFIED');--> statement-breakpoint
CREATE TYPE "core"."source_quality" AS ENUM('VERIFIED', 'SOURCE_DERIVED', 'OPENING_UNKNOWN');--> statement-breakpoint
CREATE TABLE "ops"."calculation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_version" varchar(30) NOT NULL,
	"trigger_months" numeric(6, 2) NOT NULL,
	"min_target_months" numeric(6, 2) NOT NULL,
	"reference_months" numeric(6, 2) NOT NULL,
	"max_target_months" numeric(6, 2) NOT NULL,
	"special_approval_months" numeric(6, 2) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calculation_policy_order_valid" CHECK ("ops"."calculation_policies"."reference_months" <= "ops"."calculation_policies"."trigger_months" and "ops"."calculation_policies"."trigger_months" <= "ops"."calculation_policies"."min_target_months" and "ops"."calculation_policies"."min_target_months" <= "ops"."calculation_policies"."max_target_months" and "ops"."calculation_policies"."max_target_months" <= "ops"."calculation_policies"."special_approval_months")
);
--> statement-breakpoint
CREATE TABLE "audit"."change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_name" text NOT NULL,
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"action" varchar(20) NOT NULL,
	"before_data" jsonb,
	"after_data" jsonb,
	"reason" text,
	"actor" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."contract_item_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_item_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"row_checksum" varchar(64) NOT NULL,
	"ordered_qty" numeric(20, 3) NOT NULL,
	"planned_delivery_date" date,
	"accepted_date" date,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"source_batch_id" uuid NOT NULL,
	"source_row_id" uuid NOT NULL,
	CONSTRAINT "contract_item_versions_version_positive" CHECK ("core"."contract_item_versions"."version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."contract_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"po_item_no" integer NOT NULL,
	"installment_no" integer NOT NULL,
	"ordered_qty" numeric(20, 3) NOT NULL,
	"planned_delivery_date" date,
	"accepted_date" date,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"not_seen_in_latest_batch" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source_batch_id" uuid NOT NULL,
	"source_row_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_items_po_item_positive" CHECK ("core"."contract_items"."po_item_no" > 0 and "core"."contract_items"."installment_no" > 0),
	CONSTRAINT "contract_items_ordered_qty_positive" CHECK ("core"."contract_items"."ordered_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_no" varchar(60) NOT NULL,
	"contract_no" varchar(100) NOT NULL,
	"procurement_code" varchar(100),
	"vendor_alias_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"not_seen_in_latest_batch" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."districts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"district_code" varchar(20) NOT NULL,
	"name_en" text NOT NULL,
	"name_th" text NOT NULL,
	"plant_code" varchar(10) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."handling_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handling_unit_code" varchar(50) NOT NULL,
	"receipt_lot_id" uuid NOT NULL,
	"unit_type" "core"."handling_unit_type" NOT NULL,
	"parent_handling_unit_id" uuid,
	"initial_qty" numeric(20, 3) NOT NULL,
	"on_hand_qty" numeric(20, 3) NOT NULL,
	"reserved_qty" numeric(20, 3) DEFAULT '0' NOT NULL,
	"physical_location_code" varchar(100),
	"is_virtual" boolean DEFAULT true NOT NULL,
	"status" "core"."handling_unit_status" DEFAULT 'AVAILABLE' NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handling_units_qty_valid" CHECK ("core"."handling_units"."initial_qty" >= 0 and "core"."handling_units"."on_hand_qty" >= 0 and "core"."handling_units"."reserved_qty" >= 0 and "core"."handling_units"."reserved_qty" <= "core"."handling_units"."on_hand_qty")
);
--> statement-breakpoint
CREATE TABLE "raw"."import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "raw"."import_entity_type" NOT NULL,
	"source_file_name" text NOT NULL,
	"source_sheet" text,
	"file_checksum" varchar(64) NOT NULL,
	"source_business_date" date,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"status" "raw"."import_status" DEFAULT 'RECEIVED' NOT NULL,
	CONSTRAINT "import_batches_counts_nonnegative" CHECK ("raw"."import_batches"."row_count" >= 0 and "raw"."import_batches"."accepted_count" >= 0 and "raw"."import_batches"."rejected_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ops"."import_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_row_id" uuid,
	"severity" "ops"."issue_severity" NOT NULL,
	"field_name" text,
	"issue_code" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movement_type" "core"."movement_type" NOT NULL,
	"handling_unit_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"quantity_delta" numeric(20, 3) NOT NULL,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"sap_document_no" varchar(100),
	"business_reference_type" varchar(50),
	"business_reference_id" uuid,
	"reversal_of_movement_id" uuid,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"source_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_delta_nonzero" CHECK ("core"."inventory_movements"."quantity_delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "core"."locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_type" "core"."location_type" NOT NULL,
	"plant_code" varchar(10) NOT NULL,
	"storage_location_code" varchar(10) NOT NULL,
	"district_id" uuid,
	"name_en" text NOT NULL,
	"name_th" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_code" varchar(40) NOT NULL,
	"description" text,
	"base_unit" varchar(20),
	"active" boolean DEFAULT true NOT NULL,
	"source_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."packaging_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"unit_type" "core"."handling_unit_type" NOT NULL,
	"units_per_handling_unit" numeric(20, 3) NOT NULL,
	"length_m" numeric(10, 3),
	"width_m" numeric(10, 3),
	"height_m" numeric(10, 3),
	"gross_weight_kg" numeric(12, 3),
	"stackable" boolean DEFAULT false NOT NULL,
	"side_loadable" boolean DEFAULT true NOT NULL,
	"forklift_required" boolean DEFAULT false NOT NULL,
	"maximum_stack_layers" integer DEFAULT 1 NOT NULL,
	"data_quality" "core"."packaging_quality" DEFAULT 'DUMMY' NOT NULL,
	"source_note" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packaging_profiles_units_positive" CHECK ("core"."packaging_profiles"."units_per_handling_unit" > 0 and "core"."packaging_profiles"."maximum_stack_layers" > 0),
	CONSTRAINT "packaging_profiles_dimensions_positive" CHECK (("core"."packaging_profiles"."length_m" is null or "core"."packaging_profiles"."length_m" > 0) and ("core"."packaging_profiles"."width_m" is null or "core"."packaging_profiles"."width_m" > 0) and ("core"."packaging_profiles"."height_m" is null or "core"."packaging_profiles"."height_m" > 0) and ("core"."packaging_profiles"."gross_weight_kg" is null or "core"."packaging_profiles"."gross_weight_kg" > 0))
);
--> statement-breakpoint
CREATE TABLE "core"."receipt_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_code" varchar(50) NOT NULL,
	"material_id" uuid NOT NULL,
	"contract_item_id" uuid,
	"warehouse_location_id" uuid NOT NULL,
	"receipt_reference" varchar(100),
	"receipt_sequence" integer DEFAULT 1 NOT NULL,
	"fifo_date" date,
	"received_qty" numeric(20, 3) NOT NULL,
	"opening_qty" numeric(20, 3) NOT NULL,
	"source_quality" "core"."source_quality" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_lots_qty_nonnegative" CHECK ("core"."receipt_lots"."received_qty" >= 0 and "core"."receipt_lots"."opening_qty" >= 0),
	CONSTRAINT "receipt_lots_sequence_positive" CHECK ("core"."receipt_lots"."receipt_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "raw"."source_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"entity_name" text NOT NULL,
	"source_row_number" integer NOT NULL,
	"row_payload" jsonb NOT NULL,
	"row_checksum" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_rows_row_number_positive" CHECK ("raw"."source_rows"."source_row_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."stock_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"unrestricted_qty" numeric(20, 3) NOT NULL,
	"source_missing" boolean DEFAULT false NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_row_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_snapshots_unrestricted_nonnegative" CHECK ("core"."stock_snapshots"."unrestricted_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."usage_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"district_id" uuid NOT NULL,
	"usage_month" date NOT NULL,
	"usage_qty" numeric(20, 3) NOT NULL,
	"source_was_dash" boolean DEFAULT false NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_row_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_qty_nonnegative" CHECK ("core"."usage_observations"."usage_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "core"."vendor_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias_code" varchar(30) NOT NULL,
	"display_name" text NOT NULL,
	"is_dummy" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."contract_item_versions" ADD CONSTRAINT "contract_item_versions_contract_item_id_contract_items_id_fk" FOREIGN KEY ("contract_item_id") REFERENCES "core"."contract_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_item_versions" ADD CONSTRAINT "contract_item_versions_source_batch_id_import_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_item_versions" ADD CONSTRAINT "contract_item_versions_source_row_id_source_rows_id_fk" FOREIGN KEY ("source_row_id") REFERENCES "raw"."source_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_items" ADD CONSTRAINT "contract_items_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "core"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_items" ADD CONSTRAINT "contract_items_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "core"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_items" ADD CONSTRAINT "contract_items_source_batch_id_import_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contract_items" ADD CONSTRAINT "contract_items_source_row_id_source_rows_id_fk" FOREIGN KEY ("source_row_id") REFERENCES "raw"."source_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contracts" ADD CONSTRAINT "contracts_vendor_alias_id_vendor_aliases_id_fk" FOREIGN KEY ("vendor_alias_id") REFERENCES "core"."vendor_aliases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."handling_units" ADD CONSTRAINT "handling_units_receipt_lot_id_receipt_lots_id_fk" FOREIGN KEY ("receipt_lot_id") REFERENCES "core"."receipt_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."import_issues" ADD CONSTRAINT "import_issues_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."import_issues" ADD CONSTRAINT "import_issues_source_row_id_source_rows_id_fk" FOREIGN KEY ("source_row_id") REFERENCES "raw"."source_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."inventory_movements" ADD CONSTRAINT "inventory_movements_handling_unit_id_handling_units_id_fk" FOREIGN KEY ("handling_unit_id") REFERENCES "core"."handling_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."inventory_movements" ADD CONSTRAINT "inventory_movements_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "core"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."inventory_movements" ADD CONSTRAINT "inventory_movements_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "core"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."inventory_movements" ADD CONSTRAINT "inventory_movements_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "core"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."inventory_movements" ADD CONSTRAINT "inventory_movements_source_batch_id_import_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."locations" ADD CONSTRAINT "locations_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "core"."districts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."materials" ADD CONSTRAINT "materials_source_batch_id_import_batches_id_fk" FOREIGN KEY ("source_batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."packaging_profiles" ADD CONSTRAINT "packaging_profiles_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "core"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."receipt_lots" ADD CONSTRAINT "receipt_lots_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "core"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."receipt_lots" ADD CONSTRAINT "receipt_lots_contract_item_id_contract_items_id_fk" FOREIGN KEY ("contract_item_id") REFERENCES "core"."contract_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."receipt_lots" ADD CONSTRAINT "receipt_lots_warehouse_location_id_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "core"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw"."source_rows" ADD CONSTRAINT "source_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."stock_snapshots" ADD CONSTRAINT "stock_snapshots_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "core"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."stock_snapshots" ADD CONSTRAINT "stock_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "core"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."stock_snapshots" ADD CONSTRAINT "stock_snapshots_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."stock_snapshots" ADD CONSTRAINT "stock_snapshots_source_row_id_source_rows_id_fk" FOREIGN KEY ("source_row_id") REFERENCES "raw"."source_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."usage_observations" ADD CONSTRAINT "usage_observations_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "core"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."usage_observations" ADD CONSTRAINT "usage_observations_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "core"."districts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."usage_observations" ADD CONSTRAINT "usage_observations_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "raw"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."usage_observations" ADD CONSTRAINT "usage_observations_source_row_id_source_rows_id_fk" FOREIGN KEY ("source_row_id") REFERENCES "raw"."source_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calculation_policies_version_uq" ON "ops"."calculation_policies" USING btree ("policy_version");--> statement-breakpoint
CREATE INDEX "change_log_record_idx" ON "audit"."change_log" USING btree ("schema_name","table_name","record_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_item_versions_item_version_uq" ON "core"."contract_item_versions" USING btree ("contract_item_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_item_versions_item_checksum_uq" ON "core"."contract_item_versions" USING btree ("contract_item_id","row_checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_items_contract_po_item_material_uq" ON "core"."contract_items" USING btree ("contract_id","po_item_no","material_id");--> statement-breakpoint
CREATE INDEX "contract_items_fifo_idx" ON "core"."contract_items" USING btree ("material_id","accepted_date","installment_no");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_purchase_order_uq" ON "core"."contracts" USING btree ("purchase_order_no");--> statement-breakpoint
CREATE INDEX "contracts_contract_no_idx" ON "core"."contracts" USING btree ("contract_no");--> statement-breakpoint
CREATE UNIQUE INDEX "districts_code_uq" ON "core"."districts" USING btree ("district_code");--> statement-breakpoint
CREATE UNIQUE INDEX "districts_plant_uq" ON "core"."districts" USING btree ("plant_code");--> statement-breakpoint
CREATE UNIQUE INDEX "handling_units_code_uq" ON "core"."handling_units" USING btree ("handling_unit_code");--> statement-breakpoint
CREATE INDEX "handling_units_lot_status_idx" ON "core"."handling_units" USING btree ("receipt_lot_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_entity_checksum_uq" ON "raw"."import_batches" USING btree ("entity_type","file_checksum");--> statement-breakpoint
CREATE INDEX "import_batches_entity_imported_idx" ON "raw"."import_batches" USING btree ("entity_type","imported_at");--> statement-breakpoint
CREATE INDEX "import_issues_batch_severity_idx" ON "ops"."import_issues" USING btree ("batch_id","severity");--> statement-breakpoint
CREATE INDEX "inventory_movements_unit_time_idx" ON "core"."inventory_movements" USING btree ("handling_unit_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inventory_movements_material_time_idx" ON "core"."inventory_movements" USING btree ("material_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_plant_sloc_uq" ON "core"."locations" USING btree ("plant_code","storage_location_code");--> statement-breakpoint
CREATE INDEX "locations_district_idx" ON "core"."locations" USING btree ("district_id");--> statement-breakpoint
CREATE UNIQUE INDEX "materials_code_uq" ON "core"."materials" USING btree ("material_code");--> statement-breakpoint
CREATE INDEX "packaging_profiles_material_type_idx" ON "core"."packaging_profiles" USING btree ("material_id","unit_type");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_lots_code_uq" ON "core"."receipt_lots" USING btree ("lot_code");--> statement-breakpoint
CREATE INDEX "receipt_lots_fifo_idx" ON "core"."receipt_lots" USING btree ("material_id","fifo_date","receipt_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "source_rows_batch_entity_row_uq" ON "raw"."source_rows" USING btree ("batch_id","entity_name","source_row_number");--> statement-breakpoint
CREATE INDEX "source_rows_batch_checksum_idx" ON "raw"."source_rows" USING btree ("batch_id","row_checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_snapshots_material_location_batch_uq" ON "core"."stock_snapshots" USING btree ("material_id","location_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_snapshots_date_idx" ON "core"."stock_snapshots" USING btree ("snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_material_district_month_batch_uq" ON "core"."usage_observations" USING btree ("material_id","district_id","usage_month","batch_id");--> statement-breakpoint
CREATE INDEX "usage_district_month_idx" ON "core"."usage_observations" USING btree ("district_id","usage_month");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_aliases_code_uq" ON "core"."vendor_aliases" USING btree ("alias_code");