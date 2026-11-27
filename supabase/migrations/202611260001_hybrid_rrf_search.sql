-- Hybrid search with Reciprocal Rank Fusion (docs/adr/0002-rank-rows-in-postgres-by-near-match-and-meaning.md,
-- section "RRF"). Material names get BGE-M3 embeddings from Cloudflare Workers AI; a near match ranks rows by text
-- (pg_trgm) and by meaning, fuses the two ranks with RRF (k = 60), and reports the fused score as match_score (0-1).
-- Document knowledge ranks the same way. Without an embedding the text list alone ranks, as before.
begin;

create table if not exists rag.material_name_embeddings (
  material_id text primary key references core.materials(material_id) on delete cascade,
  name_md5 text not null check (name_md5 ~ '^[0-9a-f]{32}$'),
  embedding extensions.vector(1024) not null,
  embedding_model text not null default 'baai/bge-m3' check (embedding_model = 'baai/bge-m3'),
  embedded_at timestamptz not null default now()
);
comment on table rag.material_name_embeddings is 'BGE-M3 embedding of each material name; refreshed daily when the name changes (name_md5).';
alter table rag.material_name_embeddings enable row level security;
revoke all on rag.material_name_embeddings from public, anon, authenticated;
grant all on rag.material_name_embeddings to service_role;

-- Material names with no embedding, or whose name changed since it was made. Service role only (the daily job).
create or replace function public.material_embedding_queue(p_limit integer default 100)
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('material_id', q.material_id, 'material_name', q.material_name) order by q.material_id), '[]'::jsonb)
  from (select m.material_id, m.material_name from core.materials m
        left join rag.material_name_embeddings e on e.material_id = m.material_id
        where nullif(btrim(m.material_name), '') is not null and (e.material_id is null or e.name_md5 <> md5(m.material_name))
        order by m.material_id limit least(greatest(coalesce(p_limit, 100), 1), 500)) q
$$;
revoke all on function public.material_embedding_queue(integer) from public, anon, authenticated;
grant execute on function public.material_embedding_queue(integer) to service_role;

-- Saves embeddings for names that have not changed since the queue read them; returns how many were saved.
create or replace function public.material_embedding_save(p_rows jsonb)
returns integer language plpgsql security definer set search_path = pg_catalog as $$
declare saved integer;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'material_embedding_rows_invalid'; end if;
  insert into rag.material_name_embeddings(material_id, name_md5, embedding)
  select m.material_id, md5(m.material_name), (r->>'embedding')::extensions.vector(1024)
  from jsonb_array_elements(p_rows) r join core.materials m on m.material_id = r->>'material_id' and m.material_name = r->>'material_name'
  on conflict (material_id) do update set name_md5 = excluded.name_md5, embedding = excluded.embedding, embedded_at = now();
  get diagnostics saved = row_count;
  return saved;
end $$;
revoke all on function public.material_embedding_save(jsonb) from public, anon, authenticated;
grant execute on function public.material_embedding_save(jsonb) to service_role;

-- The chat passes the question's embedding only after a text search found nothing.
drop function if exists public.vmi_chat_database(text,jsonb,uuid);

