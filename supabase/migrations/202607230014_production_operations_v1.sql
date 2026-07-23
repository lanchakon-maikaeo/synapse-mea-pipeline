-- SYNAPSE production operations v1.
-- Implements the frozen update-v1 warehouse workflow without forecasting,
-- routing or RAG: weekly planning, governed district response, sequential
-- approval, FIFO handling-unit allocation, ad-hoc issue and full traceback.

alter type public.app_role add value if not exists 'academic';
alter type public.app_role add value if not exists 'picker';

begin;

update core.warehouses
set storage_location = '0001',
    updated_at = now()
where warehouse_id = 'WH-KT'
  and sap_plant_code = '2401'
  and storage_location <> '0001';

alter table core.replenishment_plans
  drop constraint if exists replenishment_plans_status_check;

alter table core.replenishment_plans
  add column if not exists plan_number text,
  add column if not exists week_start_date date,
  add column if not exists version_no integer not null default 1,
  add column if not exists parent_plan_id uuid,
  add column if not exists response_due_at timestamptz,
  add column if not exists district_responses_completed_at timestamptz,
  add column if not exists planner_approved_by uuid references auth.users (id) on delete set null,
  add column if not exists planner_approved_at timestamptz,
  add column if not exists academic_approved_by uuid references auth.users (id) on delete set null,
  add column if not exists academic_approved_at timestamptz,
  add column if not exists locked_by uuid references auth.users (id) on delete set null,
  add column if not exists locked_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users (id) on delete set null,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text;

update core.replenishment_plans
set plan_number = coalesce(
      plan_number,
      'RP-' || to_char(created_at at time zone 'Asia/Bangkok', 'IYYY-IW')
        || '-' || upper(left(replace(replenishment_plan_id::text, '-', ''), 8))
    ),
    week_start_date = coalesce(
      week_start_date,
      date_trunc('week', created_at at time zone 'Asia/Bangkok')::date
    ),
    response_due_at = coalesce(
      response_due_at,
      (
        date_trunc('day', created_at at time zone 'Asia/Bangkok')
        + interval '1 day 17 hours'
      ) at time zone 'Asia/Bangkok'
    ),
    status = case status
      when 'approved' then 'locked'
      else status
    end;

alter table core.replenishment_plans
  alter column plan_number set not null,
  alter column week_start_date set not null,
  alter column response_due_at set not null,
  add constraint replenishment_plans_status_check check (
    status in (
      'draft',
      'pending_district_confirmation',
      'pending_planner_approval',
      'pending_academic_approval',
      'locked',
      'cancelled',
      'completed'
    )
  ),
  add constraint replenishment_plans_version_positive check (version_no > 0);

do $$
begin
  alter table core.replenishment_plans
    add constraint replenishment_plans_parent_fkey
    foreign key (parent_plan_id)
    references core.replenishment_plans (replenishment_plan_id)
    on delete restrict;
exception
  when duplicate_object then null;
end
$$;

create unique index if not exists replenishment_plans_number_version_uidx
  on core.replenishment_plans (plan_number, version_no);

alter table core.replenishment_items
  drop constraint if exists replenishment_items_status_check;

alter table core.replenishment_items
  add column if not exists requested_qty numeric,
  add column if not exists final_qty numeric,
  add column if not exists district_decision text,
  add column if not exists district_confirmed_by uuid references auth.users (id) on delete set null,
  add column if not exists district_confirmed_at timestamptz,
  add column if not exists requester_name text,
  add column if not exists confirmed_on_behalf boolean not null default false,
  add column if not exists projected_months_after numeric,
  add column if not exists exceeds_six_months boolean not null default false,
  add column if not exists special_approval_required boolean not null default false,
  add column if not exists abnormal_risk_level text not null default 'normal',
  add column if not exists abnormal_signals jsonb not null default '{}'::jsonb,
  add column if not exists source_stock_missing boolean not null default false;

update core.replenishment_items
set requested_qty = coalesce(requested_qty, confirmed_qty, suggested_qty),
    final_qty = coalesce(final_qty, confirmed_qty, suggested_qty),
    district_decision = coalesce(
      district_decision,
      case status
        when 'rejected' then 'reject'
        when 'confirmed' then 'confirm'
        when 'approved' then 'confirm'
        when 'shipped' then 'confirm'
        else null
      end
    ),
    status = case status
      when 'confirmed' then 'district_confirmed'
      when 'rejected' then 'district_rejected'
      when 'approved' then 'locked'
      when 'shipped' then 'issued'
      else status
    end;

alter table core.replenishment_items
  add constraint replenishment_items_status_check check (
    status in (
      'draft',
      'pending',
      'district_confirmed',
      'district_rejected',
      'change_requested',
      'planner_approved',
      'locked',
      'issued',
      'cancelled'
    )
  ),
  add constraint replenishment_items_district_decision_check check (
    district_decision is null
    or district_decision in ('confirm', 'reject', 'change')
  ),
  add constraint replenishment_items_requested_qty_check check (
    requested_qty is null or requested_qty >= 0
  ),
  add constraint replenishment_items_final_qty_check check (
    final_qty is null or final_qty >= 0
  ),
  add constraint replenishment_items_projected_months_check check (
    projected_months_after is null or projected_months_after >= 0
  ),
  add constraint replenishment_items_risk_level_check check (
    abnormal_risk_level in ('normal', 'medium', 'high')
  );

create table if not exists core.vendor_aliases (
  vendor_alias_id uuid primary key default gen_random_uuid(),
  vendor_id bigint not null references core.vendors (vendor_id) on delete restrict,
  alias_name text not null check (btrim(alias_name) <> ''),
  normalized_alias text not null,
  source_reference text not null,
  created_at timestamptz not null default now(),
  unique (vendor_id, normalized_alias)
);

create or replace view analytics.v_contract_status
with (security_invoker = true)
as
select
  c.contract_id,
  c.contract_key,
  c.purchase_order,
  c.contract_number,
  c.procurement_code,
  case
    when v.vendor_id is null then 'SUP-UNKNOWN'
    else 'SUP-' || lpad(v.vendor_id::text, 6, '0')
  end as vendor_name,
  c.start_date,
  c.document_date,
  c.end_date,
  case
    when c.end_date is not null and c.end_date < current_date then 'EXPIRED'
    when c.start_date is not null and c.start_date > current_date then 'PLANNED'
    when c.start_date is null and c.end_date is null then 'UNKNOWN'
    else 'ACTIVE'
  end as contract_status,
  c.source_item_count,
  count(i.contract_item_id) filter (where i.material_id is not null) as material_line_count,
  count(i.contract_item_id) filter (where i.material_id is null) as service_or_unmapped_line_count,
  count(i.contract_item_id) filter (where i.validation_status = 'warning') as warning_line_count,
  c.source_batch_id,
  c.updated_at
from core.contracts c
left join core.vendors v using (vendor_id)
left join core.contract_items i
  on i.contract_id = c.contract_id and i.is_current
where c.is_current
group by c.contract_id, v.vendor_id;

create table if not exists core.receipt_lots (
  receipt_lot_id uuid primary key default gen_random_uuid(),
  lot_code text not null unique,
  contract_item_id bigint not null references core.contract_items (contract_item_id) on delete restrict,
  warehouse_id text not null references core.warehouses (warehouse_id) on delete restrict,
  acceptance_date date not null,
  installment_no text,
  received_qty numeric not null check (received_qty > 0),
  remaining_qty numeric not null check (remaining_qty >= 0 and remaining_qty <= received_qty),
  traceability_status text not null default 'complete'
    check (traceability_status in ('complete', 'opening_unknown', 'quarantined')),
  source_batch_id uuid references raw.import_batches (batch_id) on delete restrict,
  source_reference text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists receipt_lots_fifo_idx
  on core.receipt_lots (acceptance_date, contract_item_id, created_at);

create table if not exists core.packaging_profiles (
  material_id text primary key references core.materials (material_id) on delete restrict,
  full_pallet_qty numeric check (full_pallet_qty is null or full_pallet_qty > 0),
  inner_pack_qty numeric check (inner_pack_qty is null or inner_pack_qty > 0),
  base_uom text not null,
  allows_partial_issue boolean not null default true,
  source_reference text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.handling_units (
  handling_unit_id uuid primary key default gen_random_uuid(),
  handling_unit_code text not null unique,
  receipt_lot_id uuid not null references core.receipt_lots (receipt_lot_id) on delete restrict,
  material_id text not null references core.materials (material_id) on delete restrict,
  location_id text not null references core.locations (location_id) on delete restrict,
  unit_type text not null
    check (unit_type in ('FULL_PALLET', 'BOX', 'CRATE', 'BUNDLE', 'LOOSE', 'LONG_MATERIAL')),
  opening_status text not null
    check (opening_status in ('SEALED', 'OPEN', 'DEPLETED', 'QUARANTINED', 'OPENING_UNKNOWN')),
  received_qty numeric not null check (received_qty > 0),
  available_qty numeric not null check (available_qty >= 0),
  reserved_qty numeric not null default 0 check (reserved_qty >= 0),
  opened_at timestamptz,
  source_reference text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint handling_units_quantity_balance check (
    available_qty <= received_qty and reserved_qty <= available_qty
  )
);

create index if not exists handling_units_available_idx
  on core.handling_units (material_id, location_id, opening_status)
  where available_qty > reserved_qty;

create table if not exists ops.quantity_recommendations (
  recommendation_id uuid primary key default gen_random_uuid(),
  replenishment_item_id uuid not null references core.replenishment_items (replenishment_item_id) on delete restrict,
  recommendation_version integer not null default 1 check (recommendation_version > 0),
  method text not null check (method in ('BUSINESS_RULE_V1', 'HISTORY_AVERAGE')),
  recommended_qty numeric not null check (recommended_qty >= 0),
  evidence jsonb not null,
  source_freshness_status text not null
    check (source_freshness_status in ('fresh', 'source_missing_assumed_zero', 'stale')),
  created_at timestamptz not null default now(),
  unique (replenishment_item_id, recommendation_version)
);

create table if not exists ops.district_change_requests (
  change_request_id uuid primary key default gen_random_uuid(),
  replenishment_item_id uuid not null references core.replenishment_items (replenishment_item_id) on delete restrict,
  baseline_qty numeric not null check (baseline_qty >= 0),
  requested_qty numeric not null check (requested_qty >= 0),
  projected_months_after numeric not null check (projected_months_after >= 0),
  exceeds_six_months boolean not null,
  special_approval_required boolean not null,
  risk_level text not null check (risk_level in ('normal', 'medium', 'high')),
  abnormal_signals jsonb not null default '{}'::jsonb,
  reason text not null check (btrim(reason) <> ''),
  requester_name text not null check (btrim(requester_name) <> ''),
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'rejected', 'cancelled')),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists district_change_requests_one_pending_idx
  on ops.district_change_requests (replenishment_item_id)
  where status = 'pending_review';

create table if not exists ops.plan_approvals (
  plan_approval_id uuid primary key default gen_random_uuid(),
  replenishment_plan_id uuid not null references core.replenishment_plans (replenishment_plan_id) on delete restrict,
  replenishment_item_id uuid references core.replenishment_items (replenishment_item_id) on delete restrict,
  district_id text references core.districts (district_id) on delete restrict,
  approval_stage text not null
    check (approval_stage in ('district_response', 'planner', 'academic', 'lock', 'cancel', 'version')),
  decision text not null check (decision in ('confirmed', 'rejected', 'approved', 'cancelled', 'created')),
  note text,
  actor_id uuid references auth.users (id) on delete set null,
  actor_role text not null,
  acted_at timestamptz not null default now()
);

create index if not exists plan_approvals_timeline_idx
  on ops.plan_approvals (replenishment_plan_id, acted_at, plan_approval_id);

create table if not exists ops.ad_hoc_issues (
  ad_hoc_issue_id uuid primary key default gen_random_uuid(),
  issue_number text not null unique,
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  requested_qty numeric not null check (requested_qty > 0),
  reason text not null check (btrim(reason) <> ''),
  requester_name text not null check (btrim(requester_name) <> ''),
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'issued', 'rejected', 'cancelled')),
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approval_note text,
  issued_by uuid references auth.users (id) on delete set null,
  issued_at timestamptz,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.fifo_allocations (
  fifo_allocation_id uuid primary key default gen_random_uuid(),
  replenishment_item_id uuid references core.replenishment_items (replenishment_item_id) on delete restrict,
  ad_hoc_issue_id uuid references ops.ad_hoc_issues (ad_hoc_issue_id) on delete restrict,
  handling_unit_id uuid not null references core.handling_units (handling_unit_id) on delete restrict,
  allocation_sequence integer not null check (allocation_sequence > 0),
  allocated_qty numeric not null check (allocated_qty > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'issued', 'released')),
  reserved_by uuid references auth.users (id) on delete set null,
  reserved_at timestamptz not null default now(),
  issued_by uuid references auth.users (id) on delete set null,
  issued_at timestamptz,
  released_by uuid references auth.users (id) on delete set null,
  released_at timestamptz,
  release_reason text,
  constraint fifo_allocations_single_source check (
    (replenishment_item_id is not null and ad_hoc_issue_id is null)
    or (replenishment_item_id is null and ad_hoc_issue_id is not null)
  )
);

