-- Manual rollback for M06 only.
-- Do not run after any later module depends on stock health or replenishment tables.
-- Wave 1 source, staging and Core contract data are preserved.

begin;

drop view if exists analytics.v_replenishment_queue;
drop view if exists analytics.v_stock_health;

drop function if exists core.approve_replenishment_plan(uuid);
drop function if exists core.confirm_replenishment_item(uuid, numeric, text);
drop function if exists core.create_replenishment_run(timestamptz);
drop function if exists core.round_replenishment(numeric);

drop table if exists ops.replenishment_adjustments;
drop table if exists core.replenishment_items;
drop table if exists core.replenishment_plans;
drop table if exists ops.replenishment_runs;
drop table if exists ops.calculation_policies;
drop table if exists core.usage_rates;

delete from ops.schema_migrations where version = '202607150004';

commit;
