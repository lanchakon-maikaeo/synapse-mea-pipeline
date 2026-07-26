-- SYNAPSE M13c emergency rollback.
--
-- This rollback intentionally fails closed. M13c adds audit events, request
-- idempotency, verified geocode provenance, tariff governance, and inventory
-- integrity constraints; dropping those objects would discard evidence or
-- reopen corruption paths. Disable the transport entrypoint immediately, keep
-- the additive schema/data intact, then ship a reviewed forward migration.
-- In particular, retain the checksum-traced 18 district coordinates in both
-- geo registries and the verified Mueang Mai Bang Phli transport depot; those
-- authoritative records must not be replaced by the illustrative M13 seeds.
--
-- The migration registration is deliberately retained so an automated deploy
-- cannot silently re-enable the dispatcher by replaying M13c.

begin;

revoke all on function
  public.m13_transport_dispatch(text, text, jsonb, jsonb, text)
from public, anon, authenticated, service_role;

comment on function
  public.m13_transport_dispatch(text, text, jsonb, jsonb, text)
is
  'M13c transport dispatcher disabled by fail-closed emergency rollback; re-enable only through a reviewed forward migration.';

commit;
