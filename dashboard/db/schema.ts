import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const raw = pgSchema("raw");
export const core = pgSchema("core");
export const ops = pgSchema("ops");
export const audit = pgSchema("audit");

export const importEntityType = raw.enum("import_entity_type", [
  "STOCK",
  "USAGE",
  "CONTRACT",
  "VENDOR",
]);

export const importStatus = raw.enum("import_status", [
  "RECEIVED",
  "VALIDATING",
  "ACCEPTED",
  "PARTIAL",
  "REJECTED",
]);

export const issueSeverity = ops.enum("issue_severity", ["INFO", "WARNING", "ERROR"]);
export const locationType = core.enum("location_type", ["WAREHOUSE", "DISTRICT"]);
export const sourceQuality = core.enum("source_quality", [
  "VERIFIED",
  "SOURCE_DERIVED",
  "OPENING_UNKNOWN",
]);
export const handlingUnitType = core.enum("handling_unit_type", [
  "FULL_PALLET",
  "BOX",
  "CRATE",
  "BUNDLE",
  "LOOSE",
  "LONG_MATERIAL",
]);
export const handlingUnitStatus = core.enum("handling_unit_status", [
  "AVAILABLE",
  "RESERVED",
  "EMPTY",
  "QUARANTINE",
  "CLOSED",
]);
export const packagingQuality = core.enum("packaging_quality", [
  "DUMMY",
  "ESTIMATED",
  "VERIFIED",
]);
export const movementType = core.enum("movement_type", [
  "OPENING",
  "RECEIPT",
  "RESERVE",
  "RELEASE",
  "ISSUE",
  "RETURN",
  "TRANSFER",
  "ADJUSTMENT",
  "QUARANTINE",
]);

export const importBatches = raw.table(
  "import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: importEntityType("entity_type").notNull(),
    sourceFileName: text("source_file_name").notNull(),
    sourceSheet: text("source_sheet"),
    fileChecksum: varchar("file_checksum", { length: 64 }).notNull(),
    sourceBusinessDate: date("source_business_date"),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
    importedBy: text("imported_by").notNull(),
    rowCount: integer("row_count").default(0).notNull(),
    acceptedCount: integer("accepted_count").default(0).notNull(),
    rejectedCount: integer("rejected_count").default(0).notNull(),
    status: importStatus("status").default("RECEIVED").notNull(),
  },
  (table) => [
    uniqueIndex("import_batches_entity_checksum_uq").on(table.entityType, table.fileChecksum),
    index("import_batches_entity_imported_idx").on(table.entityType, table.importedAt),
    check("import_batches_counts_nonnegative", sql`${table.rowCount} >= 0 and ${table.acceptedCount} >= 0 and ${table.rejectedCount} >= 0`),
  ],
);
export const sourceRows = raw.table(
  "source_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "restrict" }),
    entityName: text("entity_name").notNull(),
    sourceRowNumber: integer("source_row_number").notNull(),
    rowPayload: jsonb("row_payload").$type<Record<string, unknown>>().notNull(),
    rowChecksum: varchar("row_checksum", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("source_rows_batch_entity_row_uq").on(table.batchId, table.entityName, table.sourceRowNumber),
    index("source_rows_batch_checksum_idx").on(table.batchId, table.rowChecksum),
    check("source_rows_row_number_positive", sql`${table.sourceRowNumber} > 0`),
  ],
);

export const importIssues = ops.table(
  "import_issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
    sourceRowId: uuid("source_row_id").references(() => sourceRows.id, { onDelete: "cascade" }),
    severity: issueSeverity("severity").notNull(),
    fieldName: text("field_name"),
    issueCode: text("issue_code").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("import_issues_batch_severity_idx").on(table.batchId, table.severity)],
);

export const districts = core.table(
  "districts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    districtCode: varchar("district_code", { length: 20 }).notNull(),
    nameEn: text("name_en").notNull(),
    nameTh: text("name_th").notNull(),
    plantCode: varchar("plant_code", { length: 10 }).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("districts_code_uq").on(table.districtCode),
    uniqueIndex("districts_plant_uq").on(table.plantCode),
  ],
);

