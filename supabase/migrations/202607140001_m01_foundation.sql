-- SYNAPSE M01: Platform, Database and Security Foundation
-- Project: mklnbumfwojxhqscthjd (test-synapse-mea)
-- Safe to re-run. Existing public.contracts rows are preserved.

begin;

create extension if not exists pgcrypto with schema extensions;

create schema if not exists raw;
create schema if not exists staging;
create schema if not exists core;
create schema if not exists analytics;
create schema if not exists rag;
create schema if not exists ops;
create schema if not exists audit;

comment on schema raw is 'Immutable source records and ingestion batches.';
comment on schema staging is 'Validated and normalized records awaiting promotion.';
comment on schema core is 'Canonical SYNAPSE business entities.';
comment on schema analytics is 'Derived metrics, forecasts and reporting models.';
comment on schema rag is 'Document chunks, embeddings and retrieval metadata.';
comment on schema ops is 'Operational metadata, migrations and environment registry.';
comment on schema audit is 'Append-only database change history and audit helpers.';

do $$
begin
  create type public.app_role as enum ('admin', 'planner', 'district', 'viewer');
exception
  when duplicate_object then null;
end
$$;

create table if not exists ops.schema_migrations (
  version text primary key,
  module text not null,
  description text not null,
  source_file text,
  applied_at timestamptz not null default now(),
  applied_by text not null default current_user
);

create table if not exists ops.environment_registry (
  environment_name text primary key
    check (environment_name in ('development', 'test', 'production')),
  project_ref text not null,
  region text,
  deployment_profile text not null default 'managed-supabase-free',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into ops.environment_registry (
  environment_name,
  project_ref,
  region,
  deployment_profile,
  notes
)
values (
  'production',
  'mklnbumfwojxhqscthjd',
  'ap-northeast-1',
  'managed-supabase-free',
  'Current SYNAPSE project; use as production baseline until separate development/test projects are provisioned.'
)
on conflict (environment_name) do update
set project_ref = excluded.project_ref,
    region = excluded.region,
    deployment_profile = excluded.deployment_profile,
    notes = excluded.notes,
    updated_at = now();

create table if not exists raw.import_batches (
  batch_id uuid primary key default gen_random_uuid(),
  source_system text not null,
  source_file text not null,
  source_sheet text,
  source_checksum text not null,
  source_file_size_bytes bigint,
  row_count integer not null default 0 check (row_count >= 0),
  status text not null
    check (status in ('queued', 'running', 'succeeded', 'failed', 'quarantined')),
  imported_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_checksum, source_sheet)
);

create table if not exists audit.change_log (
  audit_id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  schema_name text not null,
  table_name text not null,
  record_pk text,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  old_data jsonb,
  new_data jsonb,
  changed_by uuid,
  database_role text not null default current_user
);

create index if not exists change_log_lookup_idx
  on audit.change_log (schema_name, table_name, record_pk, occurred_at desc);