create function public.vmi_chat_database(p_tool text,p_args jsonb,p_request_id uuid,p_embedding extensions.vector(1024) default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog
set statement_timeout='5s' set lock_timeout='1s' as $$
declare
  actor_role text; actor_district text; src ops.chat_sources%rowtype;
  predicate text; projection text:=''; grouping text:=''; ordering text:=''; sql text;
  item jsonb; col text; op text; value text; typ text; agg text; output_name text;
  selected text[]:='{}'; output_columns text[]:='{}'; result jsonb; result_count integer;
  row_limit integer; row_offset integer; search_text text; search_columns text:='';
  text_match text:=''; doc text; near_terms text:=''; near jsonb;
  plain_columns text; keyword_score text; meaning_score text:='null::double precision'; meaning_join text:=''; lists integer;
begin
  if auth.uid() is null then raise sqlstate '28000' using message='Authentication required'; end if;
  select role::text,district_id into actor_role,actor_district from public.user_profiles where user_id=auth.uid() and is_active;
  if actor_role is null or not exists(select 1 from audit.vmi_chat_admissions
      where request_id=p_request_id and actor_id=auth.uid() and created_at>clock_timestamp()-interval '2 minutes') then
    return jsonb_build_object('status','forbidden');
  end if;
  if p_args is null or jsonb_typeof(p_args)<>'object' or octet_length(p_args::text)>16000 then
    return jsonb_build_object('status','invalid_input');
  end if;
  if p_tool='discover_database' then
    select coalesce(jsonb_agg(jsonb_build_object('source_id',source_id,'description',description,'columns',columns) order by source_id),'[]') into result
    from ops.chat_sources where ops.chat_source_predicate(source_id,actor_role,actor_district) is not null;
    return jsonb_build_object('status','ok','tool',p_tool,'data',result,'scope',jsonb_build_object('role',actor_role,'district_id',actor_district));
  end if;
  if p_tool<>'query_database' or exists(select 1 from jsonb_object_keys(p_args) k where k not in
    ('source_id','columns','filters','group_by','metrics','order_column','order_direction','limit','offset','search')) then
    return jsonb_build_object('status','invalid_input');
  end if;
  select * into src from ops.chat_sources where source_id=p_args->>'source_id';
  predicate := ops.chat_source_predicate(src.source_id,actor_role,actor_district);
  if predicate is null then return jsonb_build_object('status','forbidden'); end if;
  select string_agg(format('coalesce(t.%I::text,'''')',key),',') into search_columns from jsonb_each_text(src.columns);
  doc:=format('lower(concat_ws('' '',%s))',search_columns);
  row_limit:=coalesce((p_args->>'limit')::integer,20); row_offset:=coalesce((p_args->>'offset')::integer,0);
  if row_limit not between 1 and 50 or row_offset not between 0 and 10000 then raise invalid_parameter_value; end if;
  if jsonb_typeof(coalesce(p_args->'filters','[]'))<>'array' or jsonb_array_length(coalesce(p_args->'filters','[]'))>12
    or jsonb_typeof(coalesce(p_args->'metrics','[]'))<>'array' or jsonb_array_length(coalesce(p_args->'metrics','[]'))>6
    or jsonb_typeof(coalesce(p_args->'group_by','[]'))<>'array' or jsonb_array_length(coalesce(p_args->'group_by','[]'))>4
    or jsonb_typeof(coalesce(p_args->'columns','[]'))<>'array' or jsonb_array_length(coalesce(p_args->'columns','[]'))>16 then raise invalid_parameter_value; end if;
  for item in select * from jsonb_array_elements(coalesce(p_args->'filters','[]')) loop
    if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k where k not in ('column','operator','value')) then raise invalid_parameter_value; end if;
    col:=item->>'column'; op:=item->>'operator'; value:=item->>'value'; typ:=src.columns->>col;
    if typ is null or length(value)>1000 then raise invalid_parameter_value; end if;
    if op in ('is_null','not_null') then predicate:=predicate||format(' and t.%I is %s null',col,case when op='not_null' then 'not' else '' end);
    elsif value is null then raise invalid_parameter_value;
    elsif op='contains' then text_match:=text_match||format(' and strpos(lower(t.%I::text),lower(%L))>0',col,value);
      near_terms:=near_terms||format(',greatest(extensions.word_similarity(lower(%L),lower(t.%I::text)),extensions.word_similarity(lower(%L),%s))',value,col,value,doc);
    elsif op in ('eq','ne','gt','gte','lt','lte') then
      predicate:=predicate||format(' and t.%I %s %L::%s',col,case op when 'eq' then '=' when 'ne' then '<>' when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end,value,typ);
    else raise invalid_parameter_value; end if;
  end loop;
  search_text:=nullif(btrim(p_args->>'search'),'');
  if search_text is not null then
    if length(search_text)>200 then raise invalid_parameter_value; end if;
    select text_match||string_agg(format(' and strpos(%s,%L)>0',doc,w),'') into text_match
    from regexp_split_to_table(lower(search_text),'\s+') w where w<>'';
    near_terms:=near_terms||format(',extensions.word_similarity(lower(%L),%s)',search_text,doc);
  end if;
  -- predicate keeps the role scope and the other filters; text_match is the exact text conditions.
  if jsonb_array_length(coalesce(p_args->'metrics','[]'))>0 then
    for col in select jsonb_array_elements_text(coalesce(p_args->'group_by','[]')) loop
      if not src.columns ? col or col=any(selected) then raise invalid_parameter_value; end if;
      selected:=array_append(selected,col); projection:=concat_ws(', ',nullif(projection,''),format('t.%I',col));
      grouping:=concat_ws(', ',nullif(grouping,''),format('t.%I',col));
    end loop;
    output_columns:=selected;
    for item in select * from jsonb_array_elements(p_args->'metrics') loop
      if jsonb_typeof(item)<>'object' or exists(select 1 from jsonb_object_keys(item) k where k not in ('function','column')) then raise invalid_parameter_value; end if;
      col:=item->>'column'; agg:=item->>'function'; typ:=src.columns->>col;
      if agg not in ('count','sum','avg','min','max') or (col<>'*' and typ is null) or (col='*' and agg<>'count') then raise invalid_parameter_value; end if;
      if agg in ('sum','avg') and typ !~ '^(smallint|integer|bigint|numeric|real|double precision)' then raise invalid_parameter_value; end if;
      output_name:=agg||'_'||case when col='*' then 'rows' else col end;
      if output_name=any(output_columns) then raise invalid_parameter_value; end if;
      output_columns:=array_append(output_columns,output_name);
      projection:=concat_ws(', ',nullif(projection,''),format('%s(%s) as %I',agg,case when col='*' then '*' else format('t.%I',col) end,output_name));
    end loop;
  else
    if jsonb_array_length(coalesce(p_args->'group_by','[]'))>0 then raise invalid_parameter_value; end if;
    for col in select jsonb_array_elements_text(coalesce(p_args->'columns','[]')) loop
      if not src.columns ? col or col=any(selected) then raise invalid_parameter_value; end if;
      selected:=array_append(selected,col);
    end loop;
    if cardinality(selected)=0 then select array_agg(key) into selected from (select key from jsonb_object_keys(src.columns) key order by key limit 16) q; end if;
    select string_agg(format('t.%I',x),', ') into projection from unnest(selected) x;
    output_columns:=selected;
  end if;
  col:=nullif(p_args->>'order_column','');
  if col is not null then
    if not col=any(output_columns) or coalesce(p_args->>'order_direction','asc') not in ('asc','desc') then raise invalid_parameter_value; end if;
    ordering:=format(' order by %I %s nulls last',col,coalesce(p_args->>'order_direction','asc'));
  elsif search_text is not null and jsonb_array_length(coalesce(p_args->'metrics','[]'))=0 then
    -- The database ranks rows by how near they are to the search term; no model reranks them.
    ordering:=format(' order by extensions.word_similarity(lower(%L),%s) desc, 1',search_text,doc);
  else ordering:=' order by 1'; end if;
  sql:=format('select coalesce(jsonb_agg(to_jsonb(q)),''[]'') from (select %s from %s t where %s%s%s limit %s offset %s) q',
    projection,src.relation,predicate||text_match,case when grouping<>'' then ' group by '||grouping else '' end,ordering,row_limit+1,row_offset);
  execute sql into result;
  result_count:=jsonb_array_length(result);
  select coalesce(jsonb_agg(e.value order by e.ord),'[]') into result from jsonb_array_elements(result) with ordinality e(value,ord) where e.ord<=row_limit;
  -- รายการใกล้เคียง (ADR 0002): nothing matched exactly. Rows near the text (pg_trgm >= 0.4) and, for a source
  -- with material_id and a question embedding, rows whose material name means the same (cosine >= 0.5) are ranked
  -- in two lists and fused by Reciprocal Rank Fusion, sum of 1/(60 + rank). match_score is that sum over its maximum,
  -- so 1 means first in every list that ran; the role scope and the other filters still apply.
  if result_count=0 and near_terms<>'' and jsonb_array_length(coalesce(p_args->'metrics','[]'))=0 then
    keyword_score:=format('least(%s)',substr(near_terms,2));
    if p_embedding is not null and src.columns ? 'material_id' and extensions.vector_norm(p_embedding)>0 then
      meaning_score:='1-(e.embedding operator(extensions.<=>) $1)';
      meaning_join:=' left join rag.material_name_embeddings e on e.material_id=t.material_id::text';
    end if;
    lists:=1+(meaning_join<>'')::integer;
    select string_agg(format('%I',x),', ') into plain_columns from unnest(selected) x;
    execute format('select coalesce(jsonb_agg(to_jsonb(q) order by q.match_score desc),''[]'') from ('
      ||'select %s, round(((coalesce(1.0/(60+keyword_rank),0)+coalesce(1.0/(60+meaning_rank),0))*61/%s)::numeric,2) as match_score from ('
      ||'select c.*, case when near_keyword>=0.4 then rank() over (order by near_keyword desc nulls last) end as keyword_rank,'
      ||' case when near_meaning>=0.5 then rank() over (order by near_meaning desc nulls last) end as meaning_rank from ('
      ||'select %s, %s as near_keyword, %s as near_meaning from (select * from %s t where %s limit 20000) t%s) c'
      ||' where near_keyword>=0.4 or near_meaning>=0.5) r order by match_score desc limit 5) q',
      plain_columns,lists,projection,keyword_score,meaning_score,src.relation,predicate,meaning_join) into near using p_embedding;
  end if;
  return jsonb_build_object('status',case when result_count=0 then 'no_data' else 'ok' end,'tool',p_tool,
    'source_id',src.source_id,'data',result,'sources',jsonb_build_array(src.source_id),
    'scope',jsonb_build_object('role',actor_role,'district_id',actor_district,'truncated',result_count>row_limit),
    'query',p_args,'aggregation',jsonb_array_length(coalesce(p_args->'metrics','[]'))>0,'observed_at',clock_timestamp())
    ||case when near is null then '{}'::jsonb else jsonb_build_object('near_matches',near) end;
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range or undefined_function or datatype_mismatch then
  return jsonb_build_object('status','invalid_input');
end $$;

revoke all on function public.vmi_chat_database(text,jsonb,uuid,extensions.vector) from public,anon,authenticated;
grant execute on function public.vmi_chat_database(text,jsonb,uuid,extensions.vector) to authenticated;

-- Documents: the same two lists and RRF. p_query is the masked question text for the text list.
drop function if exists public.vmi_chat_knowledge_bge_m3(extensions.vector,integer);
create function public.vmi_chat_knowledge_bge_m3(p_embedding extensions.vector(1024), p_limit integer default 6, p_query text default null)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog
set statement_timeout = '5s' as $$
declare result jsonb; lists integer := 1 + (nullif(btrim(p_query), '') is not null)::integer;
begin
  if auth.uid() is null then raise sqlstate '28000' using message = 'Authentication required'; end if;
  if p_embedding is null or extensions.vector_dims(p_embedding) <> 1024
    or extensions.vector_norm(p_embedding) = 0 or p_limit is null or p_limit not between 1 and 12 or length(p_query) > 1000 then
    return jsonb_build_object('status','invalid_input','tool','search_knowledge');
  end if;
  select coalesce(jsonb_agg(to_jsonb(matches) order by matches.match_score desc), '[]'::jsonb) into result from (
    select id, source_id, title, content, updated_at,
      round(((coalesce(1.0/(60+keyword_rank),0) + coalesce(1.0/(60+meaning_rank),0)) * 61 / lists)::numeric, 2) as match_score
    from (
      select k.*, case when near_keyword >= 0.4 then rank() over (order by near_keyword desc nulls last) end as keyword_rank,
        case when near_meaning >= 0.5 then rank() over (order by near_meaning desc nulls last) end as meaning_rank
      from (
        select c.*, case when nullif(btrim(p_query), '') is null then null
            else extensions.word_similarity(lower(p_query), lower(c.content)) end as near_keyword,
          1 - (c.embedding operator(extensions.<=>) p_embedding) as near_meaning
        from rag.knowledge_chunks_bge_m3 c where c.embedding_model = 'baai/bge-m3'
      ) k where near_keyword >= 0.4 or near_meaning >= 0.5
    ) r order by match_score desc limit p_limit
  ) matches;
  return jsonb_build_object('status',case when jsonb_array_length(result)>0 then 'ok' else 'no_data' end,
    'tool','search_knowledge','data',result,'observed_at',now(),
    'sources',(select coalesce(jsonb_agg(distinct x->>'source_id'),'[]'::jsonb) from jsonb_array_elements(result) x));
end $$;
revoke all on function public.vmi_chat_knowledge_bge_m3(extensions.vector,integer,text) from public,anon;
grant execute on function public.vmi_chat_knowledge_bge_m3(extensions.vector,integer,text) to authenticated;

-- Daily job: pg_cron + pg_net call the production route with the same Vault secret as agentic alerts.
-- The cron job itself is scheduled in production after the route is deployed, so a fresh database never calls out.
create or replace function ops.invoke_material_embeddings() returns bigint
language plpgsql security definer set search_path=pg_catalog as $$
declare secret text;
begin
 select decrypted_secret into secret from vault.decrypted_secrets where name='synapse-agentic-prod-cron';
 if secret is null then raise exception 'agentic_cron_secret_missing'; end if;
 return net.http_get(url:='https://mea-synapse-web.vercel.app/api/internal/material-embeddings',
  headers:=jsonb_build_object('Authorization','Bearer '||secret),timeout_milliseconds:=100000);
end;
$$;
revoke all on function ops.invoke_material_embeddings() from public,anon,authenticated;
grant execute on function ops.invoke_material_embeddings() to service_role;

insert into ops.schema_migrations (version, module, description, source_file)
values ('202611260001', 'AGENT', 'Hybrid search: BGE-M3 material name embeddings, near matches and documents ranked by text and meaning fused with RRF (k = 60).',
  'supabase/migrations/202611260001_hybrid_rrf_search.sql')
on conflict do nothing;

notify pgrst, 'reload schema';
commit;
