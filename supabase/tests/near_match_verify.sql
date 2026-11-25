-- Included by local_pipeline_workflow_verify.sql inside its rollback transaction.
-- ADR 0002: when a text search finds nothing that matches exactly, the database returns up to
-- five รายการใกล้เคียง ranked by pg_trgm, inside the same role scope, and never for aggregates.
insert into core.materials(material_id,sap_material_id,material_name,category,unit,is_vmi,master_source,data_quality_status,source_batch_id)
select v.id,v.id,v.name,'TEST','EA',true,'material_master','valid',m.source_batch_id
from core.materials m, (values ('LOCAL-NEAR-250','หม้อแปลงไฟฟ้า 3 เฟส 22kV 250kVA'),
  ('LOCAL-NEAR-SA','SURGE ARRESTER 24KV 10KA')) v(id,name)
where m.material_id='LOCAL-VMI-001';

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare r jsonb; request uuid := gen_random_uuid();
  q jsonb := '{"source_id":"core.materials","columns":["material_id","material_name"],"filters":[],"group_by":[],"metrics":[],"order_column":null,"order_direction":"asc","limit":20,"offset":0,"search":null}';
begin
  if public.vmi_chat_admit(request)->>'status' <> 'ok' then raise exception 'near match: admission failed'; end if;

  -- A name typed without the 22kV in between finds nothing exactly, then the near match.
  r := public.vmi_chat_database('query_database', q || '{"filters":[{"column":"material_name","operator":"contains","value":"หม้อแปลงไฟฟ้า 3 เฟส 250kVA"}]}', request);
  if r->>'status' <> 'no_data' or jsonb_array_length(r->'data') <> 0 then raise exception 'near match: exact miss changed: %', r->>'status'; end if;
  if r #>> '{near_matches,0,material_id}' is distinct from 'LOCAL-NEAR-250' or (r #>> '{near_matches,0,match_score}')::numeric < 0.4
     or jsonb_array_length(r->'near_matches') > 5 then
    raise exception 'near match: contains did not return the transformer: %', r->'near_matches';
  end if;

  -- A misspelt search term finds the same way.
  r := public.vmi_chat_database('query_database', q || '{"search":"surge arester 24kv"}', request);
  if r #>> '{near_matches,0,material_id}' is distinct from 'LOCAL-NEAR-SA' then
    raise exception 'near match: misspelt search missed: %', r->'near_matches';
  end if;

  -- Words in another order still find the row: the app sends Thai search terms split into words.
  r := public.vmi_chat_database('query_database', q || '{"search":"250kVA หม้อแปลง ไฟฟ้า"}', request);
  if r->>'status' <> 'ok' or r #>> '{data,0,material_id}' is distinct from 'LOCAL-NEAR-250' or r ? 'near_matches' then
    raise exception 'near match: words in another order missed: %', r;
  end if;

  -- Nothing close is nothing: no near matches are invented.
  r := public.vmi_chat_database('query_database', q || '{"search":"zzqx wvvk"}', request);
  if r->>'status' <> 'no_data' or coalesce(jsonb_array_length(r->'near_matches'), 0) <> 0 then
    raise exception 'near match: unrelated term returned rows: %', r->'near_matches';
  end if;

  -- An exact hit returns rows, never near matches.
  r := public.vmi_chat_database('query_database', q || '{"search":"SURGE ARRESTER"}', request);
  if r->>'status' <> 'ok' or r ? 'near_matches' then raise exception 'near match: exact hit changed: %', r; end if;

  -- Aggregates answer what matched; a near match would change the total.
  r := public.vmi_chat_database('query_database', q || '{"columns":[],"metrics":[{"function":"count","column":"*"}],"filters":[{"column":"material_name","operator":"contains","value":"หม้อแปลงไฟฟ้า 3 เฟส 250kVA"}]}', request);
  if r ? 'near_matches' or (r #>> '{data,0,count_rows}')::int <> 0 then raise exception 'near match: aggregate changed: %', r; end if;
end $$;
reset role;
