begin;

-- A reviewed snapshot, not automatic access to future tables or columns.
create table ops.chat_sources (
  source_id text primary key,
  relation regclass not null unique,
  description text not null,
  columns jsonb not null,
  access_mode text not null check (access_mode in ('admin','reporting','master','district','location'))
);
alter table ops.chat_sources enable row level security;
revoke all on ops.chat_sources from public, anon, authenticated;

insert into ops.chat_sources(source_id,relation,description,columns,access_mode)
select n.nspname||'.'||c.relname,c.oid,
  concat_ws(' ',obj_description(c.oid),replace(c.relname,'_',' '),
    case when c.relname ~ 'district' then 'เขต พื้นที่ รหัส ชื่อ นวลจันทร์'
      when c.relname ~ 'material|packaging' then 'พัสดุ วัสดุ สินค้า SKU หน่วย บรรจุภัณฑ์'
      when c.relname ~ 'stock|inventory|fifo|handling|receipt' then 'สต็อก คงเหลือ คลัง รับ จ่าย เคลื่อนไหว ประวัติ'
      when c.relname ~ 'contract|vendor|delivery' then 'สัญญา PO จัดซื้อ ผู้ขาย ส่งมอบ'
      when c.relname ~ 'usage|demand|forecast' then 'อัตราใช้ CMP พยากรณ์ รายเดือน ย้อนหลัง'
      when c.relname ~ 'replenishment|quantity|approval|adjustment' then 'แผนเติม แนะนำ ปริมาณ อนุมัติ ยืนยัน'
      when c.relname ~ 'transport|route|vehicle|driver' then 'ขนส่ง เส้นทาง รถ คนขับ เที่ยว ค่าขนส่ง'
      when c.relname ~ 'warehouse|location' then 'คลัง ที่ตั้ง สถานที่'
      else 'ข้อมูลระบบ นำเข้า คุณภาพ หลักฐาน' end),
  (select jsonb_object_agg(a.attname,format_type(a.atttypid,a.atttypmod))
   from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
   and a.attname !~* 'password|secret|token|api_key|authorization'),
  case when c.relname in ('districts','materials','warehouses','locations','transport_warehouses','sap_plant_district_map') then 'master'
    when n.nspname in ('core','analytics','ops') and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='district_id') then 'district'
    when n.nspname in ('core','analytics') and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='location_id') then 'location'
    when n.nspname in ('core','analytics') or c.relname in ('data_quality_rules','data_quality_issues') then 'reporting'
    else 'admin' end
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname in ('core','analytics','ops','raw','staging','reference_data')
    or (n.nspname='public' and c.relname in ('contracts','user_profiles'))
    or (n.nspname='audit' and c.relname='change_log')) and c.relkind in ('r','v','m')
  and c.relname not in ('chat_sources','one_time_worker_triggers','api_rate_limit_windows');

-- Access checks run again for every read; model-selected scope is never authority.
create function ops.chat_source_predicate(p_source text,p_role text,p_district text)
returns text language plpgsql stable set search_path=pg_catalog as $$
declare mode text;
begin
  select access_mode into mode from ops.chat_sources where source_id=p_source;
  if mode is null then return null; end if;
  if p_role='admin' or mode='master' then return 'true'; end if;
  if p_role in ('planner','viewer') and mode<>'admin' then return 'true'; end if;
  if mode='district' then
    if p_role='district' and p_district is not null then
      return format('t.district_id = %L',p_district);
    elsif p_role in ('academic','picker') then return 'true'; end if;
  end if;
  if mode='location' and p_role='district' and p_district is not null then
    return format('t.location_id in (select location_id from core.locations where district_id=%L or location_type=''WAREHOUSE'')',p_district);
  end if;
  if mode='location' and p_role in ('academic','picker') then return 'true'; end if;
  return null;
end $$;
revoke all on function ops.chat_source_predicate(text,text,text) from public,anon,authenticated;

create function public.vmi_chat_database(p_tool text,p_args jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
set statement_timeout='5s' set lock_timeout='1s' as $$
declare
  actor_role text; actor_district text; src ops.chat_sources%rowtype;
  predicate text; projection text:=''; grouping text:=''; ordering text:=''; sql text;
  item jsonb; col text; op text; value text; typ text; agg text; output_name text;
  selected text[]:='{}'; output_columns text[]:='{}'; result jsonb; result_count integer;
  row_limit integer; row_offset integer; search_text text; search_columns text:='';
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
    elsif op='contains' then predicate:=predicate||format(' and strpos(lower(t.%I::text),lower(%L))>0',col,value);
    elsif op in ('eq','ne','gt','gte','lt','lte') then
      predicate:=predicate||format(' and t.%I %s %L::%s',col,case op when 'eq' then '=' when 'ne' then '<>' when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end,value,typ);
    else raise invalid_parameter_value; end if;
  end loop;
  search_text:=nullif(btrim(p_args->>'search'),'');
  if search_text is not null then
    if length(search_text)>200 then raise invalid_parameter_value; end if;
    select string_agg(format('coalesce(t.%I::text,'''')',key),',') into search_columns from jsonb_each_text(src.columns);
    predicate:=predicate||format(' and strpos(lower(concat_ws('' '',%s)),lower(%L))>0',search_columns,search_text);
  end if;
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
  else ordering:=' order by 1'; end if;
  sql:=format('select coalesce(jsonb_agg(to_jsonb(q)),''[]'') from (select %s from %s t where %s%s%s limit %s offset %s) q',
    projection,src.relation,predicate,case when grouping<>'' then ' group by '||grouping else '' end,ordering,row_limit+1,row_offset);
  execute sql into result;
  result_count:=jsonb_array_length(result);
  select coalesce(jsonb_agg(e.value order by e.ord),'[]') into result from jsonb_array_elements(result) with ordinality e(value,ord) where e.ord<=row_limit;
  return jsonb_build_object('status',case when result_count=0 then 'no_data' else 'ok' end,'tool',p_tool,
    'source_id',src.source_id,'data',result,'sources',jsonb_build_array(src.source_id),
    'scope',jsonb_build_object('role',actor_role,'district_id',actor_district,'truncated',result_count>row_limit),
    'query',p_args,'aggregation',jsonb_array_length(coalesce(p_args->'metrics','[]'))>0,'observed_at',clock_timestamp());
exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range or undefined_function or datatype_mismatch then
  return jsonb_build_object('status','invalid_input');
end $$;
revoke all on function public.vmi_chat_database(text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.vmi_chat_database(text,jsonb,uuid) to authenticated;
insert into ops.schema_migrations(version,module,description,source_file)
values('20260908142904','P02','Reviewed database catalog and scoped structured read queries.',
 'supabase/migrations/20260908142904_p02_agent_database_catalog.sql');
notify pgrst,'reload schema';
commit;