create unique index if not exists fifo_allocations_plan_unit_uidx
  on ops.fifo_allocations (replenishment_item_id, handling_unit_id)
  where replenishment_item_id is not null;

create unique index if not exists fifo_allocations_ad_hoc_unit_uidx
  on ops.fifo_allocations (ad_hoc_issue_id, handling_unit_id)
  where ad_hoc_issue_id is not null;

create table if not exists core.inventory_movements (
  inventory_movement_id uuid primary key default gen_random_uuid(),
  movement_type text not null
    check (movement_type in ('RECEIPT', 'RESERVE', 'RESERVATION_RELEASE', 'ISSUE', 'RETURN', 'DAMAGE', 'QUARANTINE', 'ADJUSTMENT')),
  material_id text not null references core.materials (material_id) on delete restrict,
  handling_unit_id uuid references core.handling_units (handling_unit_id) on delete restrict,
  from_location_id text references core.locations (location_id) on delete restrict,
  to_location_id text references core.locations (location_id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  replenishment_item_id uuid references core.replenishment_items (replenishment_item_id) on delete restrict,
  ad_hoc_issue_id uuid references ops.ad_hoc_issues (ad_hoc_issue_id) on delete restrict,
  source_movement_id uuid references core.inventory_movements (inventory_movement_id) on delete restrict,
  idempotency_key text not null unique,
  reason text,
  performed_by uuid references auth.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_trace_idx
  on core.inventory_movements (
    material_id,
    replenishment_item_id,
    ad_hoc_issue_id,
    occurred_at
  );

create or replace function audit.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception '% is append-only; create a compensating record instead', tg_table_schema || '.' || tg_table_name;
end;
$$;

drop trigger if exists inventory_movements_append_only on core.inventory_movements;
create trigger inventory_movements_append_only
  before update or delete on core.inventory_movements
  for each row execute function audit.reject_append_only_mutation();

drop trigger if exists plan_approvals_append_only on ops.plan_approvals;
create trigger plan_approvals_append_only
  before update or delete on ops.plan_approvals
  for each row execute function audit.reject_append_only_mutation();

create or replace function core.round_replenishment(input_quantity numeric)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when input_quantity is null or input_quantity <= 0 then 0
    else round(input_quantity, 0)
  end
$$;

create or replace function core.enforce_cmp_business_rule()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, analytics
as $$
declare
  v_latest_period date;
begin
  select max(period_start)
  into v_latest_period
  from analytics.demand_monthly_features
  where material_id = new.material_id
    and district_id = new.district_id
    and feature_version = 'monthly-demand-v1';

  if v_latest_period is not null then
    select round(avg(demand_quantity), 0)
    into new.avg_4m
    from (
      select demand_quantity
      from analytics.demand_monthly_features
      where material_id = new.material_id
        and district_id = new.district_id
        and feature_version = 'monthly-demand-v1'
      order by period_start desc
      limit 4
    ) q;

    select round(avg(demand_quantity), 0)
    into new.avg_6m
    from (
      select demand_quantity
      from analytics.demand_monthly_features
      where material_id = new.material_id
        and district_id = new.district_id
        and feature_version = 'monthly-demand-v1'
      order by period_start desc
      limit 6
    ) q;

    select round(avg(demand_quantity), 0)
    into new.avg_12m
    from (
      select demand_quantity
      from analytics.demand_monthly_features
      where material_id = new.material_id
        and district_id = new.district_id
        and feature_version = 'monthly-demand-v1'
      order by period_start desc
      limit 12
    ) q;

    select round(avg(demand_quantity), 0)
    into new.avg_ly
    from analytics.demand_monthly_features
    where material_id = new.material_id
      and district_id = new.district_id
      and feature_version = 'monthly-demand-v1'
      and period_start >= date_trunc('year', v_latest_period)::date - interval '1 year'
      and period_start < date_trunc('year', v_latest_period)::date;
  end if;

  new.cmp_monthly := round(
    (
      coalesce(new.avg_ly, 0)
      + coalesce(new.avg_12m, 0)
      + coalesce(new.avg_6m, 0)
      + coalesce(new.avg_4m, 0)
    ) / 4,
    0
  );
  return new;
end;
$$;

drop trigger if exists enforce_cmp_business_rule on core.usage_rates;
create trigger enforce_cmp_business_rule
  before insert or update of avg_ly, avg_12m, avg_6m, avg_4m, cmp_monthly
  on core.usage_rates
  for each row execute function core.enforce_cmp_business_rule();

update core.usage_rates
set cmp_monthly = cmp_monthly;

update ops.calculation_policies
set policy_name = 'Business Rules v1 weekly replenishment policy',
    parameters = '{
      "months_trigger": 3.5,
      "min_months": 4,
      "reference_months": 3,
      "max_months": 6,
      "special_approval_months": 9,
      "cmp_formula": "ROUND(AVERAGE(LY,12M,6M,4M),0)",
      "rounding": "whole_base_unit",
      "partial_handling_unit_issue": true,
      "fixed_rounding_tiers": false
    }'::jsonb,
    source_reference = 'update-v1/BUSINESS_RULES_V1.md and MASTER_REQUIREMENTS_AND_DECISIONS_2026-07-22.md',
    updated_at = now()
where policy_version = 'v1.0.0';

create or replace view analytics.v_stock_health
with (security_invoker = true)
as
with latest_location_snapshot as (
  select distinct on (s.material_id, s.location_id)
    s.snapshot_id,
    s.material_id,
    s.location_id,
    l.district_id,
    s.quantity_on_hand,
    s.snapshot_at,
    s.source_batch_id
  from core.stock_snapshots s
  join core.locations l using (location_id)
  where l.location_type = 'DISTRICT'
  order by s.material_id, s.location_id, s.snapshot_at desc, s.snapshot_id
), district_stock as (
  select
    material_id,
    district_id,
    (array_agg(snapshot_id order by snapshot_at desc, snapshot_id))[1] as snapshot_id,
    sum(quantity_on_hand) as quantity_on_hand,
    max(snapshot_at) as snapshot_at,
    (array_agg(source_batch_id order by snapshot_at desc) filter (where source_batch_id is not null))[1] as source_batch_id
  from latest_location_snapshot
  group by material_id, district_id
), latest_usage as (
  select distinct on (u.material_id, u.district_id)
    u.usage_rate_id,
    u.material_id,
    u.district_id,
    u.as_of_date,
    u.cmp_monthly,
    u.avg_ly,
    u.avg_12m,
    u.avg_6m,
    u.avg_4m,
    u.source_batch_id
  from core.usage_rates u
  order by u.material_id, u.district_id, u.as_of_date desc, u.updated_at desc
)
select
  s.snapshot_id,
  u.usage_rate_id,
  m.material_id,
  m.material_name,
  d.district_id,
  d.district_name_th,
  coalesce(s.quantity_on_hand, 0) as current_stock_qty,
  s.snapshot_at,
  u.as_of_date as usage_as_of_date,
  u.cmp_monthly,
  u.avg_4m,
  u.avg_6m,
  case
    when u.cmp_monthly > 0
      then round(coalesce(s.quantity_on_hand, 0) / u.cmp_monthly, 1)
  end as months_available,
  case
    when u.cmp_monthly is null or u.cmp_monthly = 0 then 'unknown'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly < 1.5 then 'critical'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly < 3.5 then 'watch'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly > 6 then 'overstock'
    else 'healthy'
  end as health_band,
  u.avg_ly,
  u.avg_12m,
  s.snapshot_id is null as source_stock_missing,
  case
    when s.snapshot_id is null then 'Source Missing / Assumed 0'
    else 'Actual Unrestricted Stock'
  end as stock_source_status,
  s.source_batch_id as stock_source_batch_id,
  u.source_batch_id as usage_source_batch_id
from core.materials m
cross join core.districts d
left join district_stock s
  on s.material_id = m.material_id and s.district_id = d.district_id
left join latest_usage u
  on u.material_id = m.material_id and u.district_id = d.district_id
where m.is_vmi
  and d.is_active;

create or replace view analytics.v_fifo_queue
with (security_invoker = true)
as
select
  hu.handling_unit_id,
  hu.handling_unit_code,
  hu.material_id,
  m.material_name,
  hu.location_id,
  hu.unit_type,
  hu.opening_status,
  hu.received_qty,
  hu.available_qty,
  hu.reserved_qty,
  hu.available_qty - hu.reserved_qty as allocatable_qty,
  lot.receipt_lot_id,
  lot.lot_code,
  lot.acceptance_date,
  lot.installment_no,
  lot.traceability_status,
  c.purchase_order,
  ci.line_item,
  ci.source_row_number,
  c.contract_number,
  case
    when v.vendor_id is null then 'SUP-UNKNOWN'
    else 'SUP-' || lpad(v.vendor_id::text, 6, '0')
  end as vendor_name,
  hu.source_reference,
  row_number() over (
    partition by hu.material_id, hu.location_id
    order by
      case hu.opening_status when 'OPEN' then 0 when 'SEALED' then 1 else 2 end,
      lot.acceptance_date,
      c.purchase_order,
      ci.line_item,
      ci.source_row_number,
      hu.handling_unit_code
  ) as fifo_sequence
from core.handling_units hu
join core.receipt_lots lot using (receipt_lot_id)
join core.contract_items ci using (contract_item_id)
join core.contracts c using (contract_id)
left join core.vendors v using (vendor_id)
join core.materials m on m.material_id = hu.material_id
where hu.available_qty > hu.reserved_qty
  and hu.opening_status in ('OPEN', 'SEALED')
  and lot.traceability_status = 'complete';

create or replace view analytics.v_quantity_recommendations
with (security_invoker = true)
as
select
  qr.recommendation_id,
  qr.replenishment_item_id,
  i.replenishment_plan_id,
  p.plan_number,
  p.version_no,
  i.material_id,
  m.material_name,
  i.district_id,
  d.district_name_th,
  qr.method,
  qr.recommended_qty,
  i.current_stock_qty,
  i.cmp_monthly,
  i.months_available,
  i.min_fill_qty,
  i.max_fill_qty,
  qr.evidence,
  qr.source_freshness_status,
  qr.created_at
from ops.quantity_recommendations qr
join core.replenishment_items i using (replenishment_item_id)
join core.replenishment_plans p using (replenishment_plan_id)
join core.materials m using (material_id)
join core.districts d using (district_id);

create or replace view analytics.v_abnormal_request_queue
with (security_invoker = true)
as
select
  cr.change_request_id,
  cr.replenishment_item_id,
  i.replenishment_plan_id,
  p.plan_number,
  p.version_no,
  i.material_id,
  m.material_name,
  i.district_id,
  d.district_name_th,
  cr.baseline_qty,
  cr.requested_qty,
  cr.projected_months_after,
  cr.exceeds_six_months,
  cr.special_approval_required,
  cr.risk_level,
  cr.abnormal_signals,
  cr.reason,
  cr.requester_name,
  cr.status,
  cr.requested_by,
  cr.requested_at,
  cr.reviewed_by,
  cr.reviewed_at,
  cr.review_note
from ops.district_change_requests cr
join core.replenishment_items i using (replenishment_item_id)
join core.replenishment_plans p using (replenishment_plan_id)
join core.materials m using (material_id)
join core.districts d using (district_id);

create or replace view analytics.v_replenishment_queue
with (security_invoker = true)
as
select
  p.replenishment_plan_id,
  p.replenishment_run_id,
  p.status as plan_status,
  i.replenishment_item_id,
  i.material_id,
  m.material_name,
  i.district_id,
  d.district_name_th,
  i.current_stock_qty,
  i.cmp_monthly,
  i.months_available,
  i.min_fill_qty,
  i.max_fill_qty,
  i.suggested_qty,
  i.confirmed_qty,
  i.priority_score,
  i.priority_band,
  i.status as item_status,
  i.district_note,
  p.created_at,
  p.plan_number,
  p.week_start_date,
  p.version_no,
  p.parent_plan_id,
  p.response_due_at,
  p.planner_approved_at,
  p.academic_approved_at,
  p.locked_at,
  i.requested_qty,
  i.final_qty,
  i.projected_months_after,
  i.exceeds_six_months,
  i.special_approval_required,
  i.abnormal_risk_level,
  i.abnormal_signals,
  i.source_stock_missing,
  i.district_decision,
  i.requester_name,
  i.confirmed_on_behalf,
  coalesce(
    (
      select sum(a.allocated_qty)
      from ops.fifo_allocations a
      where a.replenishment_item_id = i.replenishment_item_id
        and a.status in ('reserved', 'issued')
    ),
    0
  ) as allocated_qty,
  p.updated_at
from core.replenishment_plans p
join core.replenishment_items i using (replenishment_plan_id)
join core.materials m using (material_id)
join core.districts d using (district_id);

create or replace view analytics.v_issue_traceback
with (security_invoker = true)
as
select
  mov.inventory_movement_id,
  mov.occurred_at,
  mov.quantity as issued_qty,
  mov.material_id,
  m.material_name,
  coalesce(i.district_id, ah.district_id) as district_id,
  d.district_name_th,
  coalesce(
    p.plan_number || '-V' || p.version_no::text,
    ah.issue_number
  ) as issue_reference,
  case when i.replenishment_item_id is not null then 'WEEKLY_PLAN' else 'AD_HOC' end as issue_type,
  p.replenishment_plan_id,
  i.replenishment_item_id,
  ah.ad_hoc_issue_id,
  hu.handling_unit_id,
  hu.handling_unit_code,
  hu.unit_type,
  lot.receipt_lot_id,
  lot.lot_code,
  lot.acceptance_date,
  lot.installment_no,
  c.purchase_order,
  c.contract_number,
  ci.contract_item_id,
  ci.line_item,
  ci.source_row_number,
  v.vendor_id,
  case
    when v.vendor_id is null then 'SUP-UNKNOWN'
    else 'SUP-' || lpad(v.vendor_id::text, 6, '0')
  end as vendor_name,
  jsonb_build_array(
    case
      when v.vendor_id is null then 'SUP-UNKNOWN'
      else 'SUP-' || lpad(v.vendor_id::text, 6, '0')
    end
  ) as vendor_aliases,
  mov.from_location_id,
  mov.to_location_id,
  mov.performed_by,
  mov.idempotency_key
from core.inventory_movements mov
join core.handling_units hu using (handling_unit_id)
join core.receipt_lots lot using (receipt_lot_id)
join core.contract_items ci using (contract_item_id)
join core.contracts c using (contract_id)
left join core.vendors v using (vendor_id)
join core.materials m on m.material_id = mov.material_id
left join core.replenishment_items i using (replenishment_item_id)
left join core.replenishment_plans p using (replenishment_plan_id)
left join ops.ad_hoc_issues ah using (ad_hoc_issue_id)
left join core.districts d
  on d.district_id = coalesce(i.district_id, ah.district_id)
where mov.movement_type = 'ISSUE';

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
      and hu.opening_status in ('OPEN', 'SEALED')
      and lot.traceability_status = 'complete'
      and hu.available_qty > hu.reserved_qty
    order by
      case hu.opening_status when 'OPEN' then 0 else 1 end,
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
      'reserve:' || coalesce(p_replenishment_item_id::text, p_ad_hoc_issue_id::text)
        || ':' || v_hu.handling_unit_id::text,
      'FIFO reservation',
      auth.uid()
    );

    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    raise exception 'Insufficient traceable FIFO stock for material %: shortage %', p_material_id, v_remaining;
  end if;
  return p_quantity;
