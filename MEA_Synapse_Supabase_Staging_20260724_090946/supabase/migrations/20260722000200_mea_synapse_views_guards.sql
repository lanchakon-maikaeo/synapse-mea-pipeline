CREATE SCHEMA IF NOT EXISTS "analytics";
--> statement-breakpoint
INSERT INTO "ops"."calculation_policies" (
  "id", "policy_version", "trigger_months", "min_target_months", "reference_months",
  "max_target_months", "special_approval_months", "effective_from", "approved_by"
) VALUES (
  '00000000-0000-4000-8000-000000000001', 'BR-V1', 3.5, 4, 3, 6, 9, DATE '2026-07-22', 'Business Rules v1'
) ON CONFLICT ("policy_version") DO NOTHING;
--> statement-breakpoint
INSERT INTO "core"."vendor_aliases" (
  "id", "alias_code", "display_name", "is_dummy", "active"
) VALUES (
  '00000000-0000-4000-8000-000000000002', 'SUP-UNKNOWN', 'Supplier (Dummy)', true, true
) ON CONFLICT ("alias_code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "core"."locations" (
  "id", "location_type", "plant_code", "storage_location_code", "name_en", "name_th", "active"
) VALUES (
  '00000000-0000-4000-8000-000000000003', 'WAREHOUSE', '2401', '0001', 'Khlong Toei Warehouse', 'คลังคลองเตย', true
) ON CONFLICT ("plant_code", "storage_location_code") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ops"."set_updated_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ops"."reject_append_only_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; create a reversing/new record instead', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit"."capture_core_change"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, audit
AS $$
DECLARE
  actor_value text;
  reason_value text;
  record_value text;
