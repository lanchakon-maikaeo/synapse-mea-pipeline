begin;

revoke all on function public.m10_input_dispatch(text, text, jsonb, jsonb, text) from public, anon, authenticated;
drop function if exists public.m10_input_dispatch(text, text, jsonb, jsonb, text);
drop function if exists core.publish_vmi_web_input(jsonb);
drop table if exists ops.web_input_submissions;
drop table if exists staging.vmi_input_rows;
delete from ops.schema_migrations where version = '202607160010';

commit;