end;
$$;

create or replace function core.create_replenishment_run(
  p_snapshot_cutoff_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, ops, analytics
as $$
declare
  v_policy ops.calculation_policies%rowtype;
  v_run_id uuid := gen_random_uuid();
  v_plan_id uuid := gen_random_uuid();
  v_origin_location_id text;
  v_week_start date := date_trunc('week', now() at time zone 'Asia/Bangkok')::date;
  v_plan_number text;
begin
  select * into v_policy
  from ops.calculation_policies
  where is_active;
  if not found then
    raise exception 'No active replenishment calculation policy';
  end if;

  select l.location_id into v_origin_location_id
  from core.locations l
  join core.warehouses w using (warehouse_id)
  where l.location_type = 'WAREHOUSE'
    and l.is_active
    and w.sap_plant_code = '2401'
    and w.storage_location = '0001'
  order by l.location_id
  limit 1;
  if v_origin_location_id is null then
    raise exception 'Khlong Toei warehouse Plant 2401 / Storage Location 0001 is not configured';
  end if;

  if exists (
    select 1
    from core.replenishment_plans
    where week_start_date = v_week_start
      and parent_plan_id is null
      and status not in ('cancelled', 'completed')
  ) then
    raise exception 'An active weekly plan already exists for %; version or cancel it instead', v_week_start;
  end if;

  if not exists (
    select 1
    from core.usage_rates
    where as_of_date >= current_date - 62
  ) then
    raise exception 'No current monthly usage/CMP source is available';
  end if;

  v_plan_number := 'RP-' || to_char(v_week_start, 'IYYY-IW')
    || '-' || upper(left(replace(v_plan_id::text, '-', ''), 8));

  insert into ops.replenishment_runs (
    replenishment_run_id,
    policy_version,
    snapshot_cutoff_at,
    initiated_by
  )
  values (
    v_run_id,
    v_policy.policy_version,
    p_snapshot_cutoff_at,
    auth.uid()
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
    created_by
  )
  values (
    v_plan_id,
    v_run_id,
    v_plan_number,
    v_week_start,
    1,
    v_origin_location_id,
    'draft',
    (
      date_trunc('day', now() at time zone 'Asia/Bangkok')
      + interval '1 day 17 hours'
    ) at time zone 'Asia/Bangkok',
    auth.uid()
  );

  insert into core.replenishment_items (
    replenishment_plan_id,
    material_id,
    district_id,
    source_stock_snapshot_id,
    source_usage_rate_id,
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
  select
    v_plan_id,
    h.material_id,
    h.district_id,
    h.snapshot_id,
    h.usage_rate_id,
    h.current_stock_qty,
    h.cmp_monthly,
    h.months_available,
    core.round_replenishment(h.cmp_monthly * 4 - h.current_stock_qty),
    core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty),
    core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty),
    core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty),
    core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty),
    round(
      (
        h.current_stock_qty
        + core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty)
      ) / h.cmp_monthly,
      2
    ),
    h.source_stock_missing,
    round(
      greatest(
        1::numeric,
        least(
          10::numeric,
          ((1 - least(h.current_stock_qty / nullif(h.cmp_monthly * 6, 0), 1)) * 10) * 0.5
          + greatest(0::numeric, least(10::numeric, (30 - h.months_available * 30) / 3)) * 0.3
          + 5 * 0.2
        )
      ),
      1
    ),
    case
      when h.months_available < 1.5 then 'critical'
      when h.months_available < 3.5 then 'high'
      else 'normal'
    end,
    'pending'
  from analytics.v_stock_health h
  where h.cmp_monthly > 0
    and h.usage_as_of_date >= current_date - 62
    and h.months_available <= (v_policy.parameters ->> 'months_trigger')::numeric
    and core.round_replenishment(h.cmp_monthly * 6 - h.current_stock_qty) > 0;

  insert into ops.quantity_recommendations (
    replenishment_item_id,
    method,
    recommended_qty,
    evidence,
    source_freshness_status
  )
  select
    i.replenishment_item_id,
    'BUSINESS_RULE_V1',
    i.suggested_qty,
    jsonb_build_object(
      'policy_version', v_policy.policy_version,
      'cmp_formula', 'ROUND(AVERAGE(LY,12M,6M,4M),0)',
      'trigger_months', 3.5,
      'min_months', 4,
      'max_months', 6,
      'current_stock_qty', i.current_stock_qty,
      'cmp_monthly', i.cmp_monthly,
      'months_available', i.months_available,
      'min_fill_qty', i.min_fill_qty,
      'max_fill_qty', i.max_fill_qty,
      'source_stock_missing', i.source_stock_missing
    ),
    case
      when i.source_stock_missing then 'source_missing_assumed_zero'
      else 'fresh'
    end
  from core.replenishment_items i
  where i.replenishment_plan_id = v_plan_id;

  update core.replenishment_plans
  set status = case
        when exists (
          select 1
          from core.replenishment_items
          where replenishment_plan_id = v_plan_id
        ) then 'pending_district_confirmation'
        else 'draft'
      end,
      updated_at = now()
  where replenishment_plan_id = v_plan_id;

  update ops.replenishment_runs
  set status = 'succeeded',
      candidate_count = (
        select count(*)
        from core.replenishment_items
        where replenishment_plan_id = v_plan_id
      ),
      usage_cutoff_date = (
        select max(usage_as_of_date)
        from analytics.v_stock_health
        where usage_as_of_date >= current_date - 62
      ),
      finished_at = now()
  where replenishment_run_id = v_run_id;

  return v_run_id;
exception
  when others then
    update ops.replenishment_runs
    set status = 'failed',
        error_message = left(sqlerrm, 2000),
        finished_at = now()
    where replenishment_run_id = v_run_id;
    raise;
end;
$$;

create or replace function core.respond_replenishment_item(
  p_replenishment_item_id uuid,
  p_decision text,
  p_requested_qty numeric,
  p_reason text,
  p_requester_name text
)
returns core.replenishment_items
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_item core.replenishment_items%rowtype;
  v_plan core.replenishment_plans%rowtype;
  v_role public.app_role;
  v_district_id text;
  v_actor_name text;
  v_quantity numeric;
  v_projected numeric;
  v_exceeds_six boolean;
  v_special boolean;
  v_changed boolean;
  v_risk text;
  v_signals jsonb;
