\set ON_ERROR_STOP on

begin;

create temporary table m13e_runtime (
  missing_evidence_blocked boolean not null default false,
  invalid_geometry_blocked boolean not null default false,
  expired_availability_blocked boolean not null default false,
  haversine_approval_blocked boolean not null default false,
  rejection_succeeded boolean not null default false,
  valid_approval_succeeded boolean not null default false,
  evidence_update_blocked boolean not null default false,
  noncanonical_tileset_blocked boolean not null default false,
  matrix_identity_mismatch_count integer not null default 0,
  queue_mixed_invalid jsonb,
  queue_no_worker jsonb,
  queue_old_worker_version jsonb,
  queue_invalid_worker_attestation jsonb,
  queue_first jsonb,
  queue_replay jsonb,
  queue_duplicate_active jsonb,
  queue_cross_plan_conflict jsonb,
  queue_haversine_blocked jsonb,
  queue_write_lock_blocked jsonb,
  queue_get_owner jsonb,
  queue_get_other_user jsonb,
  queue_deactivated_get jsonb,
  queue_deactivated_post jsonb,
  readiness jsonb,
  readiness_ready jsonb
);

insert into m13e_runtime default values;

grant select, update on m13e_runtime to authenticated;

create temporary table m13e_checks (
  check_name text primary key,
  passed boolean not null
);