export const locations = core.table(
  "locations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    locationType: locationType("location_type").notNull(),
    plantCode: varchar("plant_code", { length: 10 }).notNull(),
    storageLocationCode: varchar("storage_location_code", { length: 10 }).notNull(),
    districtId: uuid("district_id").references(() => districts.id, { onDelete: "restrict" }),
    nameEn: text("name_en").notNull(),
    nameTh: text("name_th").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("locations_plant_sloc_uq").on(table.plantCode, table.storageLocationCode),
    index("locations_district_idx").on(table.districtId),
  ],
);

export const materials = core.table(
  "materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    materialCode: varchar("material_code", { length: 40 }).notNull(),
    description: text("description"),
    baseUnit: varchar("base_unit", { length: 20 }),
    active: boolean("active").default(true).notNull(),
    sourceBatchId: uuid("source_batch_id").references(() => importBatches.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("materials_code_uq").on(table.materialCode)],
);

export const stockSnapshots = core.table(
  "stock_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    materialId: uuid("material_id").notNull().references(() => materials.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "restrict" }),
    snapshotDate: date("snapshot_date").notNull(),
    unrestrictedQty: numeric("unrestricted_qty", { precision: 20, scale: 3 }).notNull(),
    sourceMissing: boolean("source_missing").default(false).notNull(),
    batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "restrict" }),
    sourceRowId: uuid("source_row_id").references(() => sourceRows.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stock_snapshots_material_location_batch_uq").on(table.materialId, table.locationId, table.batchId),
    index("stock_snapshots_date_idx").on(table.snapshotDate),
    check("stock_snapshots_unrestricted_nonnegative", sql`${table.unrestrictedQty} >= 0`),
  ],
);

export const usageObservations = core.table(
  "usage_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    materialId: uuid("material_id").notNull().references(() => materials.id, { onDelete: "restrict" }),
    districtId: uuid("district_id").notNull().references(() => districts.id, { onDelete: "restrict" }),
    usageMonth: date("usage_month").notNull(),
    usageQty: numeric("usage_qty", { precision: 20, scale: 3 }).notNull(),
    sourceWasDash: boolean("source_was_dash").default(false).notNull(),
    batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "restrict" }),
    sourceRowId: uuid("source_row_id").references(() => sourceRows.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("usage_material_district_month_batch_uq").on(table.materialId, table.districtId, table.usageMonth, table.batchId),
    index("usage_district_month_idx").on(table.districtId, table.usageMonth),
    check("usage_qty_nonnegative", sql`${table.usageQty} >= 0`),
  ],
);

