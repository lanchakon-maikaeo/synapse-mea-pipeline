-- SYNAPSE Wave 2 / M06: Stock health, replenishment calculation and approval.
-- The calculation policy reproduces ALGORITHM.md: CMP/month, 3.5-month trigger,
-- 4M/6M targets and tiered rounding. It intentionally creates no fabricated stock.

begin;

create table if not exists core.usage_rates (
  usage_rate_id uuid primary key default gen_random_uuid(),
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  as_of_date date not null,
  cmp_monthly numeric not null check (cmp_monthly >= 0),
  avg_ly numeric check (avg_ly is null or avg_ly >= 0),
  avg_12m numeric check (avg_12m is null or avg_12m >= 0),
  avg_6m numeric check (avg_6m is null or avg_6m >= 0),
  avg_4m numeric check (avg_4m is null or avg_4m >= 0),
  source_batch_id uuid references raw.import_batches (batch_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (material_id, district_id, as_of_date)
);

create index if not exists usage_rates_lookup_idx
  on core.usage_rates (material_id, district_id, as_of_date desc);

create table if not exists ops.calculation_policies (
  policy_version text primary key,
  policy_name text not null,
  is_active boolean not null default false,
  parameters jsonb not null,
  source_reference text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calculation_policies_parameters_object check (jsonb_typeof(parameters) = 'object')
);

create unique index if not exists calculation_policies_one_active_idx
  on ops.calculation_policies ((is_active)) where is_active;

insert into ops.calculation_policies (policy_version, policy_name, is_active, parameters, source_reference)
values (
  'v1.0.0',
  'CMP 3.5 month replenishment policy',
  true,
  '{
    "months_trigger": 3.5,
    "min_target_source": "avg_4m",
    "max_target_source": "avg_6m",
    "priority_weights": {"stock": 0.5, "days": 0.3, "trend": 0.2},
    "trend_default_score": 5,
    "rounding_tiers": [
      {"lt": 70, "multiple": 1},
      {"lt": 100, "multiple": 50},
      {"lt": 1000, "multiple": 100},
      {"lt": 10000, "multiple": 500},
      {"gte": 10000, "multiple": 1000}
    ]
  }'::jsonb,
  'synapse/ALGORITHM.md sections 1-5, baseline dated 2026-07-14'
)
on conflict (policy_version) do update
set policy_name = excluded.policy_name,
    parameters = excluded.parameters,
    source_reference = excluded.source_reference,
    updated_at = now();

