-- Manual rollback for M08 only. Wave 1, M06 and M07 are preserved.
begin;
drop view if exists analytics.v_route_plan_summary;
drop view if exists analytics.v_route_plan_geojson;
drop function if exists core.review_route_plan(uuid,text,text);
drop function if exists core.queue_route_job(uuid,uuid,text);
drop table if exists core.route_unserved_stops;
drop table if exists core.route_stops;
drop table if exists core.route_plan_vehicles;
drop table if exists core.route_plans;
drop table if exists ops.route_jobs;
drop table if exists analytics.route_matrices;
drop table if exists core.drivers;
drop table if exists core.vehicles;
drop table if exists core.material_packaging;
drop table if exists core.location_geocodes;
delete from ops.schema_migrations where version='202607150006';
commit;
