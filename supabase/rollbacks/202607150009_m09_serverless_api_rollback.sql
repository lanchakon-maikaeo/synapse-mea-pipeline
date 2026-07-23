begin;

revoke execute on function public.m09_dispatch(text, text, jsonb, jsonb, text) from authenticated;
revoke execute on function public.m09_health() from anon, authenticated;
drop function if exists public.m09_dispatch(text, text, jsonb, jsonb, text);
drop function if exists public.m09_health();
drop function if exists public.m09_error(integer, text, text, text, jsonb);
drop function if exists public.m09_result(integer, jsonb);
drop table if exists ops.api_rate_limit_windows;
delete from ops.schema_migrations where version = '202607150009';

commit;
