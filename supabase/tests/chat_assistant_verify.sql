-- Included by local_pipeline_workflow_verify.sql inside its rollback transaction.
-- Reuses that test's real plan/approval/receipt/ISSUE chain.
create temporary table p01_checks(name text primary key, passed boolean not null);
grant select, insert on p01_checks to authenticated;

insert into core.materials(
  material_id,sap_material_id,material_name,category,unit,is_vmi,
  master_source,data_quality_status,source_batch_id
)
select 'LOCAL-VMI-ZERO','LOCAL-VMI-ZERO','Local CMP zero material','TEST','EA',true,
  'material_master','valid',source_batch_id
from core.materials where material_id='LOCAL-VMI-001';
insert into core.stock_snapshots(
  snapshot_id,material_id,location_id,quantity_on_hand,snapshot_at,source_batch_id
)
select gen_random_uuid(),'LOCAL-VMI-ZERO','DIST-5501',55,now(),source_batch_id
from core.materials where material_id='LOCAL-VMI-001';
insert into core.usage_rates(
  usage_rate_id,material_id,district_id,as_of_date,cmp_monthly,
  avg_ly,avg_12m,avg_6m,avg_4m,source_batch_id
)
select gen_random_uuid(),'LOCAL-VMI-ZERO','5501',current_date,0,0,0,0,0,source_batch_id
from core.materials where material_id='LOCAL-VMI-001';
create temporary table p01_issue_reference as
select p.plan_number
from functional_test_state s
join core.replenishment_plans p on p.replenishment_plan_id=s.replenishment_plan_id;
grant select on p01_issue_reference to authenticated;

insert into raw.source_rows(
  batch_id,source_entity,source_sheet,source_row_number,row_hash,payload
)
select c.source_batch_id,'p01_row_limit','contract',n,
  repeat(md5(n::text),2),jsonb_build_object('row_limit_fixture',n)
from core.contracts c cross join generate_series(101,125) n
where c.purchase_order=4500000001;
insert into core.contract_items(
  contract_id,material_id,source_row_id,source_row_number,line_item,item_description,
  unit,quantity,delivery_date,acceptance_date,validation_status,source_batch_id
)
select c.contract_id,'LOCAL-VMI-001',r.source_row_id,r.source_row_number,
  r.source_row_number,'P01 row limit fixture','EA',1,current_date,current_date,
  'valid',c.source_batch_id
