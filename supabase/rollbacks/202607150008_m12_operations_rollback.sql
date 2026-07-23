-- Manual rollback for M12 database observability. Business data is preserved.

begin;
drop view if exists analytics.v_operations_health;
drop function if exists ops.refresh_operational_alerts(integer);
drop function if exists ops.acknowledge_system_alert(uuid,boolean);
drop function if exists ops.raise_system_alert(text,text,text,text,text,jsonb);
drop function if exists ops.record_service_heartbeat(text,text,text,text,jsonb);
drop trigger if exists audit_core_replenishment_plans_changes on core.replenishment_plans;
drop trigger if exists audit_core_replenishment_items_changes on core.replenishment_items;
drop trigger if exists audit_core_route_plans_changes on core.route_plans;
drop trigger if exists audit_ops_system_alerts_changes on ops.system_alerts;
drop table if exists ops.release_versions;
drop table if exists ops.backup_runs;
drop table if exists ops.service_heartbeats;
drop table if exists ops.system_alerts;
delete from ops.schema_migrations where version='202607150008';
commit;