begin
  select role, district_id, coalesce(display_name, user_id::text)
  into v_role, v_district_id, v_actor_name
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;

  if v_role not in ('admin', 'planner', 'district') then
    raise exception 'Not authorized to respond to replenishment items';
  end if;
  if p_decision not in ('confirm', 'reject', 'change') then
    raise exception 'Decision must be confirm, reject or change';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Reason is required';
  end if;

  select * into v_item
  from core.replenishment_items
  where replenishment_item_id = p_replenishment_item_id
  for update;
  if not found then
    raise exception 'Replenishment item not found';
  end if;

  select * into v_plan
  from core.replenishment_plans
  where replenishment_plan_id = v_item.replenishment_plan_id
  for update;

  if v_plan.status <> 'pending_district_confirmation'
     or v_item.status not in ('draft', 'pending', 'change_requested') then
    raise exception 'Item is not awaiting district response';
  end if;
  if v_role = 'district' and v_district_id <> v_item.district_id then
    raise exception 'District may only respond to its own items';
  end if;

  v_quantity := case
    when p_decision = 'reject' then 0
    else p_requested_qty
  end;
  if v_quantity is null or v_quantity < 0 then
    raise exception 'Requested quantity must be non-negative';
  end if;
  if btrim(coalesce(p_requester_name, '')) = '' then
    v_actor_name := coalesce(v_actor_name, 'Unknown requester');
  else
    v_actor_name := left(btrim(p_requester_name), 200);
  end if;

  v_projected := round((v_item.current_stock_qty + v_quantity) / v_item.cmp_monthly, 2);
  v_exceeds_six := v_projected > 6;
  v_special := v_projected > 9;
  v_changed := v_quantity <> v_item.suggested_qty;
  v_risk := case
    when v_special then 'high'
    when v_exceeds_six
      or v_quantity > v_item.suggested_qty * 1.25 then 'medium'
    else 'normal'
  end;
  v_signals := jsonb_build_object(
    'quantity_changed', v_changed,
    'requested_to_suggested_ratio',
      case when v_item.suggested_qty > 0
        then round(v_quantity / v_item.suggested_qty, 3)
      end,
    'projected_months_after', v_projected,
    'exceeds_six_months', v_exceeds_six,
    'exceeds_nine_months', v_special,
    'source_stock_missing', v_item.source_stock_missing
  );

  update ops.district_change_requests
  set status = 'cancelled',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = 'Superseded by a newer district response',
      updated_at = now()
  where replenishment_item_id = v_item.replenishment_item_id
    and status = 'pending_review';

  if v_changed then
    insert into ops.district_change_requests (
      replenishment_item_id,
      baseline_qty,
      requested_qty,
      projected_months_after,
      exceeds_six_months,
      special_approval_required,
      risk_level,
      abnormal_signals,
      reason,
      requester_name,
      requested_by
    )
    values (
      v_item.replenishment_item_id,
      v_item.suggested_qty,
      v_quantity,
      v_projected,
      v_exceeds_six,
      v_special,
      v_risk,
      v_signals,
      left(p_reason, 1000),
      v_actor_name,
      auth.uid()
    );
  end if;

  insert into ops.replenishment_adjustments (
    replenishment_item_id,
    previous_qty,
    new_qty,
    adjustment_reason,
    adjusted_by
  )
  values (
    v_item.replenishment_item_id,
    v_item.requested_qty,
    v_quantity,
    left(p_reason, 1000),
    auth.uid()
  );

  update core.replenishment_items
  set requested_qty = v_quantity,
      confirmed_qty = case when not v_changed then v_quantity else null end,
      final_qty = case when not v_changed then v_quantity else null end,
      district_decision = case when v_changed then 'change' else p_decision end,
      district_note = left(p_reason, 1000),
      district_confirmed_by = auth.uid(),
      district_confirmed_at = now(),
      requester_name = v_actor_name,
      confirmed_on_behalf = v_role in ('admin', 'planner'),
      projected_months_after = v_projected,
      exceeds_six_months = v_exceeds_six,
      special_approval_required = v_special,
      abnormal_risk_level = v_risk,
      abnormal_signals = v_signals,
      status = case
        when v_changed then 'change_requested'
        when v_quantity = 0 then 'district_rejected'
        else 'district_confirmed'
      end,
      updated_at = now()
  where replenishment_item_id = v_item.replenishment_item_id
  returning * into v_item;

  insert into ops.plan_approvals (
    replenishment_plan_id,
    replenishment_item_id,
    district_id,
    approval_stage,
    decision,
    note,
    actor_id,
    actor_role
  )
  values (
    v_item.replenishment_plan_id,
    v_item.replenishment_item_id,
    v_item.district_id,
    'district_response',
    case when v_quantity = 0 then 'rejected' else 'confirmed' end,
    left(p_reason, 1000),
    auth.uid(),
    v_role::text
  );

  if not exists (
    select 1
    from core.replenishment_items
    where replenishment_plan_id = v_item.replenishment_plan_id
      and status in ('draft', 'pending', 'change_requested')
  ) then
    update core.replenishment_plans
    set status = 'pending_planner_approval',
        district_responses_completed_at = now(),
        updated_at = now()
    where replenishment_plan_id = v_item.replenishment_plan_id;
  end if;

  return v_item;
end;
$$;

create or replace function core.confirm_replenishment_item(
  p_replenishment_item_id uuid,
  p_confirmed_qty numeric,
  p_reason text
)
returns core.replenishment_items
language plpgsql
security definer
set search_path = pg_catalog, core, public
as $$
declare
  v_requester_name text;
begin
  select coalesce(display_name, user_id::text)
  into v_requester_name
  from public.user_profiles
  where user_id = auth.uid();

  return core.respond_replenishment_item(
    p_replenishment_item_id,
    case when p_confirmed_qty = 0 then 'reject' else 'confirm' end,
    p_confirmed_qty,
    p_reason,
    v_requester_name
  );
end;
$$;

create or replace function core.review_district_change_request(
  p_change_request_id uuid,
  p_decision text,
  p_review_note text
)
returns ops.district_change_requests
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_request ops.district_change_requests%rowtype;
  v_item core.replenishment_items%rowtype;
  v_role public.app_role;
  v_final_qty numeric;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'planner') then
    raise exception 'Only planner or admin may review district changes';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;
  if btrim(coalesce(p_review_note, '')) = '' then
    raise exception 'Review note is required';
  end if;

  select * into v_request
  from ops.district_change_requests
  where change_request_id = p_change_request_id
  for update;
  if not found or v_request.status <> 'pending_review' then
    raise exception 'Pending district change request not found';
  end if;

  select * into v_item
  from core.replenishment_items
  where replenishment_item_id = v_request.replenishment_item_id
  for update;

  v_final_qty := case
    when p_decision = 'approved' then v_request.requested_qty
    else v_request.baseline_qty
  end;

  update ops.district_change_requests
  set status = p_decision,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = left(p_review_note, 1000),
      updated_at = now()
  where change_request_id = v_request.change_request_id
  returning * into v_request;

  update core.replenishment_items
  set confirmed_qty = v_final_qty,
      final_qty = v_final_qty,
      projected_months_after = round((current_stock_qty + v_final_qty) / cmp_monthly, 2),
      exceeds_six_months = (
        round((current_stock_qty + v_final_qty) / cmp_monthly, 2) > 6
      ),
      special_approval_required = (
        round((current_stock_qty + v_final_qty) / cmp_monthly, 2) > 9
      ),
      status = case
        when v_final_qty = 0 then 'district_rejected'
        else 'district_confirmed'
      end,
      updated_at = now()
  where replenishment_item_id = v_item.replenishment_item_id;

  if not exists (
    select 1
    from core.replenishment_items
    where replenishment_plan_id = v_item.replenishment_plan_id
      and status in ('draft', 'pending', 'change_requested')
  ) then
    update core.replenishment_plans
    set status = 'pending_planner_approval',
        district_responses_completed_at = coalesce(district_responses_completed_at, now()),
        updated_at = now()
    where replenishment_plan_id = v_item.replenishment_plan_id;
  end if;

  return v_request;
end;
$$;

create or replace function core.approve_replenishment_plan(
  p_replenishment_plan_id uuid
)
returns core.replenishment_plans
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_plan core.replenishment_plans%rowtype;
  v_role public.app_role;
  v_note text := nullif(current_setting('synapse.approval_note', true), '');
  v_item record;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;

  select * into v_plan
  from core.replenishment_plans
  where replenishment_plan_id = p_replenishment_plan_id
  for update;
  if not found then
    raise exception 'Replenishment plan not found';
  end if;

  if v_plan.status = 'pending_planner_approval' then
    if v_role not in ('admin', 'planner') then
      raise exception 'Only planner or admin may perform planner approval';
    end if;
    if exists (
      select 1
      from core.replenishment_items
      where replenishment_plan_id = v_plan.replenishment_plan_id
        and status not in ('district_confirmed', 'district_rejected')
    ) or exists (
      select 1
      from ops.district_change_requests cr
      join core.replenishment_items i using (replenishment_item_id)
      where i.replenishment_plan_id = v_plan.replenishment_plan_id
        and cr.status = 'pending_review'
    ) then
      raise exception 'All district responses and change requests must be resolved';
    end if;

    update core.replenishment_items
    set status = 'planner_approved',
        updated_at = now()
    where replenishment_plan_id = v_plan.replenishment_plan_id
      and status = 'district_confirmed';

    update core.replenishment_plans
    set status = 'pending_academic_approval',
        planner_approved_by = auth.uid(),
        planner_approved_at = now(),
        updated_at = now()
    where replenishment_plan_id = v_plan.replenishment_plan_id
    returning * into v_plan;

    insert into ops.plan_approvals (
      replenishment_plan_id,
      approval_stage,
      decision,
      note,
      actor_id,
      actor_role
    )
    values (
      v_plan.replenishment_plan_id,
      'planner',
      'approved',
      left(v_note, 1000),
      auth.uid(),
      v_role::text
    );
    return v_plan;
  end if;

  if v_plan.status = 'pending_academic_approval' then
    if v_role not in ('admin', 'academic') then
      raise exception 'Only academic officer or admin may perform academic approval';
    end if;
    if exists (
      select 1
      from core.replenishment_items
      where replenishment_plan_id = v_plan.replenishment_plan_id
        and special_approval_required
        and status = 'planner_approved'
    ) and btrim(coalesce(v_note, '')) = '' then
      raise exception 'Academic note is required for quantities exceeding nine months';
    end if;

    for v_item in
      select *
      from core.replenishment_items
      where replenishment_plan_id = v_plan.replenishment_plan_id
        and status = 'planner_approved'
        and coalesce(final_qty, 0) > 0
      order by priority_score desc, district_id, material_id
    loop
      perform core.reserve_fifo(
        v_item.material_id,
        v_plan.origin_location_id,
        v_item.final_qty,
        v_item.replenishment_item_id,
        null
      );
    end loop;

    update core.replenishment_items
    set status = 'locked',
        updated_at = now()
    where replenishment_plan_id = v_plan.replenishment_plan_id
      and status = 'planner_approved';

    update core.replenishment_plans
    set status = 'locked',
        academic_approved_by = auth.uid(),
        academic_approved_at = now(),
        locked_by = auth.uid(),
        locked_at = now(),
        approved_by = auth.uid(),
        approved_at = now(),
        updated_at = now()
    where replenishment_plan_id = v_plan.replenishment_plan_id
    returning * into v_plan;

    insert into ops.plan_approvals (
      replenishment_plan_id,
      approval_stage,
      decision,
      note,
      actor_id,
      actor_role
    )
    values
      (
        v_plan.replenishment_plan_id,
        'academic',
        'approved',
        left(v_note, 1000),
        auth.uid(),
        v_role::text
      ),
      (
        v_plan.replenishment_plan_id,
        'lock',
        'approved',
        left(v_note, 1000),
        auth.uid(),
        v_role::text
      );
    return v_plan;
  end if;

  raise exception 'Plan is not awaiting planner or academic approval';
