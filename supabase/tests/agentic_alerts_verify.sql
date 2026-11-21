-- Included by local_pipeline_workflow_verify.sql inside its rollback transaction.
-- Grants, role-scoped feed and acknowledgement, worker leases and alert lifecycle.
do $$
declare actor uuid; feed jsonb; context jsonb; run uuid:=gen_random_uuid(); a uuid;
begin
 if has_function_privilege('anon','public.agentic_alert_context()','execute') or
    has_function_privilege('authenticated','public.agentic_alert_save(uuid,jsonb,text,integer)','execute') or
    has_function_privilege('anon','public.agentic_alert_feed(text,integer)','execute') or
    has_function_privilege('authenticated','ops.invoke_agentic_alert()','execute') then
  raise exception 'worker/read grant leaked';
 end if;

 -- The worker's evidence query runs against the current schema.
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 context:=public.agentic_alert_context();
 if jsonb_typeof(context->'policy')<>'object' or jsonb_typeof(context->'stock')<>'array' or jsonb_typeof(context->'queue')<>'array'
    or jsonb_typeof(context->'warehouse')<>'array' or jsonb_typeof(context->'units')<>'array' then
  raise exception 'agentic context incomplete: %', left(context::text,200);
 end if;
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 begin perform public.agentic_alert_context(); raise exception 'context open to non-service caller';
 exception when insufficient_privilege then null; end;

 select user_id into actor from public.user_profiles where is_active order by user_id limit 1;
 if actor is null then raise exception 'active test identity required'; end if;
 insert into ops.system_alerts(alert_type,severity,source_reference,message,details) values
 ('agentic','warning','proactive:test:5501','Rollback test own district','{"scope":"district","district_id":"5501","priority":900,"fingerprint":"test"}'),
 ('agentic','warning','proactive:test:5502','Rollback test other district','{"scope":"district","district_id":"5502","priority":900,"fingerprint":"test"}'),
 ('agentic','warning','proactive:test:warehouse','Rollback test warehouse','{"scope":"warehouse","priority":900,"fingerprint":"test"}');
 update public.user_profiles set role='district',district_id='5501' where user_id=actor;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
 feed:=public.agentic_alert_feed('open',0);
 if exists(select 1 from jsonb_array_elements(feed->'alerts') x where x->'details'->>'district_id' is distinct from '5501') then raise exception 'district scope leaked'; end if;
 select alert_id into a from ops.system_alerts where source_reference='proactive:test:5501';
 perform public.agentic_alert_ack(a);
 if (select status from ops.system_alerts where alert_id=a)<>'acknowledged' then raise exception 'ack failed'; end if;
 begin
  perform public.agentic_alert_ack((select alert_id from ops.system_alerts where source_reference='proactive:test:5502'));
  raise exception 'other district ack accepted';
 exception when insufficient_privilege then null; end;
 update public.user_profiles set role='picker',district_id=null where user_id=actor;
 feed:=public.agentic_alert_feed('open',0);
 if exists(select 1 from jsonb_array_elements(feed->'alerts') x where x->'details'->>'scope' is distinct from 'warehouse') then raise exception 'picker scope leaked'; end if;
 update public.user_profiles set role='viewer' where user_id=actor;
 begin perform public.agentic_alert_ack(a); raise exception 'viewer write accepted'; exception when insufficient_privilege then null; end;

 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 if not public.agentic_alert_claim(run) then raise exception 'claim failed'; end if;
 if public.agentic_alert_claim(gen_random_uuid()) then raise exception 'duplicate worker accepted'; end if;
 perform public.agentic_alert_save(run,jsonb_build_array(jsonb_build_object('key','proactive:test:5501','severity','warning','message','Rollback updated',
  'details',jsonb_build_object('scope','district','district_id','5501','priority',900,'fingerprint','changed'))),'test',0);
 if (select status from ops.system_alerts where alert_id=a)<>'acknowledged' then raise exception 'acknowledged alert reopened'; end if;
 if (select status from ops.system_alerts where source_reference='proactive:test:5502')<>'resolved' then raise exception 'absent alert not resolved'; end if;
 if (select count(*) from ops.system_alerts where source_reference='proactive:test:5501')<>1 then raise exception 'duplicate alert'; end if;
 run:=gen_random_uuid();
 if not public.agentic_alert_claim(run) then raise exception 'second run failed'; end if;
 perform public.agentic_alert_save(run,jsonb_build_array(jsonb_build_object('key','proactive:test:5501','severity','critical','message','Rollback worsened',
  'details',jsonb_build_object('scope','district','district_id','5501','priority',1000,'fingerprint','worse'))),'test',0);
 if (select status from ops.system_alerts where alert_id=a)<>'open' then raise exception 'worsening did not reopen'; end if;
 if (select acknowledged_at from ops.system_alerts where alert_id=a) is not null then raise exception 'reopened ack retained'; end if;
 perform set_config('request.jwt.claims','',true);
end $$;