insert into m13e_checks (check_name, passed)
values
  (
    'migration_registered',
    exists (
      select 1
      from ops.schema_migrations
      where version = '202607250005'
        and source_file =
          'supabase/migrations/202607250005_m13e_route_evidence.sql'
    )
  ),
  (
    'legacy_transport_vehicles_remain_unmapped',
    not exists (
      select 1
      from core.transport_vehicles
      where vehicle_mapping_status <> 'unmapped'
         or canonical_vehicle_id is not null
         or capacity_evidence_status <> 'unverified'
         or availability_evidence_status <> 'unknown'
    )
  ),
  (
    'fleet_evidence_columns_exist',
    (
      select count(*) = 26
      from information_schema.columns
      where table_schema = 'core'
        and table_name = 'transport_vehicles'
        and column_name in (
          'canonical_vehicle_id',
          'vehicle_mapping_status',
          'vehicle_mapping_source_reference',
          'vehicle_mapping_source_checksum_sha256',
          'vehicle_mapping_source_row_number',
          'vehicle_mapping_verified_at',
          'vehicle_mapping_verified_by',
          'vehicle_mapping_approval_ticket',
          'max_pallets',
          'capacity_evidence_status',
          'capacity_source_reference',
          'capacity_source_checksum_sha256',
          'capacity_source_row_number',
          'capacity_verified_at',
          'capacity_verified_by',
          'capacity_verification_ticket',
          'availability_evidence_status',
          'availability_source_reference',
          'availability_source_checksum_sha256',
          'availability_source_row_number',
          'availability_checked_at',
          'availability_expires_at',
          'availability_verified_by',
          'availability_verification_ticket',
          'updated_at',
          'vehicle_id'
        )
    )
  ),
  (
    'fleet_status_view_exposes_truthful_owner_evidence',
    coalesce(
      (
        select class.reloptions
        from pg_class class
        join pg_namespace namespace
          on namespace.oid = class.relnamespace
        where namespace.nspname = 'analytics'
          and class.relname = 'v_transport_vehicle_status'
      ),
      array[]::text[]
    ) @> array['security_invoker=true']
    and has_table_privilege(
      'service_role',
      'analytics.v_transport_vehicle_status',
      'select'
    )
    and not has_table_privilege(
      'authenticated',
      'analytics.v_transport_vehicle_status',
      'select'
    )
    and (
      select count(*) = 13
      from information_schema.columns
      where table_schema = 'analytics'
        and table_name = 'v_transport_vehicle_status'
        and column_name in (
          'canonical_vehicle_id',
          'vehicle_mapping_status',
          'vehicle_mapping_source_reference',
          'capacity_evidence_status',
          'capacity_source_reference',
          'availability_evidence_status',
          'availability_source_reference',
          'availability_checked_at',
          'availability_expires_at',
          'is_available',
          'availability_status',
          'availability_evidence',
          'availability_is_current'
        )
    )
  ),
  (
    'road_evidence_table_is_private_rls',
    to_regclass(
      'core.route_plan_vehicle_road_evidence'
    ) is not null
    and (
      select relrowsecurity
      from pg_class
      where oid =
        'core.route_plan_vehicle_road_evidence'::regclass
    )
    and not has_table_privilege(
      'anon',
      'core.route_plan_vehicle_road_evidence',
      'select'
    )
    and not has_table_privilege(
      'authenticated',
      'core.route_plan_vehicle_road_evidence',
      'select'
    )
    and has_table_privilege(
      'service_role',
      'core.route_plan_vehicle_road_evidence',
      'insert'
    )
    and not has_table_privilege(
      'service_role',
      'core.route_plan_vehicle_road_evidence',
      'update'
    )
    and not has_table_privilege(
      'service_role',
      'core.route_plan_vehicle_road_evidence',
      'delete'
    )
  ),
  (
    'geojson_view_is_security_invoker',
    coalesce(
      (
        select class.reloptions
        from pg_class class
        join pg_namespace namespace
          on namespace.oid = class.relnamespace
        where namespace.nspname = 'analytics'
          and class.relname = 'v_route_plan_geojson'
      ),
      array[]::text[]
    ) @> array['security_invoker=true']
  ),
  (
    'review_function_contains_fail_closed_guards',
    position(
      'verified Valhalla matrix'
      in pg_get_functiondef(
        'core.review_route_plan(uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'exact locked latest replenishment plan'
      in pg_get_functiondef(
        'core.review_route_plan(uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'route_plan_vehicle_road_evidence'
      in pg_get_functiondef(
        'core.review_route_plan(uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'availability_expires_at <= clock_timestamp()'
      in pg_get_functiondef(
        'core.review_route_plan(uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'evidence.route_matrix_id is distinct from v_plan.route_matrix_id'
      in pg_get_functiondef(
        'core.review_route_plan(uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'evidence.engine_status_response_sha256'
      in pg_get_functiondef(
        'core.review_route_plan(uuid,text,text)'::regprocedure
      )
    ) > 0
  ),
  (
    'route_queue_is_locked_plan_valhalla_and_idempotent',
    position(
      'route_plan_is_optimization_eligible'
      in pg_get_functiondef(
        'core.queue_route_job(uuid,uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'p_matrix_source is distinct from ''valhalla'''
      in pg_get_functiondef(
        'core.queue_route_job(uuid,uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'pg_advisory_xact_lock'
      in pg_get_functiondef(
        'core.queue_route_job(uuid,uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'route_job.requested_by = v_actor_id'
      in pg_get_functiondef(
        'core.queue_route_job(uuid,uuid,text,text)'::regprocedure
      )
    ) > 0
    and position(
      'has_recent_compatible_route_worker'
      in pg_get_functiondef(
        'core.queue_route_job(uuid,uuid,text,text)'::regprocedure
      )
    ) > 0
  ),
  (
    'transport_dispatch_exposes_governed_job_paths',
    position(
      '/v1/transport/optimization-jobs'
      in pg_get_functiondef(
        'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'blocked_route_plan_to_trip_activation_not_configured'
      in pg_get_functiondef(
        'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'v_role is null or v_role not in'
      in pg_get_functiondef(
        'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
    and position(
      'optimization_eligible_plan_ids'
      in pg_get_functiondef(
        'public.m13_transport_dispatch(text,text,jsonb,jsonb,text)'::regprocedure
      )
    ) > 0
  ),
  (
    'complete_route_input_gate_covers_every_positive_item',
    -- M14 kept the public gate name but moved the pre-M14 packaging validations
    -- into core.route_plan_has_complete_routing_inputs_m13e, which the public
    -- wrapper still calls. Inspect the combined source so the packaging-coverage
    -- guarantee is verified wherever the clause now lives.
    position(
      'not exists'
      in pg_get_functiondef(
        'core.route_plan_has_complete_routing_inputs(uuid)'::regprocedure
      )
    ) > 0
    and position(
      'physical_packaging'
      in (
        pg_get_functiondef(
          'core.route_plan_has_complete_routing_inputs(uuid)'::regprocedure
        )
        || pg_get_functiondef(
          'core.route_plan_has_complete_routing_inputs_m13e(uuid)'::regprocedure
        )
      )
    ) > 0
    and position(
      'canonical_packaging'
      in (
        pg_get_functiondef(
          'core.route_plan_has_complete_routing_inputs(uuid)'::regprocedure
        )
        || pg_get_functiondef(
          'core.route_plan_has_complete_routing_inputs_m13e(uuid)'::regprocedure
        )
      )
    ) > 0
  );

-- --------------------------------------------------------------------------
-- Isolated owner, canonical warehouse, material, plan and fleet fixtures.
-- --------------------------------------------------------------------------
insert into auth.users (id, raw_user_meta_data)
values
  (
    '13500000-0000-4000-8000-000000000001',
    '{"display_name":"M13e Planner"}'
  ),
  (
    '13500000-0000-4000-8000-000000000002',
    '{"display_name":"M13e Other Planner"}'
  );

update public.user_profiles
set role = 'planner',
    district_id = null
where user_id in (
  '13500000-0000-4000-8000-000000000001',
  '13500000-0000-4000-8000-000000000002'
);

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
  '13500000-0000-4000-8000-000000000010',
  'm13e-contract-test',
  'm13e-contract-test.csv',
  'm13e',
  repeat('1', 64),
  1,
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
    'M13E-MAT-A',
    'M13E-MAT-A',
    'M13e road evidence material',
    'TEST',
    'EA',
    2,
    false,
    'material_master',
    'valid',
    '13500000-0000-4000-8000-000000000010'
  ),
  (
    'M13E-MAT-B',
    'M13E-MAT-B',
    'M13e intentionally incomplete packaging material',
    'TEST',
    'EA',
    1,
    false,
    'material_master',
    'valid',
    '13500000-0000-4000-8000-000000000010'
  );

insert into core.material_packaging (
  material_id,
  quantity_per_box,
  box_volume_m3,
  weight_per_box_kg,
  boxes_per_pallet,
  source_reference,
  verified_at,
  quantity_uom,
  source_checksum_sha256,
  source_row_number,
  verified_by,
  verification_ticket
)
values (
  'M13E-MAT-A',
  10,
  0.05,
  20,
  10,
  'm13e-contract-test/physical-packaging.csv#row=2',
  now(),
  'EA',
  repeat('a', 64),
  2,
  '13500000-0000-4000-8000-000000000001',
  'M13E-PKG-TICKET-001'
);

insert into core.packaging_profiles (
  material_id,
  full_pallet_qty,
  inner_pack_qty,
  base_uom,
  allows_partial_issue,
  source_reference,
  verified_at,
  data_class,
  source_quality,
  source_checksum_sha256,
  source_row_number,
  verified_by,
  verification_ticket
)
values (
  'M13E-MAT-A',
  100,
  10,
  'EA',
  true,
  'm13e-contract-test/canonical-packaging.csv#row=2',
  now(),
  'actual',
  'verified',
  repeat('a', 64),
  2,
  '13500000-0000-4000-8000-000000000001',
  'M13E-PKG-TICKET-001'
);

-- M14 (project-sheet incremental) tightened
-- core.route_plan_has_complete_routing_inputs to also require every locked item's
-- packaging to be traceable to reference_data.material_packaging_evidence linked
-- to a succeeded ops.project_sheet_imports. Seed that provenance chain so a
-- complete plan is genuinely route-ready under the post-M14 gate.
insert into reference_data.source_artifacts (
  artifact_id, source_path, source_checksum, source_file_size_bytes, data_class
)
values (
  '13500000-0000-4000-8000-000000000701',
  'm13e-contract-test/project-sheet.xlsx',
  repeat('a', 64),
  1024,
  'reference_fixture'
);

with seeded_source_row as (
  insert into reference_data.source_rows (
    artifact_id, source_row_number, payload, row_hash, material_id
  )
  values (
    '13500000-0000-4000-8000-000000000701', 2, '{}'::jsonb, repeat('a', 64), 'M13E-MAT-A'
  )
  returning source_row_id
), seeded_raw_row as (
  insert into raw.source_rows (
    batch_id, source_entity, source_row_number, row_hash, payload
  )
  values (
    '13500000-0000-4000-8000-000000000010', 'packaging', 2, repeat('a', 64), '{}'::jsonb
  )
  returning source_row_id
), seeded_import as (
  insert into ops.project_sheet_imports (
    source_path, source_spreadsheet_id, source_checksum, source_downloaded_at,
    material_artifact_id, packaging_artifact_id, contract_artifact_id, usage_artifact_id,
    status, verified_by, attestation_text, change_ticket
  )
  values (
    'm13e-contract-test/project-sheet.xlsx', 'M13E-SHEET', repeat('a', 64), now(),
    '13500000-0000-4000-8000-000000000701', '13500000-0000-4000-8000-000000000701',
    '13500000-0000-4000-8000-000000000701', '13500000-0000-4000-8000-000000000701',
    'succeeded', '13500000-0000-4000-8000-000000000001',
    'm13e fixture packaging attestation', 'M13E-PKG-TICKET-001'
  )
  returning project_sheet_import_id
)
insert into reference_data.material_packaging_evidence (
  project_sheet_import_id, material_id, source_artifact_id, source_row_id,
  raw_source_row_id, source_checksum, source_row_number, quantity_uom,
  quantity_per_box, box_volume_m3, weight_per_box_kg, boxes_per_pallet,
  pallet_volume_m3, pallet_weight_kg, verified_by, change_ticket
)
select
  seeded_import.project_sheet_import_id, 'M13E-MAT-A',
  '13500000-0000-4000-8000-000000000701', seeded_source_row.source_row_id,
  seeded_raw_row.source_row_id, repeat('a', 64), 2, 'EA',
  10, 0.05, 20, 10, 0.5, 200,
  '13500000-0000-4000-8000-000000000001', 'M13E-PKG-TICKET-001'
from seeded_source_row, seeded_raw_row, seeded_import;

insert into core.warehouses (
  warehouse_id,
  warehouse_name_th,
  sap_plant_code,
  storage_location,
  is_active
)
values (
  'WH-M13E-TEST',
  'M13e route evidence warehouse',
  'M13E-TEST',
  'ROUTE',
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
  'WH-M13E-TEST',
  'WAREHOUSE',
  'M13e route evidence warehouse',
  'WH-M13E-TEST',
  null,
  true
);

insert into core.transport_warehouses (
  warehouse_code,
  name_th,
  is_active,
  canonical_warehouse_id
)
values (
  'M13E-WH',
  'M13e route evidence warehouse',
  true,
  'WH-M13E-TEST'
);

insert into core.transport_district_geo (
  district_ref,
  district_id,
  warehouse_code,
  name_en,
  name_th,
  latitude,
  longitude,
  is_warehouse,
  geocode_status,
  coordinate_source,
  source_reference,
  source_checksum_sha256,
  source_row_number,
  verified_at
)
values (
  'WH-M13E-TEST',
  null,
  'M13E-WH',
  'M13e route evidence warehouse',
  'คลังทดสอบหลักฐานเส้นทาง M13e',
  13.55760333,
  100.77072260,
  true,
  'verified',
  'm13e_contract_fixture',
  'm13e-contract-test/depot.csv#row=2',
  repeat('d', 64),
  2,
  now()
);

insert into core.vehicles (
  vehicle_id,
  vehicle_name,
  max_weight_kg,
  max_volume_m3,
  max_pallets,
  home_location_id,
  is_active,
  source_reference
)
values (
  'M13E-CANONICAL-1',
  'M13e canonical vehicle',
  5000,
  24,
  12,
  'WH-M13E-TEST',
  true,
  'm13e-contract-test/canonical-fleet#row=1'
);

insert into core.transport_vehicles (
  vehicle_id,
  plate,
  vehicle_type,
  asset_code,
  storage_location,
  home_warehouse,
  current_warehouse,
  loan_status,
  max_weight_kg,
  max_volume_m3,
  fuel_rate_km_per_l,
  fuel_price_thb_per_l,
  driver_name,
  is_active,
  canonical_vehicle_id,
  vehicle_mapping_status,
  vehicle_mapping_source_reference,
  vehicle_mapping_source_checksum_sha256,
  vehicle_mapping_source_row_number,
  vehicle_mapping_verified_at,
  vehicle_mapping_verified_by,
  vehicle_mapping_approval_ticket,
  max_pallets,
  capacity_evidence_status,
  capacity_source_reference,
  capacity_source_checksum_sha256,
  capacity_source_row_number,
  capacity_verified_at,
  capacity_verified_by,
  capacity_verification_ticket,
  availability_evidence_status,
  availability_source_reference,
  availability_source_checksum_sha256,
  availability_source_row_number,
  availability_checked_at,
  availability_expires_at,
  availability_verified_by,
  availability_verification_ticket
)
values (
  'M13E-TRANSPORT-1',
  'TEST-135E',
  'TEST-TRUCK',
  'M13E-ASSET-1',
  'ROUTE',
  'M13E-WH',
  'M13E-WH',
  'HOME',
  5000,
  24,
  10,
  35,
  'M13e contract driver',
  true,
  'M13E-CANONICAL-1',
  'verified',
  'owner-fleet-map.xlsx#row=1',
  repeat('2', 64),
  1,
  now() - interval '10 minutes',
  '13500000-0000-4000-8000-000000000001',
  'M13E-MAPPING-APPROVAL',
  12,
  'verified',
  'owner-capacity.xlsx#row=1',
  repeat('3', 64),
  1,
  now() - interval '10 minutes',
  '13500000-0000-4000-8000-000000000001',
  'M13E-CAPACITY-APPROVAL',
  'available',
  'owner-availability.xlsx#row=1',
  repeat('4', 64),
  1,
  now() - interval '1 minute',
  now() + interval '1 hour',
  '13500000-0000-4000-8000-000000000001',
  'M13E-AVAILABILITY-APPROVAL'
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
values (
  '13500000-0000-4000-8000-000000000101',
  'v1.0.0',
  now(),
  'succeeded',
  1,
  '13500000-0000-4000-8000-000000000001',
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
values (
  '13500000-0000-4000-8000-000000000201',
  '13500000-0000-4000-8000-000000000101',
  'RP-M13E-TEST',
  date_trunc('week', current_date)::date - 7,
  1,
  'WH-M13E-TEST',
  'locked',
  now() + interval '1 day',
  '13500000-0000-4000-8000-000000000001',
  now(),
  '13500000-0000-4000-8000-000000000001'
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
    '13500000-0000-4000-8000-000000000301',
    '13500000-0000-4000-8000-000000000201',
    'M13E-MAT-A',
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
    '13500000-0000-4000-8000-000000000302',
    '13500000-0000-4000-8000-000000000201',
    'M13E-MAT-B',
    '5501',
    10,
    10,
    1,
    30,
    50,
    100,
    100,
    10,
    2,
    false,
    8,
    'high',
    'locked'
  );

update ops.environment_controls
set operational_writes_enabled = true,
    updated_at = now()
where singleton;

select set_config(
  'request.jwt.claim.sub',
  '13500000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

update m13e_runtime
set queue_mixed_invalid = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-mixed-invalid'
);

reset role;

update core.replenishment_items
set final_qty = 0,
    updated_at = now()
where replenishment_item_id =
  '13500000-0000-4000-8000-000000000302';

set local role authenticated;

update m13e_runtime
set queue_no_worker = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-no-worker'
);

reset role;

insert into ops.service_heartbeats (
  service_name,
  instance_id,
  service_version,
  status,
  details,
  last_seen_at
)
values (
  'synapse-worker:m13e-attested',
  'm13e-attested',
  '1.1.0-m13e-route-evidence',
  'healthy',
  '{
    "routing_attestation_version":"valhalla-status-v1",
    "routing_ready":true,
    "routing_engine":"valhalla",
    "routing_profile":"truck",
    "routing_url_policy":"controlled_non_community_origin",
    "valhalla_url":"https://valhalla.internal",
    "tileset_version":"osm-thailand-2026-07-25-sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "engine_version":"3.5.1",
    "tileset_last_modified":1721865600,
    "osm_changeset":123456,
    "engine_status_response_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status_validated_at":"2026-07-26T00:00:00+00:00"
  }'::jsonb || jsonb_build_object(
    'status_validated_epoch',
    extract(epoch from clock_timestamp())::bigint
  ),
  now()
);

set local role authenticated;

update m13e_runtime
set queue_old_worker_version = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-old-worker-version'
);

reset role;

update ops.service_heartbeats
set service_version = '1.2.0-m13e-route-evidence-attested',
    details = jsonb_set(
      details,
      '{tileset_version}',
      '"osm-thailand-2026-07-25"'::jsonb
    ),
    last_seen_at = clock_timestamp(),
    updated_at = clock_timestamp()
where service_name = 'synapse-worker:m13e-attested';

set local role authenticated;

update m13e_runtime
set queue_invalid_worker_attestation = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-invalid-worker-attestation'
);

reset role;

update ops.service_heartbeats
set details = '{
      "routing_attestation_version":"valhalla-status-v1",
      "routing_ready":true,
      "routing_engine":"valhalla",
      "routing_profile":"truck",
      "routing_url_policy":"controlled_non_community_origin",
      "valhalla_url":"https://valhalla.internal",
      "tileset_version":"osm-thailand-2026-07-25-sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "engine_version":"3.5.1",
      "tileset_last_modified":1721865600,
      "osm_changeset":123456,
      "engine_status_response_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "status_validated_at":"2026-07-26T00:00:00+00:00"
    }'::jsonb || jsonb_build_object(
      'status_validated_epoch',
      extract(epoch from clock_timestamp())::bigint
    ),
    last_seen_at = clock_timestamp(),
    updated_at = clock_timestamp()
where service_name = 'synapse-worker:m13e-attested';

set local role authenticated;

update m13e_runtime
set queue_first = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-1'
);

update m13e_runtime
set queue_replay = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-1'
);

update m13e_runtime
set queue_duplicate_active = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-new-request-same-active-plan'
);

update m13e_runtime
set queue_cross_plan_conflict = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000299',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-1'
);

update m13e_runtime
set queue_haversine_blocked = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'haversine-test'
  ),
  'm13e-route-job-haversine'
);

update m13e_runtime
set queue_get_owner = public.m13_transport_dispatch(
  'GET',
  '/v1/transport/optimization-jobs/'
    || (queue_first #>> '{body,route_job_id}'),
  '{}'::jsonb,
  '{}'::jsonb,
  'm13e-route-job-get-owner'
);

update m13e_runtime
set readiness_ready = public.m13_transport_dispatch(
  'GET',
  '/v1/transport/readiness',
  '{}'::jsonb,
  '{}'::jsonb,
  'm13e-readiness-ready'
);

reset role;

update ops.service_heartbeats
set last_seen_at = now() - interval '11 minutes',
    updated_at = now()
where service_name = 'synapse-worker:m13e-attested';

insert into ops.service_heartbeats (
  service_name,
  instance_id,
  service_version,
  status,
  details,
  last_seen_at
)
values (
  'synapse-worker:m13e-legacy',
  'm13e-legacy',
  '1.0.0',
  'healthy',
  '{"contract_test":"legacy_worker_must_not_activate_m13e"}'::jsonb,
  now()
);

set local role authenticated;

update m13e_runtime
set readiness = public.m13_transport_dispatch(
  'GET',
  '/v1/transport/readiness',
  '{}'::jsonb,
  '{}'::jsonb,
  'm13e-readiness'
);

reset role;

update ops.environment_controls
set operational_writes_enabled = false,
    updated_at = now()
where singleton;

set local role authenticated;
update m13e_runtime
set queue_write_lock_blocked = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-write-lock'
);
reset role;

update ops.environment_controls
set operational_writes_enabled = true,
    updated_at = now()
where singleton;

select set_config(
  'request.jwt.claim.sub',
  '13500000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

update m13e_runtime
set queue_get_other_user = public.m13_transport_dispatch(
  'GET',
  '/v1/transport/optimization-jobs/'
    || (queue_first #>> '{body,route_job_id}'),
  '{}'::jsonb,
  '{}'::jsonb,
  'm13e-route-job-get-other'
);

reset role;

update public.user_profiles
set is_active = false
where user_id = '13500000-0000-4000-8000-000000000002';

set local role authenticated;

update m13e_runtime
set queue_deactivated_get = public.m13_transport_dispatch(
  'GET',
  '/v1/transport/optimization-jobs/'
    || (queue_first #>> '{body,route_job_id}'),
  '{}'::jsonb,
  '{}'::jsonb,
  'm13e-route-job-get-deactivated'
),
queue_deactivated_post = public.m13_transport_dispatch(
  'POST',
  '/v1/transport/optimization-jobs',
  '{}'::jsonb,
  jsonb_build_object(
    'replenishment_plan_id',
      '13500000-0000-4000-8000-000000000201',
    'matrix_source', 'valhalla'
  ),
  'm13e-route-job-post-deactivated'
);

reset role;

update public.user_profiles
set is_active = true
where user_id = '13500000-0000-4000-8000-000000000002';

insert into ops.background_jobs (
  job_id,
  job_type,
  status,
  payload,
  result,
  attempt_count,
  initiated_by
)
values
  (
    '13500000-0000-4000-8000-000000000401',
    'route',
    'succeeded',
    '{"contract_test":"verified"}'::jsonb,
    '{}'::jsonb,
    1,
    '13500000-0000-4000-8000-000000000001'
  ),
  (
    '13500000-0000-4000-8000-000000000402',
    'route',
    'succeeded',
    '{"contract_test":"haversine"}'::jsonb,
    '{}'::jsonb,
    1,
    '13500000-0000-4000-8000-000000000001'
  );

insert into ops.route_jobs (
  route_job_id,
  job_id,
  replenishment_plan_id,
  algorithm_version,
  matrix_source,
  timeout_seconds
)
values
  (
    '13500000-0000-4000-8000-000000000411',
    '13500000-0000-4000-8000-000000000401',
    '13500000-0000-4000-8000-000000000201',
    'ortools-m13e-test',
    'valhalla',
    30
  ),
  (
    '13500000-0000-4000-8000-000000000412',
    '13500000-0000-4000-8000-000000000402',
    '13500000-0000-4000-8000-000000000201',
    'ortools-m13e-test',
    'haversine-test',
    30
  );

insert into analytics.route_matrices (
  route_matrix_id,
  matrix_source,
  costing_model,
  location_ids,
  distances_m,
  durations_s,
  request_hash,
  evidence_status,
  engine_name,
  engine_version,
  routing_profile,
  tileset_version,
  tileset_last_modified_at,
  osm_changeset,
  engine_status_response_sha256,
  upstream_request_sha256,
  upstream_response_sha256,
  evidence_captured_at
)
values (
  '13500000-0000-4000-8000-000000000421',
  'valhalla',
  'truck',
  array['WH-M13E-TEST', 'DIST-5501'],
  '[[0,12000],[12000,0]]'::jsonb,
  '[[0,1800],[1800,0]]'::jsonb,
  repeat('5', 64),
  'verified',
  'valhalla',
  '3.5.1',
  'truck',
  'osm-thailand-2026-07-25-sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  to_timestamp(1721865600),
  123456,
  repeat('6', 64),
  repeat('7', 64),
  repeat('8', 64),
  now()
);

do $$
begin
  update analytics.route_matrices
  set tileset_version = 'osm-thailand-2026-07-25'
  where route_matrix_id =
    '13500000-0000-4000-8000-000000000421';
exception
  when check_violation then
    update m13e_runtime
    set noncanonical_tileset_blocked = true;
end
$$;

insert into analytics.route_matrices (
  route_matrix_id,
  matrix_source,
  costing_model,
  location_ids,
  distances_m,
  durations_s,
  request_hash,
  evidence_status,
  engine_name,
  engine_version,
  routing_profile,
  tileset_version,
  tileset_last_modified_at,
  osm_changeset,
  engine_status_response_sha256,
  upstream_request_sha256,
  upstream_response_sha256,
  evidence_captured_at
)
select
  '13500000-0000-4000-8000-000000000423',
  matrix_source,
  costing_model,
  location_ids,
  distances_m,
  durations_s,
  repeat('e', 64),
  evidence_status,
  engine_name,
  engine_version,
  routing_profile,
  tileset_version,
  tileset_last_modified_at,
  osm_changeset,
  engine_status_response_sha256,
  upstream_request_sha256,
  upstream_response_sha256,
  evidence_captured_at
from analytics.route_matrices
where route_matrix_id = '13500000-0000-4000-8000-000000000421';

insert into analytics.route_matrices (
  route_matrix_id,
  matrix_source,
  costing_model,
  location_ids,
  distances_m,
  durations_s,
  request_hash
)
values (
  '13500000-0000-4000-8000-000000000422',
  'haversine-test',
  'truck',
  array['WH-M13E-TEST', 'DIST-5501'],
  '[[0,10000],[10000,0]]'::jsonb,
  '[[0,1200],[1200,0]]'::jsonb,
  repeat('9', 64)
);

insert into core.route_plans (
  route_plan_id,
  route_job_id,
  route_matrix_id,
  algorithm_version,
  status,
  solver_status,
  total_distance_m,
  total_duration_s,
  served_stop_count,
  unserved_stop_count
)
values
  (
    '13500000-0000-4000-8000-000000000431',
    '13500000-0000-4000-8000-000000000411',
    '13500000-0000-4000-8000-000000000421',
    'ortools-m13e-test',
    'draft',
    'succeeded',
    24000,
    3600,
    1,
    0
  ),
  (
    '13500000-0000-4000-8000-000000000432',
    '13500000-0000-4000-8000-000000000412',
    '13500000-0000-4000-8000-000000000422',
    'ortools-m13e-test',
    'draft',
    'succeeded',
    20000,
    2400,
    1,
    0
  );

insert into core.route_plan_vehicles (
  route_plan_vehicle_id,
  route_plan_id,
  vehicle_id,
  route_sequence,
  planned_distance_m,
  planned_duration_s,
  weight_kg,
  volume_m3,
  pallets,
  weight_utilization,
  volume_utilization,
  pallet_utilization
)
values (
  '13500000-0000-4000-8000-000000000441',
  '13500000-0000-4000-8000-000000000431',
  'M13E-CANONICAL-1',
  1,
  24000,
  3600,
  200,
  1,
  1,
  0.04,
  0.041666,
  0.083333
);

insert into core.route_stops (
  route_stop_id,
  route_plan_vehicle_id,
  district_id,
  stop_sequence,
  eta,
  service_minutes,
  weight_kg,
  volume_m3,
  pallets,
  replenishment_item_ids,
  latitude,
  longitude
)
select
  '13500000-0000-4000-8000-000000000451',
  '13500000-0000-4000-8000-000000000441',
  '5501',
  1,
  now() + interval '30 minutes',
  geocode.service_minutes,
  200,
  1,
  1,
  array[
    '13500000-0000-4000-8000-000000000301'::uuid
  ],
  geocode.latitude,
  geocode.longitude
from core.location_geocodes geocode
where geocode.location_id = 'DIST-5501';

select set_config(
  'request.jwt.claim.sub',
  '13500000-0000-4000-8000-000000000001',
  true
);

do $$
begin
  perform core.review_route_plan(
    '13500000-0000-4000-8000-000000000431',
    'approved',
    null
  );
exception
  when check_violation then
    if sqlerrm like '%road/fleet evidence%' then
      update m13e_runtime
      set missing_evidence_blocked = true;
    else
      raise;
    end if;
end
$$;

do $$
begin
  insert into core.route_plan_vehicle_road_evidence (
    route_plan_vehicle_id,
    route_matrix_id,
    transport_vehicle_id,
    canonical_vehicle_id,
    vehicle_mapping_source_checksum_sha256,
    capacity_source_checksum_sha256,
    availability_source_checksum_sha256,
    availability_checked_at,
    availability_expires_at,
    geometry_geojson,
    road_distance_m,
    road_duration_s,
    has_toll,
    engine_name,
    engine_version,
    routing_profile,
    tileset_version,
    tileset_last_modified_at,
    osm_changeset,
    engine_status_response_sha256,
    route_request_sha256,
    route_response_sha256,
    ordered_waypoint_ids,
    ordered_waypoint_count,
    evidence_validator_version
  )
  values (
    '13500000-0000-4000-8000-000000000441',
    '13500000-0000-4000-8000-000000000421',
    'M13E-TRANSPORT-1',
    'M13E-CANONICAL-1',
    repeat('2', 64),
    repeat('3', 64),
    repeat('4', 64),
    now() - interval '1 minute',
    now() + interval '1 hour',
    '{"type":"LineString","coordinates":[[200,13],[100,13]]}'::jsonb,
    24000,
    3600,
    null,
    'valhalla',
    '3.5.1',
    'truck',
    'osm-thailand-2026-07-25-sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    to_timestamp(1721865600),
    123456,
    repeat('a', 64),
    repeat('b', 64),
    repeat('c', 64),
    array[
      'WH-M13E-TEST',
      'DIST-5501',
      'WH-M13E-TEST'
    ],
    3,
    'synapse-worker/test'
  );
exception
  when check_violation then
    update m13e_runtime
    set invalid_geometry_blocked = true;
end
$$;

insert into core.route_plan_vehicle_road_evidence (
  route_plan_vehicle_id,
  route_matrix_id,
  transport_vehicle_id,
  canonical_vehicle_id,
  vehicle_mapping_source_checksum_sha256,
  capacity_source_checksum_sha256,
  availability_source_checksum_sha256,
  availability_checked_at,
  availability_expires_at,
  geometry_geojson,
  road_distance_m,
  road_duration_s,
  has_toll,
  engine_name,
  engine_version,
  routing_profile,
  tileset_version,
  tileset_last_modified_at,
  osm_changeset,
  engine_status_response_sha256,
  route_request_sha256,
  route_response_sha256,
  ordered_waypoint_ids,
  ordered_waypoint_count,
  evidence_validator_version
)
values (
  '13500000-0000-4000-8000-000000000441',
  '13500000-0000-4000-8000-000000000421',
  'M13E-TRANSPORT-1',
  'M13E-CANONICAL-1',
  repeat('2', 64),
  repeat('3', 64),
  repeat('4', 64),
  now() - interval '1 minute',
  now() + interval '1 hour',
  '{
    "type":"LineString",
    "coordinates":[
      [100.77072260,13.55760333],
      [100.64410000,13.81895000],
      [100.77072260,13.55760333]
    ]
  }'::jsonb,
  24000,
  3600,
  null,
  'valhalla',
  '3.5.1',
  'truck',
  'osm-thailand-2026-07-25-sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  to_timestamp(1721865600),
  123456,
  repeat('6', 64),
  repeat('b', 64),
  repeat('c', 64),
  array[
    'WH-M13E-TEST',
    'DIST-5501',
    'WH-M13E-TEST'
  ],
  3,
  'synapse-worker/test'
);

do $$
begin
  update core.route_plan_vehicle_road_evidence
  set road_distance_m = 1
  where route_plan_vehicle_id =
    '13500000-0000-4000-8000-000000000441';
exception
  when object_not_in_prerequisite_state then
    update m13e_runtime
    set evidence_update_blocked = true;
end
$$;

do $$
declare
  v_case record;
begin
  for v_case in
    select *
    from (
      values
        (
          'update analytics.route_matrices set engine_version = ''3.5.2'' where route_matrix_id = ''13500000-0000-4000-8000-000000000421''',
          'update analytics.route_matrices set engine_version = ''3.5.1'' where route_matrix_id = ''13500000-0000-4000-8000-000000000421'''
        ),
        (
          'update analytics.route_matrices set tileset_version = ''osm-thailand-2026-07-25-sha256-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'' where route_matrix_id = ''13500000-0000-4000-8000-000000000421''',
          'update analytics.route_matrices set tileset_version = ''osm-thailand-2026-07-25-sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'' where route_matrix_id = ''13500000-0000-4000-8000-000000000421'''
        ),
        (
          'update analytics.route_matrices set tileset_last_modified_at = to_timestamp(1721865601) where route_matrix_id = ''13500000-0000-4000-8000-000000000421''',
          'update analytics.route_matrices set tileset_last_modified_at = to_timestamp(1721865600) where route_matrix_id = ''13500000-0000-4000-8000-000000000421'''
        ),
        (
          'update analytics.route_matrices set osm_changeset = 123457 where route_matrix_id = ''13500000-0000-4000-8000-000000000421''',
          'update analytics.route_matrices set osm_changeset = 123456 where route_matrix_id = ''13500000-0000-4000-8000-000000000421'''
        ),
        (
          'update analytics.route_matrices set engine_status_response_sha256 = repeat(''f'', 64) where route_matrix_id = ''13500000-0000-4000-8000-000000000421''',
          'update analytics.route_matrices set engine_status_response_sha256 = repeat(''6'', 64) where route_matrix_id = ''13500000-0000-4000-8000-000000000421'''
        )
    ) as identity_case(mutate_sql, restore_sql)
  loop
    execute v_case.mutate_sql;
    begin
      perform core.review_route_plan(
        '13500000-0000-4000-8000-000000000431',
        'approved',
        null
      );
      raise exception 'Expected matrix identity mismatch to block approval';
    exception
      when check_violation then
        if sqlerrm like '%route matrix identity%' then
          update m13e_runtime
          set matrix_identity_mismatch_count =
            matrix_identity_mismatch_count + 1;
        else
          raise;
        end if;
    end;
    execute v_case.restore_sql;
  end loop;

  update core.route_plans
  set route_matrix_id = '13500000-0000-4000-8000-000000000423'
  where route_plan_id = '13500000-0000-4000-8000-000000000431';

  begin
    perform core.review_route_plan(
      '13500000-0000-4000-8000-000000000431',
      'approved',
      null
    );
    raise exception 'Expected matrix linkage mismatch to block approval';
  exception
    when check_violation then
      if sqlerrm like '%route matrix identity%' then
        update m13e_runtime
        set matrix_identity_mismatch_count =
          matrix_identity_mismatch_count + 1;
      else
        raise;
      end if;
  end;

  update core.route_plans
  set route_matrix_id = '13500000-0000-4000-8000-000000000421'
  where route_plan_id = '13500000-0000-4000-8000-000000000431';
end
$$;

update core.transport_vehicles
set availability_expires_at = now() - interval '1 second'
where vehicle_id = 'M13E-TRANSPORT-1';

do $$
begin
  perform core.review_route_plan(
    '13500000-0000-4000-8000-000000000431',
    'approved',
    null
  );
exception
  when check_violation then
    if sqlerrm like '%road/fleet evidence%' then
      update m13e_runtime
      set expired_availability_blocked = true;
    else
      raise;
    end if;
end
$$;

update core.transport_vehicles
set availability_expires_at = now() + interval '1 hour'
where vehicle_id = 'M13E-TRANSPORT-1';

do $$
begin
  perform core.review_route_plan(
    '13500000-0000-4000-8000-000000000432',
    'approved',
    null
  );
exception
  when check_violation then
    if sqlerrm like '%verified Valhalla matrix%' then
      update m13e_runtime
      set haversine_approval_blocked = true;
    else
      raise;
    end if;
end
$$;

update m13e_runtime
set rejection_succeeded = (
  core.review_route_plan(
    '13500000-0000-4000-8000-000000000432',
    'rejected',
    'Haversine is not production road evidence'
  )
).status = 'rejected';

update m13e_runtime
set valid_approval_succeeded = (
  core.review_route_plan(
    '13500000-0000-4000-8000-000000000431',
    'approved',
    null
  )
).status = 'approved';

insert into m13e_checks (check_name, passed)
select
  'missing_road_evidence_blocks_approval',
  missing_evidence_blocked
from m13e_runtime
union all
select
  'invalid_linestring_is_rejected',
  invalid_geometry_blocked
from m13e_runtime
union all
select
  'expired_availability_blocks_approval',
  expired_availability_blocked
from m13e_runtime
union all
select
  'haversine_matrix_blocks_approval',
  haversine_approval_blocked
from m13e_runtime
union all
select
  'rejection_contract_remains_available',
  rejection_succeeded
from m13e_runtime
union all
select
  'verified_exact_plan_can_be_approved',
  valid_approval_succeeded
from m13e_runtime
union all
select
  'road_evidence_is_append_only',
  evidence_update_blocked
from m13e_runtime
union all
select
  'verified_matrix_requires_canonical_tileset_digest',
  noncanonical_tileset_blocked
from m13e_runtime
union all
select
  'matrix_identity_mismatch_blocks_approval',
  matrix_identity_mismatch_count = 6
from m13e_runtime;

insert into m13e_checks (check_name, passed)
select
  'mixed_validity_plan_is_rejected_before_queue',
  queue_mixed_invalid ->> 'status' = '409'
  and queue_mixed_invalid #>> '{body,error,code}' =
    'route_job_not_dispatchable'
from m13e_runtime
union all
select
  'governed_route_job_is_accepted',
  queue_first ->> 'status' = '202'
  and queue_first #>> '{body,status}' = 'queued'
  and queue_first #>> '{body,algorithm_version}' =
    'ortools-m13e-road-evidence-v1'
  and queue_first #>> '{body,matrix_source}' = 'valhalla'
  and queue_first #>> '{body,replenishment_plan_id}' =
    '13500000-0000-4000-8000-000000000201'
  and queue_first #>> '{body,idempotent_replay}' = 'false'
from m13e_runtime
union all
select
  'route_queue_requires_recent_attested_worker',
  queue_no_worker ->> 'status' = '503'
  and queue_no_worker #>> '{body,error,code}' =
    'optimization_worker_unavailable'
  and queue_old_worker_version ->> 'status' = '503'
  and queue_old_worker_version #>> '{body,error,code}' =
    'optimization_worker_unavailable'
  and queue_invalid_worker_attestation ->> 'status' = '503'
  and queue_invalid_worker_attestation #>> '{body,error,code}' =
    'optimization_worker_unavailable'
from m13e_runtime
union all
select
  'same_actor_same_request_is_idempotent',
  queue_replay ->> 'status' = '202'
  and queue_replay #>> '{body,route_job_id}' =
    queue_first #>> '{body,route_job_id}'
  and queue_replay #>> '{body,idempotent_replay}' = 'true'
from m13e_runtime
union all
select
  'new_request_reuses_same_actor_plan_active_job',
  queue_duplicate_active ->> 'status' = '202'
  and queue_duplicate_active #>> '{body,route_job_id}' =
    queue_first #>> '{body,route_job_id}'
  and queue_duplicate_active #>> '{body,idempotent_replay}' = 'true'
  and (
    select count(*) = 1
    from ops.route_jobs route_job
    join ops.background_jobs background using (job_id)
    where route_job.requested_by =
      '13500000-0000-4000-8000-000000000001'
      and route_job.replenishment_plan_id =
        '13500000-0000-4000-8000-000000000201'
      and background.status in ('queued', 'running')
  )
from m13e_runtime
union all
select
  'request_id_cannot_cross_plan',
  queue_cross_plan_conflict ->> 'status' = '409'
  and queue_cross_plan_conflict #>> '{body,error,code}' =
    'idempotency_conflict'
  and not (
    queue_cross_plan_conflict #> '{body,error}' ? 'route_job_id'
  )
from m13e_runtime
union all
select
  'haversine_route_job_is_rejected',
  queue_haversine_blocked ->> 'status' = '422'
  and queue_haversine_blocked #>> '{body,error,code}' =
    'validation_error'
from m13e_runtime
union all
select
  'route_job_obeys_operational_write_lock',
  queue_write_lock_blocked ->> 'status' = '423'
  and queue_write_lock_blocked #>> '{body,error,code}' =
    'production_not_ready'
from m13e_runtime
union all
select
  'route_job_owner_can_read_status',
  queue_get_owner ->> 'status' = '200'
  and queue_get_owner #>> '{body,route_job_id}' =
    queue_first #>> '{body,route_job_id}'
  and queue_get_owner #>> '{body,status}' = 'queued'
  and queue_get_owner #>> '{body,algorithm_version}' =
    'ortools-m13e-road-evidence-v1'
  and not (queue_get_owner -> 'body' ? 'error_message')
  and not (queue_get_owner -> 'body' ? 'request_id')
from m13e_runtime
union all
select
  'route_job_is_not_disclosed_cross_user',
  queue_get_other_user ->> 'status' = '404'
  and queue_get_other_user #>> '{body,error,code}' = 'not_found'
  and not (
    queue_get_other_user #> '{body,error}' ? 'route_job_id'
  )
from m13e_runtime
union all
select
  'deactivated_profile_cannot_get_or_post_route_jobs',
  queue_deactivated_get ->> 'status' = '403'
  and queue_deactivated_get #>> '{body,error,code}' = 'forbidden'
  and queue_deactivated_post ->> 'status' = '403'
  and queue_deactivated_post #>> '{body,error,code}' = 'forbidden'
from m13e_runtime
union all
select
  'readiness_exposes_selected_plan_eligibility_to_planner',
  readiness_ready ->> 'status' = '200'
  and readiness_ready #>> '{body,optimization_worker_ready}' = 'true'
  and readiness_ready #>> '{body,optimization_worker_status}' =
    'ready_valhalla_exact_locked_plan_queue'
  and readiness_ready #> '{body,optimization_eligible_plan_ids}' =
    '["13500000-0000-4000-8000-000000000201"]'::jsonb
  and readiness_ready #>> '{body,optimization_plan_eligibility_scope}' =
    'exact_locked_plan_current_evidence_and_worker'
from m13e_runtime
union all
select
  'readiness_is_worker_and_activation_truthful',
  readiness ->> 'status' = '200'
  and readiness #>> '{body,optimization_worker_ready}' = 'false'
  and readiness #>> '{body,optimization_worker_status}' =
    'blocked_no_recent_optimization_worker_heartbeat'
  and readiness #>> '{body,trip_persistence_ready}' = 'false'
  and readiness #>> '{body,trip_persistence_status}' =
    'blocked_route_plan_to_trip_activation_not_configured'
  and readiness #> '{body,optimization_eligible_plan_ids}' = '[]'::jsonb
from m13e_runtime;

insert into m13e_checks (check_name, passed)
values
  (
    'fleet_status_view_reports_only_current_evidence',
    exists (
      select 1
      from analytics.v_transport_vehicle_status vehicle
      where vehicle.vehicle_id = 'M13E-TRANSPORT-1'
        and vehicle.vehicle_mapping_status = 'verified'
        and vehicle.vehicle_mapping_source_reference =
          'owner-fleet-map.xlsx#row=1'
        and vehicle.capacity_evidence_status = 'verified'
        and vehicle.availability_evidence_status = 'available'
        and vehicle.availability_evidence =
          'owner-availability.xlsx#row=1'
        and vehicle.availability_is_current
        and vehicle.is_available
        and vehicle.availability_status = 'available'
    )
  ),
  (
    'approved_plan_uses_real_road_totals',
    exists (
      select 1
      from core.route_plans plan
      join core.route_plan_vehicles vehicle
        using (route_plan_id)
      join core.route_plan_vehicle_road_evidence evidence
        using (route_plan_vehicle_id)
      where plan.route_plan_id =
        '13500000-0000-4000-8000-000000000431'
        and plan.status = 'approved'
        and plan.total_distance_m = evidence.road_distance_m
        and plan.total_duration_s = evidence.road_duration_s
        and vehicle.planned_distance_m =
          evidence.road_distance_m
        and vehicle.planned_duration_s =
          evidence.road_duration_s
    )
  ),
  (
    'geojson_contains_real_line_and_verified_stop',
    (
      select
        jsonb_path_exists(
          geojson,
          '$.features[*] ? (@.geometry.type == "LineString" && @.properties.feature_kind == "verified_road_route")'
        )
        and jsonb_path_exists(
          geojson,
          '$.features[*] ? (@.geometry.type == "Point" && @.properties.feature_kind == "verified_ordered_stop")'
        )
        and geojson ->> 'road_geometry_available' = 'true'
      from analytics.v_route_plan_geojson
      where route_plan_id =
        '13500000-0000-4000-8000-000000000431'
    )
  ),
  (
    'toll_truth_is_nullable_not_invented',
    exists (
      select 1
      from core.route_plan_vehicle_road_evidence
      where route_plan_vehicle_id =
        '13500000-0000-4000-8000-000000000441'
        and has_toll is null
    )
  );

table m13e_checks;

do $$
begin
  if exists (
    select 1
    from m13e_checks
    where not passed
  ) then
    raise exception 'M13e route evidence contract failed';
  end if;
end
$$;

rollback;
