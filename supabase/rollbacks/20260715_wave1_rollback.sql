-- Manual rollback for Wave 1 modules M03-M05 only.
-- Do not run after Wave 2+ objects depend on Core or Analytics.
-- M01 schemas, public.contracts and its 6,305 source rows are preserved.

begin;

drop view if exists analytics.v_material_master_coverage;
drop view if exists analytics.v_contract_reconciliation;
drop view if exists analytics.v_current_stock;
drop view if exists analytics.v_contract_status;
drop view if exists analytics.v_data_quality_summary;

drop function if exists core.refresh_contract_foundation(uuid, uuid);

drop table if exists core.delivery_events;
drop table if exists core.stock_snapshots;
drop table if exists core.inventory_transactions;
drop table if exists core.contract_items;
drop table if exists core.contracts;
drop table if exists core.materials;
drop table if exists core.vendors;
drop table if exists core.locations;
drop table if exists core.warehouses;
drop table if exists core.districts;

drop function if exists staging.refresh_materials(uuid);
drop function if exists staging.refresh_contracts(uuid);
drop function if exists staging.try_date(text);
drop function if exists staging.try_numeric(text);
drop function if exists staging.try_integer(text);
drop function if exists staging.try_bigint(text);
drop function if exists staging.clean_text(text);

drop table if exists staging.material_rows;
drop table if exists staging.contract_rows;
drop table if exists staging.sap_plant_district_map;
drop table if exists ops.data_quality_issues;
drop table if exists ops.data_quality_rules;

delete from raw.import_batches
where source_checksum = '39c0735fea5e32c4c9056fdd75830f1e47bde43a71a51a67ca4e86e5bc557126'
  and source_sheet = 'DB_Material';

drop table if exists ops.pipeline_runs;
drop table if exists raw.source_rows;

alter table raw.import_batches
  drop column if exists connector_name,
  drop column if exists source_entity,
  drop column if exists started_at,
  drop column if exists finished_at,
  drop column if exists error_message;

delete from ops.schema_migrations
where version in ('202607150001', '202607150002', '202607150003');

commit;
