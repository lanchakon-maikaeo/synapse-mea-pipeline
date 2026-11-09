-- Runs inside a rollback-only transaction; never leaves synthetic embeddings in the corpus.
begin;
select set_config('test.admin', (select user_id::text from public.user_profiles where role::text='admin' and is_active limit 1), true);
select set_config('test.district', (select user_id::text from public.user_profiles where role::text='district' and district_id is not null and is_active limit 1), true);
select set_config('test.district_id', (select district_id from public.user_profiles where user_id::text=current_setting('test.district')), true);
insert into rag.knowledge_chunks_bge_m3(source_id,title,chunk_index,content,embedding,allowed_roles,district_id)
select '__vector_test__', 'Vector verification', i, 'test knowledge '||i,
  (array[1::real]||array_fill(0::real,array[1023]))::extensions.vector,
  case when i=0 then array['admin'] else array['district'] end,
  case when i=2 then (select district_id from core.districts where district_id<>current_setting('test.district_id') limit 1) else null end
from generate_series(0,2) i;
set local role authenticated;
do $$
declare r jsonb; v extensions.vector := (array[1::real]||array_fill(0::real,array[1023]))::extensions.vector;
begin
  assert current_setting('test.admin')<>'' and current_setting('test.district')<>'', 'test requires active admin and district identities';
  perform set_config('request.jwt.claim.sub',current_setting('test.admin'),true);
  assert (select count(*)=3 from rag.knowledge_chunks_bge_m3 where source_id='__vector_test__'), 'admin may read all test chunks';
  r := public.vmi_chat_knowledge_bge_m3(v,12);
  assert r->>'status'='ok', 'vector match works';
  assert jsonb_array_length(r->'data')<=12, 'bounded vector results';
  r := public.vmi_chat_knowledge_bge_m3(v,13);
  assert r->>'status'='invalid_input', 'limit is enforced';
  r := public.vmi_chat_knowledge_bge_m3(array_fill(0::real,array[1024])::extensions.vector,6);
  assert r->>'status'='invalid_input', 'zero vector rejected';
  r := public.vmi_chat_knowledge_bge_m3((array[1::real]||array_fill(0::real,array[767]))::extensions.vector,6);
  assert r->>'status'='invalid_input', 'old Gemini vector dimensions rejected';
  perform set_config('request.jwt.claim.sub',current_setting('test.district'),true);
  assert (select count(*)=1 from rag.knowledge_chunks_bge_m3 where source_id='__vector_test__'), 'role and district isolation';
  r := public.vmi_chat_knowledge_bge_m3(v,12);
  assert not exists(select 1 from jsonb_array_elements(r->'data') x where x->>'source_id'='__vector_test__' and x->>'content'<>'test knowledge 1'), 'RPC preserves RLS';
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  assert (select count(*)=0 from rag.knowledge_chunks_bge_m3), 'unknown identity sees no chunks';
  assert not has_table_privilege('authenticated','rag.knowledge_chunks_bge_m3','INSERT'), 'chat cannot write knowledge';
  assert not has_function_privilege('anon','public.vmi_chat_knowledge_bge_m3(extensions.vector,integer)','EXECUTE'), 'anon cannot search';
end $$;
rollback;
select 'knowledge vector and RLS checks passed' as result;