create or replace function audit.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function audit.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, audit
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_pk text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := to_jsonb(old);
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_new := to_jsonb(new);
  end if;

  v_pk := coalesce(
    v_new ->> 'id',
    v_old ->> 'id',
    v_new ->> 'user_id',
    v_old ->> 'user_id',
    v_new ->> 'source_row_number',
    v_old ->> 'source_row_number'
  );

  insert into audit.change_log (
    schema_name,
    table_name,
    record_pk,
    operation,
    old_data,
    new_data,
    changed_by,
    database_role
  )
  values (
    tg_table_schema,
    tg_table_name,
    v_pk,
    tg_op,
    v_old,
    v_new,
    auth.uid(),
    current_user
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.app_role not null default 'viewer',
  district_id text,
  display_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_district_role_check check (
    (role = 'district' and district_id ~ '^55(0[1-9]|1[0-8])$')
    or (role <> 'district' and district_id is null)
  )
);

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.role
  from public.user_profiles p
  where p.user_id = (select auth.uid())
    and p.is_active
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.user_profiles (user_id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

insert into public.user_profiles (user_id, display_name)
select id, raw_user_meta_data ->> 'display_name'
from auth.users
on conflict (user_id) do nothing;

alter table public.user_profiles enable row level security;

drop policy if exists user_profiles_select_self on public.user_profiles;
create policy user_profiles_select_self
  on public.user_profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists user_profiles_admin_select on public.user_profiles;
create policy user_profiles_admin_select
  on public.user_profiles
  for select
  to authenticated
  using ((select public.current_app_role()) = 'admin');

drop policy if exists user_profiles_admin_insert on public.user_profiles;
create policy user_profiles_admin_insert
  on public.user_profiles
  for insert
  to authenticated
  with check ((select public.current_app_role()) = 'admin');

drop policy if exists user_profiles_admin_update on public.user_profiles;
create policy user_profiles_admin_update
  on public.user_profiles
  for update
  to authenticated
  using ((select public.current_app_role()) = 'admin')
  with check ((select public.current_app_role()) = 'admin');

drop policy if exists user_profiles_admin_delete on public.user_profiles;
create policy user_profiles_admin_delete
  on public.user_profiles
  for delete
  to authenticated
  using ((select public.current_app_role()) = 'admin');

drop trigger if exists set_user_profiles_updated_at on public.user_profiles;
create trigger set_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function audit.set_updated_at();

drop trigger if exists audit_user_profiles_changes on public.user_profiles;
create trigger audit_user_profiles_changes
  after insert or update or delete on public.user_profiles
  for each row execute function audit.log_row_change();

alter table if exists public.contracts
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists source_batch_id uuid,
  add column if not exists source_file text not null default 'รวมสัญญา.xlsx',
  add column if not exists source_sheet text not null default 'รวมสัญญา',
  add column if not exists source_checksum text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$
begin
  alter table public.contracts
    add constraint contracts_source_batch_id_fkey
    foreign key (source_batch_id)
    references raw.import_batches (batch_id)
    on delete restrict;
exception
  when duplicate_object then null;
end
$$;

with baseline_batch as (
  insert into raw.import_batches (
    source_system,
    source_file,
    source_sheet,
    source_checksum,
    source_file_size_bytes,
    row_count,
    status,
    imported_at,
    metadata
  )
  values (
    'excel',
    'รวมสัญญา.xlsx',
    'รวมสัญญา',
    '8ea7b0e712726e6cc1990f33b0031be231a91cc01fb4f8d96e6146d83e3cf9dd',
    750651,
    6305,
    'succeeded',
    now(),
    jsonb_build_object(
      'source_modified_at', '2026-07-14T15:06:01+07:00',
      'source_range', 'A1:P6306',
      'header_rows', 1,
      'baseline_reason', 'Existing public.contracts reconciliation during M01'
    )
  )
  on conflict (source_checksum, source_sheet) do update
  set source_file = excluded.source_file,
      source_file_size_bytes = excluded.source_file_size_bytes,
      row_count = excluded.row_count,
      status = excluded.status,
      metadata = raw.import_batches.metadata || excluded.metadata,
      updated_at = now()
  returning batch_id
)
update public.contracts c
set source_batch_id = b.batch_id,
    source_file = 'รวมสัญญา.xlsx',
    source_sheet = 'รวมสัญญา',
    source_checksum = '8ea7b0e712726e6cc1990f33b0031be231a91cc01fb4f8d96e6146d83e3cf9dd',
    metadata = c.metadata || jsonb_build_object('source_row_number', c.source_row_number)
from baseline_batch b
where c.source_batch_id is null
   or c.source_checksum is distinct from '8ea7b0e712726e6cc1990f33b0031be231a91cc01fb4f8d96e6146d83e3cf9dd';

create index if not exists contracts_source_batch_id_idx
  on public.contracts (source_batch_id);

create index if not exists contracts_purchase_order_idx
  on public.contracts (purchase_order);

create index if not exists contracts_contract_number_idx
  on public.contracts (contract_number)
  where contract_number is not null;

drop trigger if exists set_contracts_updated_at on public.contracts;
create trigger set_contracts_updated_at
  before update on public.contracts
  for each row execute function audit.set_updated_at();

drop trigger if exists audit_contracts_changes on public.contracts;
create trigger audit_contracts_changes
  after insert or update or delete on public.contracts
  for each row execute function audit.log_row_change();

alter table public.contracts enable row level security;

drop policy if exists contracts_authenticated_read on public.contracts;
create policy contracts_authenticated_read
  on public.contracts
  for select
  to authenticated
  using ((select public.current_app_role()) in ('admin', 'planner', 'district', 'viewer'));

drop policy if exists contracts_admin_insert on public.contracts;
create policy contracts_admin_insert
  on public.contracts
  for insert
  to authenticated
  with check ((select public.current_app_role()) = 'admin');

drop policy if exists contracts_admin_update on public.contracts;
create policy contracts_admin_update
  on public.contracts
  for update
  to authenticated
  using ((select public.current_app_role()) = 'admin')
  with check ((select public.current_app_role()) = 'admin');

drop policy if exists contracts_admin_delete on public.contracts;
create policy contracts_admin_delete
  on public.contracts
  for delete
  to authenticated
  using ((select public.current_app_role()) = 'admin');

alter table ops.schema_migrations enable row level security;
alter table ops.environment_registry enable row level security;
alter table raw.import_batches enable row level security;
alter table audit.change_log enable row level security;

revoke all on schema raw, staging, core, analytics, rag, ops, audit from public, anon, authenticated;
grant usage on schema raw, staging, core, analytics, rag, ops, audit to service_role;

revoke all on all tables in schema raw, staging, core, analytics, rag, ops, audit from public, anon, authenticated;
grant all on all tables in schema raw, staging, core, analytics, rag, ops, audit to service_role;
grant all on all sequences in schema raw, staging, core, analytics, rag, ops, audit to service_role;

revoke all on public.user_profiles from anon;
grant select, insert, update, delete on public.user_profiles to authenticated;
grant all on public.user_profiles to service_role;

revoke all on public.contracts from anon;
grant select, insert, update, delete on public.contracts to authenticated;
grant all on public.contracts to service_role;

do $$
declare
  v_contracts_sequence text;
begin
  v_contracts_sequence := pg_get_serial_sequence('public.contracts', 'id');
  if v_contracts_sequence is not null then
    execute format(
      'grant usage, select on sequence %s to authenticated, service_role',
      v_contracts_sequence
    );
  end if;
end
$$;

grant usage on type public.app_role to authenticated, service_role;
revoke all on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated, service_role;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
revoke all on function audit.log_row_change() from public, anon, authenticated;
revoke all on function audit.set_updated_at() from public, anon, authenticated;

alter default privileges for role postgres in schema raw, staging, core, analytics, rag, ops, audit
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema raw, staging, core, analytics, rag, ops, audit
  grant all on tables to service_role;
alter default privileges for role postgres in schema raw, staging, core, analytics, rag, ops, audit
  grant all on sequences to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607140001',
  'M01',
  'Platform schemas, environment registry, application roles, RLS, audit trail and reconciliation of 6,305 existing contract rows.',
  'supabase/migrations/202607140001_m01_foundation.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
