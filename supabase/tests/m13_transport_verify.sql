\set ON_ERROR_STOP on

begin;

create temporary table m13_transport_checks (
  check_name text primary key,
  passed boolean not null
);

create temporary table m13_runtime_state (
  quarantine_preflight jsonb,
  source_readiness_result jsonb,
  readiness_result jsonb,
  missing_plan_result jsonb,
  unlocked_plan_result jsonb,
  depot_origin_mismatch_result jsonb,
  demand_mismatch_result jsonb,
  invalid_avoid_tolls_result jsonb,
  optimize_preflight jsonb,
  optimization_worker_result jsonb,
  write_lock_result jsonb,
  create_result jsonb,
  dispatch_result jsonb,
  dispatch_retry_result jsonb,
  invalid_transition_result jsonb,
  complete_result jsonb,
  terminal_transition_result jsonb,
  trip_id uuid,
  cutoff_at timestamptz,
  cutoff_run_id uuid,
  cutoff_selected_old boolean not null default false,
  weekly_uniqueness_enforced boolean not null default false,
  return_balance_enforced boolean not null default false,
  event_append_only_enforced boolean not null default false
);

insert into m13_runtime_state default values;

create temporary table m13_authoritative_geo_expected (
  district_ref text primary key,
  district_id text,
  warehouse_code text,
  name_en text not null,
  name_th text not null,
  latitude numeric(11, 8) not null,
  longitude numeric(11, 8) not null,
  is_warehouse boolean not null,
  source_row_number integer not null
);

insert into m13_authoritative_geo_expected values
  ('5501', '5501', null, 'Nawamin District',
    'การไฟฟ้านครหลวง เขตนวลจันทร์', 13.81895000, 100.64410000, false, 2),
  ('5601', '5502', null, 'Samsen District',
    'การไฟฟ้านครหลวง เขตสามเสน', 13.78054000, 100.51764000, false, 3),
  ('5701', '5503', null, 'Nonthaburi District',
    'การไฟฟ้านครหลวง เขตนนทบุรี', 13.87001000, 100.51778000, false, 4),
  ('5801', '5504', null, 'Thonburi District',
    'การไฟฟ้านครหลวง เขตธนบุรี', 13.74671400, 100.47022800, false, 5),
  ('5901', '5505', null, 'Bang Yai District',
    'การไฟฟ้านครหลวง เขตบางใหญ่', 13.84836400, 100.43609400, false, 6),
  ('6001', '5506', null, 'Lat Krabang District',
    'การไฟฟ้านครหลวง เขตลาดกระบัง', 13.81564100, 100.74612300, false, 7),
  ('6501', '5507', null, 'Bang Na District',
    'การไฟฟ้านครหลวง เขตบางนา', 13.67613000, 100.59186000, false, 8),
  ('6601', '5508', null, 'Wat Liap District',
    'การไฟฟ้านครหลวง เขตวัดเลียบ', 13.74194400, 100.50000000, false, 9),
  ('6701', '5509', null, 'Khlong Toei District',
    'การไฟฟ้านครหลวง เขตคลองเตย', 13.72156000, 100.55539000, false, 10),
  ('6801', '5510', null, 'Rat Burana District',
    'การไฟฟ้านครหลวง เขตราษฎร์บูรณะ', 13.67907500, 100.51305100, false, 11),
  ('6901', '5511', null, 'Yannawa District',
    'การไฟฟ้านครหลวง เขตยานนาวา', 13.69305600, 100.49333300, false, 12),
  ('7001', '5512', null, 'Bang Khun Thian District',
    'การไฟฟ้านครหลวง เขตบางขุนเทียน', 13.65557000, 100.42435000, false, 13),
  ('7501', '5513', null, 'Bang Bua Thong District',
    'การไฟฟ้านครหลวง เขตบางบัวทอง', 13.94567700, 100.37977000, false, 14),
  ('7601', '5514', null, 'Bang Kapi District',
    'การไฟฟ้านครหลวง เขตบางกะปิ', 13.74407000, 100.60137000, false, 15),
  ('7701', '5515', null, 'Samut Prakan District',
    'การไฟฟ้านครหลวง เขตสมุทรปราการ', 13.59431700, 100.60681700, false, 16),
  ('7801', '5516', null, 'Bang Phli District',
    'การไฟฟ้านครหลวง เขตบางพลี', 13.64160000, 100.71325000, false, 17),
  ('7901', '5517', null, 'Min Buri District',
    'การไฟฟ้านครหลวง เขตมีนบุรี', 13.81160700, 100.70849700, false, 18),
  ('8001', '5518', null, 'Bang Khen District',
    'การไฟฟ้านครหลวง เขตบางเขน', 13.87107000, 100.59534000, false, 19),
  ('WH-MMBP', null, 'เมืองใหม่',
    'MEA Procurement Department, Mueang Mai Bang Phli',
    'การไฟฟ้านครหลวง ฝ่ายพัสดุ เมืองใหม่บางพลี',
    13.55760333, 100.77072260, true, 20);