export const calculationPolicies = ops.table(
  "calculation_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    policyVersion: varchar("policy_version", { length: 30 }).notNull(),
    triggerMonths: numeric("trigger_months", { precision: 6, scale: 2 }).notNull(),
    minTargetMonths: numeric("min_target_months", { precision: 6, scale: 2 }).notNull(),
    referenceMonths: numeric("reference_months", { precision: 6, scale: 2 }).notNull(),
    maxTargetMonths: numeric("max_target_months", { precision: 6, scale: 2 }).notNull(),
    specialApprovalMonths: numeric("special_approval_months", { precision: 6, scale: 2 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    approvedBy: text("approved_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("calculation_policies_version_uq").on(table.policyVersion),
    check("calculation_policy_order_valid", sql`${table.referenceMonths} <= ${table.triggerMonths} and ${table.triggerMonths} <= ${table.minTargetMonths} and ${table.minTargetMonths} <= ${table.maxTargetMonths} and ${table.maxTargetMonths} <= ${table.specialApprovalMonths}`),
  ],
);

export const vendorAliases = core.table(
  "vendor_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    aliasCode: varchar("alias_code", { length: 30 }).notNull(),
    displayName: text("display_name").notNull(),
    isDummy: boolean("is_dummy").default(true).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("vendor_aliases_code_uq").on(table.aliasCode)],
);

export const contracts = core.table(
  "contracts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    purchaseOrderNo: varchar("purchase_order_no", { length: 60 }).notNull(),
    contractNo: varchar("contract_no", { length: 100 }).notNull(),
    procurementCode: varchar("procurement_code", { length: 100 }),
    vendorAliasId: uuid("vendor_alias_id").references(() => vendorAliases.id, { onDelete: "restrict" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    notSeenInLatestBatch: boolean("not_seen_in_latest_batch").default(false).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("contracts_purchase_order_uq").on(table.purchaseOrderNo),
    index("contracts_contract_no_idx").on(table.contractNo),
  ],
);

export const contractItems = core.table(
  "contract_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id").notNull().references(() => contracts.id, { onDelete: "restrict" }),
    materialId: uuid("material_id").notNull().references(() => materials.id, { onDelete: "restrict" }),
    poItemNo: integer("po_item_no").notNull(),
    installmentNo: integer("installment_no").notNull(),
    orderedQty: numeric("ordered_qty", { precision: 20, scale: 3 }).notNull(),
    plannedDeliveryDate: date("planned_delivery_date"),
    acceptedDate: date("accepted_date"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    notSeenInLatestBatch: boolean("not_seen_in_latest_batch").default(false).notNull(),
    active: boolean("active").default(true).notNull(),
    sourceBatchId: uuid("source_batch_id").notNull().references(() => importBatches.id, { onDelete: "restrict" }),
    sourceRowId: uuid("source_row_id").notNull().references(() => sourceRows.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("contract_items_contract_po_item_material_uq").on(table.contractId, table.poItemNo, table.materialId),
    index("contract_items_fifo_idx").on(table.materialId, table.acceptedDate, table.installmentNo),
    check("contract_items_po_item_positive", sql`${table.poItemNo} > 0 and ${table.installmentNo} > 0`),
    check("contract_items_ordered_qty_positive", sql`${table.orderedQty} > 0`),
  ],
);

export const contractItemVersions = core.table(
  "contract_item_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractItemId: uuid("contract_item_id").notNull().references(() => contractItems.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    rowChecksum: varchar("row_checksum", { length: 64 }).notNull(),
    orderedQty: numeric("ordered_qty", { precision: 20, scale: 3 }).notNull(),
    plannedDeliveryDate: date("planned_delivery_date"),
    acceptedDate: date("accepted_date"),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    sourceBatchId: uuid("source_batch_id").notNull().references(() => importBatches.id, { onDelete: "restrict" }),
    sourceRowId: uuid("source_row_id").notNull().references(() => sourceRows.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("contract_item_versions_item_version_uq").on(table.contractItemId, table.versionNo),
    uniqueIndex("contract_item_versions_item_checksum_uq").on(table.contractItemId, table.rowChecksum),
    check("contract_item_versions_version_positive", sql`${table.versionNo} > 0`),
  ],
);

export const receiptLots = core.table(
  "receipt_lots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    lotCode: varchar("lot_code", { length: 50 }).notNull(),
    materialId: uuid("material_id").notNull().references(() => materials.id, { onDelete: "restrict" }),
    contractItemId: uuid("contract_item_id").references(() => contractItems.id, { onDelete: "restrict" }),
    warehouseLocationId: uuid("warehouse_location_id").notNull().references(() => locations.id, { onDelete: "restrict" }),
    receiptReference: varchar("receipt_reference", { length: 100 }),
    receiptSequence: integer("receipt_sequence").default(1).notNull(),
    fifoDate: date("fifo_date"),
    receivedQty: numeric("received_qty", { precision: 20, scale: 3 }).notNull(),
    openingQty: numeric("opening_qty", { precision: 20, scale: 3 }).notNull(),
    sourceQuality: sourceQuality("source_quality").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("receipt_lots_code_uq").on(table.lotCode),
    index("receipt_lots_fifo_idx").on(table.materialId, table.fifoDate, table.receiptSequence),
    check("receipt_lots_qty_nonnegative", sql`${table.receivedQty} >= 0 and ${table.openingQty} >= 0`),
    check("receipt_lots_sequence_positive", sql`${table.receiptSequence} > 0`),
  ],
);

export const handlingUnits = core.table(
  "handling_units",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    handlingUnitCode: varchar("handling_unit_code", { length: 50 }).notNull(),
    receiptLotId: uuid("receipt_lot_id").notNull().references(() => receiptLots.id, { onDelete: "restrict" }),
    unitType: handlingUnitType("unit_type").notNull(),
    parentHandlingUnitId: uuid("parent_handling_unit_id"),
    initialQty: numeric("initial_qty", { precision: 20, scale: 3 }).notNull(),
    onHandQty: numeric("on_hand_qty", { precision: 20, scale: 3 }).notNull(),
    reservedQty: numeric("reserved_qty", { precision: 20, scale: 3 }).default("0").notNull(),
    physicalLocationCode: varchar("physical_location_code", { length: 100 }),
    isVirtual: boolean("is_virtual").default(true).notNull(),
    status: handlingUnitStatus("status").default("AVAILABLE").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("handling_units_code_uq").on(table.handlingUnitCode),
    index("handling_units_lot_status_idx").on(table.receiptLotId, table.status),
    check("handling_units_qty_valid", sql`${table.initialQty} >= 0 and ${table.onHandQty} >= 0 and ${table.reservedQty} >= 0 and ${table.reservedQty} <= ${table.onHandQty}`),
  ],
);