BEGIN
  actor_value := COALESCE(NULLIF(current_setting('app.actor', true), ''), current_user);
  reason_value := NULLIF(current_setting('app.change_reason', true), '');
  record_value := COALESCE(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id', 'unknown');

  INSERT INTO audit.change_log (
    schema_name, table_name, record_id, action, before_data, after_data, reason, actor
  ) VALUES (
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    record_value,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    reason_value,
    actor_value
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "materials_set_updated_at"
BEFORE UPDATE ON "core"."materials"
FOR EACH ROW EXECUTE FUNCTION "ops"."set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "districts_set_updated_at"
BEFORE UPDATE ON "core"."districts"
FOR EACH ROW EXECUTE FUNCTION "ops"."set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "locations_set_updated_at"
BEFORE UPDATE ON "core"."locations"
FOR EACH ROW EXECUTE FUNCTION "ops"."set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "contracts_set_updated_at"
BEFORE UPDATE ON "core"."contracts"
FOR EACH ROW EXECUTE FUNCTION "ops"."set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "contract_items_set_updated_at"
BEFORE UPDATE ON "core"."contract_items"
FOR EACH ROW EXECUTE FUNCTION "ops"."set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "handling_units_set_updated_at"
BEFORE UPDATE ON "core"."handling_units"
FOR EACH ROW EXECUTE FUNCTION "ops"."set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "source_rows_append_only"
BEFORE UPDATE OR DELETE ON "raw"."source_rows"
FOR EACH ROW EXECUTE FUNCTION "ops"."reject_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "inventory_movements_append_only"
BEFORE UPDATE OR DELETE ON "core"."inventory_movements"
FOR EACH ROW EXECUTE FUNCTION "ops"."reject_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "change_log_append_only"
BEFORE UPDATE OR DELETE ON "audit"."change_log"
FOR EACH ROW EXECUTE FUNCTION "ops"."reject_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "contracts_audit"
AFTER INSERT OR UPDATE OR DELETE ON "core"."contracts"
FOR EACH ROW EXECUTE FUNCTION "audit"."capture_core_change"();
--> statement-breakpoint
CREATE TRIGGER "contract_items_audit"
AFTER INSERT OR UPDATE OR DELETE ON "core"."contract_items"
FOR EACH ROW EXECUTE FUNCTION "audit"."capture_core_change"();
--> statement-breakpoint
CREATE TRIGGER "receipt_lots_audit"
AFTER INSERT OR UPDATE OR DELETE ON "core"."receipt_lots"
FOR EACH ROW EXECUTE FUNCTION "audit"."capture_core_change"();
--> statement-breakpoint
CREATE TRIGGER "handling_units_audit"
AFTER INSERT OR UPDATE OR DELETE ON "core"."handling_units"
FOR EACH ROW EXECUTE FUNCTION "audit"."capture_core_change"();
--> statement-breakpoint
CREATE TRIGGER "packaging_profiles_audit"
AFTER INSERT OR UPDATE OR DELETE ON "core"."packaging_profiles"
FOR EACH ROW EXECUTE FUNCTION "audit"."capture_core_change"();
--> statement-breakpoint
CREATE OR REPLACE VIEW "analytics"."v_current_stock" AS
WITH ranked AS (
  SELECT
    ss.*,
    ib.imported_at,
    row_number() OVER (
      PARTITION BY ss.material_id, ss.location_id
      ORDER BY ib.imported_at DESC, ss.created_at DESC
    ) AS row_rank
  FROM core.stock_snapshots ss
  JOIN raw.import_batches ib ON ib.id = ss.batch_id
  WHERE ib.status IN ('ACCEPTED', 'PARTIAL')
)
SELECT
  r.material_id,
  m.material_code,
  r.location_id,
  l.plant_code,
  l.storage_location_code,
  l.district_id,
  r.snapshot_date,
  r.unrestricted_qty,
  r.source_missing,
  r.batch_id,
  r.imported_at
FROM ranked r
JOIN core.materials m ON m.id = r.material_id
JOIN core.locations l ON l.id = r.location_id
WHERE r.row_rank = 1;
--> statement-breakpoint
CREATE OR REPLACE VIEW "analytics"."v_district_stock" AS
SELECT
  cs.district_id,
  d.district_code,
  d.plant_code,
  cs.material_id,
  cs.material_code,
  max(cs.snapshot_date) AS snapshot_date,
  sum(cs.unrestricted_qty) AS unrestricted_qty,
  bool_or(cs.source_missing) AS has_source_missing
FROM analytics.v_current_stock cs
JOIN core.districts d ON d.id = cs.district_id
WHERE cs.district_id IS NOT NULL
GROUP BY cs.district_id, d.district_code, d.plant_code, cs.material_id, cs.material_code;
--> statement-breakpoint
CREATE OR REPLACE VIEW "analytics"."v_handling_unit_balance" AS
SELECT
  hu.id AS handling_unit_id,
  hu.handling_unit_code,
  hu.unit_type,
  hu.status,
  hu.is_virtual,
  hu.physical_location_code,
  hu.initial_qty,
  hu.on_hand_qty,
  hu.reserved_qty,
  hu.on_hand_qty - hu.reserved_qty AS available_qty,
  rl.id AS receipt_lot_id,
  rl.lot_code,
  rl.source_quality,
  rl.fifo_date,
  m.id AS material_id,
  m.material_code
FROM core.handling_units hu
JOIN core.receipt_lots rl ON rl.id = hu.receipt_lot_id
JOIN core.materials m ON m.id = rl.material_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW "analytics"."v_fifo_queue" AS
SELECT
  hub.*,
  ci.contract_id,
  c.purchase_order_no,
  c.contract_no,
  ci.po_item_no,
  ci.installment_no,
  va.alias_code AS vendor_alias
FROM analytics.v_handling_unit_balance hub
LEFT JOIN core.contract_items ci ON ci.id = (
  SELECT rl.contract_item_id FROM core.receipt_lots rl WHERE rl.id = hub.receipt_lot_id
)
LEFT JOIN core.contracts c ON c.id = ci.contract_id
LEFT JOIN core.vendor_aliases va ON va.id = c.vendor_alias_id
WHERE hub.available_qty > 0
  AND hub.status IN ('AVAILABLE', 'RESERVED')
ORDER BY hub.material_code, hub.fifo_date NULLS LAST, hub.handling_unit_code;
--> statement-breakpoint
CREATE OR REPLACE VIEW "analytics"."v_traceability_coverage" AS
SELECT
  hub.material_id,
  hub.material_code,
  sum(hub.on_hand_qty) AS total_on_hand_qty,
  sum(hub.on_hand_qty) FILTER (WHERE hub.source_quality = 'VERIFIED') AS verified_qty,
  sum(hub.on_hand_qty) FILTER (WHERE hub.source_quality = 'SOURCE_DERIVED') AS source_derived_qty,
  sum(hub.on_hand_qty) FILTER (WHERE hub.source_quality = 'OPENING_UNKNOWN') AS unknown_qty,
  CASE
    WHEN sum(hub.on_hand_qty) = 0 THEN 0
    ELSE round(
      100 * sum(hub.on_hand_qty) FILTER (WHERE hub.source_quality = 'VERIFIED') / sum(hub.on_hand_qty),
      2
    )
  END AS verified_percent
FROM analytics.v_handling_unit_balance hub
GROUP BY hub.material_id, hub.material_code;
--> statement-breakpoint
ALTER TABLE "raw"."import_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "raw"."source_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."import_issues" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."calculation_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."districts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."locations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."materials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."stock_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."usage_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."vendor_aliases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."contracts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."contract_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."contract_item_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."receipt_lots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."handling_units" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."packaging_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core"."inventory_movements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit"."change_log" ENABLE ROW LEVEL SECURITY;