insert into m13_transport_checks (check_name, passed)
values
  ('transport_migration_registered',
    exists (
      select 1
      from ops.schema_migrations
      where version = '202607250001'
    )),
  ('transport_replenishment_link_migration',
    exists (
      select 1
      from ops.schema_migrations
      where version = '202607250002'
    )),
  ('transport_hardening_migration',
    exists (
      select 1
      from ops.schema_migrations
      where version = '202607250003'
    )),
  ('transport_operational_integrity_migration',
    exists (
      select 1
      from ops.schema_migrations
      where version = '202607250004'
    )),
  ('transport_master_tables_exist',
    to_regclass('core.transport_warehouses') is not null
    and to_regclass('core.transport_district_geo') is not null
    and to_regclass('core.transport_vehicles') is not null
    and to_regclass('core.transport_route_legs') is not null),
  ('transport_trips_and_events_exist',
    to_regclass('ops.transport_trips') is not null
    and to_regclass('ops.transport_trip_events') is not null),
  ('transport_tables_rls_enabled',
    (
      select relrowsecurity
      from pg_class
      where oid = 'ops.transport_trips'::regclass
    )
    and (
      select relrowsecurity
      from pg_class
      where oid = 'ops.transport_trip_events'::regclass
    )),
  ('transport_analytics_views_exist',
    to_regclass('analytics.v_transport_vehicle_status') is not null
    and to_regclass('analytics.v_transport_route_matrix') is not null
    and to_regclass('analytics.v_transport_trip_summary') is not null
    and to_regclass('analytics.v_transport_dispatch_queue') is not null),
  ('transport_views_are_security_invoker',
    (
      select bool_and(
        coalesce(class.reloptions, array[]::text[])
          @> array['security_invoker=true']
      )
      from pg_class class
      join pg_namespace namespace
        on namespace.oid = class.relnamespace
      where namespace.nspname = 'analytics'
        and class.relname in (
          'v_transport_vehicle_status',
          'v_transport_route_matrix',
          'v_transport_trip_summary',
          'v_transport_dispatch_queue'
        )
    )),
  ('transport_dispatch_authenticated_only',
    has_function_privilege(
      'authenticated',
      'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)',
      'execute'
    )),
  ('transport_masters_locked_from_authenticated',
    not has_table_privilege(
      'authenticated',
      'core.transport_vehicles',
      'select'
    )
    and not has_table_privilege(
      'authenticated',
      'ops.transport_trips',
      'insert'
    )
    and not has_table_privilege(
      'authenticated',
      'ops.transport_trip_events',
      'select'
    )),
  ('transport_toll_tariff_catalog_governed',
    to_regclass('core.transport_toll_tariffs') is not null
    and (
      select relrowsecurity
      from pg_class
      where oid = 'core.transport_toll_tariffs'::regclass
    )
    and not has_table_privilege(
      'authenticated',
      'core.transport_toll_tariffs',
      'select'
    )
    and (
      select count(*) = 9
      from information_schema.columns
      where table_schema = 'core'
        and table_name = 'transport_toll_tariffs'
        and column_name in (
          'operator_name',
          'toll_plaza_name',
          'entry_plaza_name',
          'exit_plaza_name',
          'vehicle_class',
          'amount_thb',
          'valid_from',
          'valid_to',
          'source_reference'
        )
    )),
  ('transport_toll_tariff_catalog_starts_empty',
    (select count(*) = 0 from core.transport_toll_tariffs)),
  ('transport_seed_counts',
    (select count(*) = 3 from core.transport_warehouses)
    and (select count(*) = 20 from core.transport_district_geo)
    and (select count(*) = 6 from core.transport_vehicles)
    and (select count(*) = 54 from core.transport_route_legs)),
  ('legacy_warehouse_geocodes_fail_closed',
    exists (
      select 1
      from core.transport_district_geo
      where district_ref = 'WH'
        and warehouse_code = 'คลองเตย'
        and is_warehouse
        and geocode_status = 'quarantined'
        and quarantined_at is not null
        and btrim(coalesce(quarantine_reason, '')) <> ''
    )
    and exists (
      select 1
      from core.transport_warehouses
      where warehouse_code = 'บางพลี'
    )
    and not exists (
      select 1
      from core.transport_district_geo
      where is_warehouse
        and warehouse_code = 'บางพลี'
    )),
  ('authoritative_transport_geo_matches_csv',
    (select count(*) = 19 from m13_authoritative_geo_expected)
    and (
      select count(*) = 19
      from core.transport_district_geo
      where geocode_status = 'verified'
    )
    and not exists (
      select 1
      from m13_authoritative_geo_expected expected
      left join core.transport_district_geo actual
        on actual.district_ref = expected.district_ref
      where actual.district_ref is null
        or actual.district_id is distinct from expected.district_id
        or actual.warehouse_code is distinct from expected.warehouse_code
        or actual.name_en is distinct from expected.name_en
        or actual.name_th is distinct from expected.name_th
        or actual.latitude is distinct from expected.latitude
        or actual.longitude is distinct from expected.longitude
        or actual.is_warehouse is distinct from expected.is_warehouse
        or actual.geocode_status <> 'verified'
        or actual.coordinate_source <> 'user_authoritative_csv'
        or actual.source_checksum_sha256 <>
          'fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a'
        or actual.source_row_number <> expected.source_row_number
        or actual.source_reference <>
          'data/MEA_Synapse_Supabase_Production_20260724/data/districts.csv#row='
            || expected.source_row_number::text
        or actual.verified_at is null
        or actual.quarantined_at is not null
    )),
  ('authoritative_geo_precision_is_lossless',
    (
      select count(*) = 4
      from information_schema.columns
      where (
          (
            table_schema = 'core'
            and table_name = 'transport_district_geo'
            and column_name in ('latitude', 'longitude')
          )
          or (
            table_schema = 'core'
            and table_name = 'location_geocodes'
            and column_name in ('latitude', 'longitude')
          )
        )
        and numeric_precision = 11
        and numeric_scale = 8
    )
    and exists (
      select 1
      from core.transport_district_geo
      where district_ref = 'WH-MMBP'
        and latitude = 13.55760333
        and longitude = 100.77072260
    )),
  ('m08_and_transport_district_geocodes_match',
    (
      select count(*) = 18
      from m13_authoritative_geo_expected expected
      join core.transport_district_geo transport
        on transport.district_ref = expected.district_ref
      join core.location_geocodes worker
        on worker.location_id = 'DIST-' || expected.district_id
      where not expected.is_warehouse
        and worker.latitude = transport.latitude
        and worker.longitude = transport.longitude
        and worker.latitude = expected.latitude
        and worker.longitude = expected.longitude
        and worker.verified_at is not null
        and worker.source_reference =
          'data/MEA_Synapse_Supabase_Production_20260724/data/districts.csv#row='
            || expected.source_row_number::text
            || ';sha256=fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a'
    )
    and not exists (
      select 1
      from core.location_geocodes
      where location_id = 'WH-MMBP'
    )),
  ('transport_geo_governance_columns',
    (
      select count(*) = 14
      from information_schema.columns
      where table_schema = 'core'
        and table_name = 'transport_district_geo'
        and column_name in (
          'warehouse_code',
          'name_en',
          'geocode_status',
          'coordinate_source',
          'source_reference',
          'source_checksum_sha256',
          'source_row_number',
          'accuracy_meters',
          'verified_at',
          'verified_by',
          'quarantined_at',
          'quarantined_by',
          'quarantine_reason',
          'updated_at'
        )
    )),
  ('transport_trip_idempotency_columns',
    (
      select count(*) = 2
      from information_schema.columns
      where table_schema = 'ops'
        and table_name = 'transport_trips'
        and column_name in ('request_id', 'request_payload_hash')
    )),
  ('transport_transition_triggers',
    exists (
      select 1
      from pg_trigger
      where tgname = 'enforce_transport_trip_transition'
        and tgrelid = 'ops.transport_trips'::regclass
        and not tgisinternal
    )
    and exists (
      select 1
      from pg_trigger
      where tgname = 'transport_trip_events_append_only'
        and tgrelid = 'ops.transport_trip_events'::regclass
        and not tgisinternal
    )),
  ('transport_request_and_vehicle_indexes',
    to_regclass('ops.transport_trips_actor_request_uidx') is not null
    and to_regclass('ops.transport_trips_vehicle_active_day_uidx') is not null
    and to_regclass('core.transport_route_legs_district_distance_idx') is not null),
  ('transport_dispatch_has_shared_guards',
    position(
      'api_rate_limit_windows'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'operational_writes_enabled'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'm13_transport_dispatch_pre_m13d'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13e(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'm13_transport_dispatch_pre_m13e'
      in pg_get_functiondef(
        'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0),
  ('transport_optimize_has_exact_plan_guards',
    position(
      'plan_not_dispatchable'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'depot_plan_mismatch'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'plan_demand_mismatch'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0),
  ('transport_trip_creation_fails_closed_without_road_evidence',
    position(
      'road_route_evidence_not_persistable'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'insert into ops.transport_trips'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) = 0
    and position(
      'sum(route.distance_km)'
      in pg_get_functiondef(
        'public.m13_transport_dispatch_pre_m13d(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) = 0),
  ('inventory_hardening_contracts',
    to_regclass(
      'core.replenishment_plans_one_active_root_week_uidx'
    ) is not null
    and exists (
      select 1
      from pg_trigger
      where tgname = 'enforce_inventory_return_balance'
        and tgrelid = 'core.inventory_movements'::regclass
        and not tgisinternal
    )
    and to_regprocedure(
      'analytics.stock_health_at(timestamp with time zone)'
    ) is not null),
  ('stock_health_cutoff_not_public',
    not has_function_privilege(
      'anon',
      'analytics.stock_health_at(timestamp with time zone)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'analytics.stock_health_at(timestamp with time zone)',
      'execute'
    ));

-- --------------------------------------------------------------------------
-- Isolated transport fixtures
-- --------------------------------------------------------------------------
insert into auth.users (id, raw_user_meta_data)
values
  (
    '13000000-0000-4000-8000-000000000001',
    '{"display_name":"M13 Planner"}'
  ),
  (
    '13000000-0000-4000-8000-000000000002',
    '{"display_name":"M13 Viewer"}'
  );

update public.user_profiles
set role = 'planner',
    district_id = null
where user_id = '13000000-0000-4000-8000-000000000001';

update public.user_profiles
set role = 'viewer',
    district_id = null
where user_id = '13000000-0000-4000-8000-000000000002';

grant select, update on m13_runtime_state to authenticated;

insert into raw.import_batches (
  batch_id,
  source_system,
  source_file,
  source_sheet,
  source_checksum,
  row_count,
  status,
  imported_at,
  metadata
)
values (
  '13000000-0000-4000-8000-000000000010',
  'm13-contract-test',
  'm13-contract-test.csv',
  'm13',
  repeat('d', 64),
  4,
  'succeeded',
  now(),
  '{"isolated":true}'::jsonb
);

insert into core.materials (
  material_id,
  sap_material_id,
  material_name,
  category,
  unit,
  weight_per_unit_kg,
  is_vmi,
  master_source,
  data_quality_status,
  source_batch_id
)
values
  (
    'M13-MAT-A',
    'M13-MAT-A',
    'M13 dispatch material A',
    'TEST',
    'EA',
    2,
    false,
    'material_master',
    'valid',
    '13000000-0000-4000-8000-000000000010'
  ),
  (
    'M13-MAT-B',
    'M13-MAT-B',
    'M13 zero line',
    'TEST',
    'EA',
    1,
    false,
    'material_master',
    'valid',
    '13000000-0000-4000-8000-000000000010'
  ),
  (
    'M13-MAT-C',
    'M13-MAT-C',
    'M13 rejected line',
    'TEST',
    'EA',
    1,
    false,
    'material_master',
    'valid',
    '13000000-0000-4000-8000-000000000010'
  ),
  (
    'M13-CUTOFF',
    'M13-CUTOFF',
    'M13 cutoff material',
    'TEST',
    'EA',
    1,
    true,
    'material_master',
    'valid',
    '13000000-0000-4000-8000-000000000010'
  );

-- Transaction-local canonical origin used only to exercise the matching
-- contract. Production MMBP remains fail-closed until its core warehouse
-- plant/storage master is provided.
insert into core.warehouses (
  warehouse_id,
  warehouse_name_th,
  sap_plant_code,
  storage_location,
  is_active
)
values (
  'WH-MMBP-TEST',
  'M13 contract Mueang Mai Bang Phli',
  'M13-TEST',
  'MMBP',
  true
);

insert into core.locations (
  location_id,
  location_type,
  location_name_th,
  warehouse_id,
  district_id,
  is_active
)
values (
  'WH-MMBP-TEST',
  'WAREHOUSE',
  'M13 contract Mueang Mai Bang Phli',
  'WH-MMBP-TEST',
  null,
  true
);

insert into ops.replenishment_runs (
  replenishment_run_id,
  policy_version,
  snapshot_cutoff_at,
  status,
  candidate_count,
  initiated_by,
  finished_at
)
values
  (
    '13000000-0000-4000-8000-000000000101',
    'v1.0.0',
    now(),
    'succeeded',
    3,
    '13000000-0000-4000-8000-000000000001',
    now()
  ),
  (
    '13000000-0000-4000-8000-000000000102',
    'v1.0.0',
    now(),
    'succeeded',
    1,
    '13000000-0000-4000-8000-000000000001',
    now()
  ),
  (
    '13000000-0000-4000-8000-000000000108',
    'v1.0.0',
    now(),
    'succeeded',
    1,
    '13000000-0000-4000-8000-000000000001',
    now()
  ),
  (
    '13000000-0000-4000-8000-000000000109',
    'v1.0.0',
    now(),
    'succeeded',
    0,
    '13000000-0000-4000-8000-000000000001',
    now()
  );

insert into core.replenishment_plans (
  replenishment_plan_id,
  replenishment_run_id,
  plan_number,
  week_start_date,
  version_no,
  origin_location_id,
  status,
  response_due_at,
  locked_by,
  locked_at,
  created_by
)
values
  (
    '13000000-0000-4000-8000-000000000201',
    '13000000-0000-4000-8000-000000000101',
    'RP-M13-TEST-A',
    date_trunc('week', current_date)::date - 21,
    1,
    'WH-MMBP-TEST',
    'locked',
    now() + interval '1 day',
    '13000000-0000-4000-8000-000000000001',
    now(),
    '13000000-0000-4000-8000-000000000001'
  ),
  (
    '13000000-0000-4000-8000-000000000202',
    '13000000-0000-4000-8000-000000000102',
    'RP-M13-TEST-B',
    date_trunc('week', current_date)::date - 14,
    1,
    'WH-MMBP-TEST',
    'locked',
    now() + interval '1 day',
    '13000000-0000-4000-8000-000000000001',
    now(),
    '13000000-0000-4000-8000-000000000001'
  ),
  (
    '13000000-0000-4000-8000-000000000208',
    '13000000-0000-4000-8000-000000000108',
    'RP-M13-TEST-KT',
    date_trunc('week', current_date)::date - 42,
    1,
    'WH-KT',
    'locked',
    now() + interval '1 day',
    '13000000-0000-4000-8000-000000000001',
    now(),
    '13000000-0000-4000-8000-000000000001'
  ),
  (
    '13000000-0000-4000-8000-000000000205',
    '13000000-0000-4000-8000-000000000109',
    'RP-M13-TEST-UNLOCKED',
    date_trunc('week', current_date)::date - 35,
    1,
    'WH-MMBP-TEST',
    'draft',
    now() + interval '1 day',
    null,
    null,
    '13000000-0000-4000-8000-000000000001'
  );

insert into core.replenishment_items (
  replenishment_item_id,
  replenishment_plan_id,
  material_id,
  district_id,
  current_stock_qty,
  cmp_monthly,
  months_available,
  min_fill_qty,
  max_fill_qty,
  suggested_qty,
  requested_qty,
  final_qty,
  projected_months_after,
  source_stock_missing,
  priority_score,
  priority_band,
  status
)
values
  (
    '13000000-0000-4000-8000-000000000301',
    '13000000-0000-4000-8000-000000000201',
    'M13-MAT-A',
    '5501',
    10,
    10,
    1,
    30,
    50,
    100,
    100,
    100,
    11,
    false,
    9,
    'critical',
    'locked'
  ),
  (
    '13000000-0000-4000-8000-000000000302',
    '13000000-0000-4000-8000-000000000201',
    'M13-MAT-B',
    '5501',
    10,
    10,
    1,
    0,
    0,
    0,
    0,
    0,
    1,
    false,
    5,
    'normal',
    'locked'
  ),
  (
    '13000000-0000-4000-8000-000000000303',
    '13000000-0000-4000-8000-000000000201',
    'M13-MAT-C',
    '5501',
    10,
    10,
    1,
    30,
    50,
    50,
    50,
    50,
    6,
    false,
    5,
    'normal',
    'district_rejected'
  ),
  (
    '13000000-0000-4000-8000-000000000304',
    '13000000-0000-4000-8000-000000000202',
    'M13-MAT-A',
    '5501',
    10,
    10,
    1,
    30,
    50,
    200,
    200,
    200,
    21,
    false,
    9,
    'critical',
    'locked'
  ),
  (
    '13000000-0000-4000-8000-000000000308',
    '13000000-0000-4000-8000-000000000208',
    'M13-MAT-A',
    '5502',
    10,
    10,
    1,
    30,
    50,
    50,
    50,
    50,
    6,
    false,
    9,
    'critical',
    'locked'
  );

update ops.environment_controls
set operational_writes_enabled = true,
    updated_at = now()
where singleton;

select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update m13_runtime_state
set source_readiness_result = public.m13_transport_dispatch(
  'GET',
  '/v1/transport/readiness',
  '{}'::jsonb,
  '{}'::jsonb,
  'm13-source-readiness'
);

update m13_runtime_state
set missing_plan_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimize',
  '{}'::jsonb,
  '{
    "depot":{"id":"เมืองใหม่"},
    "stops":[{"id":"5501"}]
  }'::jsonb,
  'm13-preflight-missing-plan'
);

update m13_runtime_state
set quarantine_preflight = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimize',
  '{}'::jsonb,
  '{
    "replenishment_plan_id":"13000000-0000-4000-8000-000000000201",
    "depot":{"id":"คลองเตย"},
    "stops":[{"id":"5501"}],
    "objective":"duration"
  }'::jsonb,
  'm13-preflight-quarantine'
);

update m13_runtime_state
set unlocked_plan_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimize',
  '{}'::jsonb,
  '{
    "replenishment_plan_id":"13000000-0000-4000-8000-000000000205",
    "depot":{"id":"เมืองใหม่"},
    "stops":[{"id":"5501"}]
  }'::jsonb,
  'm13-preflight-unlocked-plan'
);

update m13_runtime_state
set depot_origin_mismatch_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimize',
  '{}'::jsonb,
  '{
    "replenishment_plan_id":"13000000-0000-4000-8000-000000000201",
    "depot":{"id":"เมืองใหม่"},
    "stops":[{"id":"5501"}]
  }'::jsonb,
  'm13-preflight-origin-mismatch'
);

