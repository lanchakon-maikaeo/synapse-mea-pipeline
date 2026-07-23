-- SYNAPSE M12: operational alerts, heartbeats, backup/restore evidence, releases and workflow audit.

begin;

create table if not exists ops.system_alerts (
  alert_id uuid primary key default gen_random_uuid(),
  alert_type text not null check (alert_type in (
    'import_failed','job_failed','data_stale','backup_failed','service_down','security'
  )),
  severity text not null check (severity in ('info','warning','critical')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  source_type text,
  source_reference text,
  message text not null check (btrim(message) <> ''),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  detected_at timestamptz not null default now(),
  acknowledged_by uuid references auth.users (id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists system_alerts_open_dedup_idx
  on ops.system_alerts (alert_type, coalesce(source_reference,'')) where status='open';
create index if not exists system_alerts_status_created_idx
  on ops.system_alerts (status, severity, created_at desc);

create table if not exists ops.service_heartbeats (
  service_name text primary key,
  instance_id text not null,
  service_version text not null,
  status text not null check (status in ('healthy','degraded','stopping')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ops.backup_runs (
  backup_run_id uuid primary key default gen_random_uuid(),
  backup_type text not null check (backup_type in ('database','storage','restore_drill')),
  status text not null check (status in ('running','succeeded','failed')),
  artifact_reference text,
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  validation_details jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_details)='object'),
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists ops.release_versions (
  release_version text primary key,
  git_sha text check (git_sha is null or git_sha ~ '^[0-9a-f]{7,64}$'),
  status text not null check (status in ('deployed','rolled_back','failed')),
  rollback_of text references ops.release_versions (release_version) on delete restrict,
  deployment_profile text not null check (deployment_profile in ('test','free-poc','self-host')),
  notes text,
  deployed_by uuid references auth.users (id) on delete set null,
  deployed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

insert into ops.release_versions (release_version, status, deployment_profile, notes)
values ('1.0.0-non-ai', 'deployed', 'test', 'Waves 0-3 plus M09, M10 and M12; Wave 4/M11 intentionally excluded.')
on conflict (release_version) do update
set status=excluded.status, deployment_profile=excluded.deployment_profile, notes=excluded.notes;

create or replace function ops.record_service_heartbeat(
  p_service_name text,
  p_instance_id text,
  p_service_version text,
  p_status text default 'healthy',
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
begin
  if btrim(coalesce(p_service_name,''))='' or btrim(coalesce(p_instance_id,''))='' then
    raise exception 'Service name and instance ID are required';
  end if;
  if p_status not in ('healthy','degraded','stopping') then raise exception 'Unsupported heartbeat status'; end if;
  insert into ops.service_heartbeats (service_name, instance_id, service_version, status, details, last_seen_at)
  values (p_service_name, p_instance_id, p_service_version, p_status, coalesce(p_details,'{}'::jsonb), now())
  on conflict (service_name) do update
  set instance_id=excluded.instance_id, service_version=excluded.service_version,
      status=excluded.status, details=excluded.details, last_seen_at=now(), updated_at=now();
end;
$$;

create or replace function ops.raise_system_alert(
  p_alert_type text,
  p_severity text,
  p_message text,
  p_source_type text default null,
  p_source_reference text default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, ops
as $$
declare v_alert_id uuid;
begin
  insert into ops.system_alerts (
    alert_type, severity, source_type, source_reference, message, details
  ) values (
    p_alert_type, p_severity, p_source_type, p_source_reference, p_message, coalesce(p_details,'{}'::jsonb)
  )
  on conflict (alert_type, (coalesce(source_reference,''))) where status='open'
  do update set severity=excluded.severity, message=excluded.message, details=excluded.details,
                detected_at=now(), updated_at=now()
  returning alert_id into v_alert_id;
  return v_alert_id;
end;
$$;

create or replace function ops.acknowledge_system_alert(p_alert_id uuid, p_resolve boolean default false)
returns ops.system_alerts
language plpgsql
security definer
set search_path = pg_catalog, ops, public
as $$
declare v_role public.app_role; v_alert ops.system_alerts%rowtype;
begin
  select role into v_role from public.user_profiles where user_id=auth.uid() and is_active;
  if v_role is null or v_role not in ('admin','planner') then raise exception 'Only planner or admin may acknowledge alerts'; end if;
  update ops.system_alerts
  set status=case when p_resolve then 'resolved' else 'acknowledged' end,
      acknowledged_by=auth.uid(), acknowledged_at=coalesce(acknowledged_at,now()),
      resolved_at=case when p_resolve then now() else null end, updated_at=now()
  where alert_id=p_alert_id and status <> 'resolved'
  returning * into v_alert;
  if not found then raise exception 'Open or acknowledged alert not found'; end if;
  return v_alert;
end;
$$;

create or replace function ops.refresh_operational_alerts(p_stale_hours integer default 26)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, ops, raw
as $$
declare v_count integer; v_total integer := 0;
begin
  if p_stale_hours <= 0 then raise exception 'Stale threshold must be positive'; end if;

  insert into ops.system_alerts (alert_type,severity,source_type,source_reference,message,details,detected_at)
  select 'import_failed','critical','import_batch',batch_id::text,
         'Import batch failed: ' || source_file,
         jsonb_build_object('source_file',source_file,'source_sheet',source_sheet), coalesce(imported_at,created_at)
  from raw.import_batches b where status='failed'
  on conflict (alert_type, (coalesce(source_reference,''))) where status='open'
  do update set detected_at=excluded.detected_at, message=excluded.message, details=excluded.details, updated_at=now();
  get diagnostics v_count=row_count; v_total:=v_total+v_count;

  insert into ops.system_alerts (alert_type,severity,source_type,source_reference,message,details,detected_at)
  select 'job_failed','critical','background_job',job_id::text,
         'Background ' || job_type || ' job failed',
         jsonb_build_object('attempt_count',attempt_count,'error_message',error_message), coalesce(finished_at,updated_at)
  from ops.background_jobs j where status='failed'
  on conflict (alert_type, (coalesce(source_reference,''))) where status='open'
  do update set detected_at=excluded.detected_at, message=excluded.message, details=excluded.details, updated_at=now();
  get diagnostics v_count=row_count; v_total:=v_total+v_count;

  with latest as (
    select source_system, max(coalesce(imported_at,created_at)) as latest_at
    from raw.import_batches where status='succeeded' group by source_system
  )
  insert into ops.system_alerts (alert_type,severity,source_type,source_reference,message,details)
  select 'data_stale','warning','source_system',source_system,
         'Source data is stale: ' || source_system,
         jsonb_build_object('latest_at',latest_at,'threshold_hours',p_stale_hours)
  from latest l where latest_at < now() - make_interval(hours=>p_stale_hours)
  on conflict (alert_type, (coalesce(source_reference,''))) where status='open'
  do update set detected_at=now(), message=excluded.message, details=excluded.details, updated_at=now();
  get diagnostics v_count=row_count;
  return v_total+v_count;
end;
$$;

create or replace function audit.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, audit
as $$
declare v_old jsonb; v_new jsonb; v_pk text;
begin
  if tg_op in ('UPDATE','DELETE') then v_old:=to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then v_new:=to_jsonb(new); end if;
  v_pk:=coalesce(
    v_new->>'id',v_old->>'id',v_new->>'user_id',v_old->>'user_id',
    v_new->>'contract_id',v_old->>'contract_id',v_new->>'replenishment_plan_id',v_old->>'replenishment_plan_id',
    v_new->>'replenishment_item_id',v_old->>'replenishment_item_id',v_new->>'route_plan_id',v_old->>'route_plan_id',
    v_new->>'alert_id',v_old->>'alert_id',v_new->>'material_id',v_old->>'material_id',
    v_new->>'source_row_number',v_old->>'source_row_number'
  );
  insert into audit.change_log (schema_name,table_name,record_pk,operation,old_data,new_data,changed_by,database_role)
  values (tg_table_schema,tg_table_name,v_pk,tg_op,v_old,v_new,auth.uid(),current_user);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare target text;
begin
  foreach target in array array['core.replenishment_plans','core.replenishment_items','core.route_plans','ops.system_alerts'] loop
    execute format('drop trigger if exists audit_%s_changes on %s',replace(target,'.','_'),target);
    execute format('create trigger audit_%s_changes after insert or update or delete on %s for each row execute function audit.log_row_change()',replace(target,'.','_'),target);
  end loop;
end;
$$;

drop trigger if exists set_ops_system_alerts_updated_at on ops.system_alerts;
create trigger set_ops_system_alerts_updated_at before update on ops.system_alerts
for each row execute function audit.set_updated_at();
drop trigger if exists set_ops_service_heartbeats_updated_at on ops.service_heartbeats;
create trigger set_ops_service_heartbeats_updated_at before update on ops.service_heartbeats
for each row execute function audit.set_updated_at();

create or replace view analytics.v_operations_health
with (security_invoker=true)
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
  now() as checked_at;

alter table ops.system_alerts enable row level security;
alter table ops.service_heartbeats enable row level security;
alter table ops.backup_runs enable row level security;
alter table ops.release_versions enable row level security;

revoke all on ops.system_alerts,ops.service_heartbeats,ops.backup_runs,ops.release_versions
  from public,anon,authenticated;
grant all on ops.system_alerts,ops.service_heartbeats,ops.backup_runs,ops.release_versions to service_role;
grant select on analytics.v_operations_health to service_role;

revoke all on function ops.record_service_heartbeat(text,text,text,text,jsonb),
  ops.raise_system_alert(text,text,text,text,text,jsonb),ops.acknowledge_system_alert(uuid,boolean),
  ops.refresh_operational_alerts(integer) from public,anon,authenticated;
grant execute on function ops.record_service_heartbeat(text,text,text,text,jsonb),
  ops.raise_system_alert(text,text,text,text,text,jsonb),ops.acknowledge_system_alert(uuid,boolean),
  ops.refresh_operational_alerts(integer) to service_role;

insert into ops.schema_migrations (version,module,description,source_file)
values ('202607150008','M12','Operational alerts, service heartbeats, backup/restore evidence, release tracking and workflow audit.','supabase/migrations/202607150008_m12_operations.sql')
on conflict (version) do update set description=excluded.description,source_file=excluded.source_file;

commit;
