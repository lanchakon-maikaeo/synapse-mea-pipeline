-- Included by local_pipeline_workflow_verify.sql inside its rollback transaction, after near_match_verify.sql.
-- ADR 0002, section RRF: a near match ranks rows by text (pg_trgm >= 0.4) and by the meaning of the material
-- name (BGE-M3 cosine >= 0.5), fuses the two ranks with Reciprocal Rank Fusion (k = 60), and reports the fused
-- score over its maximum as match_score. Unit vectors stand in for embeddings: the same axis means the same.
insert into core.materials(material_id,sap_material_id,material_name,category,unit,is_vmi,master_source,data_quality_status,source_batch_id)
select v.id,v.id,v.name,'TEST','EA',true,'material_master','valid',m.source_batch_id
from core.materials m, (values ('LOCAL-HYB-TR','หม้อแปลงไฟฟ้า 3 เฟส 22kV 160kVA'),
  ('LOCAL-HYB-CB','สายเคเบิลอะลูมิเนียม 185 ตร.มม.'), ('LOCAL-HYB-NEW','ฟิวส์แรงสูง 24kV 10A')) v(id,name)
where m.material_id='LOCAL-VMI-001';
insert into rag.material_name_embeddings(material_id,name_md5,embedding)
select m.material_id, md5(m.material_name), (select array_agg((i=v.axis)::int::real) from generate_series(1,1024) i)::extensions.vector
from core.materials m join (values ('LOCAL-HYB-TR',1),('LOCAL-HYB-CB',2)) v(id,axis) on v.id=m.material_id;
insert into rag.knowledge_chunks_bge_m3(source_id,title,chunk_index,content,embedding)
values ('LOCAL-HYB-DOC','คู่มือการเติมพัสดุ',0,'ขั้นตอนการขอเติมพัสดุ ต้องได้รับอนุมัติจากหัวหน้าเขตก่อน',
  (select array_agg((i=2)::int::real) from generate_series(1,1024) i)::extensions.vector);

-- Earlier tests change this user's role; documents default to admin only (RLS).
update public.user_profiles set role='admin', district_id=null, is_active=true where user_id='10000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare r jsonb; request uuid := gen_random_uuid();
  e1 extensions.vector := (select array_agg((i=1)::int::real) from generate_series(1,1024) i)::extensions.vector;
  e2 extensions.vector := (select array_agg((i=2)::int::real) from generate_series(1,1024) i)::extensions.vector;
  q jsonb := '{"source_id":"core.materials","columns":["material_id","material_name"],"filters":[],"group_by":[],"metrics":[],"order_column":null,"order_direction":"asc","limit":20,"offset":0,"search":null}';