reset role;

update core.transport_warehouses
set canonical_warehouse_id = 'WH-MMBP-TEST'
where warehouse_code = 'เมืองใหม่';

select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update m13_runtime_state
set readiness_result = public.m13_transport_dispatch(
  'GET',
  '/v1/transport/readiness',
  '{}'::jsonb,
  '{}'::jsonb,
  'm13-readiness'
);

update m13_runtime_state
set demand_mismatch_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimize',
  '{}'::jsonb,
  '{
    "replenishment_plan_id":"13000000-0000-4000-8000-000000000201",
    "depot":{"id":"เมืองใหม่"},
    "stops":[{"id":"5601"}]
  }'::jsonb,
  'm13-preflight-demand-mismatch'
);

update m13_runtime_state
set invalid_avoid_tolls_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimize',
  '{}'::jsonb,
  '{
    "replenishment_plan_id":"13000000-0000-4000-8000-000000000201",
    "depot":{"id":"เมืองใหม่"},
    "stops":[{"id":"5501"}],
    "avoidTolls":"false"
  }'::jsonb,
  'm13-preflight-invalid-avoid-tolls'
);

update m13_runtime_state
set optimize_preflight = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimize',
  '{}'::jsonb,
  '{
    "replenishment_plan_id":"13000000-0000-4000-8000-000000000201",
    "depot":{"id":"เมืองใหม่","lat":0,"lon":0},
    "stops":[{"id":"5501","lat":0,"lon":0}],
    "objective":"duration",
    "avoidTolls":false
  }'::jsonb,
  'm13-preflight-ok'
);

