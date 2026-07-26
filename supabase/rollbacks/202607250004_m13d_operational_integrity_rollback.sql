-- SYNAPSE M13d emergency rollback.
--
-- M13d records immutable planning evidence and durable failure attempts.
-- Those records must not be dropped or rewritten. Fail closed by disabling the
-- affected write entrypoints and ship a reviewed forward migration.

begin;

revoke all on function public.m13_create_replenishment_run(
  timestamptz, text
) from public, anon, authenticated, service_role;

revoke all on function public.m13_transport_dispatch(
  text, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;

comment on function public.m13_create_replenishment_run(
  timestamptz, text
) is
  'Disabled by the M13d fail-closed rollback; retained with durable attempt evidence.';

comment on function public.m13_transport_dispatch(
  text, text, jsonb, jsonb, text
) is
  'Disabled by the M13d fail-closed rollback; legacy trips and route evidence remain quarantined.';

commit;
