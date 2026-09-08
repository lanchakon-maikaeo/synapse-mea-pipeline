-- Managed Test fixtures only; every admission is rolled back.
begin;
set local role authenticated;
do $$
declare r jsonb; request uuid := gen_random_uuid();
begin
 perform set_config('request.jwt.claim.sub','9bd65a3f-a46d-47b0-a02c-2b27837a382f',true);
 r := public.vmi_chat_overview('get_operations_overview','{"view":"risk"}',request);
 assert r->>'status'='forbidden', 'requires admission';
 r := public.vmi_chat_admit(request);
 assert r->>'status'='ok', 'admin admission';
 r := public.vmi_chat_overview('get_operations_overview','{"view":"delivery"}',request);
 assert r->>'status'='ok' and jsonb_array_length(r->'data') between 1 and 20, 'admin overview';
 assert not exists(select 1 from jsonb_array_elements(r->'data') e where (e->>'cmp_monthly')::numeric <= 0 or e->>'stock_source_status'='missing'), 'missing evidence excluded';
 r := public.vmi_chat_overview('get_operations_overview','{"view":"risk","district_id":"bad"}',request);
 assert r->>'status'='invalid_input', 'invalid district';
 r := public.vmi_chat_overview('get_operations_overview','{"view":"risk","actor_id":"spoof"}',request);
 assert r->>'status'='invalid_input', 'identity injection';
 r := public.vmi_chat_overview('get_operations_overview','{"view":"risk","material_id":"DOES-NOT-EXIST"}',request);
 assert r->>'status'='no_data', 'absent material';
 perform set_config('request.jwt.claim.sub','2199851f-76f3-40d7-9574-d57a4fa83c32',true);
 r := public.vmi_chat_overview('get_operations_overview','{"view":"risk"}',request);
 assert r->>'status'='forbidden', 'admission bound to actor';
 request := gen_random_uuid(); perform public.vmi_chat_admit(request);
 r := public.vmi_chat_overview('get_operations_overview','{"view":"risk"}',request);
 assert r->>'status'='ok', 'district overview';
 assert not exists(select 1 from jsonb_array_elements(r->'data') e where e->>'district_id' <> '5501'), 'district isolation';
 r := public.vmi_chat_overview('get_operations_overview','{"view":"risk","district_id":"5502"}',request);
 assert r->>'status'='forbidden', 'cross district';
 perform set_config('request.jwt.claim.sub','e7fb2f14-bd3c-4e62-937d-5d100373790a',true);
 r := public.vmi_chat_overview('get_operations_overview','{"view":"risk"}',request);
 assert r->>'status'='forbidden', 'inactive identity';
end $$;
rollback;
select '11 overview assertions passed' as result;
