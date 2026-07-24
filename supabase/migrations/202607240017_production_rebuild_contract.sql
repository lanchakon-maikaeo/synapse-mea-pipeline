-- SYNAPSE M17: greenfield production contract and fail-closed cutover.
-- The Staging reference package is mapped into the canonical schema; its
-- parallel UUID model is intentionally not installed.

begin;

alter table core.packaging_profiles
  add column if not exists source_quality text not null default 'source_derived';
alter table core.packaging_profiles
  drop constraint if exists packaging_profiles_source_quality_check;
alter table core.packaging_profiles
  add constraint packaging_profiles_source_quality_check
  check (source_quality in (
    'verified',
    'source_derived',
    'estimated',
    'test_fixture'
  ));

update core.packaging_profiles
set source_quality = case
  when data_class = 'test_fixture' then 'test_fixture'
  when verified_at is not null then 'verified'
  else 'source_derived'
end;

alter table core.receipt_lots
  add column if not exists source_quality text not null default 'verified';
alter table core.receipt_lots
  drop constraint if exists receipt_lots_source_quality_check;
alter table core.receipt_lots
  add constraint receipt_lots_source_quality_check
  check (source_quality in (
    'verified',
    'source_derived',
    'opening_unknown'
  ));

update core.receipt_lots
set source_quality = case
  when traceability_status = 'opening_unknown' then 'opening_unknown'
  when source_batch_id is not null then 'source_derived'
  else 'verified'
end;

create table if not exists core.contract_item_versions (
  contract_item_version_id bigint generated always as identity primary key,
  contract_item_id bigint not null
    references core.contract_items (contract_item_id) on delete restrict,
  version_no integer not null check (version_no > 0),
  source_quality text not null default 'source_derived'
    check (source_quality in ('verified', 'source_derived')),
  source_batch_id uuid references raw.import_batches (batch_id) on delete restrict,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  captured_at timestamptz not null default now(),
  unique (contract_item_id, version_no)
);

create or replace function core.capture_contract_item_version()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_version integer;
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return new;
  end if;

  select coalesce(max(version_no), 0) + 1
  into v_version
  from core.contract_item_versions
  where contract_item_id = new.contract_item_id;

  insert into core.contract_item_versions (
    contract_item_id,
    version_no,
    source_quality,
    source_batch_id,
    snapshot
  )
  values (
    new.contract_item_id,
    v_version,
    case when new.validation_status = 'valid'
      then 'verified'
      else 'source_derived'
    end,
    new.source_batch_id,
    to_jsonb(new)
  );
  return new;
end;
$$;

insert into core.contract_item_versions (
  contract_item_id,
  version_no,
  source_quality,
  source_batch_id,
  snapshot
)
select
  i.contract_item_id,
  1,
  case when i.validation_status = 'valid'
    then 'verified'
    else 'source_derived'
  end,
  i.source_batch_id,
  to_jsonb(i)
from core.contract_items i
where not exists (
  select 1
  from core.contract_item_versions v
  where v.contract_item_id = i.contract_item_id
);

drop trigger if exists capture_contract_item_version on core.contract_items;
create trigger capture_contract_item_version
  after insert or update on core.contract_items
  for each row execute function core.capture_contract_item_version();

create table if not exists ops.environment_controls (
  singleton boolean primary key default true check (singleton),
  operational_writes_enabled boolean not null default false,
  change_ticket text,
  configured_by text not null default current_user,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into ops.environment_controls (
  singleton,
  operational_writes_enabled,
  change_ticket
)
values (
  true,
  exists (
    select 1
    from ops.environment_registry
    where environment_name <> 'production'
  ),
  'M17_INITIAL_CONTROL'
)
on conflict (singleton) do nothing;

create table if not exists ops.environment_cutovers (
  cutover_id bigint generated always as identity primary key,
  environment_name text not null
    check (environment_name in ('development', 'test', 'production')),
  project_ref text not null,
  event_type text not null
    check (event_type in ('configured', 'enabled', 'disabled')),
  change_ticket text not null check (btrim(change_ticket) <> ''),
  readiness_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(readiness_snapshot) = 'object'),
  executed_by text not null default current_user,
  executed_at timestamptz not null default now()
);

