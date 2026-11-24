-- Included by local_pipeline_workflow_verify.sql inside its rollback transaction.
-- ADR 0001: people registries are not chat sources, user ids never reach the model, and the
-- masking terms and mask counts are for the service role only.
do $$
declare terms jsonb; actor uuid; today date:=(now() at time zone 'Asia/Bangkok')::date;
begin
 if exists(select 1 from ops.chat_sources where source_id in ('ops.access_requests','public.user_profiles','audit.change_log')) then
  raise exception 'a people registry is still a chat source';
 end if;
 if exists(select 1 from ops.chat_sources, jsonb_object_keys(columns) k where k ~ '_by$' or k in ('actor_id','user_id')) then
  raise exception 'a user id column still reaches the model';
 end if;
 if has_function_privilege('authenticated','public.ai_privacy_terms()','execute') or
    has_function_privilege('anon','public.ai_privacy_terms()','execute') or
    has_function_privilege('authenticated','public.ai_record_mask_counts(text,jsonb)','execute') or
    has_function_privilege('anon','public.ai_record_mask_counts(text,jsonb)','execute') or
    has_table_privilege('authenticated','ops.ai_mask_words','select') or
    has_table_privilege('authenticated','ops.ai_mask_counts','select') then
  raise exception 'masking terms or counts open to signed-in users';
 end if;

 -- ชื่อที่ระบบรู้จัก come from people columns; คำที่ต้องปิดเสมอ that an admin removed drop out.
 select user_id into actor from public.user_profiles where is_active order by user_id limit 1;
 update public.user_profiles set display_name='วิภา ทองดี' where user_id=actor;
 insert into ops.ai_mask_words(word,reason,added_by) values('โครงการลับ X','ทดสอบ',actor),('คำที่เอาออกแล้ว','ทดสอบ',actor);
 update ops.ai_mask_words set removed_at=now(),removed_by=actor,removal_reason='ทดสอบ' where word='คำที่เอาออกแล้ว';
 begin
  insert into ops.ai_mask_words(word,reason,added_by) values('โครงการลับ x','ซ้ำ',actor);
  raise exception 'duplicate active word accepted';
 exception when unique_violation then null; end;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 terms:=public.ai_privacy_terms();
 if not terms->'names' ? 'วิภา ทองดี' then raise exception 'known name missing: %', left(terms::text,200); end if;
 if not terms->'words' ? 'โครงการลับ X' or terms->'words' ? 'คำที่เอาออกแล้ว' then raise exception 'always-mask words wrong: %', terms->'words'; end if;

 -- Counts add up per Bangkok day, task and kind; only counts are accepted; a year is kept.
 insert into ops.ai_mask_counts(day,task,kind,count) values(today-400,'chat','name',5);
 perform public.ai_record_mask_counts('chat','{"name":2,"phone":1}');
 perform public.ai_record_mask_counts('chat','{"name":1}');
 if (select count from ops.ai_mask_counts where day=today and task='chat' and kind='name')<>3 then raise exception 'counts not added up'; end if;
 if exists(select 1 from ops.ai_mask_counts where day<today-365) then raise exception 'counts older than a year kept'; end if;
 begin perform public.ai_record_mask_counts('chat','{"name":"วิภา"}'); raise exception 'a value accepted as a count';
 exception when invalid_parameter_value then null; end;
 begin perform public.ai_record_mask_counts('other','{"name":1}'); raise exception 'unknown task accepted';
 exception when invalid_parameter_value then null; end;
 begin perform public.ai_record_mask_counts('chat','{"address":1}'); raise exception 'unknown kind accepted';
 exception when invalid_parameter_value then null; end;

 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 begin perform public.ai_privacy_terms(); raise exception 'terms open to a non-service caller';
 exception when insufficient_privilege then null; end;
 begin perform public.ai_record_mask_counts('chat','{"name":1}'); raise exception 'counts open to a non-service caller';
 exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims','',true);
end $$;