end;
$$;

create or replace function core.cancel_replenishment_plan(
  p_replenishment_plan_id uuid,
  p_reason text
)
returns core.replenishment_plans
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_plan core.replenishment_plans%rowtype;
  v_role public.app_role;
  v_allocation record;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'planner') then
    raise exception 'Only planner or admin may cancel plans';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Cancellation reason is required';
  end if;

  select * into v_plan
  from core.replenishment_plans
  where replenishment_plan_id = p_replenishment_plan_id
  for update;
  if not found then
    raise exception 'Replenishment plan not found';
  end if;
  if v_plan.status in ('cancelled', 'completed') then
    raise exception 'Completed or cancelled plan cannot be cancelled';
  end if;

  for v_allocation in
    select a.*, hu.material_id, hu.location_id
    from ops.fifo_allocations a
    join core.replenishment_items i using (replenishment_item_id)
    join core.handling_units hu using (handling_unit_id)
    where i.replenishment_plan_id = v_plan.replenishment_plan_id
      and a.status = 'reserved'
    for update of a, hu
  loop
    update core.handling_units
    set reserved_qty = reserved_qty - v_allocation.allocated_qty,
        updated_at = now()
    where handling_unit_id = v_allocation.handling_unit_id;

    update ops.fifo_allocations
    set status = 'released',
        released_by = auth.uid(),
        released_at = now(),
        release_reason = left(p_reason, 1000)
    where fifo_allocation_id = v_allocation.fifo_allocation_id;

    insert into core.inventory_movements (
      movement_type,
      material_id,
      handling_unit_id,
      from_location_id,
      quantity,
      replenishment_item_id,
      idempotency_key,
      reason,
      performed_by
    )
    values (
      'RESERVATION_RELEASE',
      v_allocation.material_id,
      v_allocation.handling_unit_id,
      v_allocation.location_id,
      v_allocation.allocated_qty,
      v_allocation.replenishment_item_id,
      'release:' || v_allocation.fifo_allocation_id::text,
      left(p_reason, 1000),
      auth.uid()
    );
  end loop;

  update core.replenishment_items
  set status = 'cancelled',
      updated_at = now()
  where replenishment_plan_id = v_plan.replenishment_plan_id
    and status <> 'issued';

  update core.replenishment_plans
  set status = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = now(),
      cancellation_reason = left(p_reason, 1000),
      updated_at = now()
  where replenishment_plan_id = v_plan.replenishment_plan_id
  returning * into v_plan;

  insert into ops.plan_approvals (
    replenishment_plan_id,
    approval_stage,
    decision,
    note,
    actor_id,
    actor_role
  )
  values (
    v_plan.replenishment_plan_id,
    'cancel',
    'cancelled',
    left(p_reason, 1000),
    auth.uid(),
    v_role::text
  );
  return v_plan;
end;
$$;

create or replace function core.version_replenishment_plan(
  p_replenishment_plan_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_source core.replenishment_plans%rowtype;
  v_role public.app_role;
  v_new_plan_id uuid := gen_random_uuid();
  v_new_run_id uuid := gen_random_uuid();
  v_root_plan_id uuid;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'planner') then
    raise exception 'Only planner or admin may version plans';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Version reason is required';
  end if;

  select * into v_source
  from core.replenishment_plans
  where replenishment_plan_id = p_replenishment_plan_id
  for update;
  if not found or v_source.status <> 'locked' then
    raise exception 'Only a locked plan may be versioned';
  end if;

  perform core.cancel_replenishment_plan(v_source.replenishment_plan_id, p_reason);
  v_root_plan_id := coalesce(v_source.parent_plan_id, v_source.replenishment_plan_id);

  insert into ops.replenishment_runs (
    replenishment_run_id,
    policy_version,
    snapshot_cutoff_at,
    usage_cutoff_date,
    status,
    candidate_count,
    initiated_by,
    finished_at
  )
  select
    v_new_run_id,
    policy_version,
    snapshot_cutoff_at,
    usage_cutoff_date,
    'succeeded',
    candidate_count,
    auth.uid(),
    now()
  from ops.replenishment_runs
  where replenishment_run_id = v_source.replenishment_run_id;

  insert into core.replenishment_plans (
    replenishment_plan_id,
    replenishment_run_id,
    plan_number,
    week_start_date,
    version_no,
    parent_plan_id,
    origin_location_id,
    status,
    response_due_at,
    created_by
  )
  values (
    v_new_plan_id,
    v_new_run_id,
    v_source.plan_number,
    v_source.week_start_date,
    v_source.version_no + 1,
    v_root_plan_id,
    v_source.origin_location_id,
    'pending_district_confirmation',
    (
      date_trunc('day', now() at time zone 'Asia/Bangkok')
      + interval '1 day 17 hours'
    ) at time zone 'Asia/Bangkok',
    auth.uid()
  );

  insert into core.replenishment_items (
    replenishment_plan_id,
    material_id,
    district_id,
    source_stock_snapshot_id,
    source_usage_rate_id,
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
  select
    v_new_plan_id,
    material_id,
    district_id,
    source_stock_snapshot_id,
    source_usage_rate_id,
    current_stock_qty,
    cmp_monthly,
    months_available,
    min_fill_qty,
    max_fill_qty,
    suggested_qty,
    suggested_qty,
    suggested_qty,
    round((current_stock_qty + suggested_qty) / cmp_monthly, 2),
    source_stock_missing,
    priority_score,
    priority_band,
    'pending'
  from core.replenishment_items
  where replenishment_plan_id = v_source.replenishment_plan_id
    and status <> 'district_rejected';

  insert into ops.quantity_recommendations (
    replenishment_item_id,
    method,
    recommended_qty,
    evidence,
    source_freshness_status
  )
  select
    i.replenishment_item_id,
    'BUSINESS_RULE_V1',
    i.suggested_qty,
    jsonb_build_object(
      'versioned_from_plan_id', v_source.replenishment_plan_id,
      'version_reason', left(p_reason, 1000),
      'current_stock_qty', i.current_stock_qty,
      'cmp_monthly', i.cmp_monthly,
      'max_months', 6
    ),
    case when i.source_stock_missing
      then 'source_missing_assumed_zero'
      else 'fresh'
    end
  from core.replenishment_items i
  where i.replenishment_plan_id = v_new_plan_id;

  insert into ops.plan_approvals (
    replenishment_plan_id,
    approval_stage,
    decision,
    note,
    actor_id,
    actor_role
  )
  values (
    v_new_plan_id,
    'version',
    'created',
    left(p_reason, 1000),
    auth.uid(),
    v_role::text
  );
  return v_new_plan_id;
end;
$$;

create or replace function core.receive_handling_unit(
  p_contract_item_id bigint,
  p_location_id text,
  p_acceptance_date date,
  p_quantity numeric,
  p_handling_unit_code text,
  p_unit_type text,
  p_opening_status text,
  p_installment_no text,
  p_source_reference text
)
returns core.handling_units
language plpgsql
security definer
set search_path = pg_catalog, core, public
as $$
declare
  v_role public.app_role;
  v_material_id text;
  v_warehouse_id text;
  v_lot_id uuid := gen_random_uuid();
  v_hu core.handling_units%rowtype;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'picker') then
    raise exception 'Only picker or admin may receive handling units';
  end if;
  if p_acceptance_date is null or p_acceptance_date > current_date then
    raise exception 'Acceptance date must be a valid non-future date';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Receipt quantity must be positive';
  end if;
  if btrim(coalesce(p_handling_unit_code, '')) = ''
     or btrim(coalesce(p_source_reference, '')) = '' then
    raise exception 'Handling-unit code and source reference are required';
  end if;
  if p_opening_status not in ('SEALED', 'OPENING_UNKNOWN') then
    raise exception 'New receipt must be SEALED or OPENING_UNKNOWN';
  end if;

  select ci.material_id, l.warehouse_id
  into v_material_id, v_warehouse_id
  from core.contract_items ci
  cross join core.locations l
  where ci.contract_item_id = p_contract_item_id
    and l.location_id = p_location_id
    and l.location_type = 'WAREHOUSE';
  if v_material_id is null or v_warehouse_id is null then
    raise exception 'Contract item with material and warehouse location are required';
  end if;

  insert into core.receipt_lots (
    receipt_lot_id,
    lot_code,
    contract_item_id,
    warehouse_id,
    acceptance_date,
    installment_no,
    received_qty,
    remaining_qty,
    traceability_status,
    source_reference,
    created_by
  )
  values (
    v_lot_id,
    'LOT-' || to_char(p_acceptance_date, 'YYYYMMDD') || '-'
      || upper(left(replace(v_lot_id::text, '-', ''), 8)),
    p_contract_item_id,
    v_warehouse_id,
    p_acceptance_date,
    nullif(left(p_installment_no, 100), ''),
    p_quantity,
    p_quantity,
    case when p_opening_status = 'OPENING_UNKNOWN'
      then 'opening_unknown'
      else 'complete'
    end,
    left(p_source_reference, 1000),
    auth.uid()
  );

  insert into core.handling_units (
    handling_unit_code,
    receipt_lot_id,
    material_id,
    location_id,
    unit_type,
    opening_status,
    received_qty,
    available_qty,
    source_reference
  )
  values (
    left(btrim(p_handling_unit_code), 200),
    v_lot_id,
    v_material_id,
    p_location_id,
    p_unit_type,
    p_opening_status,
    p_quantity,
    p_quantity,
    left(p_source_reference, 1000)
  )
  returning * into v_hu;

  insert into core.inventory_movements (
    movement_type,
    material_id,
    handling_unit_id,
    to_location_id,
    quantity,
    idempotency_key,
    reason,
    performed_by,
    metadata
  )
  values (
    'RECEIPT',
    v_material_id,
    v_hu.handling_unit_id,
    p_location_id,
    p_quantity,
    'receipt:' || v_hu.handling_unit_id::text,
    left(p_source_reference, 1000),
    auth.uid(),
    jsonb_build_object(
      'contract_item_id', p_contract_item_id,
      'acceptance_date', p_acceptance_date,
      'installment_no', p_installment_no
    )
  );
  return v_hu;
end;
$$;

