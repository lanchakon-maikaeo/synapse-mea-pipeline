-- Additive corpus: keep the Gemini table/RPC used by main intact.
begin;

create extension if not exists vector with schema extensions;
create table rag.knowledge_chunks_bge_m3 (
  id uuid primary key default gen_random_uuid(),
  source_id text not null check (length(source_id) between 1 and 500),
  title text not null check (length(title) between 1 and 500),
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (length(content) between 1 and 8000),
  embedding extensions.vector(1024) not null,
  embedding_model text not null default 'baai/bge-m3'
    check (embedding_model = 'baai/bge-m3'),
  allowed_roles text[] not null default array['admin']::text[]
    check (cardinality(allowed_roles) > 0 and allowed_roles <@ array['admin','planner','district','viewer','academic','picker']::text[]),
  district_id text references core.districts(district_id),
  updated_at timestamptz not null default now(),
  unique(source_id, chunk_index)
);
comment on table rag.knowledge_chunks_bge_m3 is 'Reviewed document chunks; semantic retrieval only. Operational values must be queried live.';
alter table rag.knowledge_chunks_bge_m3 enable row level security;
revoke all on rag.knowledge_chunks_bge_m3 from public, anon, authenticated;
grant usage on schema rag to authenticated;
grant select on rag.knowledge_chunks_bge_m3 to authenticated;
grant all on rag.knowledge_chunks_bge_m3 to service_role;
create policy knowledge_read on rag.knowledge_chunks_bge_m3 for select to authenticated using (
  exists (select 1 from public.user_profiles p where p.user_id = (select auth.uid()) and p.is_active
    and (p.role::text = 'admin' or (p.role::text = any(allowed_roles)
      and (knowledge_chunks_bge_m3.district_id is null or knowledge_chunks_bge_m3.district_id = p.district_id))))
);
create index knowledge_chunks_bge_m3_embedding_hnsw on rag.knowledge_chunks_bge_m3
  using hnsw (embedding extensions.vector_cosine_ops);

create function public.vmi_chat_knowledge_bge_m3(p_embedding extensions.vector(1024), p_limit integer default 6)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog
set statement_timeout = '5s' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise sqlstate '28000' using message = 'Authentication required'; end if;
  if p_embedding is null or extensions.vector_dims(p_embedding) <> 1024
    or extensions.vector_norm(p_embedding) = 0 or p_limit is null or p_limit not between 1 and 12 then
    return jsonb_build_object('status','invalid_input','tool','search_knowledge');
  end if;
  select coalesce(jsonb_agg(to_jsonb(matches)), '[]'::jsonb) into result from (
    select id, source_id, title, content, updated_at,
      1 - (embedding operator(extensions.<=>) p_embedding) as similarity
    from rag.knowledge_chunks_bge_m3
    where embedding_model = 'baai/bge-m3'
      and 1 - (embedding operator(extensions.<=>) p_embedding) >= 0.5
    order by embedding operator(extensions.<=>) p_embedding limit p_limit
  ) matches;
  return jsonb_build_object('status',case when jsonb_array_length(result)>0 then 'ok' else 'no_data' end,
    'tool','search_knowledge','data',result,'observed_at',now(),
    'sources',(select coalesce(jsonb_agg(distinct x->>'source_id'),'[]'::jsonb) from jsonb_array_elements(result) x));
end $$;
revoke all on function public.vmi_chat_knowledge_bge_m3(extensions.vector,integer) from public,anon;
grant execute on function public.vmi_chat_knowledge_bge_m3(extensions.vector,integer) to authenticated;

-- Registered on main so the deploy script does not apply it twice.
insert into ops.schema_migrations(version,module,description,source_file)
values('202611100007','P03','BGE-M3 (1024-dim) knowledge chunks and scoped retrieval.',
  'supabase/migrations/202611100007_p03_bge_m3_knowledge.sql');
notify pgrst, 'reload schema';
commit;
