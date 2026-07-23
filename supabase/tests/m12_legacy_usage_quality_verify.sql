select 'staging_quality_trigger' as check_name,
       to_regprocedure('staging.flag_legacy_usage_quality()') is not null as passed
union all select 'core_normalizer', to_regprocedure('core.normalize_usage_averages()') is not null
union all select 'negative_demand_rule', exists(select 1 from ops.data_quality_rules where rule_code='LEGACY_NEGATIVE_DEMAND_ADJUSTMENT' and is_active)
union all select 'negative_average_rule', exists(select 1 from ops.data_quality_rules where rule_code='LEGACY_NEGATIVE_USAGE_AVERAGE' and is_active)
union all select 'migration_registered', exists(select 1 from ops.schema_migrations where version='202607160012');
