-- Proactive logistics alerts: persisted recommendations and caller-derived reads.
begin;
alter table ops.system_alerts drop constraint system_alerts_alert_type_check;
alter table ops.system_alerts add constraint system_alerts_alert_type_check check
 (alert_type in ('import_failed','job_failed','data_stale','backup_failed','service_down','security','agentic'));
create unique index agentic_alert_identity on ops.system_alerts(source_reference) where alert_type='agentic';
create table ops.agentic_alert_runs (
 run_id uuid primary key, status text not null check(status in ('running','succeeded','failed')),
 started_at timestamptz not null default now(), finished_at timestamptz,
 candidate_count integer, analyzed_count integer, model text, error_code text
);
alter table ops.agentic_alert_runs enable row level security;
revoke all on ops.agentic_alert_runs from public,anon,authenticated;
grant all on ops.agentic_alert_runs to service_role;

create function public.agentic_alert_context() returns jsonb
language plpgsql security definer set search_path=pg_catalog set statement_timeout='20s'
as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise insufficient_privilege; end if;
 return jsonb_build_object(
  'policy',(select parameters || jsonb_build_object('version',policy_version,'stock_max_age_hours',26)
    from ops.calculation_policies where policy_version='v1.0.0'),
  'stock',coalesce((select jsonb_agg(to_jsonb(s)) from analytics.v_stock_health s),'[]'::jsonb),
  'queue',coalesce((select jsonb_agg(to_jsonb(q)||jsonb_build_object('origin_location_id',p.origin_location_id,'input_data_class',i.input_data_class))
    from analytics.v_replenishment_queue q join core.replenishment_plans p using(replenishment_plan_id)
    join core.replenishment_items i using(replenishment_item_id)
    where p.status not in ('completed','cancelled') and i.status not in ('issued','cancelled','district_rejected')),'[]'::jsonb),
  'warehouse',coalesce((select jsonb_agg(to_jsonb(s)) from (
    select distinct on(ss.material_id,ss.location_id) ss.material_id,ss.location_id,l.location_name_th,
      ss.quantity_on_hand,ss.snapshot_at,ss.data_class,ss.source_quality
    from core.stock_snapshots ss join core.locations l using(location_id)
    join core.materials m using(material_id) where l.location_type='WAREHOUSE' and l.is_active and m.is_vmi
    order by ss.material_id,ss.location_id,ss.snapshot_at desc,ss.created_at desc,ss.snapshot_id desc
  ) s),'[]'::jsonb),
  'units',coalesce((select jsonb_agg(jsonb_build_object('handling_unit_id',hu.handling_unit_id,
    'material_id',hu.material_id,'location_id',hu.location_id,'available_qty',hu.available_qty,'reserved_qty',hu.reserved_qty,
    'eligible',((hu.opening_status in ('OPEN','SEALED') and lot.traceability_status='complete') or
      (hu.opening_status='OPENING_UNKNOWN' and lot.traceability_status='reconciled_actual_sources' and exists(
        select 1 from reference_data.opening_balance_handling_unit_evidence e where e.handling_unit_id=hu.handling_unit_id
         and e.material_id=hu.material_id and btrim(e.verification_ticket)<>'' and e.verified_at is not null)))))
    from core.handling_units hu join core.receipt_lots lot using(receipt_lot_id)),'[]'::jsonb),
  'existing',coalesce((select jsonb_agg(jsonb_build_object('key',source_reference,'status',status,'details',details))
    from ops.system_alerts where alert_type='agentic'),'[]'::jsonb),
  'data_as_of',clock_timestamp());
end;
$$;

create function public.agentic_alert_claim(p_run_id uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('agentic-alert-worker',0));
 if exists(select 1 from ops.agentic_alert_runs where status='running' and started_at>now()-interval '5 minutes') then return false; end if;
 update ops.agentic_alert_runs set status='failed',finished_at=now(),error_code='lease_expired'
   where status='running' and started_at<=now()-interval '5 minutes';
 insert into ops.agentic_alert_runs(run_id,status) values(p_run_id,'running');
 return true;
end;
$$;

