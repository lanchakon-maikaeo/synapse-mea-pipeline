-- Manual rollback for M01 only.
-- Do not run after M02+ objects depend on these schemas/functions.
-- Existing public.contracts business columns and all 6,305 rows are preserved.

begin;

drop trigger if exists audit_contracts_changes on public.contracts;
drop trigger if exists set_contracts_updated_at on public.contracts;

drop policy if exists contracts_authenticated_read on public.contracts;
drop policy if exists contracts_admin_insert on public.contracts;
drop policy if exists contracts_admin_update on public.contracts;
drop policy if exists contracts_admin_delete on public.contracts;

alter table public.contracts drop constraint if exists contracts_source_batch_id_fkey;
alter table public.contracts
  drop column if exists source_batch_id,
  drop column if exists source_file,
  drop column if exists source_sheet,
  drop column if exists source_checksum,
  drop column if exists metadata,
  drop column if exists updated_at;

drop trigger if exists on_auth_user_created on auth.users;
drop table if exists public.user_profiles;
drop function if exists public.handle_new_auth_user();
drop function if exists public.current_app_role();
drop type if exists public.app_role;

drop function if exists audit.log_row_change();
drop function if exists audit.set_updated_at();

drop schema if exists audit;
drop schema if exists ops;
drop schema if exists rag;
drop schema if exists analytics;
drop schema if exists core;
drop schema if exists staging;
drop schema if exists raw;

commit;
