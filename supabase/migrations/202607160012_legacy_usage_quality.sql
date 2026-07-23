-- Preserve signed SAP adjustment averages in Staging while keeping Core forecast inputs non-negative.

begin;

alter table staging.legacy_usage_rows
  drop constraint if exists legacy_usage_rows_avg_ly_check,
  drop constraint if exists legacy_usage_rows_avg_12m_check,
  drop constraint if exists legacy_usage_rows_avg_6m_check,
  drop constraint if exists legacy_usage_rows_avg_4m_check;

create or replace function staging.flag_legacy_usage_quality()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.avg_ly < 0 or new.avg_12m < 0 or new.avg_6m < 0 or new.avg_4m < 0
     or jsonb_array_length(new.history) < 3 then
    new.validation_status := 'warning';
  end if;
  return new;
end;
$$;

drop trigger if exists flag_legacy_usage_quality on staging.legacy_usage_rows;
create trigger flag_legacy_usage_quality
  before insert or update on staging.legacy_usage_rows
  for each row execute function staging.flag_legacy_usage_quality();

create or replace function core.normalize_usage_averages()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.avg_ly < 0 then new.avg_ly := null; end if;
  if new.avg_12m < 0 then new.avg_12m := null; end if;
  if new.avg_6m < 0 then new.avg_6m := null; end if;
  if new.avg_4m < 0 then new.avg_4m := null; end if;
  return new;
end;
$$;

drop trigger if exists normalize_usage_averages on core.usage_rates;
create trigger normalize_usage_averages
  before insert or update on core.usage_rates
  for each row execute function core.normalize_usage_averages();

insert into ops.data_quality_rules (rule_code, severity, source_entity, field_name, description)
values
  ('LEGACY_NEGATIVE_DEMAND_ADJUSTMENT', 'warning', 'legacy_actual_cmp_usage', 'history',
   'Negative SAP return/adjustment observations remain in Raw and are excluded from non-negative forecast features.'),
  ('LEGACY_NEGATIVE_USAGE_AVERAGE', 'warning', 'legacy_actual_cmp_usage', 'avg_usage',
   'Negative rolling averages remain in Staging; Core receives NULL because operational usage rates cannot be negative.')
on conflict (rule_code) do update
set severity = excluded.severity,
    source_entity = excluded.source_entity,
    field_name = excluded.field_name,
    description = excluded.description,
    is_active = true,
    updated_at = now();

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607160012', 'M04-M06-M07',
  'Quality treatment for signed SAP adjustments: preserve Raw/Staging evidence and protect non-negative Core features.',
  'supabase/migrations/202607160012_legacy_usage_quality.sql'
)
on conflict (version) do update
set description = excluded.description, source_file = excluded.source_file;

commit;