create function public.agentic_alert_save(p_run_id uuid,p_alerts jsonb,p_model text,p_analyzed integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog set statement_timeout='20s' as $$
declare a jsonb; count_saved integer:=0;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise insufficient_privilege; end if;
 perform pg_advisory_xact_lock(hashtextextended('agentic-alert-worker',0));
 if not exists(select 1 from ops.agentic_alert_runs where run_id=p_run_id and status='running'
    and started_at>now()-interval '5 minutes') then raise exception 'run_not_active'; end if;
 if jsonb_typeof(p_alerts)<>'array' or jsonb_array_length(p_alerts)>10000 then raise exception 'invalid_alerts'; end if;
 for a in select value from jsonb_array_elements(p_alerts) loop
  if coalesce(a->>'key','')!~'^proactive:[a-zA-Z0-9:_-]{1,200}$' or
    a->>'severity' not in ('info','warning','critical') or
    coalesce(length(a->>'message'),0) not between 1 and 500 or
    jsonb_typeof(a->'details')<>'object' or
    a->'details'->>'scope' not in ('district','warehouse','workflow') then raise exception 'invalid_alert'; end if;
  insert into ops.system_alerts(alert_type,severity,source_type,source_reference,message,details)
   values('agentic',a->>'severity','proactive_pipeline',a->>'key',a->>'message',a->'details')
   on conflict(source_reference) where alert_type='agentic' do update set
    severity=excluded.severity,message=excluded.message,details=excluded.details,
    status=case when (ops.system_alerts.status='resolved' or (excluded.severity='critical' and ops.system_alerts.severity<>'critical') or (excluded.severity='warning' and ops.system_alerts.severity='info') or (coalesce((excluded.details->'evidence'->>'shortfall_qty')::numeric,0)>coalesce((ops.system_alerts.details->'evidence'->>'shortfall_qty')::numeric,0))) then 'open' else ops.system_alerts.status end,
    resolved_at=null,acknowledged_at=case when (ops.system_alerts.status='resolved' or (excluded.severity='critical' and ops.system_alerts.severity<>'critical') or (excluded.severity='warning' and ops.system_alerts.severity='info') or (coalesce((excluded.details->'evidence'->>'shortfall_qty')::numeric,0)>coalesce((ops.system_alerts.details->'evidence'->>'shortfall_qty')::numeric,0))) then null else ops.system_alerts.acknowledged_at end,
    acknowledged_by=case when (ops.system_alerts.status='resolved' or (excluded.severity='critical' and ops.system_alerts.severity<>'critical') or (excluded.severity='warning' and ops.system_alerts.severity='info') or (coalesce((excluded.details->'evidence'->>'shortfall_qty')::numeric,0)>coalesce((ops.system_alerts.details->'evidence'->>'shortfall_qty')::numeric,0))) then null else ops.system_alerts.acknowledged_by end,
    detected_at=case when (ops.system_alerts.status='resolved' or (excluded.severity='critical' and ops.system_alerts.severity<>'critical') or (excluded.severity='warning' and ops.system_alerts.severity='info') or (coalesce((excluded.details->'evidence'->>'shortfall_qty')::numeric,0)>coalesce((ops.system_alerts.details->'evidence'->>'shortfall_qty')::numeric,0))) then now() else ops.system_alerts.detected_at end,updated_at=now();
  count_saved:=count_saved+1;
 end loop;
 update ops.system_alerts set status='resolved',resolved_at=now(),updated_at=now()
  where alert_type='agentic' and status<>'resolved'
   and not exists(select 1 from jsonb_array_elements(p_alerts) candidate(value) where candidate.value->>'key'=source_reference);
 update ops.agentic_alert_runs set status='succeeded',finished_at=now(),candidate_count=count_saved,
  analyzed_count=p_analyzed,model=p_model where run_id=p_run_id;
 return jsonb_build_object('saved',count_saved,'run_id',p_run_id);
end;
$$;

create function public.agentic_alert_fail(p_run_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise insufficient_privilege; end if;
 update ops.agentic_alert_runs set status='failed',finished_at=now(),error_code='worker_unavailable'
 where run_id=p_run_id and status='running';
end;
$$;

create function public.agentic_alert_feed(p_status text default 'open',p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path=pg_catalog set statement_timeout='5s' as $$
declare actor_role text; actor_district text; payload jsonb; count_open bigint;
begin
 select role::text,district_id into actor_role,actor_district from public.user_profiles where user_id=auth.uid() and is_active;
 if actor_role is null then raise insufficient_privilege; end if;
 if p_status not in ('open','acknowledged','resolved') or p_offset not between 0 and 10000 then raise exception 'invalid_filter'; end if;
 with allowed as (select a.* from ops.system_alerts a where
  (a.alert_type<>'agentic' and actor_role in ('admin','planner')) or
  (a.alert_type='agentic' and (
   actor_role in ('admin','planner','academic','viewer') or
   (actor_role='district' and a.details->>'district_id'=actor_district) or
   (actor_role='picker' and a.details->>'scope'='warehouse'))))
 select count(*) into count_open from allowed where status='open';
 with allowed as (select a.* from ops.system_alerts a where
  (a.alert_type<>'agentic' and actor_role in ('admin','planner')) or
  (a.alert_type='agentic' and (actor_role in ('admin','planner','academic','viewer') or
   (actor_role='district' and a.details->>'district_id'=actor_district) or
   (actor_role='picker' and a.details->>'scope'='warehouse'))))
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into payload from (
  select alert_id,alert_type,severity,status,message,details,created_at,updated_at,acknowledged_at from allowed
   where status=p_status order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end,
    case when jsonb_typeof(details->'priority')='number' then (details->>'priority')::numeric else 0 end desc,created_at desc,alert_id limit 30 offset p_offset) q;
 return jsonb_build_object('open_count',count_open,'alerts',payload,'offset',p_offset,
   'last_run',(select jsonb_build_object('status',status,'started_at',started_at,'finished_at',finished_at)
      from ops.agentic_alert_runs order by started_at desc limit 1),'schedule','07:30 Asia/Bangkok');
end;
$$;

create function public.agentic_alert_ack(p_alert_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare r text; d text;
begin
 select role::text,district_id into r,d from public.user_profiles where user_id=auth.uid() and is_active;
 if r is null or r='viewer' then raise insufficient_privilege; end if;
 update ops.system_alerts a set status='acknowledged',acknowledged_by=auth.uid(),acknowledged_at=now(),updated_at=now()
 where alert_id=p_alert_id and status='open' and ((alert_type<>'agentic' and r in ('admin','planner')) or
  (alert_type='agentic' and (r in ('admin','planner','academic') or
    (r='district' and details->>'district_id'=d) or (r='picker' and details->>'scope'='warehouse'))));
 if not found then raise insufficient_privilege; end if;
end;
$$;
revoke all on function public.agentic_alert_context(),public.agentic_alert_claim(uuid),
 public.agentic_alert_save(uuid,jsonb,text,integer),public.agentic_alert_fail(uuid),
 public.agentic_alert_feed(text,integer),public.agentic_alert_ack(uuid) from public,anon,authenticated;
grant execute on function public.agentic_alert_context(),public.agentic_alert_claim(uuid),
 public.agentic_alert_save(uuid,jsonb,text,integer),public.agentic_alert_fail(uuid) to service_role;
grant execute on function public.agentic_alert_feed(text,integer),public.agentic_alert_ack(uuid) to authenticated;
insert into ops.schema_migrations(version,module,description,source_file)
 values('20261004024530','P04','Proactive alert evidence, worker leases and scoped feed.',
 'supabase/migrations/20261004024530_proactive_agentic_alerts.sql');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
revoke usage on schema net,cron from public,anon,authenticated;
create function ops.invoke_agentic_alert_dev() returns bigint
language plpgsql security definer set search_path=pg_catalog as $$
declare secret text;
begin
 select decrypted_secret into secret from vault.decrypted_secrets where name='synapse-agentic-dev-cron';
 if secret is null then raise exception 'agentic_cron_secret_missing'; end if;
 return net.http_get(url:='https://mea-synapse-production-git-dev-synapse-mea.vercel.app/api/internal/agentic-alerts',
  headers:=jsonb_build_object('Authorization','Bearer '||secret),timeout_milliseconds:=100000);
end;
$$;
revoke all on function ops.invoke_agentic_alert_dev() from public,anon,authenticated;
grant execute on function ops.invoke_agentic_alert_dev() to service_role;

notify pgrst,'reload schema';
commit;
