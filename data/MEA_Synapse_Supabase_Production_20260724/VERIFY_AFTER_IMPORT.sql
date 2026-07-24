-- MEA Synapse — Supabase Production verification
-- Read-only queries. Safe to run after import.

SELECT 'districts' AS check_name, count(*)::bigint AS actual, 18::bigint AS expected
FROM core.districts
UNION ALL
SELECT 'locations', count(*), 314 FROM core.locations
UNION ALL
SELECT 'materials', count(*), 4358 FROM core.materials
UNION ALL
SELECT 'stock_snapshots', count(*), 14641 FROM core.stock_snapshots
UNION ALL
SELECT 'usage_metrics', count(*), 5926 FROM core.usage_metrics
UNION ALL
SELECT 'usage_observations', count(*), 71112 FROM core.usage_observations
UNION ALL
SELECT 'contract_items', count(*), 4175 FROM core.contract_items
ORDER BY check_name;

SELECT
  count(*) AS khlong_toei_material_rows,
  sum(unrestricted_qty) AS khlong_toei_unrestricted_qty,
  max(snapshot_date) AS snapshot_date
FROM analytics.v_current_stock
WHERE plant_code = '2401'
  AND storage_location_code = '0001';

SELECT *
FROM public.mea_dashboard_summary;

SELECT
  count(*) AS invalid_cmp_rows
FROM core.usage_metrics
WHERE cmp_qty <> round((ly_avg + m12_avg + m6_avg + m4_avg) / 4, 0);

SELECT
  count(*) AS vendor_alias_count,
  bool_and(alias_code = 'SUP-UNKNOWN') AS only_dummy_vendor
FROM core.vendor_aliases
WHERE active;

SELECT
  count(*) AS web_district_replenishment_rows,
  count(*) FILTER (WHERE stock_triggered) AS triggered_rows,
  count(*) FILTER (WHERE cmp_qty = 0) AS zero_cmp_rows
FROM public.mea_district_replenishment;

SELECT
  count(*) AS fifo_reference_rows,
  count(*) FILTER (WHERE fifo_date IS NOT NULL) AS rows_with_fifo_date
FROM public.mea_contract_fifo_reference;

SELECT *
FROM analytics.v_source_observation_coverage;

SELECT *
FROM analytics.v_production_readiness;
