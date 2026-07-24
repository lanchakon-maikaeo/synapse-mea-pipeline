-- SYNAPSE M00: idempotent bootstrap for a completely empty Supabase project.
-- Historical environments already contain public.contracts; greenfield
-- Production does not.

begin;

create schema if not exists ops;

create table if not exists ops.schema_migrations (
  version text primary key,
  module text not null,
  description text not null,
  source_file text,
  applied_at timestamptz not null default now(),
  applied_by text not null default current_user
);

create table if not exists public.contracts (
  id bigint generated always as identity primary key,
  source_row_number integer not null unique,
  material_code text,
  item_description text,
  unit text,
  procurement_code text,
  purchase_order bigint,
  contract_number text,
  line_item integer,
  vendor text,
  start_date date,
  quantity numeric,
  record_date date,
  bid_open_date date,
  delivery_date date,
  acceptance_date date,
  document_date date,
  end_date date,
  created_at timestamptz not null default now()
);

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607140000',
  'M00',
  'Greenfield bootstrap for the legacy contract landing table and migration registry.',
  'supabase/migrations/202607140000_m00_greenfield_bootstrap.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
