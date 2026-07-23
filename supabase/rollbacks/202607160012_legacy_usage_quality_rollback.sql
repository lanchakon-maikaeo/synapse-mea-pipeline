begin;
drop trigger if exists normalize_usage_averages on core.usage_rates;
drop function if exists core.normalize_usage_averages();
drop trigger if exists flag_legacy_usage_quality on staging.legacy_usage_rows;
drop function if exists staging.flag_legacy_usage_quality();
delete from ops.data_quality_rules where rule_code in ('LEGACY_NEGATIVE_DEMAND_ADJUSTMENT','LEGACY_NEGATIVE_USAGE_AVERAGE');
delete from ops.schema_migrations where version='202607160012';
commit;