export const packagingProfiles = core.table(
  "packaging_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    materialId: uuid("material_id").notNull().references(() => materials.id, { onDelete: "restrict" }),
    unitType: handlingUnitType("unit_type").notNull(),
    unitsPerHandlingUnit: numeric("units_per_handling_unit", { precision: 20, scale: 3 }).notNull(),
    lengthM: numeric("length_m", { precision: 10, scale: 3 }),
    widthM: numeric("width_m", { precision: 10, scale: 3 }),
    heightM: numeric("height_m", { precision: 10, scale: 3 }),
    grossWeightKg: numeric("gross_weight_kg", { precision: 12, scale: 3 }),
    stackable: boolean("stackable").default(false).notNull(),
    sideLoadable: boolean("side_loadable").default(true).notNull(),
    forkliftRequired: boolean("forklift_required").default(false).notNull(),
    maximumStackLayers: integer("maximum_stack_layers").default(1).notNull(),
    dataQuality: packagingQuality("data_quality").default("DUMMY").notNull(),
    sourceNote: text("source_note"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("packaging_profiles_material_type_idx").on(table.materialId, table.unitType),
    check("packaging_profiles_units_positive", sql`${table.unitsPerHandlingUnit} > 0 and ${table.maximumStackLayers} > 0`),
    check("packaging_profiles_dimensions_positive", sql`(${table.lengthM} is null or ${table.lengthM} > 0) and (${table.widthM} is null or ${table.widthM} > 0) and (${table.heightM} is null or ${table.heightM} > 0) and (${table.grossWeightKg} is null or ${table.grossWeightKg} > 0)`),
  ],
);

export const inventoryMovements = core.table(
  "inventory_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    movementType: movementType("movement_type").notNull(),
    handlingUnitId: uuid("handling_unit_id").notNull().references(() => handlingUnits.id, { onDelete: "restrict" }),
    materialId: uuid("material_id").notNull().references(() => materials.id, { onDelete: "restrict" }),
    quantityDelta: numeric("quantity_delta", { precision: 20, scale: 3 }).notNull(),
    fromLocationId: uuid("from_location_id").references(() => locations.id, { onDelete: "restrict" }),
    toLocationId: uuid("to_location_id").references(() => locations.id, { onDelete: "restrict" }),
    sapDocumentNo: varchar("sap_document_no", { length: 100 }),
    businessReferenceType: varchar("business_reference_type", { length: 50 }),
    businessReferenceId: uuid("business_reference_id"),
    reversalOfMovementId: uuid("reversal_of_movement_id"),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    actor: text("actor").notNull(),
    sourceBatchId: uuid("source_batch_id").references(() => importBatches.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("inventory_movements_unit_time_idx").on(table.handlingUnitId, table.occurredAt),
    index("inventory_movements_material_time_idx").on(table.materialId, table.occurredAt),
    check("inventory_movements_delta_nonzero", sql`${table.quantityDelta} <> 0`),
  ],
);

export const changeLog = audit.table(
  "change_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    schemaName: text("schema_name").notNull(),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    action: varchar("action", { length: 20 }).notNull(),
    beforeData: jsonb("before_data").$type<Record<string, unknown>>(),
    afterData: jsonb("after_data").$type<Record<string, unknown>>(),
    reason: text("reason"),
    actor: text("actor").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("change_log_record_idx").on(table.schemaName, table.tableName, table.recordId, table.occurredAt)],
);
