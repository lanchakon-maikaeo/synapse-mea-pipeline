-- SYNAPSE M14b: reconcile legacy opening balances from two independent Actual
-- sources without representing them as exact receiving lots.
--
-- Stock quantity comes from the completed Khlong Toei snapshot; contract context
-- comes from a completed accepted contract line for the same material. The
-- explicit reconciled_actual_sources / OPENING_UNKNOWN labels preserve the
-- weaker legacy-lot certainty while still allowing governed FIFO reservation.

begin;

alter table core.receipt_lots
  drop constraint if exists receipt_lots_traceability_status_check;
alter table core.receipt_lots
  add constraint receipt_lots_traceability_status_check
  check (traceability_status in (
    'complete',
    'opening_unknown',
    'quarantined',
    'reconciled_actual_sources'
  ));

create table if not exists reference_data.opening_balance_handling_unit_evidence (
  opening_balance_evidence_id bigint generated always as identity primary key,
  handling_unit_id uuid not null unique
    references core.handling_units (handling_unit_id) on delete restrict,
  material_id text not null
    references core.materials (material_id) on delete restrict,
  stock_snapshot_id uuid not null unique
    references core.stock_snapshots (snapshot_id) on delete restrict,
  stock_observation_evidence_id bigint not null
    references reference_data.stock_observation_evidence (
      stock_observation_evidence_id
    ) on delete restrict,
  contract_item_id bigint not null
    references core.contract_items (contract_item_id) on delete restrict,
  contract_source_row_id bigint not null
    references raw.source_rows (source_row_id) on delete restrict,
  reconciliation_basis text not null
    check (reconciliation_basis = 'actual_stock_plus_accepted_contract_context'),
  verified_by uuid not null references auth.users (id) on delete restrict,
  verification_ticket text not null check (btrim(verification_ticket) <> ''),
  attestation_text text not null check (btrim(attestation_text) <> ''),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists opening_balance_evidence_material_idx
  on reference_data.opening_balance_handling_unit_evidence (
    material_id, verified_at desc
  );

alter table reference_data.opening_balance_handling_unit_evidence
  enable row level security;
revoke all on reference_data.opening_balance_handling_unit_evidence
  from public, anon, authenticated;
grant all on reference_data.opening_balance_handling_unit_evidence
  to service_role;

create or replace function public.m14b_reconcile_opening_balance_handling_units(
  p_replenishment_plan_id uuid,
  p_verified_by uuid,
  p_verification_ticket text,
  p_attestation_text text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_plan core.replenishment_plans%rowtype;
  v_cutoff_at timestamptz;
  v_warehouse_id text;
  v_expected integer;
  v_candidates integer;
  v_total_quantity numeric;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'M14b opening-balance reconciliation requires service_role';
  end if;
  if p_verified_by is null
     or not exists (
       select 1
       from public.user_profiles profile
       where profile.user_id = p_verified_by
         and profile.is_active
         and profile.role::text = 'admin'
     ) then
    raise exception 'An active Production admin verifier is required';
  end if;
  if btrim(coalesce(p_verification_ticket, '')) = ''
     or btrim(coalesce(p_attestation_text, '')) = '' then
    raise exception 'Verification ticket and attestation are required';
  end if;

  select plan.*
  into v_plan
  from core.replenishment_plans plan
  where plan.replenishment_plan_id = p_replenishment_plan_id
  for update;
  if not found then
    raise exception 'Replenishment plan not found';
  end if;
  if v_plan.status <> 'pending_district_confirmation' then
    raise exception 'Opening balance reconciliation is allowed before district response only';
  end if;

  select run.snapshot_cutoff_at
  into v_cutoff_at
  from ops.replenishment_runs run
  where run.replenishment_run_id = v_plan.replenishment_run_id;

  select location.warehouse_id
  into v_warehouse_id
  from core.locations location
  where location.location_id = v_plan.origin_location_id
    and location.location_type = 'WAREHOUSE'
    and location.is_active;
  if v_warehouse_id is null then
    raise exception 'Plan origin is not an active canonical warehouse';
  end if;

  select count(distinct item.material_id)::integer
  into v_expected
  from core.replenishment_items item
  where item.replenishment_plan_id = p_replenishment_plan_id
    and item.suggested_qty > 0;

  drop table if exists pg_temp.m14b_opening_candidates;
  create temporary table m14b_opening_candidates
  on commit drop
  as
  select distinct on (item.material_id)
    item.material_id,
    stock.snapshot_id,
    stock.quantity_on_hand,
    stock.snapshot_at,
    stock.source_batch_id as stock_batch_id,
    stock_evidence.stock_observation_evidence_id,
    stock_artifact.source_path as stock_source_path,
    stock_artifact.source_sheet as stock_source_sheet,
    stock_row.source_row_number as stock_source_row_number,
    contract_item.contract_item_id,
    contract_item.acceptance_date,
    contract_item.source_row_id as contract_source_row_id,
    contract_batch.source_file as contract_source_file,
    contract_batch.source_sheet as contract_source_sheet,
    contract_item.source_row_number as contract_source_row_number,
    'OBR-' || item.material_id || '-'
      || upper(left(replace(stock.snapshot_id::text, '-', ''), 12))
      as lot_code,
    'OBR-HU-' || item.material_id || '-'
      || upper(left(replace(stock.snapshot_id::text, '-', ''), 12))
      as handling_unit_code
  from core.replenishment_items item
  join lateral (
    select snapshot.*
    from core.stock_snapshots snapshot
    where snapshot.material_id = item.material_id
      and snapshot.location_id = v_plan.origin_location_id
      and snapshot.data_class = 'actual'
      and snapshot.quantity_on_hand > 0
      and snapshot.snapshot_at <= v_cutoff_at
      and snapshot.created_at <= v_cutoff_at
    order by snapshot.snapshot_at desc, snapshot.created_at desc
    limit 1
  ) stock on true
  join reference_data.stock_observation_evidence stock_evidence
    on stock_evidence.stock_snapshot_id = stock.snapshot_id
   and stock_evidence.verification_status = 'source_observed'
  join reference_data.source_rows stock_row
    on stock_row.source_row_id = stock_evidence.source_row_id
  join reference_data.source_artifacts stock_artifact
    on stock_artifact.artifact_id = stock_evidence.source_artifact_id
   and stock_artifact.data_class = 'actual'
  join lateral (
    select candidate.*
    from core.contract_items candidate
    join raw.import_batches candidate_batch
      on candidate_batch.batch_id = candidate.source_batch_id
    join ops.actual_workbook_imports actual_import
      on actual_import.contract_checksum = candidate_batch.source_checksum
     and actual_import.status = 'succeeded'
    where candidate.material_id = item.material_id
      and candidate.is_current
      and candidate.acceptance_date is not null
      and candidate.acceptance_date <=
        (v_cutoff_at at time zone 'Asia/Bangkok')::date
    order by
      candidate.acceptance_date desc,
      candidate.source_row_number desc,
      candidate.contract_item_id desc
    limit 1
  ) contract_item on true
  join raw.import_batches contract_batch
    on contract_batch.batch_id = contract_item.source_batch_id
  where item.replenishment_plan_id = p_replenishment_plan_id
    and item.suggested_qty > 0
  order by item.material_id;

  alter table pg_temp.m14b_opening_candidates
    add primary key (material_id);

  select count(*)::integer, sum(quantity_on_hand)
  into v_candidates, v_total_quantity
  from pg_temp.m14b_opening_candidates;
  if v_candidates <> v_expected then
    raise exception
      'Only % of % plan materials have both completed warehouse stock and accepted contract context',
      v_candidates,
      v_expected;
  end if;

  insert into core.receipt_lots (
    lot_code,
    contract_item_id,
    warehouse_id,
    acceptance_date,
    installment_no,
    received_qty,
    remaining_qty,
    traceability_status,
    source_batch_id,
    source_reference,
    created_by
  )
  select
    candidate.lot_code,
    candidate.contract_item_id,
    v_warehouse_id,
    candidate.acceptance_date,
    'OPENING-BALANCE-RECONCILIATION',
    candidate.quantity_on_hand,
    candidate.quantity_on_hand,
    'reconciled_actual_sources',
    candidate.stock_batch_id,
    candidate.stock_source_path || '#'
      || candidate.stock_source_sheet || ':row='
      || candidate.stock_source_row_number::text
      || '; accepted-contract-context='
      || candidate.contract_source_file || '#'
      || candidate.contract_source_sheet || ':row='
      || candidate.contract_source_row_number::text,
    p_verified_by
  from pg_temp.m14b_opening_candidates candidate
  on conflict (lot_code) do nothing;

  insert into core.handling_units (
    handling_unit_code,
    receipt_lot_id,
    material_id,
    location_id,
    unit_type,
    opening_status,
    received_qty,
    available_qty,
    reserved_qty,
    source_reference
  )
  select
    candidate.handling_unit_code,
    lot.receipt_lot_id,
    candidate.material_id,
    v_plan.origin_location_id,
    'LOOSE',
    'OPENING_UNKNOWN',
    candidate.quantity_on_hand,
    candidate.quantity_on_hand,
    0,
    lot.source_reference
  from pg_temp.m14b_opening_candidates candidate
  join core.receipt_lots lot using (lot_code)
  on conflict (handling_unit_code) do nothing;

  insert into reference_data.opening_balance_handling_unit_evidence (
    handling_unit_id,
    material_id,
    stock_snapshot_id,
    stock_observation_evidence_id,
    contract_item_id,
    contract_source_row_id,
    reconciliation_basis,
    verified_by,
    verification_ticket,
    attestation_text
  )
  select
    handling_unit.handling_unit_id,
    candidate.material_id,
    candidate.snapshot_id,
    candidate.stock_observation_evidence_id,
    candidate.contract_item_id,
    candidate.contract_source_row_id,
    'actual_stock_plus_accepted_contract_context',
    p_verified_by,
    left(p_verification_ticket, 200),
    left(p_attestation_text, 2000)
  from pg_temp.m14b_opening_candidates candidate
  join core.handling_units handling_unit
    on handling_unit.handling_unit_code = candidate.handling_unit_code
  on conflict (handling_unit_id) do nothing;

  return jsonb_build_object(
    'status', 'succeeded',
    'replenishment_plan_id', p_replenishment_plan_id,
    'material_count', v_candidates,
    'reconciled_quantity', v_total_quantity,
    'traceability_status', 'reconciled_actual_sources',
    'opening_status', 'OPENING_UNKNOWN'
  );
end;
$$;

revoke all on function public.m14b_reconcile_opening_balance_handling_units(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.m14b_reconcile_opening_balance_handling_units(
  uuid, uuid, text, text
) to service_role;

create or replace function core.reserve_fifo(
  p_material_id text,
  p_location_id text,
  p_quantity numeric,
  p_replenishment_item_id uuid default null,
  p_ad_hoc_issue_id uuid default null
)
returns numeric
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_remaining numeric := p_quantity;
  v_take numeric;
  v_sequence integer := 0;
  v_hu record;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Allocation quantity must be positive';
  end if;
  if (p_replenishment_item_id is null) = (p_ad_hoc_issue_id is null) then
    raise exception 'Exactly one allocation source is required';
  end if;

  for v_hu in
    select
      hu.handling_unit_id,
      hu.handling_unit_code,
      hu.available_qty - hu.reserved_qty as allocatable_qty
    from core.handling_units hu
    join core.receipt_lots lot using (receipt_lot_id)
    join core.contract_items ci using (contract_item_id)
    join core.contracts c using (contract_id)
    where hu.material_id = p_material_id
      and hu.location_id = p_location_id
      and (
        (
          hu.opening_status in ('OPEN', 'SEALED')
          and lot.traceability_status = 'complete'
        )
        or (
          hu.opening_status = 'OPENING_UNKNOWN'
          and lot.traceability_status = 'reconciled_actual_sources'
          and exists (
            select 1
            from reference_data.opening_balance_handling_unit_evidence evidence
            where evidence.handling_unit_id = hu.handling_unit_id
              and evidence.material_id = hu.material_id
              and btrim(evidence.verification_ticket) <> ''
              and evidence.verified_at is not null
          )
        )
      )
      and hu.available_qty > hu.reserved_qty
    order by
      case hu.opening_status
        when 'OPEN' then 0
        when 'SEALED' then 1
        else 2
      end,
      lot.acceptance_date,
      c.purchase_order,
      ci.line_item,
      ci.source_row_number,
      hu.handling_unit_code
    for update of hu
  loop
    exit when v_remaining <= 0;
    v_sequence := v_sequence + 1;
    v_take := least(v_remaining, v_hu.allocatable_qty);

    insert into ops.fifo_allocations (
      replenishment_item_id,
      ad_hoc_issue_id,
      handling_unit_id,
      allocation_sequence,
      allocated_qty,
      reserved_by
    )
    values (
      p_replenishment_item_id,
      p_ad_hoc_issue_id,
      v_hu.handling_unit_id,
      v_sequence,
      v_take,
      auth.uid()
    );

    update core.handling_units
    set reserved_qty = reserved_qty + v_take,
        updated_at = now()
    where handling_unit_id = v_hu.handling_unit_id;

    insert into core.inventory_movements (
      movement_type,
      material_id,
      handling_unit_id,
      from_location_id,
      quantity,
      replenishment_item_id,
      ad_hoc_issue_id,
      idempotency_key,
      reason,
      performed_by
    )
    values (
      'RESERVE',
      p_material_id,
      v_hu.handling_unit_id,
      p_location_id,
      v_take,
      p_replenishment_item_id,
      p_ad_hoc_issue_id,
      'reserve:' || coalesce(
        p_replenishment_item_id::text,
        p_ad_hoc_issue_id::text
      ) || ':' || v_hu.handling_unit_id::text,
      'FIFO reservation from verified legacy opening-balance reconciliation',
      auth.uid()
    );

    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    raise exception
      'Insufficient traceable FIFO stock for material %: shortage %',
      p_material_id,
      v_remaining;
  end if;
  return p_quantity;
end;
$$;

revoke all on function core.reserve_fifo(text, text, numeric, uuid, uuid)
  from public, anon, authenticated;
grant execute on function core.reserve_fifo(text, text, numeric, uuid, uuid)
  to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607270002',
  'M14b',
  'Verified legacy opening-balance reconciliation from completed Khlong Toei stock plus accepted contract context, retaining explicit weaker lot certainty for governed FIFO.',
  'supabase/migrations/202607270002_m14b_opening_balance_traceability.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
