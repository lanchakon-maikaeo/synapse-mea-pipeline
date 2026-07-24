-- Data rollback is intentionally separate from schema rollback.
-- Run public.m16_rollback_test_fixture(<workbook_sha256>) before this file.

begin;

drop trigger if exists classify_quantity_recommendation_source
  on ops.quantity_recommendations;
drop function if exists ops.classify_quantity_recommendation_source();
drop trigger if exists classify_replenishment_item_input
  on core.replenishment_items;
drop function if exists core.classify_replenishment_item_input();

drop function if exists public.m16_rollback_test_fixture(text);
drop function if exists public.m16_import_test_fixture(text, text, jsonb, jsonb);

drop table if exists ops.test_fixture_material_overrides;
drop table if exists ops.test_fixture_imports;

drop view if exists analytics.v_stock_health;

alter table ops.quantity_recommendations
  drop constraint if exists quantity_recommendations_source_freshness_status_check;
alter table ops.quantity_recommendations
  add constraint quantity_recommendations_source_freshness_status_check
  check (source_freshness_status in ('fresh', 'source_missing_assumed_zero', 'stale'));

alter table core.replenishment_items
  drop constraint if exists replenishment_items_input_data_class_check;
alter table core.replenishment_items
  drop column if exists input_data_class;

alter table core.packaging_profiles
  drop constraint if exists packaging_profiles_data_class_check;
alter table core.packaging_profiles
  drop column if exists source_batch_id,
  drop column if exists data_class;

alter table core.usage_rates
  drop constraint if exists usage_rates_data_class_check;
alter table core.usage_rates
  drop column if exists data_class;

alter table core.stock_snapshots
  drop constraint if exists stock_snapshots_data_class_check;
alter table core.stock_snapshots
  drop column if exists data_class;

create or replace view analytics.v_stock_health
with (security_invoker = true)
as
with latest_location_snapshot as (
  select distinct on (s.material_id, s.location_id)
    s.snapshot_id,
    s.material_id,
    s.location_id,
    l.district_id,
    s.quantity_on_hand,
    s.snapshot_at,
    s.source_batch_id
  from core.stock_snapshots s
  join core.locations l using (location_id)
  where l.location_type = 'DISTRICT'
  order by s.material_id, s.location_id, s.snapshot_at desc, s.snapshot_id
), district_stock as (
  select
    material_id,
    district_id,
    (array_agg(snapshot_id order by snapshot_at desc, snapshot_id))[1] as snapshot_id,
    sum(quantity_on_hand) as quantity_on_hand,
    max(snapshot_at) as snapshot_at,
    (array_agg(source_batch_id order by snapshot_at desc)
      filter (where source_batch_id is not null))[1] as source_batch_id
  from latest_location_snapshot
  group by material_id, district_id
), latest_usage as (
  select distinct on (u.material_id, u.district_id)
    u.usage_rate_id,
    u.material_id,
    u.district_id,
    u.as_of_date,
    u.cmp_monthly,
    u.avg_ly,
    u.avg_12m,
    u.avg_6m,
    u.avg_4m,
    u.source_batch_id
  from core.usage_rates u
  order by u.material_id, u.district_id, u.as_of_date desc, u.updated_at desc
)
select
  s.snapshot_id,
  u.usage_rate_id,
  m.material_id,
  m.material_name,
  d.district_id,
  d.district_name_th,
  coalesce(s.quantity_on_hand, 0) as current_stock_qty,
  s.snapshot_at,
  u.as_of_date as usage_as_of_date,
  u.cmp_monthly,
  u.avg_4m,
  u.avg_6m,
  case
    when u.cmp_monthly > 0
      then round(coalesce(s.quantity_on_hand, 0) / u.cmp_monthly, 1)
  end as months_available,
  case
    when u.cmp_monthly is null or u.cmp_monthly = 0 then 'unknown'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly < 1.5 then 'critical'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly < 3.5 then 'watch'
    when coalesce(s.quantity_on_hand, 0) / u.cmp_monthly > 6 then 'overstock'
    else 'healthy'
  end as health_band,
  u.avg_ly,
  u.avg_12m,
  s.snapshot_id is null as source_stock_missing,
  case
    when s.snapshot_id is null then 'Source Missing / Assumed 0'
    else 'Actual Unrestricted Stock'
  end as stock_source_status,
  s.source_batch_id as stock_source_batch_id,
  u.source_batch_id as usage_source_batch_id
from core.materials m
cross join core.districts d
left join district_stock s
  on s.material_id = m.material_id and s.district_id = d.district_id
left join latest_usage u
  on u.material_id = m.material_id and u.district_id = d.district_id
where m.is_vmi
  and d.is_active;

grant select on analytics.v_stock_health to service_role;

delete from ops.schema_migrations where version = '202607240016';

commit;
