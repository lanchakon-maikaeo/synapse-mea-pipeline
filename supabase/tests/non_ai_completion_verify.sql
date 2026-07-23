-- Completion checks for all implemented non-AI modules. Expected: 15/15 true.
with checks as (
  select 'all_non_ai_migrations_registered' as check_name,
    count(*)=10 as passed,count(*)::text||'/10 migrations' as detail
  from ops.schema_migrations
  where version in (
    '202607140001','202607140002','202607150001','202607150002','202607150003',
    '202607150004','202607150005','202607150006','202607150007','202607150008'
  )
  union all select 'm12_migration_registered',exists(select 1 from ops.schema_migrations where version='202607150008'),'migration registered'
  union all select 'm12_tables_rls_enabled',count(*)=4,count(*)::text||'/4 tables'
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='ops' and c.relname in ('system_alerts','service_heartbeats','backup_runs','release_versions') and c.relrowsecurity
  union all select 'anonymous_m12_access_blocked',count(*)=0,count(*)::text||' exposed tables'
  from information_schema.tables
  where table_schema='ops' and table_name in ('system_alerts','service_heartbeats','backup_runs','release_versions')
    and has_table_privilege('anon',format('%I.%I',table_schema,table_name),'select')
  union all select 'm12_functions_available',count(*)=4,count(*)::text||'/4 functions'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='ops' and p.proname in ('record_service_heartbeat','raise_system_alert','acknowledge_system_alert','refresh_operational_alerts')
  union all select 'operations_health_view_available',count(*)=1,count(*)::text||'/1 view'
  from information_schema.views where table_schema='analytics' and table_name='v_operations_health'
  union all select 'workflow_audit_triggers',count(*)=3,count(*)::text||'/3 triggers'
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where not t.tgisinternal and t.tgname in ('audit_core_replenishment_plans_changes','audit_core_replenishment_items_changes','audit_core_route_plans_changes')
  union all select 'release_registered',count(*)=1,count(*)::text||'/1 release'
  from ops.release_versions where release_version='1.0.0-non-ai' and status='deployed'
  union all select 'operations_health_returns_one_row',count(*)=1,count(*)::text||' health rows'
  from analytics.v_operations_health
  union all select 'wave1_contract_items_preserved',count(*)=6305,count(*)::text||'/6305 items'
  from core.contract_items where is_current
  union all select 'wave2_policy_preserved',count(*)=1,count(*)::text||'/1 active policies'
  from ops.calculation_policies where is_active
  union all select 'wave3_models_preserved',count(*)=3,count(*)::text||'/3 models'
  from analytics.forecast_model_versions where is_active
  union all select 'no_mock_drivers',count(*)=0,count(*)::text||' placeholder drivers'
  from core.drivers where lower(employee_reference)~'(mock|dummy|test)' or lower(display_name)~'(mock|dummy|test)'
  union all select 'no_service_key_in_database_sources',count(*)=0,count(*)::text||' suspicious function definitions'
  from pg_proc p where p.prokind in ('f','p') and pg_get_functiondef(p.oid)~*'(service_role_key|supabase_service_key)'
  union all select 'ai_module_not_deployed',count(*)=0,count(*)::text||' M11 migrations'
  from ops.schema_migrations where module='M11'
)
select check_name,passed,detail from checks order by check_name;
