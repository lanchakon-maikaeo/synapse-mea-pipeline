-- Included by local_pipeline_workflow_verify.sql inside its rollback transaction, after hybrid_search_verify.sql.
-- ADR 0002, section "คำ SAP": a Thai search carries its SAP words as near_text, and the text list ranks a row by the
-- share of those words it holds when that beats its pg_trgm similarity. Production names spelled as in core.materials.
insert into core.materials(material_id,sap_material_id,material_name,category,unit,is_vmi,master_source,data_quality_status,source_batch_id)
select v.id,v.id,v.name,'TEST','EA',true,'material_master','valid',m.source_batch_id
from core.materials m, (values ('LOCAL-SAP-250','TRANS 3P4W 12/24KV D416Y240V 250KVA(SL)'),
  ('LOCAL-SAP-1250','TRANS3P4W1224KV D416Y240V1250KVA (SL)'), ('LOCAL-SAP-300','CONV TRANS 3 P 24 KV 300 KVA'),
  ('LOCAL-SAP-185','คีมล๊อคช่วยปอกสายไฟฟ้า ขนาด 185 sq.mm.'), ('LOCAL-SAP-400','TRANS 3P3W 12/24KV 400KVA 220V(SL)')) v(id,name)
where m.material_id='LOCAL-VMI-001';
-- Meaning vectors for the case below: by meaning 300 kVA (cosine 1) > 400 kVA (0.9) > 250 kVA (0.6).
insert into rag.material_name_embeddings(material_id,name_md5,embedding)
select m.material_id, md5(m.material_name), (select array_agg(case i when 5 then v.a when 6 then v.b else 0 end::real) from generate_series(1,1024) i)::extensions.vector
from core.materials m join (values ('LOCAL-SAP-300',1.0,0.0),('LOCAL-SAP-400',0.9,0.436),('LOCAL-SAP-250',0.6,0.8)) v(id,a,b) on v.id=m.material_id;

select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare r jsonb; request uuid := gen_random_uuid();
  q jsonb := '{"source_id":"core.materials","columns":["material_id","material_name"],"group_by":[],"metrics":[],"order_column":null,"order_direction":"asc","limit":20,"offset":0,"search":null,"filters":[{"column":"material_name","operator":"contains","value":"หม้อแปลงไฟฟ้า 3 เฟส 250kVA"}]}';
  ids text;
begin
  if public.vmi_chat_admit(request)->>'status' <> 'ok' then raise exception 'sap terms: admission failed'; end if;

  -- The Thai words alone never meet the English name.
  r := public.vmi_chat_database('query_database', q, request);
  if exists(select 1 from jsonb_array_elements(coalesce(r->'near_matches','[]')) x where x->>'material_id' like 'LOCAL-SAP-%') then
    raise exception 'sap terms: Thai text alone matched an English name: %', r->'near_matches';
  end if;

  -- With its SAP words the 250 kVA transformer comes first and alone at 1; 300 kVA holds two of three words;
  -- 1250KVA glued to other letters and digits holds one, under the floor.
  r := public.vmi_chat_database('query_database', q || '{"near_text":"trans 3p 250kva"}', request);
  select string_agg(x->>'material_id', ',' order by o) into ids from jsonb_array_elements(r->'near_matches') with ordinality e(x,o);
  if r->>'status' <> 'no_data' or r #>> '{near_matches,0,material_id}' is distinct from 'LOCAL-SAP-250'
     or (r #>> '{near_matches,0,match_score}')::numeric <> 1.00 or ids like '%LOCAL-SAP-1250%'
     or (r #>> '{near_matches,1,match_score}')::numeric >= 1.00
     or r #>> '{query,filters,0,value}' is distinct from 'หม้อแปลงไฟฟ้า 3 เฟส 250kVA' then
    raise exception 'sap terms: ranking wrong: %', r->'near_matches';
  end if;

  -- Production 27 Nov, with a question embedding: 107 TRANS 3P names hold two of the three words and tie at rank 2
  -- of the text list, and BGE-M3 does not tell 250 from 400 kVA. Plain RRF put the 400 kVA transformer first. With
  -- SAP words, a row's fused score is scaled by how near its text is, so the one name holding them all stays first.
  r := public.vmi_chat_database('query_database', q || '{"near_text":"trans 3p 250kva"}', request,
    (select array_agg((i=5)::int::real) from generate_series(1,1024) i)::extensions.vector);
  if r #>> '{near_matches,0,material_id}' is distinct from 'LOCAL-SAP-250' or (r #>> '{near_matches,0,match_score}')::numeric < 0.9
     or (r #>> '{near_matches,1,match_score}')::numeric > 0.7 then
    raise exception 'sap terms: meaning list outranked the name holding every SAP word: %', r->'near_matches';
  end if;

  -- "185 sq.mm." reads as 185sqmm, found by the SAP word alone (the Thai text is near nothing).
  r := public.vmi_chat_database('query_database', q || '{"filters":[{"column":"material_name","operator":"contains","value":"ซซซซ"}],"near_text":"185sqmm"}', request);
  if not exists(select 1 from jsonb_array_elements(r->'near_matches') x where x->>'material_id'='LOCAL-SAP-185' and (x->>'match_score')::numeric=1.00) then
    raise exception 'sap terms: sq.mm. not read as sqmm: %', r->'near_matches';
  end if;

  -- Only lowercase letters, digits and | between alternatives, at most 12 words: anything else reads nothing.
  foreach ids in array array['trans|', '|trans', 'trans||3p', '(trans', 'trans 3p.*', 'TRANS', 'สาย 185sqmm', 'a b c d e f g h i j k l m'] loop
    r := public.vmi_chat_database('query_database', q || jsonb_build_object('near_text', ids), request);
    if r->>'status' <> 'invalid_input' then raise exception 'sap terms: near_text % accepted: %', ids, r; end if;
  end loop;
end $$;
reset role;
