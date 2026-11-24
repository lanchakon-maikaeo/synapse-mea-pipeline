-- การค้นแบบใกล้เคียง (docs/adr/0002-rank-rows-in-postgres-by-near-match-and-meaning.md).
-- A contains filter still matches its text exactly; a search matches when every word of it appears,
-- in any order (the app splits Thai search terms into words). When a search or contains filter finds no rows,
-- it returns up to five รายการใกล้เคียง ranked by pg_trgm within the same role scope and
-- filters, and a search ranks the rows it finds by how near they are, so no model reranks rows.
begin;

create extension if not exists pg_trgm with schema extensions;

create or replace function public.vmi_chat_database(p_tool text,p_args jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
set statement_timeout='5s' set lock_timeout='1s' as $$
declare
  actor_role text; actor_district text; src ops.chat_sources%rowtype;
  predicate text; projection text:=''; grouping text:=''; ordering text:=''; sql text;
  item jsonb; col text; op text; value text; typ text; agg text; output_name text;
  selected text[]:='{}'; output_columns text[]:='{}'; result jsonb; result_count integer;
  row_limit integer; row_offset integer; search_text text; search_columns text:='';
  text_match text:=''; doc text; near_terms text:=''; near jsonb;
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
  -- รายการใกล้เคียง (ADR 0002): nothing matched exactly, so rank the same scope and filters by pg_trgm.
  if result_count=0 and near_terms<>'' and jsonb_array_length(coalesce(p_args->'metrics','[]'))=0 then
    execute format('select coalesce(jsonb_agg(to_jsonb(q) order by q.match_score desc),''[]'') from (select %s, round(least(%s)::numeric,2) as match_score from (select * from %s t where %s limit 20000) t where least(%s)>=0.4 order by match_score desc limit 5) q',
      projection,substr(near_terms,2),src.relation,predicate,substr(near_terms,2)) into near;
  end if;
  return jsonb_build_object('status',case when result_count=0 then 'no_data' else 'ok' end,'tool',p_tool,
    'source_id',src.source_id,'data',result,'sources',jsonb_build_array(src.source_id),
    'scope',jsonb_build_object('role',actor_role,'district_id',actor_district,'truncated',result_count>row_limit),
    'query',p_args,'aggregation',jsonb_array_length(coalesce(p_args->'metrics','[]'))>0,'observed_at',clock_timestamp())
    ||case when near is null then '{}'::jsonb else jsonb_build_object('near_matches',near) end;
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range or undefined_function or datatype_mismatch then
  return jsonb_build_object('status','invalid_input');
end $$;

revoke all on function public.vmi_chat_database(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.vmi_chat_database(text,jsonb,uuid) to authenticated;

insert into ops.schema_migrations (version, module, description, source_file)
values ('202611250001', 'AGENT', 'Near-match search: pg_trgm รายการใกล้เคียง when a text search finds nothing, search words matched in any order, and search rows ranked in the database.',
  'supabase/migrations/202611250001_near_match_search.sql')
on conflict do nothing;

notify pgrst, 'reload schema';
commit;