create or replace function core.issue_replenishment_plan(
  p_replenishment_plan_id uuid
)
returns core.replenishment_plans
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_plan core.replenishment_plans%rowtype;
  v_role public.app_role;
  v_allocation record;
  v_destination_id text;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'picker') then
    raise exception 'Only picker or admin may issue locked plans';
  end if;

  select * into v_plan
  from core.replenishment_plans
  where replenishment_plan_id = p_replenishment_plan_id
  for update;
  if not found or v_plan.status <> 'locked' then
    raise exception 'Locked replenishment plan not found';
  end if;

  for v_allocation in
    select
      a.*,
      i.material_id,
      i.district_id,
      hu.receipt_lot_id,
      hu.location_id
    from ops.fifo_allocations a
    join core.replenishment_items i using (replenishment_item_id)
    join core.handling_units hu using (handling_unit_id)
    where i.replenishment_plan_id = v_plan.replenishment_plan_id
      and a.status = 'reserved'
    order by i.district_id, i.material_id, a.allocation_sequence
    for update of a, hu
  loop
    select location_id into v_destination_id
    from core.locations
    where district_id = v_allocation.district_id
      and location_type = 'DISTRICT'
      and is_active
    order by location_id
    limit 1;
    if v_destination_id is null then
      raise exception 'Active district destination is missing for %', v_allocation.district_id;
    end if;

    update core.handling_units
    set available_qty = available_qty - v_allocation.allocated_qty,
        reserved_qty = reserved_qty - v_allocation.allocated_qty,
        opening_status = case
          when available_qty - v_allocation.allocated_qty = 0 then 'DEPLETED'
          else 'OPEN'
        end,
        opened_at = case
          when available_qty - v_allocation.allocated_qty > 0
            then coalesce(opened_at, now())
          else opened_at
        end,
        updated_at = now()
    where handling_unit_id = v_allocation.handling_unit_id;

    update core.receipt_lots
    set remaining_qty = remaining_qty - v_allocation.allocated_qty,
        updated_at = now()
    where receipt_lot_id = v_allocation.receipt_lot_id;

    update ops.fifo_allocations
    set status = 'issued',
        issued_by = auth.uid(),
        issued_at = now()
    where fifo_allocation_id = v_allocation.fifo_allocation_id;

    insert into core.inventory_movements (
      movement_type,
      material_id,
      handling_unit_id,
      from_location_id,
      to_location_id,
      quantity,
      replenishment_item_id,
      idempotency_key,
      reason,
      performed_by
    )
    values (
      'ISSUE',
      v_allocation.material_id,
      v_allocation.handling_unit_id,
      v_allocation.location_id,
      v_destination_id,
      v_allocation.allocated_qty,
      v_allocation.replenishment_item_id,
      'issue:' || v_allocation.fifo_allocation_id::text,
      'Locked weekly replenishment issue',
      auth.uid()
    );
  end loop;

  if not found then
    raise exception 'Plan has no reserved FIFO allocations';
  end if;

  update core.replenishment_items
  set status = case
        when status = 'district_rejected' then status
        else 'issued'
      end,
      updated_at = now()
  where replenishment_plan_id = v_plan.replenishment_plan_id;

  update core.replenishment_plans
  set status = 'completed',
      updated_at = now()
  where replenishment_plan_id = v_plan.replenishment_plan_id
  returning * into v_plan;
  return v_plan;
end;
$$;

create or replace function core.reconcile_opening_handling_unit(
  p_handling_unit_id uuid,
  p_resolved_status text,
  p_reason text
)
returns core.handling_units
language plpgsql
security definer
set search_path = pg_catalog, core, public
as $$
declare
  v_role public.app_role;
  v_hu core.handling_units%rowtype;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'picker') then
    raise exception 'Only picker or admin may reconcile opening stock';
  end if;
  if p_resolved_status not in ('OPEN', 'SEALED')
     or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Resolved status OPEN or SEALED and reason are required';
  end if;

  select * into v_hu
  from core.handling_units
  where handling_unit_id = p_handling_unit_id
  for update;
  if not found or v_hu.opening_status <> 'OPENING_UNKNOWN' then
    raise exception 'OPENING_UNKNOWN handling unit not found';
  end if;

  update core.receipt_lots
  set traceability_status = 'complete',
      updated_at = now()
  where receipt_lot_id = v_hu.receipt_lot_id;

  update core.handling_units
  set opening_status = p_resolved_status,
      opened_at = case when p_resolved_status = 'OPEN' then now() else null end,
      source_reference = source_reference || ' | reconciliation: ' || left(p_reason, 500),
      updated_at = now()
  where handling_unit_id = v_hu.handling_unit_id
  returning * into v_hu;

  insert into core.inventory_movements (
    movement_type,
    material_id,
    handling_unit_id,
    to_location_id,
    quantity,
    idempotency_key,
    reason,
    performed_by,
    metadata
  )
  values (
    'ADJUSTMENT',
    v_hu.material_id,
    v_hu.handling_unit_id,
    v_hu.location_id,
    v_hu.available_qty,
    'opening-reconcile:' || v_hu.handling_unit_id::text,
    left(p_reason, 1000),
    auth.uid(),
    jsonb_build_object('resolved_status', p_resolved_status)
  );
  return v_hu;
end;
$$;

create or replace function core.create_ad_hoc_issue(
  p_material_id text,
  p_district_id text,
  p_requested_qty numeric,
  p_reason text,
  p_requester_name text,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_role public.app_role;
  v_profile_district text;
  v_issue_id uuid := gen_random_uuid();
  v_existing_issue_id uuid;
begin
  select role, district_id into v_role, v_profile_district
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'planner', 'district') then
    raise exception 'Not authorized to create ad-hoc issues';
  end if;
  if v_role = 'district' and v_profile_district <> p_district_id then
    raise exception 'District may only request for its own district';
  end if;
  if p_requested_qty is null or p_requested_qty <= 0
     or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_requester_name, '')) = '' then
    raise exception 'Positive quantity, reason and requester name are required';
  end if;
  if not exists (select 1 from core.materials where material_id = p_material_id)
     or not exists (select 1 from core.districts where district_id = p_district_id and is_active) then
    raise exception 'Active material and district are required';
  end if;

  if nullif(p_idempotency_key, '') is not null then
    select ad_hoc_issue_id into v_existing_issue_id
    from ops.ad_hoc_issues
    where idempotency_key = p_idempotency_key;
    if found then
      return v_existing_issue_id;
    end if;
  end if;

  insert into ops.ad_hoc_issues (
    ad_hoc_issue_id,
    issue_number,
    material_id,
    district_id,
    requested_qty,
    reason,
    requester_name,
    requested_by,
    idempotency_key
  )
  values (
    v_issue_id,
    'AH-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMMDD')
      || '-' || upper(left(replace(v_issue_id::text, '-', ''), 8)),
    p_material_id,
    p_district_id,
    p_requested_qty,
    left(p_reason, 1000),
    left(p_requester_name, 200),
    auth.uid(),
    nullif(left(p_idempotency_key, 200), '')
  );
  return v_issue_id;
end;
$$;

create or replace function core.approve_ad_hoc_issue(
  p_ad_hoc_issue_id uuid,
  p_note text
)
returns ops.ad_hoc_issues
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_role public.app_role;
  v_issue ops.ad_hoc_issues%rowtype;
  v_origin_location_id text;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'planner') then
    raise exception 'Only planner or admin may approve ad-hoc issues';
  end if;
  if btrim(coalesce(p_note, '')) = '' then
    raise exception 'Approval note is required';
  end if;

  select * into v_issue
  from ops.ad_hoc_issues
  where ad_hoc_issue_id = p_ad_hoc_issue_id
  for update;
  if not found or v_issue.status <> 'pending_approval' then
    raise exception 'Pending ad-hoc issue not found';
  end if;

  select l.location_id into v_origin_location_id
  from core.locations l
  join core.warehouses w using (warehouse_id)
  where l.location_type = 'WAREHOUSE'
    and l.is_active
    and w.sap_plant_code = '2401'
    and w.storage_location = '0001'
  order by l.location_id
  limit 1;

  perform core.reserve_fifo(
    v_issue.material_id,
    v_origin_location_id,
    v_issue.requested_qty,
    null,
    v_issue.ad_hoc_issue_id
  );

  update ops.ad_hoc_issues
  set status = 'approved',
      approved_by = auth.uid(),
      approved_at = now(),
      approval_note = left(p_note, 1000),
      updated_at = now()
  where ad_hoc_issue_id = v_issue.ad_hoc_issue_id
  returning * into v_issue;
  return v_issue;
end;
$$;

create or replace function core.issue_ad_hoc_issue(
  p_ad_hoc_issue_id uuid
)
returns ops.ad_hoc_issues
language plpgsql
security definer
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_role public.app_role;
  v_issue ops.ad_hoc_issues%rowtype;
  v_allocation record;
  v_destination_id text;
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'picker') then
    raise exception 'Only picker or admin may issue ad-hoc requests';
  end if;

  select * into v_issue
  from ops.ad_hoc_issues
  where ad_hoc_issue_id = p_ad_hoc_issue_id
  for update;
  if not found or v_issue.status <> 'approved' then
    raise exception 'Approved ad-hoc issue not found';
  end if;

  select location_id into v_destination_id
  from core.locations
  where district_id = v_issue.district_id
    and location_type = 'DISTRICT'
    and is_active
  order by location_id
  limit 1;
  if v_destination_id is null then
    raise exception 'District destination is missing';
  end if;

  for v_allocation in
    select a.*, hu.receipt_lot_id, hu.location_id
    from ops.fifo_allocations a
    join core.handling_units hu using (handling_unit_id)
    where a.ad_hoc_issue_id = v_issue.ad_hoc_issue_id
      and a.status = 'reserved'
    order by a.allocation_sequence
    for update of a, hu
  loop
    update core.handling_units
    set available_qty = available_qty - v_allocation.allocated_qty,
        reserved_qty = reserved_qty - v_allocation.allocated_qty,
        opening_status = case
          when available_qty - v_allocation.allocated_qty = 0 then 'DEPLETED'
          else 'OPEN'
        end,
        opened_at = case
          when available_qty - v_allocation.allocated_qty > 0
            then coalesce(opened_at, now())
          else opened_at
        end,
        updated_at = now()
    where handling_unit_id = v_allocation.handling_unit_id;

    update core.receipt_lots
    set remaining_qty = remaining_qty - v_allocation.allocated_qty,
        updated_at = now()
    where receipt_lot_id = v_allocation.receipt_lot_id;

    update ops.fifo_allocations
    set status = 'issued',
        issued_by = auth.uid(),
        issued_at = now()
    where fifo_allocation_id = v_allocation.fifo_allocation_id;

    insert into core.inventory_movements (
      movement_type,
      material_id,
      handling_unit_id,
      from_location_id,
      to_location_id,
      quantity,
      ad_hoc_issue_id,
      idempotency_key,
      reason,
      performed_by
    )
    values (
      'ISSUE',
      v_issue.material_id,
      v_allocation.handling_unit_id,
      v_allocation.location_id,
      v_destination_id,
      v_allocation.allocated_qty,
      v_issue.ad_hoc_issue_id,
      'issue:' || v_allocation.fifo_allocation_id::text,
      v_issue.reason,
      auth.uid()
    );
  end loop;

  if not found then
    raise exception 'Ad-hoc issue has no reserved FIFO allocations';
  end if;

  update ops.ad_hoc_issues
  set status = 'issued',
      issued_by = auth.uid(),
      issued_at = now(),
      updated_at = now()
  where ad_hoc_issue_id = v_issue.ad_hoc_issue_id
  returning * into v_issue;
  return v_issue;
end;
$$;