create or replace view analytics.v_production_readiness
with (security_invoker = true)
as
with environment as (
  select environment_name, project_ref, region
  from ops.environment_registry
  order by updated_at desc
  limit 1
), material_scope as (
  select count(*)::bigint as material_count
  from core.materials
  where is_vmi
), district_scope as (
  select count(*)::bigint as district_count
  from core.districts
  where is_active
), expected_scope as (
  select
    m.material_count,
    d.district_count,
    m.material_count * d.district_count as expected_district_material_rows
  from material_scope m
  cross join district_scope d
), actual_stock as (
  select count(*)::bigint as row_count
  from (
    select distinct s.material_id, l.district_id
    from core.stock_snapshots s
    join core.locations l using (location_id)
    join core.materials m using (material_id)
    where l.location_type = 'DISTRICT'
      and l.is_active
      and m.is_vmi
      and s.data_class = 'actual'
  ) q
), actual_usage as (
  select count(*)::bigint as row_count
  from (
    select distinct u.material_id, u.district_id
    from core.usage_rates u
    join core.materials m using (material_id)
    join core.districts d using (district_id)
    where m.is_vmi
      and d.is_active
      and u.data_class = 'actual'
  ) q
), fixture as (
  select
    (select count(*) from core.stock_snapshots where data_class = 'test_fixture')
    + (select count(*) from core.usage_rates where data_class = 'test_fixture')
    + (select count(*) from core.packaging_profiles where data_class = 'test_fixture')
    as row_count
), master_quality as (
  select
    count(*) filter (
      where m.weight_per_unit_kg is not null
        and m.weight_per_unit_kg > 0
    )::bigint as weighted_material_count,
    count(*) filter (
      where p.source_quality = 'verified'
        and p.data_class = 'actual'
    )::bigint as verified_packaging_count
  from core.materials m
  left join core.packaging_profiles p using (material_id)
  where m.is_vmi
), identities as (
  select
    count(distinct role::text) filter (
      where role::text in ('admin', 'planner', 'academic', 'picker')
    )::bigint as central_role_count,
    count(distinct district_id) filter (
      where role::text = 'district'
    )::bigint as district_user_count
  from public.user_profiles
  where is_active
), recovery as (
  select
    exists (
      select 1 from ops.backup_runs
      where backup_type = 'database' and status = 'succeeded'
    ) as backup_verified,
    exists (
      select 1 from ops.backup_runs
      where backup_type = 'restore_drill' and status = 'succeeded'
    ) as restore_drill_verified
), readiness as (
  select
    e.environment_name,
    e.project_ref,
    e.region,
    c.operational_writes_enabled,
    s.material_count as active_vmi_material_count,
    s.district_count as active_district_count,
    s.expected_district_material_rows,
    ast.row_count as actual_district_stock_rows,
    au.row_count as actual_usage_rows,
    f.row_count as fixture_row_count,
    mq.weighted_material_count,
    mq.verified_packaging_count,
    i.central_role_count,
    i.district_user_count,
    r.backup_verified,
    r.restore_drill_verified,
    (
      s.material_count > 0
      and s.district_count = 18
      and ast.row_count >= s.expected_district_material_rows
      and au.row_count >= s.expected_district_material_rows
      and f.row_count = 0
      and mq.weighted_material_count >= s.material_count
      and mq.verified_packaging_count >= s.material_count
    ) as data_contract_ready,
    (
      i.central_role_count = 4
      and i.district_user_count >= s.district_count
    ) as identity_ready,
    (r.backup_verified and r.restore_drill_verified) as recovery_ready
  from environment e
  cross join ops.environment_controls c
  cross join expected_scope s
  cross join actual_stock ast
  cross join actual_usage au
  cross join fixture f
  cross join master_quality mq
  cross join identities i
  cross join recovery r
)
select
  *,
  (
    environment_name = 'production'
    and operational_writes_enabled
    and data_contract_ready
    and identity_ready
    and recovery_ready
  ) as cutover_ready,
  case
    when environment_name <> 'production' then 'non_production'
    when operational_writes_enabled
      and data_contract_ready
      and identity_ready
      and recovery_ready then 'operational'
    else 'blocked'
  end as readiness_status
