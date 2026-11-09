begin;
-- Fixed overview projection; identity always comes from the authenticated caller.
create function public.vmi_chat_overview(p_tool text, p_args jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog set statement_timeout = '5s' set lock_timeout = '1s'
as $$
declare
  actor uuid := auth.uid(); actor_role text; actor_district text;
  district_filter text; material_filter text; result_rows jsonb; total integer;
begin
  if actor is null then raise sqlstate '28000' using message = 'Authentication required'; end if;
  select role::text, district_id into actor_role, actor_district
  from public.user_profiles where user_id = actor and is_active;
  if actor_role is null then return jsonb_build_object('status','forbidden'); end if;
  if p_tool is distinct from 'get_operations_overview' or p_request_id is null
    or p_args is null or jsonb_typeof(p_args) <> 'object' or octet_length(p_args::text) > 2000 then
    return jsonb_build_object('status','invalid_input');
  end if;
  if exists(select 1 from jsonb_each(p_args) e where e.key not in ('view','material_id','district_id')
    or jsonb_typeof(e.value) <> 'string' or length(e.value #>> '{}') not between 1 and 100)
    or coalesce(p_args->>'view','') not in ('risk','delivery') then
    return jsonb_build_object('status','invalid_input');
  end if;
  material_filter := p_args->>'material_id'; district_filter := p_args->>'district_id';
  if (material_filter is not null and material_filter !~ '^[A-Za-z0-9._/-]{1,100}$')
    or (district_filter is not null and district_filter !~ '^55(0[1-9]|1[0-8])$') then
    return jsonb_build_object('status','invalid_input');
  end if;
  if actor_role = 'district' then
    if actor_district is null or (district_filter is not null and district_filter <> actor_district) then
      return jsonb_build_object('status','forbidden');
    end if;
    district_filter := actor_district;
  end if;
  -- The admission must be caller-bound, recent and issued before a paid model call.
  if not exists(select 1 from audit.vmi_chat_admissions where request_id = p_request_id
    and actor_id = actor and created_at > clock_timestamp() - interval '2 minutes') then
    return jsonb_build_object('status','forbidden');
  end if;
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into result_rows from (
    select h.material_id,h.material_name,m.unit,h.district_id,h.district_name_th,
      h.current_stock_qty,h.cmp_monthly,h.months_available,h.health_band,h.snapshot_at,
      h.usage_as_of_date,h.input_data_class,h.stock_source_status,
      p.plan_number,p.plan_status,p.item_status,p.suggested_qty,p.confirmed_qty,p.final_qty,
      p.priority_score,p.updated_at as plan_updated_at
    from analytics.v_stock_health h join core.materials m using(material_id)
    left join lateral (
      select q.plan_number,q.plan_status,q.item_status,q.suggested_qty,q.confirmed_qty,
        q.final_qty,q.priority_score,q.updated_at
      from analytics.v_replenishment_queue q
      where q.material_id=h.material_id and q.district_id=h.district_id
        and q.plan_status not in ('cancelled','completed')
        and q.item_status not in ('rejected','shipped','cancelled')
      order by q.created_at desc,q.version_no desc,q.replenishment_item_id limit 1
    ) p on p_args->>'view' = 'delivery'
    where (material_filter is null or h.material_id=material_filter)
      and (district_filter is null or h.district_id=district_filter)
      and not h.source_stock_missing and h.cmp_monthly > 0
      and (h.health_band in ('critical','watch')
        or (p_args->>'view'='delivery' and p.suggested_qty > 0))
    order by h.months_available asc nulls last,p.priority_score desc nulls last,
      h.district_id,h.material_id limit 21
  ) q;
  total := jsonb_array_length(result_rows);
  select coalesce(jsonb_agg(value order by ordinal),'[]'::jsonb) into result_rows
    from jsonb_array_elements(result_rows) with ordinality e(value,ordinal) where ordinal <= 20;
  return jsonb_build_object('request_id',p_request_id,'tool',p_tool,'view',p_args->>'view',
    'status',case when total=0 then 'no_data' else 'ok' end,'data',result_rows,
    'scope',jsonb_build_object('role',actor_role,'district_id',district_filter,'truncated',total>20),
    'sources',jsonb_build_array('analytics.v_stock_health','analytics.v_replenishment_queue'),
    'warnings',jsonb_build_array('recommendation_only','missing_stock_excluded'));
end;
$$;
revoke all on function public.vmi_chat_overview(text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.vmi_chat_overview(text,jsonb,uuid) to authenticated;
insert into ops.schema_migrations(version,module,description,source_file)
values('202611100004','P02','Caller-scoped stock risk and delivery overview.',
'supabase/migrations/202611100004_p02_chat_operations_overview.sql');
notify pgrst, 'reload schema';
commit;