create or replace function core.record_inventory_return(
  p_source_issue_movement_id uuid,
  p_quantity numeric,
  p_damaged boolean,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, public
as $$
declare
  v_role public.app_role;
  v_source core.inventory_movements%rowtype;
  v_hu core.handling_units%rowtype;
  v_return_id uuid := gen_random_uuid();
begin
  select role into v_role
  from public.user_profiles
  where user_id = auth.uid()
    and is_active;
  if v_role not in ('admin', 'picker') then
    raise exception 'Only picker or admin may record returns';
  end if;
  if p_quantity is null or p_quantity <= 0
     or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'Positive return quantity and reason are required';
  end if;

  select * into v_source
  from core.inventory_movements
  where inventory_movement_id = p_source_issue_movement_id
    and movement_type = 'ISSUE';
  if not found then
    raise exception 'Original issue movement not found';
  end if;
  if p_quantity > v_source.quantity then
    raise exception 'Return quantity exceeds original issue quantity';
  end if;
  if p_quantity + coalesce(
    (
      select sum(quantity)
      from core.inventory_movements
      where source_movement_id = v_source.inventory_movement_id
        and movement_type = 'RETURN'
    ),
    0
  ) > v_source.quantity then
    raise exception 'Cumulative return quantity exceeds original issue quantity';
  end if;

  select * into v_hu
  from core.handling_units
  where handling_unit_id = v_source.handling_unit_id
  for update;

  update core.handling_units
  set available_qty = available_qty + p_quantity,
      opening_status = case when p_damaged then 'QUARANTINED' else 'OPEN' end,
      opened_at = coalesce(opened_at, now()),
      updated_at = now()
  where handling_unit_id = v_hu.handling_unit_id;

  update core.receipt_lots
  set remaining_qty = remaining_qty + p_quantity,
      traceability_status = case
        when p_damaged then 'quarantined'
        else traceability_status
      end,
      updated_at = now()
  where receipt_lot_id = v_hu.receipt_lot_id;

  insert into core.inventory_movements (
    inventory_movement_id,
    movement_type,
    material_id,
    handling_unit_id,
    from_location_id,
    to_location_id,
    quantity,
    replenishment_item_id,
    ad_hoc_issue_id,
    source_movement_id,
    idempotency_key,
    reason,
    performed_by,
    metadata
  )
  values (
    v_return_id,
    'RETURN',
    v_source.material_id,
    v_source.handling_unit_id,
    v_source.to_location_id,
    v_source.from_location_id,
    p_quantity,
    v_source.replenishment_item_id,
    v_source.ad_hoc_issue_id,
    v_source.inventory_movement_id,
    'return:' || v_return_id::text,
    left(p_reason, 1000),
    auth.uid(),
    jsonb_build_object('damaged', p_damaged)
  );

  if p_damaged then
    insert into core.inventory_movements (
      movement_type,
      material_id,
      handling_unit_id,
      from_location_id,
      quantity,
      replenishment_item_id,
      ad_hoc_issue_id,
      source_movement_id,
      idempotency_key,
      reason,
      performed_by
    )
    values (
      'QUARANTINE',
      v_source.material_id,
      v_source.handling_unit_id,
      v_source.from_location_id,
      p_quantity,
      v_source.replenishment_item_id,
      v_source.ad_hoc_issue_id,
      v_return_id,
      'quarantine:' || v_return_id::text,
      left(p_reason, 1000),
      auth.uid()
    );
  end if;
  return v_return_id;
end;
$$;

create or replace function public.m09_dispatch(
  p_method text,
  p_path text,
  p_query jsonb default '{}'::jsonb,
  p_body jsonb default '{}'::jsonb,
  p_request_id text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core, analytics, ops
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_district_id text;
  v_method text := upper(coalesce(p_method, ''));
  v_payload jsonb;
  v_path_id uuid;
  v_count integer;
  v_limit integer;
  v_search text;
  v_bigint bigint;
  v_item_district text;
  v_intercept boolean := (
    p_path = '/v1/replenishment/queue'
    or p_path like '/v1/replenishment/recommendations%'
    or p_path like '/v1/replenishment/change-requests%'
    or p_path like '/v1/replenishment/approvals%'
    or p_path ~ '^/v1/replenishment/items/[0-9a-fA-F-]{36}/(respond|confirm)$'
    or p_path ~ '^/v1/replenishment/plans/[0-9a-fA-F-]{36}/(approve|cancel|version|issue)$'
    or p_path like '/v1/inventory/%'
    or p_path like '/v1/ad-hoc/%'
    or p_path = '/v1/traceability'
    or p_path like '/v1/forecasts%'
    or p_path like '/v1/routes%'
    or p_path like '/v1/jobs%'
    or p_path like '/v1/wave3%'
    or p_path like '/v1/rag%'
  );
begin
  if v_user_id is null then
    return public.m09_error(
      401,
      'unauthorized',
      'Missing or invalid bearer token',
      p_request_id
    );
  end if;

  select role::text, district_id
  into v_role, v_district_id
  from public.user_profiles
  where user_id = v_user_id
    and is_active;
  if v_role is null then
    return public.m09_error(
      403,
      'forbidden',
      'No active application role is assigned',
      p_request_id
    );
  end if;

  if not v_intercept then
    return public.m09_dispatch_impl(
      p_method,
      p_path,
      p_query,
      p_body,
      p_request_id
    );
  end if;

  insert into ops.api_rate_limit_windows (
    user_id,
    window_start,
    request_count
  )
  values (
    v_user_id,
    date_trunc('minute', clock_timestamp()),
    1
  )
  on conflict (user_id, window_start) do update
  set request_count = ops.api_rate_limit_windows.request_count + 1,
      updated_at = now()
  returning request_count into v_count;
  if v_count > 120 then
    return public.m09_error(
      429,
      'rate_limited',
      'Too many requests',
      p_request_id
    );
  end if;

  if p_path like '/v1/forecasts%'
     or p_path like '/v1/routes%'
     or p_path like '/v1/jobs%'
     or p_path like '/v1/wave3%'
     or p_path like '/v1/rag%' then
    return public.m09_error(
      410,
      'scope_excluded',
      'Forecasting, routing and RAG are excluded from this production release',
      p_request_id
    );
  end if;

  if v_method = 'GET' and p_path = '/v1/replenishment/queue' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select *
      from analytics.v_replenishment_queue
      where v_role <> 'district' or district_id = v_district_id
      order by
        week_start_date desc,
        priority_score desc,
        district_id,
        material_id
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET'
     and p_path = '/v1/replenishment/recommendations' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select *
      from analytics.v_quantity_recommendations
      where v_role <> 'district' or district_id = v_district_id
      order by created_at desc, district_id, material_id
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET'
     and p_path = '/v1/replenishment/change-requests' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select *
      from analytics.v_abnormal_request_queue
      where (v_role <> 'district' or district_id = v_district_id)
        and (
          nullif(p_query ->> 'status', '') is null
          or status = p_query ->> 'status'
        )
      order by
        case risk_level when 'high' then 0 when 'medium' then 1 else 2 end,
        requested_at desc
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET'
     and p_path = '/v1/replenishment/approvals' then
    v_path_id := nullif(p_query ->> 'plan_id', '')::uuid;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select
        a.plan_approval_id,
        a.replenishment_plan_id,
        a.replenishment_item_id,
        a.district_id,
        a.approval_stage,
        a.decision,
        a.note,
        a.actor_id,
        a.actor_role,
        a.acted_at
      from ops.plan_approvals a
      where (v_path_id is null or a.replenishment_plan_id = v_path_id)
        and (v_role <> 'district' or a.district_id = v_district_id)
      order by a.acted_at desc, a.plan_approval_id
      limit 500
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/replenishment/items/[0-9a-fA-F-]{36}/(respond|confirm)$' then
    if v_role not in ('admin', 'planner', 'district') then
      return public.m09_error(
        403,
        'forbidden',
        'Insufficient application role',
        p_request_id
      );
    end if;
    if not (p_body ? 'confirmed_qty')
       or btrim(coalesce(p_body ->> 'reason', '')) = '' then
      return public.m09_error(
        422,
        'validation_error',
        'confirmed_qty and reason are required',
        p_request_id
      );
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/replenishment/items/([0-9a-fA-F-]{36})/(?:respond|confirm)$'
    )::uuid;
    if v_role = 'district' then
      select district_id
      into v_item_district
      from core.replenishment_items
      where replenishment_item_id = v_path_id;
      if v_item_district is not null
         and v_item_district <> v_district_id then
        return public.m09_error(
          403,
          'forbidden',
          'District may only respond to its own replenishment items',
          p_request_id
        );
      end if;
    end if;
    select to_jsonb(
      core.respond_replenishment_item(
        v_path_id,
        coalesce(
          nullif(p_body ->> 'decision', ''),
          case when (p_body ->> 'confirmed_qty')::numeric = 0
            then 'reject'
            else 'confirm'
          end
        ),
        (p_body ->> 'confirmed_qty')::numeric,
        left(p_body ->> 'reason', 1000),
        left(coalesce(p_body ->> 'requester_name', ''), 200)
      )
    )
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/replenishment/change-requests/[0-9a-fA-F-]{36}/review$' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(
        403,
        'forbidden',
        'Only planner or admin may review district changes',
        p_request_id
      );
    end if;
    if p_body ->> 'decision' not in ('approved', 'rejected')
       or btrim(coalesce(p_body ->> 'review_note', '')) = '' then
      return public.m09_error(
        422,
        'validation_error',
        'decision and review_note are required',
        p_request_id
      );
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/replenishment/change-requests/([0-9a-fA-F-]{36})/review$'
    )::uuid;
    select to_jsonb(
      core.review_district_change_request(
        v_path_id,
        p_body ->> 'decision',
        left(p_body ->> 'review_note', 1000)
      )
    )
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/replenishment/plans/[0-9a-fA-F-]{36}/approve$' then
    if v_role not in ('admin', 'planner', 'academic') then
      return public.m09_error(
        403,
        'forbidden',
        'Insufficient approval role',
        p_request_id
      );
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/replenishment/plans/([0-9a-fA-F-]{36})/approve$'
    )::uuid;
    perform set_config(
      'synapse.approval_note',
      left(coalesce(p_body ->> 'note', ''), 1000),
      true
    );
    select to_jsonb(core.approve_replenishment_plan(v_path_id))
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/replenishment/plans/[0-9a-fA-F-]{36}/cancel$' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    if btrim(coalesce(p_body ->> 'reason', '')) = '' then
      return public.m09_error(422, 'validation_error', 'reason is required', p_request_id);
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/replenishment/plans/([0-9a-fA-F-]{36})/cancel$'
    )::uuid;
    select to_jsonb(
      core.cancel_replenishment_plan(
        v_path_id,
        left(p_body ->> 'reason', 1000)
      )
    )
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/replenishment/plans/[0-9a-fA-F-]{36}/version$' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    if btrim(coalesce(p_body ->> 'reason', '')) = '' then
      return public.m09_error(422, 'validation_error', 'reason is required', p_request_id);
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/replenishment/plans/([0-9a-fA-F-]{36})/version$'
    )::uuid;
    v_path_id := core.version_replenishment_plan(
      v_path_id,
      left(p_body ->> 'reason', 1000)
    );
    return public.m09_result(
      201,
      jsonb_build_object('replenishment_plan_id', v_path_id)
    );
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/replenishment/plans/[0-9a-fA-F-]{36}/issue$' then
    if v_role not in ('admin', 'picker') then
      return public.m09_error(403, 'forbidden', 'Only picker or admin may issue plans', p_request_id);
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/replenishment/plans/([0-9a-fA-F-]{36})/issue$'
    )::uuid;
    select to_jsonb(core.issue_replenishment_plan(v_path_id))
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/inventory/fifo' then
    if v_role = 'district' then
      return public.m09_error(403, 'forbidden', 'Warehouse FIFO is not a district surface', p_request_id);
    end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select *
      from analytics.v_fifo_queue
      where nullif(p_query ->> 'material_id', '') is null
         or material_id = p_query ->> 'material_id'
      order by material_id, location_id, fifo_sequence
      limit 1000
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET'
     and p_path = '/v1/inventory/handling-units' then
    if v_role = 'district' then
      return public.m09_error(403, 'forbidden', 'Warehouse handling units are not a district surface', p_request_id);
    end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select
        hu.handling_unit_id,
        hu.handling_unit_code,
        hu.material_id,
        m.material_name,
        hu.location_id,
        hu.unit_type,
        hu.opening_status,
        hu.received_qty,
        hu.available_qty,
        hu.reserved_qty,
        hu.available_qty - hu.reserved_qty as allocatable_qty,
        lot.lot_code,
        lot.acceptance_date,
        lot.installment_no,
        lot.traceability_status,
        lot.source_reference,
        hu.created_at,
        hu.updated_at
      from core.handling_units hu
      join core.receipt_lots lot using (receipt_lot_id)
      join core.materials m on m.material_id = hu.material_id
      order by
        case hu.opening_status
          when 'OPENING_UNKNOWN' then 0
          when 'QUARANTINED' then 1
          when 'OPEN' then 2
          when 'SEALED' then 3
          else 4
        end,
        lot.acceptance_date,
        hu.handling_unit_code
      limit 1000
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET'
     and p_path = '/v1/inventory/receipt-options' then
    if v_role not in ('admin', 'picker') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    v_limit := coalesce(nullif(p_query ->> 'limit', '')::integer, 200);
    if v_limit not between 1 and 500 then
      return public.m09_error(422, 'validation_error', 'Invalid limit', p_request_id);
    end if;
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select
        ci.contract_item_id,
        ci.material_id,
        ci.item_description,
        ci.unit,
        ci.line_item,
        ci.source_row_number,
        c.purchase_order,
        c.contract_number,
        case
          when v.vendor_id is null then 'SUP-UNKNOWN'
          else 'SUP-' || lpad(v.vendor_id::text, 6, '0')
        end as vendor_name
      from core.contract_items ci
      join core.contracts c using (contract_id)
      left join core.vendors v using (vendor_id)
      where ci.is_current
        and ci.material_id is not null
      order by ci.acceptance_date desc nulls last, c.purchase_order, ci.line_item
      limit v_limit
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST'
     and p_path = '/v1/inventory/receipts' then
    if v_role not in ('admin', 'picker') then
      return public.m09_error(403, 'forbidden', 'Only picker or admin may receive stock', p_request_id);
    end if;
    if not (p_body ?& array[
      'contract_item_id',
      'location_id',
      'acceptance_date',
      'quantity',
      'handling_unit_code',
      'unit_type',
      'opening_status',
      'source_reference'
    ]) then
      return public.m09_error(422, 'validation_error', 'Receipt fields are incomplete', p_request_id);
    end if;
    v_bigint := (p_body ->> 'contract_item_id')::bigint;
    select to_jsonb(
      core.receive_handling_unit(
        v_bigint,
        p_body ->> 'location_id',
        (p_body ->> 'acceptance_date')::date,
        (p_body ->> 'quantity')::numeric,
        left(p_body ->> 'handling_unit_code', 200),
        p_body ->> 'unit_type',
        p_body ->> 'opening_status',
        left(coalesce(p_body ->> 'installment_no', ''), 100),
        left(p_body ->> 'source_reference', 1000)
      )
    )
    into v_payload;
    return public.m09_result(201, v_payload);
  end if;

  if v_method = 'POST'
     and p_path = '/v1/inventory/returns' then
    if v_role not in ('admin', 'picker') then
      return public.m09_error(403, 'forbidden', 'Only picker or admin may record returns', p_request_id);
    end if;
    if not (p_body ?& array['source_issue_movement_id', 'quantity', 'reason']) then
      return public.m09_error(422, 'validation_error', 'Return fields are incomplete', p_request_id);
    end if;
    v_path_id := core.record_inventory_return(
      (p_body ->> 'source_issue_movement_id')::uuid,
      (p_body ->> 'quantity')::numeric,
      coalesce((p_body ->> 'damaged')::boolean, false),
      left(p_body ->> 'reason', 1000)
    );
    return public.m09_result(
      201,
      jsonb_build_object('inventory_movement_id', v_path_id)
    );
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/inventory/handling-units/[0-9a-fA-F-]{36}/reconcile$' then
    if v_role not in ('admin', 'picker') then
      return public.m09_error(403, 'forbidden', 'Only picker or admin may reconcile stock', p_request_id);
    end if;
    if p_body ->> 'resolved_status' not in ('OPEN', 'SEALED')
       or btrim(coalesce(p_body ->> 'reason', '')) = '' then
      return public.m09_error(
        422,
        'validation_error',
        'resolved_status and reason are required',
        p_request_id
      );
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/inventory/handling-units/([0-9a-fA-F-]{36})/reconcile$'
    )::uuid;
    select to_jsonb(
      core.reconcile_opening_handling_unit(
        v_path_id,
        p_body ->> 'resolved_status',
        left(p_body ->> 'reason', 1000)
      )
    )
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/ad-hoc/issues' then
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select
        ah.*,
        m.material_name,
        d.district_name_th,
        coalesce(
          (
            select sum(a.allocated_qty)
            from ops.fifo_allocations a
            where a.ad_hoc_issue_id = ah.ad_hoc_issue_id
              and a.status in ('reserved', 'issued')
          ),
          0
        ) as allocated_qty
      from ops.ad_hoc_issues ah
      join core.materials m using (material_id)
      join core.districts d using (district_id)
      where v_role <> 'district' or ah.district_id = v_district_id
      order by ah.requested_at desc
      limit 500
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path = '/v1/ad-hoc/issues' then
    if v_role not in ('admin', 'planner', 'district') then
      return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
    end if;
    if not (p_body ?& array[
      'material_id',
      'district_id',
      'requested_qty',
      'reason',
      'requester_name'
    ]) then
      return public.m09_error(422, 'validation_error', 'Ad-hoc issue fields are incomplete', p_request_id);
    end if;
    if v_role = 'district'
       and p_body ->> 'district_id' <> v_district_id then
      return public.m09_error(
        403,
        'forbidden',
        'District may only request for its own district',
        p_request_id
      );
    end if;
    v_path_id := core.create_ad_hoc_issue(
      p_body ->> 'material_id',
      p_body ->> 'district_id',
      (p_body ->> 'requested_qty')::numeric,
      left(p_body ->> 'reason', 1000),
      left(p_body ->> 'requester_name', 200),
      left(coalesce(p_body ->> 'idempotency_key', ''), 200)
    );
    return public.m09_result(
      201,
      jsonb_build_object('ad_hoc_issue_id', v_path_id)
    );
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/ad-hoc/issues/[0-9a-fA-F-]{36}/approve$' then
    if v_role not in ('admin', 'planner') then
      return public.m09_error(403, 'forbidden', 'Only planner or admin may approve', p_request_id);
    end if;
    if btrim(coalesce(p_body ->> 'note', '')) = '' then
      return public.m09_error(422, 'validation_error', 'note is required', p_request_id);
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/ad-hoc/issues/([0-9a-fA-F-]{36})/approve$'
    )::uuid;
    select to_jsonb(
      core.approve_ad_hoc_issue(
        v_path_id,
        left(p_body ->> 'note', 1000)
      )
    )
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST'
     and p_path ~ '^/v1/ad-hoc/issues/[0-9a-fA-F-]{36}/issue$' then
    if v_role not in ('admin', 'picker') then
      return public.m09_error(403, 'forbidden', 'Only picker or admin may issue', p_request_id);
    end if;
    v_path_id := substring(
      p_path
      from '^/v1/ad-hoc/issues/([0-9a-fA-F-]{36})/issue$'
    )::uuid;
    select to_jsonb(core.issue_ad_hoc_issue(v_path_id))
    into v_payload;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/traceability' then
    v_search := nullif(left(btrim(p_query ->> 'search'), 100), '');
    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
    into v_payload
    from (
      select *
      from analytics.v_issue_traceback
      where (v_role <> 'district' or district_id = v_district_id)
        and (
          v_search is null
          or material_id ilike '%' || v_search || '%'
          or coalesce(material_name, '') ilike '%' || v_search || '%'
          or issue_reference ilike '%' || v_search || '%'
          or handling_unit_code ilike '%' || v_search || '%'
          or coalesce(contract_number, '') ilike '%' || v_search || '%'
          or purchase_order::text ilike '%' || v_search || '%'
          or coalesce(vendor_name, '') ilike '%' || v_search || '%'
        )
      order by occurred_at desc
      limit 1000
    ) q;
    return public.m09_result(200, v_payload);
  end if;

  return public.m09_error(
    404,
    'not_found',
    'API path not found',
    p_request_id
  );
