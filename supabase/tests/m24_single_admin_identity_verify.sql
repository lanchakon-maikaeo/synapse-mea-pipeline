\set ON_ERROR_STOP on

begin;

create temporary table m24_checks (
  check_name text primary key,
  passed boolean not null
);

insert into m24_checks (check_name, passed)
values
  (
    'migration_registered',
    exists (
      select 1 from ops.schema_migrations
      where version = '202607240024'
    )
  ),
  (
    'identity_policy_is_explicit',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'analytics'
        and table_name = 'v_production_readiness'
        and column_name = 'identity_policy'
        and data_type = 'text'
    )
  ),
  (
    'identity_gate_requires_admin',
    position(
      'identities.admin_user_count >= 1'
      in pg_get_viewdef(
        'analytics.v_production_readiness'::regclass,
        true
      )
    ) > 0
  ),
  (
    'admin_role_remains_production_role',
    'admin'::public.app_role is not null
  );

table m24_checks;

do $$
begin
  if exists (select 1 from m24_checks where not passed) then
    raise exception 'M24 single-admin identity contract failed';
  end if;
end
$$;

rollback;