update m13_runtime_state
set optimization_worker_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
    '13000000-0000-4000-8000-000000000201'
  ),
  'm13-worker-blocked'
);

update m13_runtime_state
set create_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/trips',
  '{}'::jsonb,
  jsonb_build_object(
    'warehouse_code', 'เมืองใหม่',
    'vehicle_id', 'V702',
    'stops', jsonb_build_array('5501'),
    'trip_date', current_date + 1,
    'replenishment_plan_id',
      '13000000-0000-4000-8000-000000000201',
    'notes', 'M13 idempotency contract'
  ),
  'm13-create-1'
);

reset role;

-- Direct owner-only fixture represents a future server-authenticated route
-- evidence writer. No client request can create this row through M13c.
insert into ops.transport_trips (
  trip_id,
  trip_code,
  vehicle_id,
  driver_name,
  warehouse_code,
  route_district_refs,
  total_distance_km,
  total_toll_thb,
  total_travel_minutes,
  fuel_cost_estimate_thb,
  trip_date,
  status,
  max_weight_kg,
  notes,
  replenishment_plan_id,
  created_by,
  request_id,
  request_payload_hash
)
values (
  '13000000-0000-4000-8000-000000000601',
  'TRP-M13-ROUTE-EVIDENCE-FIXTURE',
  'V702',
  'M13 route evidence fixture',
  'เมืองใหม่',
  array['5501'],
  0,
  0,
  0,
  0,
  current_date + 1,
  'planned',
  5000,
  'Transaction-local server route evidence fixture',
  '13000000-0000-4000-8000-000000000201',
  '13000000-0000-4000-8000-000000000001',
  'm13-direct-route-evidence-fixture',
  repeat('a', 64)
);

