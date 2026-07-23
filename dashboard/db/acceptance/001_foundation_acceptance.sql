DO $$
DECLARE
  foundation_table_count integer;
  rls_table_count integer;
BEGIN
  SELECT count(*)
  INTO foundation_table_count
  FROM information_schema.tables
  WHERE table_schema IN ('raw', 'core', 'ops', 'audit')
    AND table_type = 'BASE TABLE';

  IF foundation_table_count <> 18 THEN
    RAISE EXCEPTION 'Expected 18 foundation tables, found %', foundation_table_count;
  END IF;

  SELECT count(*)
  INTO rls_table_count
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('raw', 'core', 'ops', 'audit')
    AND c.relkind = 'r'
    AND c.relrowsecurity;

  IF rls_table_count <> 18 THEN
    RAISE EXCEPTION 'Expected RLS on 18 foundation tables, found %', rls_table_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ops.calculation_policies
    WHERE policy_version = 'BR-V1'
      AND trigger_months = 3.5
      AND min_target_months = 4
      AND reference_months = 3
      AND max_target_months = 6
      AND special_approval_months = 9
  ) THEN
    RAISE EXCEPTION 'Business Rules v1 calculation policy is missing or incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.locations
    WHERE plant_code = '2401'
      AND storage_location_code = '0001'
      AND location_type = 'WAREHOUSE'
  ) THEN
    RAISE EXCEPTION 'Khlong Toei warehouse baseline is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.vendor_aliases
    WHERE alias_code = 'SUP-UNKNOWN' AND is_dummy
  ) THEN
    RAISE EXCEPTION 'Privacy-safe dummy supplier alias is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'core'
      AND c.relname = 'inventory_movements'
      AND t.tgname = 'inventory_movements_append_only'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Append-only inventory movement guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.views
    WHERE table_schema = 'analytics'
      AND table_name = 'v_fifo_queue'
  ) THEN
    RAISE EXCEPTION 'FIFO analytics view is missing';
  END IF;
END;
$$;