from core.contracts c
join raw.source_rows r on r.batch_id=c.source_batch_id and r.source_entity='p01_row_limit'
where c.purchase_order=4500000001;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into p01_checks values
  ('stock_same_scope',
   public.vmi_chat_read('get_stock_status',
     '{"material_id":"LOCAL-VMI-001","scope":"district","district_id":"5501"}',
     gen_random_uuid()) #>> '{data,0,unit}' = 'EA'),
  ('replenishment_same_scope',
   public.vmi_chat_read('get_replenishment_recommendation',
     '{"material_id":"LOCAL-VMI-001","district_id":"5501"}',
     gen_random_uuid())->>'status' = 'ok'),
  ('replenishment_cmp_zero_evidence',
   public.vmi_chat_read('get_replenishment_recommendation',
     '{"material_id":"LOCAL-VMI-ZERO","district_id":"5501"}',
     gen_random_uuid()) #>> '{data,0,evidence,reason}' = 'cmp_zero_not_eligible'),
  ('contract_exact_po',
   public.vmi_chat_read('get_contract_status','{"purchase_order":"4500000001"}',
     gen_random_uuid()) #>> '{data,0,purchase_order}' = '4500000001'),
  ('traceability_proven_issue',
   public.vmi_chat_read('get_traceability','{"material_id":"LOCAL-VMI-001"}',
     gen_random_uuid()) #>> '{data,0,provenance_kind}' = 'issued_movement'),
  ('unknown_argument_denied',
   public.vmi_chat_read('get_stock_status',
     '{"material_id":"LOCAL-VMI-001","scope":"warehouse","actor_id":"forged"}',
     gen_random_uuid())->>'status' = 'invalid_input'),
  ('oversized_po_denied',
   public.vmi_chat_read('get_contract_status','{"purchase_order":"9999999999999999999"}',
     gen_random_uuid())->>'status' = 'invalid_input'),
  ('date_argument_denied',
   public.vmi_chat_read('get_traceability','{"material_id":"LOCAL-VMI-001","date_from":"2020-01-01"}',
     gen_random_uuid())->>'status' = 'invalid_input');
insert into p01_checks
select 'plan_same_scope',
  public.vmi_chat_read('get_plan_status',jsonb_build_object('plan_id',replenishment_plan_id),
    gen_random_uuid())->>'status' = 'ok'
from functional_test_state;
insert into p01_checks
select 'trace_exact_plan_issue_reference',
  public.vmi_chat_read('get_traceability',
    jsonb_build_object('issue_reference',p.plan_number),gen_random_uuid())->>'status' = 'ok'
from p01_issue_reference p;
reset role;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
set local role authenticated;
with response as materialized (
  select public.vmi_chat_read('get_contract_status',
    '{"purchase_order":"4500000001"}',gen_random_uuid()) value
)
insert into p01_checks
select 'row_limit_20',jsonb_array_length(value->'data')=20
  and value#>>'{scope,truncated}'='true'
from response;
reset role;

update public.user_profiles set district_id='5502'
where user_id='10000000-0000-4000-8000-000000000003';
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
set local role authenticated;
insert into p01_checks values
  ('cross_district_denied',
   public.vmi_chat_read('get_stock_status',
     '{"material_id":"LOCAL-VMI-001","scope":"district","district_id":"5501"}',
     gen_random_uuid())->>'status' = 'forbidden'),
  ('district_contract_denied',
   public.vmi_chat_read('get_contract_status','{"purchase_order":"4500000001"}',
     gen_random_uuid())->>'status' = 'forbidden'),
  ('foreign_trace_hidden',
   public.vmi_chat_read('get_traceability','{"material_id":"LOCAL-VMI-001"}',
     gen_random_uuid())->>'status' = 'no_data');
insert into p01_checks
select 'foreign_plan_hidden',
  public.vmi_chat_read('get_plan_status',jsonb_build_object('plan_id',replenishment_plan_id),
    gen_random_uuid())->>'status' = 'no_data'
from functional_test_state;
update public.user_profiles set role='admin', district_id=null
where user_id='10000000-0000-4000-8000-000000000003';
do $$
begin
  begin
    perform * from core.stock_snapshots;
    raise exception 'Direct table unexpectedly readable';
  exception when insufficient_privilege then
    insert into p01_checks values('direct_table_denied',true);
  end;
  begin
    perform * from analytics.v_issue_traceback;
    raise exception 'Direct view unexpectedly readable';
  exception when insufficient_privilege then
    insert into p01_checks values('direct_view_denied',true);
  end;
  begin
    insert into audit.vmi_chat_requests(request_id,actor_id,tool,tool_version,status,latency_ms)
      values(gen_random_uuid(),'10000000-0000-4000-8000-000000000001',
        'get_stock_status','v1','ok',0);
    raise exception 'Forged audit unexpectedly allowed';
  exception when insufficient_privilege then
    insert into p01_checks values('audit_forgery_denied',true);
  end;
end $$;
reset role;
insert into p01_checks
select 'profile_escalation_denied', role='district' and district_id='5502'
from public.user_profiles where user_id='10000000-0000-4000-8000-000000000003';
insert into p01_checks values
  ('anon_rpc_denied',not has_function_privilege('anon','public.vmi_chat_read(text,jsonb,uuid)','execute')),
  ('rpc_timeout_set',(select 'statement_timeout=5s'=any(proconfig)
    from pg_proc where oid='public.vmi_chat_read(text,jsonb,uuid)'::regprocedure)),
  ('audit_actor_from_caller',(select count(*)=4 from audit.vmi_chat_requests
    where actor_id='10000000-0000-4000-8000-000000000003'));

select set_config('request.jwt.claim.sub','',true);
set local role authenticated;
do $$
begin
  begin
    perform public.vmi_chat_read('get_stock_status',
      '{"material_id":"LOCAL-VMI-001","scope":"warehouse"}',gen_random_uuid());
    raise exception 'Missing identity accepted';
  exception when invalid_authorization_specification then
    insert into p01_checks values('missing_identity_denied',true);
  end;
end $$;
reset role;
update public.user_profiles set is_active=false
where user_id='10000000-0000-4000-8000-000000000002';
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
set local role authenticated;
insert into p01_checks values('inactive_denied',
  public.vmi_chat_read('get_stock_status',
    '{"material_id":"LOCAL-VMI-001","scope":"warehouse"}',
    gen_random_uuid())->>'status' = 'forbidden');
insert into p01_checks values('inactive_admission_denied',
  public.vmi_chat_admit(gen_random_uuid())->>'status' = 'forbidden');
reset role;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000006',true);
set local role authenticated;
do $$
declare response jsonb;
begin
  for i in 1..11 loop
    response := public.vmi_chat_read('get_traceability',
      '{"material_id":"LOCAL-VMI-001"}',gen_random_uuid());
    if i <= 10 and response->>'status' <> 'ok' then
      raise exception 'Rate limit applied too early';
    end if;
  end loop;
  insert into p01_checks values('rate_limit_11th_request',
    response->>'status'='unavailable' and response#>>'{warnings,0}'='rate_limited');
end $$;
reset role;
insert into p01_checks values('rate_limited_request_audited',
  (select count(*)=11 from audit.vmi_chat_requests
   where actor_id='10000000-0000-4000-8000-000000000006'));
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000006',true);
set local role authenticated;
do $$
declare response jsonb;
begin
  for i in 1..11 loop
    response := public.vmi_chat_admit(gen_random_uuid());
    if i <= 10 and response->>'status' <> 'ok' then
      raise exception 'Admission rate limit applied too early';
    end if;
  end loop;
  insert into p01_checks values('admission_rate_limit_11th_request',
    response->>'status'='unavailable' and response#>>'{warnings,0}'='rate_limited');
end $$;
reset role;
insert into p01_checks values
  ('admission_count_bounded',(select count(*)=10 from audit.vmi_chat_admissions
    where actor_id='10000000-0000-4000-8000-000000000006')),
  ('admission_anon_denied',not has_function_privilege('anon','public.vmi_chat_admit(uuid)','execute'));
do $$
begin
  begin
    update audit.vmi_chat_requests set status='ok';
    raise exception 'Audit update unexpectedly allowed';
  exception when raise_exception then
    if sqlerrm = 'Audit update unexpectedly allowed' then raise; end if;
    insert into p01_checks values('audit_append_only',true);
  end;
end $$;
-- Overview, database catalog and knowledge search, as the local admin.
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare r jsonb; request uuid := gen_random_uuid();
begin
  r := public.vmi_chat_overview('get_operations_overview','{"view":"risk"}',request);
  insert into p01_checks values('overview_requires_admission', r->>'status'='forbidden');
  insert into p01_checks values('admin_admission', public.vmi_chat_admit(request)->>'status'='ok');
  r := public.vmi_chat_overview('get_operations_overview','{"view":"risk"}',request);
  insert into p01_checks values('overview_after_admission', r->>'status' in ('ok','no_data'));
  r := public.vmi_chat_overview('get_operations_overview','{"view":"risk","actor_id":"spoof"}',request);
  insert into p01_checks values('overview_identity_injection', r->>'status'='invalid_input');
  r := public.vmi_chat_database('discover_database','{}',request);
  insert into p01_checks values('database_catalog', r->>'status'='ok'
    and jsonb_array_length(r->'data') > 0
    and not exists(select 1 from jsonb_array_elements(r->'data') x where x->>'source_id' like 'auth.%'));
  r := public.vmi_chat_database('query_database','{"source_id":"core.districts","columns":["district_id; drop table core.districts"]}',request);
  insert into p01_checks values('database_column_injection', r->>'status'='invalid_input');
  r := public.vmi_chat_database('query_database','{"source_id":"core.districts","sql":"select 1"}',request);
  insert into p01_checks values('database_raw_sql_rejected', r->>'status'='invalid_input');
  r := public.vmi_chat_database('query_database','{"source_id":"auth.users"}',request);
  insert into p01_checks values('database_unregistered_source', r->>'status'='forbidden');
  r := public.vmi_chat_knowledge_bge_m3(array_fill(0.01::real, array[1024])::extensions.vector, 3);
  insert into p01_checks values('knowledge_search_runs', r is not null);
end $$;
reset role;
insert into p01_checks values
  ('chat_rpcs_anon_denied',
    not has_function_privilege('anon','public.vmi_chat_overview(text,jsonb,uuid)','execute')
    and not has_function_privilege('anon','public.vmi_chat_database(text,jsonb,uuid)','execute')
    and not has_function_privilege('anon','public.vmi_chat_knowledge_bge_m3(extensions.vector,integer)','execute'));
table p01_checks;
do $$
begin
  if exists(select 1 from p01_checks where not passed) then
    raise exception 'P01 SQL acceptance failed: %',
      (select string_agg(name,', ') from p01_checks where not passed);
  end if;
end $$;
