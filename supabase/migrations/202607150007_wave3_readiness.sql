-- SYNAPSE Wave 3 completion: AutoETS registry, drift detection and operational readiness.

begin;

insert into analytics.forecast_model_versions (
  model_version, model_name, model_family, parameters, implementation_reference
)
values (
  'autoets-v1', 'AutoETS', 'statsforecast', '{"season_length":12,"prediction_interval":80}',
  'intelligence/src/synapse_intelligence/forecasting.py'
)
on conflict (model_version) do update
set model_name = excluded.model_name,
    model_family = excluded.model_family,
    parameters = excluded.parameters,
    implementation_reference = excluded.implementation_reference,
    is_active = true;

create or replace function analytics.refresh_forecast_drift_events(
  p_wape_threshold numeric default 0.50,
  p_abs_bias_ratio numeric default 0.25,
  p_demand_shift_ratio numeric default 0.50,
  p_freshness_days integer default 62
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, analytics
as $$
declare
  v_count integer;
  v_total integer := 0;
begin
  if p_wape_threshold <= 0 or p_abs_bias_ratio <= 0 or p_demand_shift_ratio <= 0 or p_freshness_days <= 0 then
    raise exception 'Drift thresholds must be positive';
  end if;

  with latest as (
    select distinct on (material_id, district_id)
      material_id, district_id, wape
    from analytics.forecast_metrics
    where selected
    order by material_id, district_id, created_at desc
  )
  insert into analytics.forecast_drift_events (
    material_id, district_id, metric_name, observed_value, threshold_value, severity, details
  )
  select material_id, district_id, 'wape', wape, p_wape_threshold,
         case when wape >= p_wape_threshold * 2 then 'critical' else 'warning' end,
         jsonb_build_object('source', 'selected_backtest_metric')
  from latest l
  where wape > p_wape_threshold
    and not exists (
      select 1 from analytics.forecast_drift_events e
      where e.material_id=l.material_id and e.district_id=l.district_id
        and e.metric_name='wape' and e.detected_at >= now() - interval '24 hours'
    );
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  with latest as (
    select distinct on (material_id, district_id)
      material_id, district_id, bias
    from analytics.forecast_metrics
    where selected
    order by material_id, district_id, created_at desc
  ), demand_scale as (
    select material_id, district_id, avg(demand_quantity) as mean_demand
    from analytics.demand_monthly_features
    group by material_id, district_id
  )
  insert into analytics.forecast_drift_events (
    material_id, district_id, metric_name, observed_value, threshold_value, severity, details
  )
  select l.material_id, l.district_id, 'bias', l.bias,
         greatest(d.mean_demand, 1) * p_abs_bias_ratio,
         case when abs(l.bias) >= greatest(d.mean_demand, 1) * p_abs_bias_ratio * 2 then 'critical' else 'warning' end,
         jsonb_build_object('threshold_ratio', p_abs_bias_ratio, 'mean_demand', d.mean_demand)
  from latest l
  join demand_scale d using (material_id, district_id)
  where abs(l.bias) > greatest(d.mean_demand, 1) * p_abs_bias_ratio
    and not exists (
      select 1 from analytics.forecast_drift_events e
      where e.material_id=l.material_id and e.district_id=l.district_id
        and e.metric_name='bias' and e.detected_at >= now() - interval '24 hours'
    );
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  with ranked as (
    select material_id, district_id, demand_quantity,
           row_number() over (partition by material_id, district_id order by period_start desc) as recency
    from analytics.demand_monthly_features
  ), windows as (
    select material_id, district_id,
           avg(demand_quantity) filter (where recency between 1 and 3) as recent_mean,
           avg(demand_quantity) filter (where recency between 4 and 6) as previous_mean,
           count(*) filter (where recency between 1 and 6) as observation_count
    from ranked
    where recency <= 6
    group by material_id, district_id
  ), shifted as (
    select *, abs(recent_mean - previous_mean) / greatest(abs(previous_mean), 1) as shift_ratio
    from windows
    where observation_count = 6
  )
  insert into analytics.forecast_drift_events (
    material_id, district_id, metric_name, observed_value, threshold_value, severity, details
  )
  select material_id, district_id, 'demand_shift', shift_ratio, p_demand_shift_ratio,
         case when shift_ratio >= p_demand_shift_ratio * 2 then 'critical' else 'warning' end,
         jsonb_build_object('recent_3m_mean', recent_mean, 'previous_3m_mean', previous_mean)
  from shifted s
  where shift_ratio > p_demand_shift_ratio
    and not exists (
      select 1 from analytics.forecast_drift_events e
      where e.material_id=s.material_id and e.district_id=s.district_id
        and e.metric_name='demand_shift' and e.detected_at >= now() - interval '24 hours'
    );
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  with freshness as (
    select material_id, district_id, max(period_start) as latest_period
    from analytics.demand_monthly_features
    group by material_id, district_id
  )
  insert into analytics.forecast_drift_events (
    material_id, district_id, metric_name, observed_value, threshold_value, severity, details
  )
  select material_id, district_id, 'data_freshness', current_date - latest_period,
         p_freshness_days,
         case when current_date - latest_period >= p_freshness_days * 2 then 'critical' else 'warning' end,
         jsonb_build_object('latest_period', latest_period)
  from freshness f
  where current_date - latest_period > p_freshness_days
    and not exists (
      select 1 from analytics.forecast_drift_events e
      where e.material_id=f.material_id and e.district_id=f.district_id
        and e.metric_name='data_freshness' and e.detected_at >= now() - interval '24 hours'
    );
  get diagnostics v_count = row_count;
  return v_total + v_count;
end;
$$;

create or replace view analytics.v_wave3_readiness
with (security_invoker = true)
as
with counts as (
  select
    (select count(*) from analytics.demand_monthly_features) as demand_feature_rows,
    (select count(*) from (
      select 1 from analytics.demand_monthly_features
      group by material_id, district_id having count(*) >= 14
    ) s) as forecast_ready_series,
    (select count(*) from core.locations where is_active) as active_locations,
    (select count(*) from core.location_geocodes where verified_at is not null) as verified_geocodes,
    (select count(*) from core.material_packaging
      where verified_at is not null and quantity_per_box is not null and box_volume_m3 is not null
        and weight_per_box_kg is not null and boxes_per_pallet is not null) as routing_ready_materials,
    (select count(*) from core.vehicles where is_active) as active_vehicles,
    (select count(*) from core.vehicles where is_active and max_pallets is not null) as routing_ready_vehicles,
    (select count(*) from core.drivers where is_active) as active_drivers,
    (select count(*) from core.replenishment_plans where status='approved') as approved_replenishment_plans,
    (select count(*) from ops.background_jobs where status in ('queued','running')) as active_jobs
)
select *,
  forecast_ready_series > 0 as forecast_operational_ready,
  verified_geocodes >= active_locations
    and routing_ready_materials > 0
    and routing_ready_vehicles > 0
    and active_drivers > 0
    and approved_replenishment_plans > 0 as route_operational_ready,
  now() as checked_at
from counts;

revoke all on function analytics.refresh_forecast_drift_events(numeric, numeric, numeric, integer)
  from public, anon, authenticated;
grant execute on function analytics.refresh_forecast_drift_events(numeric, numeric, numeric, integer)
  to service_role;
grant select on analytics.v_wave3_readiness to service_role;

insert into ops.schema_migrations (version, module, description, source_file)
values (
  '202607150007', 'W03',
  'AutoETS model registry, forecast drift detection and Wave 3 operational-readiness signal.',
  'supabase/migrations/202607150007_wave3_readiness.sql'
)
on conflict (version) do update set description=excluded.description, source_file=excluded.source_file;

commit;