insert into ops.transport_trip_events (
  trip_id,
  from_status,
  to_status,
  request_id,
  request_payload_hash,
  result_snapshot,
  actor_id
)
select
  trip.trip_id,
  null,
  'planned',
  'm13-direct-route-evidence-fixture',
  repeat('a', 64),
  to_jsonb(trip),
  trip.created_by
from ops.transport_trips trip
where trip.trip_id = '13000000-0000-4000-8000-000000000601';

update m13_runtime_state
set trip_id = '13000000-0000-4000-8000-000000000601';

select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update m13_runtime_state state
set dispatch_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/trips/' || state.trip_id::text || '/status',
  '{}'::jsonb,
  '{"status":"dispatched","depart_time":"08:00"}'::jsonb,
  'm13-status-dispatch'
);

update m13_runtime_state state
set dispatch_retry_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/trips/' || state.trip_id::text || '/status',
  '{}'::jsonb,
  '{"status":"dispatched","depart_time":"08:00"}'::jsonb,
  'm13-status-dispatch'
);

update m13_runtime_state state
set invalid_transition_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/trips/' || state.trip_id::text || '/status',
  '{}'::jsonb,
  '{"status":"planned"}'::jsonb,
  'm13-status-invalid'
);

update m13_runtime_state state
set complete_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/trips/' || state.trip_id::text || '/status',
  '{}'::jsonb,
  '{
    "status":"completed",
    "return_time":"16:00",
    "fuel_cost_actual_thb":500
  }'::jsonb,
  'm13-status-complete'
);

update m13_runtime_state state
set terminal_transition_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/trips/' || state.trip_id::text || '/status',
  '{}'::jsonb,
  '{"status":"cancelled"}'::jsonb,
  'm13-status-terminal'
);

reset role;

update ops.environment_controls
set operational_writes_enabled = false,
    updated_at = now()
where singleton;

select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update m13_runtime_state
set write_lock_result = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimize',
  '{}'::jsonb,
  '{
    "replenishment_plan_id":"13000000-0000-4000-8000-000000000201",
    "depot":{"id":"เมืองใหม่"},
    "stops":[{"id":"5501"}]
  }'::jsonb,
  'm13-write-locked'
);