exception
  when invalid_text_representation
    or datetime_field_overflow
    or numeric_value_out_of_range
    or check_violation
    or not_null_violation then
    return public.m09_error(
      422,
      'validation_error',
      left(sqlerrm, 500),
      p_request_id
    );
  when unique_violation then
    return public.m09_error(
      409,
      'conflict',
      left(sqlerrm, 500),
      p_request_id
    );
  when raise_exception then
    return public.m09_error(
      409,
      'workflow_conflict',
      left(sqlerrm, 500),
      p_request_id
    );
  when others then
    return public.m09_error(
      400,
      'bad_request',
      left(sqlerrm, 500),
      p_request_id
    );
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'receipt_lots',
    'packaging_profiles',
    'handling_units'
  ]
  loop
    execute format('drop trigger if exists set_%I_updated_at on core.%I', v_table, v_table);
    execute format(
      'create trigger set_%I_updated_at before update on core.%I for each row execute function audit.set_updated_at()',
      v_table,
      v_table
    );
  end loop;

  foreach v_table in array array[
    'district_change_requests',
    'ad_hoc_issues'
  ]
  loop
    execute format('drop trigger if exists set_%I_updated_at on ops.%I', v_table, v_table);
    execute format(
      'create trigger set_%I_updated_at before update on ops.%I for each row execute function audit.set_updated_at()',
      v_table,
      v_table
    );
  end loop;
end
$$;

do $$
declare
  v_qualified text;
begin
  foreach v_qualified in array array[
    'core.vendor_aliases',
    'core.receipt_lots',
    'core.packaging_profiles',
    'core.handling_units',
    'core.inventory_movements',
    'ops.quantity_recommendations',
    'ops.district_change_requests',
    'ops.plan_approvals',
    'ops.ad_hoc_issues',
    'ops.fifo_allocations'
  ]
  loop
    execute format('alter table %s enable row level security', v_qualified);
    execute format(
      'revoke all on %s from public, anon, authenticated',
      v_qualified
    );
    execute format('grant all on %s to service_role', v_qualified);
  end loop;
end
$$;

grant select on
  analytics.v_fifo_queue,
  analytics.v_quantity_recommendations,
  analytics.v_abnormal_request_queue,
  analytics.v_issue_traceback
to service_role;

revoke all on function
  core.reserve_fifo(text, text, numeric, uuid, uuid),
  core.respond_replenishment_item(uuid, text, numeric, text, text),
  core.review_district_change_request(uuid, text, text),
  core.cancel_replenishment_plan(uuid, text),
  core.version_replenishment_plan(uuid, text),
  core.receive_handling_unit(bigint, text, date, numeric, text, text, text, text, text),
  core.reconcile_opening_handling_unit(uuid, text, text),
  core.issue_replenishment_plan(uuid),
  core.create_ad_hoc_issue(text, text, numeric, text, text, text),
  core.approve_ad_hoc_issue(uuid, text),
  core.issue_ad_hoc_issue(uuid),
  core.record_inventory_return(uuid, numeric, boolean, text)
from public, anon, authenticated;

grant execute on function
  core.reserve_fifo(text, text, numeric, uuid, uuid),
  core.respond_replenishment_item(uuid, text, numeric, text, text),
  core.review_district_change_request(uuid, text, text),
  core.cancel_replenishment_plan(uuid, text),
  core.version_replenishment_plan(uuid, text),
  core.receive_handling_unit(bigint, text, date, numeric, text, text, text, text, text),
  core.reconcile_opening_handling_unit(uuid, text, text),
  core.issue_replenishment_plan(uuid),
  core.create_ad_hoc_issue(text, text, numeric, text, text, text),
  core.approve_ad_hoc_issue(uuid, text),
  core.issue_ad_hoc_issue(uuid),
  core.record_inventory_return(uuid, numeric, boolean, text)
to service_role;

grant usage on type public.app_role to authenticated, service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607230014',
  'M06/M09/M10/M12',
  'Production weekly replenishment, District-Planner-Academic lock, FIFO handling units, ad-hoc issue, append-only movement and traceback; forecasting, routing and RAG excluded.',
  'supabase/migrations/202607230014_production_operations_v1.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
