begin;

drop function if exists public.m09_dispatch(text, text, jsonb, jsonb, text);

alter function public.m09_dispatch_impl(text, text, jsonb, jsonb, text)
  rename to m09_dispatch;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated;

delete from ops.schema_migrations
where version = '202607160013';

commit;