reset role;

update ops.environment_controls
set operational_writes_enabled = true,
    updated_at = now()
where singleton;

-- --------------------------------------------------------------------------
-- Snapshot cutoff regression: rows after the cutoff must not be selected.
-- --------------------------------------------------------------------------
insert into core.stock_snapshots (
  snapshot_id,
  material_id,
  location_id,
  quantity_on_hand,
  snapshot_at,
  source_batch_id,
  data_class,
  source_quality,
  created_at
)
values
  (
    '13000000-0000-4000-8000-000000000401',
    'M13-CUTOFF',
    'DIST-5502',
    10,
    statement_timestamp() - interval '2 days',
    '13000000-0000-4000-8000-000000000010',
    'actual',
    'source_derived',
    statement_timestamp() - interval '2 days'
  ),
  (
    '13000000-0000-4000-8000-000000000402',
    'M13-CUTOFF',
    'DIST-5502',
    999,
    statement_timestamp(),
    '13000000-0000-4000-8000-000000000010',
    'actual',
    'source_derived',
    statement_timestamp()
  );

insert into core.usage_rates (
  usage_rate_id,
  material_id,
  district_id,
  as_of_date,
  cmp_monthly,
  avg_ly,
  avg_12m,
  avg_6m,
  avg_4m,
  source_batch_id,
  data_class,
  source_quality,
  created_at,
  updated_at
)
values
  (
    '13000000-0000-4000-8000-000000000411',
    'M13-CUTOFF',
    '5502',
    current_date - 2,
    10,
    10,
    10,
    10,
    10,
    '13000000-0000-4000-8000-000000000010',
    'actual',
    'source_derived',
    statement_timestamp() - interval '2 days',
    statement_timestamp() - interval '2 days'
  ),
  (
    '13000000-0000-4000-8000-000000000412',
    'M13-CUTOFF',
    '5502',
    current_date,
    99,
    99,
    99,
    99,
    99,
    '13000000-0000-4000-8000-000000000010',
    'actual',
    'source_derived',
    statement_timestamp(),
    statement_timestamp()
  );

select set_config(
  'request.jwt.claim.sub',
  '13000000-0000-4000-8000-000000000001',
  true
);

update m13_runtime_state
set cutoff_at =
  date_trunc('second', statement_timestamp()) - interval '1 day';

update m13_runtime_state state
set cutoff_run_id = core.create_replenishment_run(state.cutoff_at);

update m13_runtime_state state
set cutoff_selected_old = exists (
  select 1
  from core.replenishment_plans plan
  join core.replenishment_items item using (replenishment_plan_id)
  join ops.replenishment_runs run using (replenishment_run_id)
  where plan.replenishment_run_id = state.cutoff_run_id
    and item.material_id = 'M13-CUTOFF'
    and item.district_id = '5502'
    and item.source_stock_snapshot_id =
      '13000000-0000-4000-8000-000000000401'
    and item.source_usage_rate_id =
      '13000000-0000-4000-8000-000000000411'
    and item.current_stock_qty = 10
    and item.cmp_monthly = 10
    and run.snapshot_cutoff_at = state.cutoff_at
);

insert into ops.replenishment_runs (
  replenishment_run_id,
  policy_version,
  snapshot_cutoff_at,
  status,
  initiated_by
)
values (
  '13000000-0000-4000-8000-000000000103',
  'v1.0.0',
  now(),
  'running',
  '13000000-0000-4000-8000-000000000001'
);

do $$
begin
  begin
    insert into core.replenishment_plans (
      replenishment_plan_id,
      replenishment_run_id,
      plan_number,
      week_start_date,
      version_no,
      origin_location_id,
      status,
      response_due_at,
      created_by
    )
    values (
      '13000000-0000-4000-8000-000000000203',
      '13000000-0000-4000-8000-000000000103',
      'RP-M13-DUPLICATE',
      date_trunc('week', current_date)::date,
      1,
      'WH-KT',
      'draft',
      now() + interval '1 day',
      '13000000-0000-4000-8000-000000000001'
    );
  exception
    when unique_violation then
      update m13_runtime_state
      set weekly_uniqueness_enforced = true;
  end;
end
$$;

insert into core.inventory_movements (
  inventory_movement_id,
  movement_type,
  material_id,
  from_location_id,
  to_location_id,
  quantity,
  idempotency_key,
  reason,
  performed_by
)
values (
  '13000000-0000-4000-8000-000000000501',
  'ISSUE',
  'M13-CUTOFF',
  'WH-KT',
  'DIST-5502',
  10,
  'm13-return-source',
  'M13 return concurrency fixture',
  '13000000-0000-4000-8000-000000000001'
);

insert into core.inventory_movements (
  inventory_movement_id,
  movement_type,
  material_id,
  from_location_id,
  to_location_id,
  quantity,
  source_movement_id,
  idempotency_key,
  reason,
  performed_by
)
values (
  '13000000-0000-4000-8000-000000000502',
  'RETURN',
  'M13-CUTOFF',
  'DIST-5502',
  'WH-KT',
  6,
  '13000000-0000-4000-8000-000000000501',
  'm13-return-first',
  'M13 accepted return',
  '13000000-0000-4000-8000-000000000001'
);

do $$
begin
  begin
    insert into core.inventory_movements (
      inventory_movement_id,
      movement_type,
      material_id,
      from_location_id,
      to_location_id,
      quantity,
      source_movement_id,
      idempotency_key,
      reason,
      performed_by
    )
    values (
      '13000000-0000-4000-8000-000000000503',
      'RETURN',
      'M13-CUTOFF',
      'DIST-5502',
      'WH-KT',
      5,
      '13000000-0000-4000-8000-000000000501',
      'm13-return-over',
      'M13 rejected over-return',
      '13000000-0000-4000-8000-000000000001'
    );
  exception
    when check_violation then
      update m13_runtime_state
      set return_balance_enforced = true;
  end;
end
$$;