create table if not exists ops.replenishment_runs (
  replenishment_run_id uuid primary key default gen_random_uuid(),
  policy_version text not null references ops.calculation_policies (policy_version),
  snapshot_cutoff_at timestamptz,
  usage_cutoff_date date,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  error_message text,
  initiated_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists core.replenishment_plans (
  replenishment_plan_id uuid primary key default gen_random_uuid(),
  replenishment_run_id uuid not null unique references ops.replenishment_runs (replenishment_run_id) on delete restrict,
  origin_location_id text not null references core.locations (location_id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft', 'pending_district_confirmation', 'approved', 'cancelled', 'completed')),
  created_by uuid references auth.users (id) on delete set null,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.replenishment_items (
  replenishment_item_id uuid primary key default gen_random_uuid(),
  replenishment_plan_id uuid not null references core.replenishment_plans (replenishment_plan_id) on delete restrict,
  material_id text not null references core.materials (material_id) on delete restrict,
  district_id text not null references core.districts (district_id) on delete restrict,
  source_stock_snapshot_id uuid references core.stock_snapshots (snapshot_id) on delete restrict,
  source_usage_rate_id uuid references core.usage_rates (usage_rate_id) on delete restrict,
  current_stock_qty numeric not null check (current_stock_qty >= 0),
  cmp_monthly numeric not null check (cmp_monthly > 0),
  months_available numeric not null check (months_available >= 0),
  min_fill_qty numeric not null check (min_fill_qty >= 0),
  max_fill_qty numeric not null check (max_fill_qty >= 0),
  suggested_qty numeric not null check (suggested_qty >= 0),
  confirmed_qty numeric check (confirmed_qty is null or confirmed_qty >= 0),
  priority_score numeric not null check (priority_score between 1 and 10),
  priority_band text not null check (priority_band in ('critical', 'high', 'normal')),
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'confirmed', 'rejected', 'approved', 'shipped', 'cancelled')),
  district_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (replenishment_plan_id, material_id, district_id)
);

create index if not exists replenishment_items_queue_idx
  on core.replenishment_items (status, priority_score desc, district_id);

create table if not exists ops.replenishment_adjustments (
  adjustment_id uuid primary key default gen_random_uuid(),
  replenishment_item_id uuid not null references core.replenishment_items (replenishment_item_id) on delete restrict,
  previous_qty numeric,
  new_qty numeric,
  adjustment_reason text not null check (btrim(adjustment_reason) <> ''),
  adjusted_by uuid references auth.users (id) on delete set null,
  adjusted_at timestamptz not null default now()
);

create or replace function core.round_replenishment(input_quantity numeric)
returns numeric
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when input_quantity is null or input_quantity <= 0 then 0
    when input_quantity < 70 then round(input_quantity)
    when input_quantity < 100 then round(input_quantity / 50) * 50
    when input_quantity < 1000 then round(input_quantity / 100) * 100
    when input_quantity < 10000 then round(input_quantity / 500) * 500
    else round(input_quantity / 1000) * 1000
  end
$$;

create or replace view analytics.v_stock_health
with (security_invoker = true)
as
with latest_snapshot as (
  select distinct on (s.material_id, l.district_id)
    s.snapshot_id, s.material_id, l.district_id, s.quantity_on_hand, s.snapshot_at
  from core.stock_snapshots s
  join core.locations l using (location_id)
  where l.location_type = 'DISTRICT'
  order by s.material_id, l.district_id, s.snapshot_at desc
), latest_usage as (
  select distinct on (u.material_id, u.district_id)
    u.usage_rate_id, u.material_id, u.district_id, u.as_of_date,
    u.cmp_monthly, u.avg_4m, u.avg_6m
  from core.usage_rates u
  order by u.material_id, u.district_id, u.as_of_date desc
)
select
  s.snapshot_id,
  u.usage_rate_id,
  s.material_id,
  m.material_name,
  s.district_id,
  d.district_name_th,
  s.quantity_on_hand as current_stock_qty,
  s.snapshot_at,
  u.as_of_date as usage_as_of_date,
  u.cmp_monthly,
  u.avg_4m,
  u.avg_6m,
  case when u.cmp_monthly > 0 then round(s.quantity_on_hand / u.cmp_monthly, 1) end as months_available,
  case
    when u.cmp_monthly is null or u.cmp_monthly = 0 then 'unknown'
    when s.quantity_on_hand / u.cmp_monthly < 1.5 then 'critical'
    when s.quantity_on_hand / u.cmp_monthly < 3.0 then 'watch'
    else 'healthy'
  end as health_band
from latest_snapshot s
join latest_usage u using (material_id, district_id)
join core.materials m using (material_id)
join core.districts d using (district_id);

create or replace function core.create_replenishment_run(p_snapshot_cutoff_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, ops, analytics
as $$
declare
  v_policy ops.calculation_policies%rowtype;
  v_run_id uuid;
  v_plan_id uuid;
  v_origin_location_id text;
begin
  select * into v_policy from ops.calculation_policies where is_active;
  if not found then
    raise exception 'No active replenishment calculation policy';
  end if;

  select location_id into v_origin_location_id
  from core.locations where location_type = 'WAREHOUSE' and is_active
  order by location_id limit 1;
  if v_origin_location_id is null then
    raise exception 'No active warehouse location';
  end if;

  insert into ops.replenishment_runs (policy_version, snapshot_cutoff_at, initiated_by)
  values (v_policy.policy_version, p_snapshot_cutoff_at, auth.uid())
  returning replenishment_run_id into v_run_id;

  insert into core.replenishment_plans (replenishment_run_id, origin_location_id, created_by)
  values (v_run_id, v_origin_location_id, auth.uid())
  returning replenishment_plan_id into v_plan_id;

  insert into core.replenishment_items (
    replenishment_plan_id, material_id, district_id, source_stock_snapshot_id, source_usage_rate_id,
    current_stock_qty, cmp_monthly, months_available, min_fill_qty, max_fill_qty,
    suggested_qty, priority_score, priority_band, status
  )
  select
    v_plan_id, h.material_id, h.district_id, h.snapshot_id, h.usage_rate_id,
    h.current_stock_qty, h.cmp_monthly, h.months_available,
    core.round_replenishment(h.avg_4m - h.current_stock_qty),
    core.round_replenishment(h.avg_6m - h.current_stock_qty),
    core.round_replenishment(h.avg_6m - h.current_stock_qty),
    round(greatest(1::numeric, least(10::numeric,
      ((1 - least(h.current_stock_qty / nullif(h.avg_6m, 0), 1)) * 10) * 0.5
      + greatest(0::numeric, least(10::numeric, (30 - h.months_available * 30) / 3)) * 0.3
      + 5 * 0.2
    )), 1),
    case when h.months_available < 1.5 then 'critical'
         when h.months_available < 3 then 'high' else 'normal' end,
    'pending'
  from analytics.v_stock_health h
  where h.cmp_monthly > 0
    and h.months_available <= (v_policy.parameters ->> 'months_trigger')::numeric
    and core.round_replenishment(h.avg_6m - h.current_stock_qty) > 0;

  update core.replenishment_plans
  set status = case when exists (select 1 from core.replenishment_items where replenishment_plan_id = v_plan_id)
                    then 'pending_district_confirmation' else 'draft' end,
      updated_at = now()
  where replenishment_plan_id = v_plan_id;

  update ops.replenishment_runs
  set status = 'succeeded',
      candidate_count = (select count(*) from core.replenishment_items where replenishment_plan_id = v_plan_id),
      usage_cutoff_date = (select max(usage_as_of_date) from analytics.v_stock_health),
      finished_at = now()
  where replenishment_run_id = v_run_id;

  return v_run_id;
exception when others then
  update ops.replenishment_runs
  set status = 'failed', error_message = sqlerrm, finished_at = now()
  where replenishment_run_id = v_run_id;
  raise;
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
set search_path = pg_catalog, core, public, ops
as $$
declare
  v_item core.replenishment_items%rowtype;
  v_role public.app_role;
  v_district_id text;
begin
  select * into v_item from core.replenishment_items where replenishment_item_id = p_replenishment_item_id for update;
  if not found then raise exception 'Replenishment item not found'; end if;
  if p_confirmed_qty is null or p_confirmed_qty < 0 then raise exception 'Confirmed quantity must be non-negative'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'Adjustment reason is required'; end if;

  select role, district_id into v_role, v_district_id from public.user_profiles where user_id = auth.uid();
  if v_role not in ('admin', 'planner', 'district') then raise exception 'Not authorized to confirm replenishment'; end if;
  if v_role = 'district' and v_district_id <> v_item.district_id then raise exception 'District may only confirm its own items'; end if;
  if v_item.status not in ('draft', 'pending') then raise exception 'Item is not awaiting confirmation'; end if;
  if p_confirmed_qty > v_item.max_fill_qty then raise exception 'Confirmed quantity exceeds anti-hoarding maximum'; end if;

  insert into ops.replenishment_adjustments (replenishment_item_id, previous_qty, new_qty, adjustment_reason, adjusted_by)
  values (v_item.replenishment_item_id, v_item.confirmed_qty, p_confirmed_qty, p_reason, auth.uid());

  update core.replenishment_items
  set confirmed_qty = p_confirmed_qty,
      district_note = p_reason,
      status = case when p_confirmed_qty = 0 then 'rejected' else 'confirmed' end,
      updated_at = now()
  where replenishment_item_id = v_item.replenishment_item_id
  returning * into v_item;
  return v_item;
end;
$$;

create or replace function core.approve_replenishment_plan(p_replenishment_plan_id uuid)
returns core.replenishment_plans
language plpgsql
security definer
set search_path = pg_catalog, core, public
as $$
declare
  v_plan core.replenishment_plans%rowtype;
  v_role public.app_role;
begin
  select role into v_role from public.user_profiles where user_id = auth.uid();
  if v_role not in ('admin', 'planner') then raise exception 'Only planner or admin may approve plans'; end if;
  select * into v_plan from core.replenishment_plans where replenishment_plan_id = p_replenishment_plan_id for update;
  if not found then raise exception 'Replenishment plan not found'; end if;
  if exists (select 1 from core.replenishment_items where replenishment_plan_id = v_plan.replenishment_plan_id and status = 'pending') then
    raise exception 'All items must be confirmed or rejected before approval';
  end if;
  update core.replenishment_items set status = 'approved', updated_at = now()
  where replenishment_plan_id = v_plan.replenishment_plan_id and status = 'confirmed';
  update core.replenishment_plans set status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where replenishment_plan_id = v_plan.replenishment_plan_id returning * into v_plan;
  return v_plan;
end;
$$;

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
  p.created_at
from core.replenishment_plans p
join core.replenishment_items i using (replenishment_plan_id)
join core.materials m using (material_id)
join core.districts d using (district_id);

do $$
declare table_name text;
begin
  foreach table_name in array array['usage_rates', 'replenishment_plans', 'replenishment_items'] loop
    execute format('drop trigger if exists set_%I_updated_at on core.%I', table_name, table_name);
    execute format('create trigger set_%I_updated_at before update on core.%I for each row execute function audit.set_updated_at()', table_name, table_name);
  end loop;
  foreach table_name in array array['calculation_policies'] loop
    execute format('drop trigger if exists set_%I_updated_at on ops.%I', table_name, table_name);
    execute format('create trigger set_%I_updated_at before update on ops.%I for each row execute function audit.set_updated_at()', table_name, table_name);
  end loop;
end;
$$;

alter table core.usage_rates enable row level security;
alter table core.replenishment_plans enable row level security;
alter table core.replenishment_items enable row level security;
alter table ops.calculation_policies enable row level security;
alter table ops.replenishment_runs enable row level security;
alter table ops.replenishment_adjustments enable row level security;

revoke all on core.usage_rates, core.replenishment_plans, core.replenishment_items,
  ops.calculation_policies, ops.replenishment_runs, ops.replenishment_adjustments
  from public, anon, authenticated;
grant all on core.usage_rates, core.replenishment_plans, core.replenishment_items,
  ops.calculation_policies, ops.replenishment_runs, ops.replenishment_adjustments to service_role;
grant select on analytics.v_stock_health, analytics.v_replenishment_queue to service_role;
grant usage, select on all sequences in schema ops to service_role;

revoke all on function core.round_replenishment(numeric), core.create_replenishment_run(timestamptz),
  core.confirm_replenishment_item(uuid, numeric, text), core.approve_replenishment_plan(uuid)
  from public, anon, authenticated;
grant execute on function core.round_replenishment(numeric), core.create_replenishment_run(timestamptz),
  core.confirm_replenishment_item(uuid, numeric, text), core.approve_replenishment_plan(uuid) to service_role;

insert into ops.schema_migrations (version, module, description, source_file)
values ('202607150004', 'M06', 'Versioned stock-health/replenishment policy, queue, approval and adjustment audit.', 'supabase/migrations/202607150004_m06_replenishment.sql')
on conflict (version) do update set description = excluded.description, source_file = excluded.source_file;

commit;