from readiness;

create or replace function ops.configure_environment(
  p_environment text,
  p_project_ref text,
  p_region text,
  p_change_ticket text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
begin
  if p_environment not in ('development', 'test', 'production') then
    raise exception 'Unsupported environment';
  end if;
  if p_project_ref !~ '^[a-z0-9]{20}$' then
    raise exception 'Invalid Supabase project ref';
  end if;
  if p_environment = 'production'
     and p_project_ref = 'mklnbumfwojxhqscthjd' then
    raise exception 'The registered Test project cannot be relabeled as Production';
  end if;
  if btrim(coalesce(p_region, '')) = ''
     or btrim(coalesce(p_change_ticket, '')) = '' then
    raise exception 'Region and change ticket are required';
  end if;

  delete from ops.environment_registry;
  insert into ops.environment_registry (
    environment_name,
    project_ref,
    region,
    deployment_profile,
    notes
  )
  values (
    p_environment,
    p_project_ref,
    p_region,
    case when p_environment = 'production'
      then 'managed-supabase-production'
      else 'managed-supabase-non-production'
    end,
    'Configured by the M17 greenfield environment contract.'
  );

  update ops.environment_controls
  set operational_writes_enabled = p_environment <> 'production',
      change_ticket = left(p_change_ticket, 200),
      configured_by = current_user,
      configured_at = now(),
      updated_at = now()
  where singleton;

  insert into ops.environment_cutovers (
    environment_name,
    project_ref,
    event_type,
    change_ticket,
    readiness_snapshot
  )
  values (
    p_environment,
    p_project_ref,
    'configured',
    left(p_change_ticket, 200),
    jsonb_build_object('operational_writes_enabled', p_environment <> 'production')
  );
end;
$$;

create or replace function ops.set_operational_writes_enabled(
  p_enabled boolean,
  p_expected_project_ref text,
  p_change_ticket text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, ops, analytics
as $$
declare
  v_readiness analytics.v_production_readiness%rowtype;
begin
  if btrim(coalesce(p_change_ticket, '')) = '' then
    raise exception 'Change ticket is required';
  end if;

  select * into v_readiness
  from analytics.v_production_readiness;
  if not found or v_readiness.project_ref <> p_expected_project_ref then
    raise exception 'Project ref mismatch';
  end if;
  if p_enabled
     and v_readiness.environment_name = 'production'
     and not (
       v_readiness.data_contract_ready
       and v_readiness.identity_ready
       and v_readiness.recovery_ready
     ) then
    raise exception 'Production readiness gates are not complete';
  end if;

  update ops.environment_controls
  set operational_writes_enabled = p_enabled,
      change_ticket = left(p_change_ticket, 200),
      configured_by = current_user,
      configured_at = now(),
      updated_at = now()
  where singleton;

  insert into ops.environment_cutovers (
    environment_name,
    project_ref,
    event_type,
    change_ticket,
    readiness_snapshot
  )
  values (
    v_readiness.environment_name,
    v_readiness.project_ref,
    case when p_enabled then 'enabled' else 'disabled' end,
    left(p_change_ticket, 200),
    to_jsonb(v_readiness)
  );
end;
$$;

create or replace view analytics.v_operations_health
with (security_invoker = true)
as
select
  (select count(*) from ops.system_alerts where status in ('open','acknowledged')) as open_alert_count,
  (select count(*) from ops.background_jobs where status='failed' and finished_at >= now()-interval '24 hours') as failed_job_count_24h,
  (select count(distinct source_reference) from ops.system_alerts where alert_type='data_stale' and status in ('open','acknowledged')) as stale_source_count,
  (select status from ops.backup_runs order by started_at desc limit 1) as latest_backup_status,
  (select finished_at from ops.backup_runs order by started_at desc limit 1) as latest_backup_at,
  (select max(coalesce(imported_at,created_at)) from raw.import_batches where status='succeeded') as latest_import_at,
  (select max(coalesce(finished_at,created_at)) from ops.background_jobs) as latest_job_at,
  (select count(*) from ops.service_heartbeats) as registered_service_count,
  (select count(*) from ops.service_heartbeats where last_seen_at < now()-interval '10 minutes') as stale_service_count,
  now() as checked_at,
  r.environment_name,
  r.project_ref,
  r.region,
  r.readiness_status,
  r.operational_writes_enabled,
  r.data_contract_ready,
  r.identity_ready,
  r.recovery_ready,
  r.cutover_ready
from analytics.v_production_readiness r;

create or replace function public.m09_health()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, analytics
as $$
  select jsonb_build_object(
    'status', case
      when environment_name = 'production' and not cutover_ready
        then 'not_ready'
      else 'ok'
    end,
    'service', 'synapse-api',
    'version', 'v2',
    'database', 'ready',
    'environment', environment_name,
    'project_ref', project_ref,
    'operational_ready', case
      when environment_name = 'production' then cutover_ready
      else operational_writes_enabled
    end,
    'readiness_status', readiness_status
  )
  from analytics.v_production_readiness
$$;

do $$
begin
  if to_regprocedure(
    'public.m09_dispatch_pre_m17(text,text,jsonb,jsonb,text)'
  ) is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_pre_m17;
  end if;
end
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
set search_path = pg_catalog, public, analytics, ops
as $$
declare
  v_method text := upper(coalesce(p_method, ''));
  v_writes_enabled boolean;
  v_payload jsonb;
begin
  if auth.uid() is null then
    return public.m09_error(
      401,
      'unauthorized',
      'Missing or invalid bearer token',
      p_request_id
    );
  end if;

  if v_method = 'GET' and p_path = '/v1/operations/readiness' then
    if not exists (
      select 1
      from public.user_profiles
      where user_id = auth.uid() and is_active
    ) then
      return public.m09_error(
        403,
        'forbidden',
        'No active application role is assigned',
        p_request_id
      );
    end if;
    select to_jsonb(r) into v_payload
    from analytics.v_production_readiness r;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST'
     and (
       p_path like '/v1/replenishment/%'
       or p_path like '/v1/inventory/%'
       or p_path like '/v1/ad-hoc/%'
     ) then
    select operational_writes_enabled
    into v_writes_enabled
    from ops.environment_controls
    where singleton;
    if not coalesce(v_writes_enabled, false) then
      return public.m09_error(
        423,
        'production_not_ready',
        'Operational writes are locked until Production cutover gates pass',
        p_request_id
      );
    end if;
  end if;

  return public.m09_dispatch_pre_m17(
    p_method,
    p_path,
    p_query,
    p_body,
    p_request_id
  );
end;
$$;

alter table ops.release_versions
  drop constraint if exists release_versions_deployment_profile_check;
alter table ops.release_versions
  add constraint release_versions_deployment_profile_check
  check (deployment_profile in ('test', 'production', 'free-poc', 'self-host'));

alter table core.contract_item_versions enable row level security;
alter table ops.environment_controls enable row level security;
alter table ops.environment_cutovers enable row level security;

revoke all on core.contract_item_versions,
  ops.environment_controls,
  ops.environment_cutovers
  from public, anon, authenticated;
grant all on core.contract_item_versions,
  ops.environment_controls,
  ops.environment_cutovers
  to service_role;

revoke all on function core.capture_contract_item_version()
  from public, anon, authenticated;
revoke all on function ops.configure_environment(text, text, text, text)
  from public, anon, authenticated;
revoke all on function ops.set_operational_writes_enabled(boolean, text, text)
  from public, anon, authenticated;
grant execute on function ops.configure_environment(text, text, text, text)
  to service_role;
grant execute on function ops.set_operational_writes_enabled(boolean, text, text)
  to service_role;

revoke all on function public.m09_dispatch_pre_m17(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch_pre_m17(text, text, jsonb, jsonb, text)
  to service_role;
revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated, service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607240017',
  'M17',
  'Greenfield Production environment, source-quality/version lineage, readiness gates and fail-closed operational cutover.',
  'supabase/migrations/202607240017_production_rebuild_contract.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