do $$
begin
  begin
    update ops.transport_trip_events
    set to_status = 'cancelled'
    where trip_id = (
      select trip_id
      from m13_runtime_state
    );
  exception
    when raise_exception then
      update m13_runtime_state
      set event_append_only_enforced = true;
  end;
end
$$;

-- --------------------------------------------------------------------------
-- Behavioral assertions
-- --------------------------------------------------------------------------
insert into m13_transport_checks (check_name, passed)
select
  'quarantined_geo_rejected',
  (quarantine_preflight ->> 'status')::integer = 422
  and quarantine_preflight #>> '{body,error,code}' =
    'geocode_not_verified'
from m13_runtime_state
union all
select
  'source_readiness_explains_canonical_origin_block',
  (source_readiness_result ->> 'status')::integer = 200
  and (
    source_readiness_result
      #>> '{body,verified_district_geocodes}'
  )::integer = 18
  and (
    source_readiness_result
      #>> '{body,verified_warehouse_geocodes}'
  )::integer = 1
  and (
    source_readiness_result
      #>> '{body,quarantined_geocodes}'
  )::integer = 1
  and (
    source_readiness_result
      #>> '{body,warehouses_missing_geocode}'
  )::integer = 1
  and (
    source_readiness_result
      #>> '{body,verified_depots_missing_canonical_origin}'
  )::integer = 1
  and not coalesce(
    (source_readiness_result #>> '{body,route_ready}')::boolean,
    true
  )
  and source_readiness_result
    #>> '{body,route_readiness_status}' =
      'blocked_verified_depot_missing_canonical_origin'
from m13_runtime_state
union all
select
  'optimize_requires_dispatchable_plan',
  (missing_plan_result ->> 'status')::integer = 422
  and missing_plan_result #>> '{body,error,code}' =
    'validation_error'
  and (unlocked_plan_result ->> 'status')::integer = 409
  and unlocked_plan_result #>> '{body,error,code}' =
    'plan_not_dispatchable'
from m13_runtime_state
union all
select
  'optimize_requires_matching_canonical_origin',
  (depot_origin_mismatch_result ->> 'status')::integer = 409
  and depot_origin_mismatch_result #>> '{body,error,code}' =
    'depot_plan_mismatch'
  and depot_origin_mismatch_result
    #>> '{body,error,details,origin_warehouse_id}' =
      'WH-MMBP-TEST'
from m13_runtime_state
union all
select
  'optimize_requires_exact_positive_locked_plan_demand',
  (demand_mismatch_result ->> 'status')::integer = 409
  and demand_mismatch_result #>> '{body,error,code}' =
    'plan_demand_mismatch'
from m13_runtime_state
union all
select
  'optimize_requires_boolean_avoid_tolls',
  (invalid_avoid_tolls_result ->> 'status')::integer = 422
  and invalid_avoid_tolls_result #>> '{body,error,code}' =
    'validation_error'
from m13_runtime_state
union all
select
  'optimize_preflight_returns_canonical_verified_geo',
  (optimize_preflight ->> 'status')::integer = 200
  and coalesce(
    (optimize_preflight #>> '{body,authorized}')::boolean,
    false
  )
  and optimize_preflight #>> '{body,replenishment_plan_id}' =
    '13000000-0000-4000-8000-000000000201'
  and optimize_preflight #>> '{body,root_replenishment_plan_id}' =
    '13000000-0000-4000-8000-000000000201'
  and optimize_preflight #>> '{body,origin_location_id}' =
    'WH-MMBP-TEST'
  and optimize_preflight #>> '{body,depot,district_ref}' = 'WH-MMBP'
  and optimize_preflight #>> '{body,depot,warehouse_code}' = 'เมืองใหม่'
  and (optimize_preflight #>> '{body,depot,lat}')::numeric =
    13.55760333
  and (optimize_preflight #>> '{body,depot,lon}')::numeric =
    100.77072260
  and optimize_preflight
    #>> '{body,depot,source_checksum_sha256}' =
      'fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a'
  and optimize_preflight #>> '{body,stops,0,district_ref}' = '5501'
  and (optimize_preflight #>> '{body,stops,0,lat}')::numeric =
    13.81895000
  and (optimize_preflight #>> '{body,stops,0,lon}')::numeric =
    100.64410000
  and optimize_preflight
    #>> '{body,stops,0,source_checksum_sha256}' =
      'fe97ecb44299dbd8b1fa8778b11483e343a31e8bd1d12ca7b11cba324e5fc62a'
  and optimize_preflight #>> '{body,verified_geo_ids,0}' = 'WH-MMBP'
  and optimize_preflight #>> '{body,verified_geo_ids,1}' = '5501'
  and not coalesce(
    (optimize_preflight #>> '{body,avoid_tolls}')::boolean,
    true
  )
  and not coalesce(
    (
      optimize_preflight
        #>> '{body,monetary_toll_estimate_available}'
    )::boolean,
    true
  )
  and optimize_preflight
    #>> '{body,monetary_toll_estimate_status}' =
      'unavailable_route_tariff_mapping_not_configured'
  and jsonb_array_length(
    optimize_preflight #> '{body,verified_geo_ids}'
  ) = 2
from m13_runtime_state
union all
select
  'readiness_reports_toll_estimate_unavailable',
  (readiness_result ->> 'status')::integer = 200
  and (
    readiness_result
      #>> '{body,verified_current_toll_tariffs}'
  )::integer = 0
  and not coalesce(
    (
      readiness_result
        #>> '{body,monetary_toll_estimate_available}'
    )::boolean,
    true
  )
  and readiness_result
    #>> '{body,monetary_toll_estimate_status}' =
      'unavailable_route_tariff_mapping_not_configured'
  and coalesce(
    (readiness_result #>> '{body,route_ready}')::boolean,
    false
  )
  and readiness_result #>> '{body,route_readiness_status}' = 'ready'
  and not coalesce(
    (readiness_result #>> '{body,trip_persistence_ready}')::boolean,
    true
  )
  and readiness_result #>> '{body,trip_persistence_status}' =
    'blocked_route_plan_to_trip_activation_not_configured'
from m13_runtime_state
union all
select
  'optimization_worker_fails_closed',
  (optimization_worker_result ->> 'status')::integer = 409
  and optimization_worker_result #>> '{body,error,code}' =
    'route_job_not_dispatchable'
from m13_runtime_state
union all
select
  'transport_write_lock_applies',
  (write_lock_result ->> 'status')::integer = 423
  and write_lock_result #>> '{body,error,code}' =
    'production_not_ready'
from m13_runtime_state
union all
select
  'dispatch_queue_is_plan_district_specific',
  (
    select count(*) = 2
    from analytics.v_transport_dispatch_queue
    where district_id = '5501'
      and replenishment_plan_id in (
        '13000000-0000-4000-8000-000000000201',
        '13000000-0000-4000-8000-000000000202'
      )
  )
  and exists (
    select 1
    from analytics.v_transport_dispatch_queue
    where replenishment_plan_id =
      '13000000-0000-4000-8000-000000000201'
      and plan_number = 'RP-M13-TEST-A'
      and district_id = '5501'
      and line_count = 1
      and total_qty = 100
      and origin_location_id = 'WH-MMBP-TEST'
      and origin_warehouse_id = 'WH-MMBP-TEST'
      and suggested_warehouse = 'เมืองใหม่'
      and suggested_distance_km is null
      and suggested_warehouse_geocode_status = 'verified'
      and route_eligible
  )
  and exists (
    select 1
    from analytics.v_transport_dispatch_queue
    where replenishment_plan_id =
      '13000000-0000-4000-8000-000000000202'
      and plan_number = 'RP-M13-TEST-B'
      and district_id = '5501'
      and line_count = 1
      and total_qty = 200
      and origin_location_id = 'WH-MMBP-TEST'
      and origin_warehouse_id = 'WH-MMBP-TEST'
      and suggested_warehouse = 'เมืองใหม่'
      and suggested_distance_km is null
      and suggested_warehouse_geocode_status = 'verified'
      and route_eligible
  )
union all
select
  'dispatch_queue_preserves_quarantined_plan_origin',
  exists (
    select 1
    from analytics.v_transport_dispatch_queue
    where replenishment_plan_id =
      '13000000-0000-4000-8000-000000000208'
      and plan_number = 'RP-M13-TEST-KT'
      and district_id = '5502'
      and district_ref = '5601'
      and line_count = 1
      and total_qty = 50
      and origin_location_id = 'WH-KT'
      and origin_warehouse_id = 'WH-KT'
      and suggested_warehouse = 'คลองเตย'
      and suggested_distance_km is null
      and suggested_warehouse_geocode_status = 'quarantined'
      and not route_eligible
  )
  and not exists (
    select 1
    from analytics.v_transport_dispatch_queue
    where replenishment_plan_id =
      '13000000-0000-4000-8000-000000000208'
      and suggested_warehouse = 'เมืองใหม่'
  )
union all
select
  'route_matrix_is_canonical_but_never_road_evidence',
  exists (
    select 1
    from analytics.v_transport_route_matrix
    where warehouse_code = 'เมืองใหม่'
      and canonical_warehouse_id = 'WH-MMBP-TEST'
      and endpoint_geocodes_eligible
      and not route_eligible
  )
  and not exists (
    select 1
    from analytics.v_transport_route_matrix
    where matrix_evidence_status <>
      'legacy_illustrative_not_road_evidence'
       or road_evidence_usable
       or route_eligible
  )
  and not exists (
    select 1
    from analytics.v_transport_route_matrix
    where warehouse_code in ('คลองเตย', 'บางพลี')
      and endpoint_geocodes_eligible
  )
union all
select
  'trip_create_fails_closed_without_road_evidence',
  (create_result ->> 'status')::integer = 410
  and create_result #>> '{body,error,code}' =
    'road_route_evidence_not_persistable'
  and not exists (
    select 1
    from ops.transport_trips trip
    where trip.request_id = 'm13-create-1'
  )
from m13_runtime_state
union all
select
  'trip_status_transition_contract',
  (dispatch_result ->> 'status')::integer = 409
  and dispatch_result #>> '{body,error,code}' =
    'road_evidence_not_verified'
  and (dispatch_retry_result ->> 'status')::integer = 409
  and dispatch_retry_result #>> '{body,error,code}' =
    'road_evidence_not_verified'
  and (invalid_transition_result ->> 'status')::integer = 409
  and invalid_transition_result #>> '{body,error,code}' =
    'road_evidence_not_verified'
  and (complete_result ->> 'status')::integer = 409
  and complete_result #>> '{body,error,code}' =
    'road_evidence_not_verified'
  and (terminal_transition_result ->> 'status')::integer = 200
  and terminal_transition_result #>> '{body,status}' = 'cancelled'
from m13_runtime_state
union all
select
  'trip_events_are_idempotent_and_append_only',
  (
    select count(*) = 2
    from ops.transport_trip_events event
    where event.trip_id = state.trip_id
  )
  and state.event_append_only_enforced
from m13_runtime_state state
union all
select
  'transport_rate_window_incremented',
  exists (
    select 1
    from ops.api_rate_limit_windows rate
    where rate.user_id =
      '13000000-0000-4000-8000-000000000001'
      and rate.request_count >= 10
  )
union all
select
  'replenishment_cutoff_selects_historical_inputs',
  cutoff_selected_old
from m13_runtime_state
union all
select
  'one_active_root_plan_per_week_enforced',
  weekly_uniqueness_enforced
from m13_runtime_state
union all
select
  'inventory_return_balance_enforced',
  return_balance_enforced
from m13_runtime_state;

table m13_transport_checks;

do $$
begin
  if exists (
    select 1
    from m13_transport_checks
    where not passed
  ) then
    raise exception 'M13 transport contract failed: %',
      (
        select string_agg(check_name, ', ' order by check_name)
        from m13_transport_checks
        where not passed
      );
  end if;
end
$$;

rollback;