begin
  if public.vmi_chat_admit(request)->>'status' <> 'ok' then raise exception 'hybrid: admission failed'; end if;

  -- Text alone finds nothing; the meaning list alone finds the transformer: first of two lists is 1/61 of 2/61.
  r := public.vmi_chat_database('query_database', q || '{"search":"zzqx wvvk"}', request, e1);
  if r->>'status' <> 'no_data' or r #>> '{near_matches,0,material_id}' is distinct from 'LOCAL-HYB-TR'
     or (r #>> '{near_matches,0,match_score}')::numeric <> 0.50 or jsonb_array_length(r->'near_matches') <> 1 then
    raise exception 'hybrid: meaning-only near match wrong: %', r->'near_matches';
  end if;

  -- A row near in text and in meaning outranks one near in text only, and scores close to 1.
  r := public.vmi_chat_database('query_database', q || '{"filters":[{"column":"material_name","operator":"contains","value":"หม้อแปลงไฟฟ้า 3 เฟส 160kVA"}]}', request, e1);
  if r->>'status' <> 'no_data' or r #>> '{near_matches,0,material_id}' is distinct from 'LOCAL-HYB-TR'
     or (r #>> '{near_matches,0,match_score}')::numeric < 0.95
     or exists(select 1 from jsonb_array_elements(r->'near_matches') x where x->>'material_id' <> 'LOCAL-HYB-TR' and (x->>'match_score')::numeric > 0.5) then
    raise exception 'hybrid: fused ranking wrong: %', r->'near_matches';
  end if;

  -- The other filters and the role scope still apply to the meaning list.
  r := public.vmi_chat_database('query_database', q || '{"search":"zzqx wvvk","filters":[{"column":"material_id","operator":"eq","value":"LOCAL-HYB-CB"}]}', request, e1);
  if coalesce(jsonb_array_length(r->'near_matches'), 0) <> 0 then raise exception 'hybrid: filter ignored: %', r->'near_matches'; end if;

  -- A source without material_id ignores the embedding and ranks by text only.
  r := public.vmi_chat_database('query_database', '{"source_id":"core.districts","search":"zzqx wvvk"}', request, e1);
  if r->>'status' <> 'no_data' or coalesce(jsonb_array_length(r->'near_matches'), 0) <> 0 then
    raise exception 'hybrid: district source changed: %', r;
  end if;

  -- Without an embedding the text list alone ranks, and its first row scores 1.
  r := public.vmi_chat_database('query_database', q || '{"search":"surge arester 24kv"}', request);
  if r #>> '{near_matches,0,material_id}' is distinct from 'LOCAL-NEAR-SA' or (r #>> '{near_matches,0,match_score}')::numeric <> 1.00 then
    raise exception 'hybrid: text-only near match wrong: %', r->'near_matches';
  end if;

  -- Documents: first in both lists is 1, first in the text list only is 0.5, neither is nothing.
  r := public.vmi_chat_knowledge_bge_m3(e2, 3, 'ขั้นตอนการขอเติมพัสดุ');
  if r->>'status' <> 'ok' or r #>> '{data,0,source_id}' is distinct from 'LOCAL-HYB-DOC' or (r #>> '{data,0,match_score}')::numeric <> 1.00 then
    raise exception 'hybrid: document fused ranking wrong: %', r;
  end if;
  r := public.vmi_chat_knowledge_bge_m3(e1, 3, 'ขั้นตอนการขอเติมพัสดุ');
  if r #>> '{data,0,source_id}' is distinct from 'LOCAL-HYB-DOC' or (r #>> '{data,0,match_score}')::numeric <> 0.50 then
    raise exception 'hybrid: document text-only ranking wrong: %', r;
  end if;
  r := public.vmi_chat_knowledge_bge_m3(e1, 3);
  if r->>'status' <> 'no_data' then raise exception 'hybrid: unrelated document returned: %', r; end if;
end $$;
reset role;

-- Embeddings stay behind the service role: signed-in users cannot read them or run the daily job's functions.
do $$
begin
  if has_table_privilege('authenticated','rag.material_name_embeddings','select')
     or has_function_privilege('authenticated','public.material_embedding_queue(integer)','execute')
     or has_function_privilege('authenticated','public.material_embedding_save(jsonb)','execute')
     or has_function_privilege('anon','public.vmi_chat_database(text,jsonb,uuid,extensions.vector)','execute')
     or has_function_privilege('authenticated','ops.invoke_material_embeddings()','execute') then
    raise exception 'hybrid: embedding privileges too wide';
  end if;
end $$;

-- The daily job embeds names that have none or whose name changed, and never saves over a renamed material.
insert into rag.material_name_embeddings(material_id,name_md5,embedding)
select m.material_id, md5(m.material_name), (select array_agg((i=3)::int::real) from generate_series(1,1024) i)::extensions.vector
from core.materials m where m.material_id <> 'LOCAL-HYB-NEW' and nullif(btrim(m.material_name),'') is not null
on conflict (material_id) do nothing;
set local role service_role;
do $$
declare queued jsonb; saved integer;
  e4 text := (select array_agg((i=4)::int::real) from generate_series(1,1024) i)::extensions.vector::text;
begin
  queued := public.material_embedding_queue(100);
  if queued <> '[{"material_id":"LOCAL-HYB-NEW","material_name":"ฟิวส์แรงสูง 24kV 10A"}]'::jsonb then
    raise exception 'hybrid: queue wrong: %', queued;
  end if;
  saved := public.material_embedding_save(jsonb_build_array(jsonb_build_object('material_id','LOCAL-HYB-NEW','material_name','ชื่อเก่า','embedding',e4)));
  if saved <> 0 then raise exception 'hybrid: saved an embedding for a changed name'; end if;
  saved := public.material_embedding_save(jsonb_build_array(jsonb_build_object('material_id','LOCAL-HYB-NEW','material_name','ฟิวส์แรงสูง 24kV 10A','embedding',e4)));
  if saved <> 1 or public.material_embedding_queue(100) <> '[]'::jsonb then raise exception 'hybrid: save did not clear the queue'; end if;
end $$;
reset role;
update core.materials set material_name='หม้อแปลงไฟฟ้า 3 เฟส 22kV 160kVA (ใหม่)' where material_id='LOCAL-HYB-TR';
set local role service_role;
do $$
begin
  if public.material_embedding_queue(100) #>> '{0,material_id}' is distinct from 'LOCAL-HYB-TR' then
    raise exception 'hybrid: renamed material not queued: %', public.material_embedding_queue(100);
  end if;
end $$;
reset role;
