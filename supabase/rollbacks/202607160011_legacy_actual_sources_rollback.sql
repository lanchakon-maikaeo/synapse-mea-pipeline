-- Manual rollback for M11 legacy actual-source import. Removes only rows tied to its registered batches.
begin;

delete from analytics.demand_monthly_features where source_batch_id in (select batch_id from ops.legacy_source_imports);
delete from core.usage_rates where source_batch_id in (select batch_id from ops.legacy_source_imports);
delete from core.stock_snapshots where source_batch_id in (select batch_id from ops.legacy_source_imports);
delete from ops.pipeline_runs where batch_id in (select batch_id from ops.legacy_source_imports);
delete from staging.legacy_usage_rows;
delete from staging.legacy_stock_rows;
delete from staging.legacy_material_rows;
delete from core.materials m
where m.source_batch_id in (select batch_id from ops.legacy_source_imports)
  and not exists (select 1 from core.contract_items ci where ci.material_id = m.material_id)
  and not exists (select 1 from core.stock_snapshots ss where ss.material_id = m.material_id)
  and not exists (select 1 from core.usage_rates ur where ur.material_id = m.material_id)
  and not exists (select 1 from analytics.demand_monthly_features df where df.material_id = m.material_id);
drop function if exists public.m11_legacy_dispatch(text, text, jsonb, jsonb, text);
drop function if exists public.m11_import_legacy_actual(text, text, jsonb, jsonb);
drop table if exists ops.legacy_source_imports;
drop table if exists staging.legacy_usage_rows;
drop table if exists staging.legacy_stock_rows;
drop table if exists staging.legacy_material_rows;
delete from ops.schema_migrations where version='202607160011';

commit;
