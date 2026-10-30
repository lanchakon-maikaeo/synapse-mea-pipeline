-- M21: Weekly delivery calendar, cut-off rules for extra requests, and
-- abnormal-request alerts with history.
--
-- 1. Delivery calendar: every district belongs to a zone; every zone has a
--    fixed weekday run (all districts delivered — no district is forced to
--    pick up). Cut-off for adding to a run: the day before at 14:00.
-- 2. Extra (ad hoc) requests carry an urgency code. On creation the system
--    decides the slot automatically:
--      zone_run       — rides on this week's run to that zone (before cut-off)
--      reserve_run    — urgent, after cut-off: Friday reserve run
--      express        — urgent, reserve also closed: next working day (approval)
--      next_week_run  — not urgent, after cut-off: next week's zone run
-- 3. Abnormal request check (ad hoc + district change requests): compares the
--    quantity with what was issued to that district before (SYNAPSE + legacy
--    history), with CMP and current district stock, and counts repeated extra
--    requests. Non-normal results create an alert kept in ops.request_alerts
--    with acknowledge / dismiss review history.
--
-- Routes
--   GET  /v1/delivery/calendar                 (all roles)
--   POST /v1/delivery/calendar                 (admin, planner) update zones / settings
--   POST /v1/ad-hoc/preview                    (admin, planner, district) slot + check before submit
--   POST /v1/ad-hoc/issues                     (wrapped) adds urgency, slot, alert
--   GET  /v1/request-alerts                    (admin, planner, academic; district = own)
--   POST /v1/request-alerts/{id}/review        (admin, planner)
--   GET  /v1/extra-requests/report             (admin, planner, academic, viewer)

begin;

-- ------------------------------------------------------------------
-- Calendar tables
-- ------------------------------------------------------------------
create table if not exists ops.delivery_zones (
  zone_code text primary key check (zone_code ~ '^[A-Z]{1,4}$'),
  name_th text not null,
  weekday smallint not null check (weekday between 1 and 5),
  vehicle text,
  sort_order smallint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create table if not exists ops.delivery_zone_districts (
  district_id text primary key references core.districts (district_id),
  zone_code text not null references ops.delivery_zones (zone_code),
  stop_order smallint not null default 0
);

create table if not exists ops.delivery_settings (
  singleton boolean primary key default true check (singleton),
  cutoff_days_before smallint not null default 1 check (cutoff_days_before between 0 and 3),
  cutoff_hour smallint not null default 14 check (cutoff_hour between 0 and 23),
  reserve_weekday smallint not null default 5 check (reserve_weekday between 1 and 5),
  plan_lock_weekday smallint not null default 4 check (plan_lock_weekday between 1 and 5),
  plan_lock_hour smallint not null default 12 check (plan_lock_hour between 0 and 23),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

insert into ops.delivery_settings (singleton) values (true) on conflict do nothing;

insert into ops.delivery_zones (zone_code, name_th, weekday, vehicle, sort_order) values
  ('E',  'ตะวันออก (ลาดกระบัง · มีนบุรี · บางกะปิ)', 2, 'พด.707', 1),
  ('SE', 'ตะวันออกเฉียงใต้ (บางพลี · สมุทรปราการ · บางนา)', 2, 'พด.708', 2),
  ('IN', 'ใจกลาง (คลองเตย · วัดเลียบ)', 2, 'พด.708', 3),
  ('W',  'ตะวันตก (บางบัวทอง · บางใหญ่)', 3, 'พด.707', 4),
  ('N',  'เหนือ (นนทบุรี · สามเสน)', 3, 'พด.708', 5),
  ('NE', 'ตะวันออกเฉียงเหนือ (บางเขน · นวลจันทร์)', 4, 'พด.707', 6),
  ('S',  'ใต้/ฝั่งธน (บางขุนเทียน · ราษฎร์บูรณะ · ธนบุรี · ยานนาวา)', 4, 'พด.708', 7)
on conflict (zone_code) do nothing;

insert into ops.delivery_zone_districts (district_id, zone_code, stop_order)
select v.district_id, v.zone_code, v.stop_order
from (values
  ('5506', 'E', 1), ('5517', 'E', 2), ('5514', 'E', 3),
  ('5516', 'SE', 1), ('5515', 'SE', 2), ('5507', 'SE', 3),
  ('5509', 'IN', 1), ('5508', 'IN', 2),
  ('5513', 'W', 1), ('5505', 'W', 2),
  ('5503', 'N', 1), ('5502', 'N', 2),
  ('5518', 'NE', 1), ('5501', 'NE', 2),
  ('5512', 'S', 1), ('5510', 'S', 2), ('5504', 'S', 3), ('5511', 'S', 4)
) as v (district_id, zone_code, stop_order)
where exists (select 1 from core.districts d where d.district_id = v.district_id)
on conflict (district_id) do nothing;

alter table ops.delivery_zones enable row level security;
alter table ops.delivery_zone_districts enable row level security;
alter table ops.delivery_settings enable row level security;
revoke all on ops.delivery_zones, ops.delivery_zone_districts, ops.delivery_settings
  from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Ad hoc request: urgency + slot
-- ------------------------------------------------------------------
alter table ops.ad_hoc_issues
  add column if not exists urgency_code text,
  add column if not exists urgency_note text,
  add column if not exists delivery_mode text,
  add column if not exists delivery_date date,
  add column if not exists delivery_zone text,
  add column if not exists cutoff_at timestamptz,
  add column if not exists alert_level text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_hoc_issues_urgency_code_check') then
    alter table ops.ad_hoc_issues add constraint ad_hoc_issues_urgency_code_check check (
      urgency_code is null or urgency_code in ('normal', 'outage', 'stock_out_job', 'project_start', 'other_urgent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ad_hoc_issues_delivery_mode_check') then
    alter table ops.ad_hoc_issues add constraint ad_hoc_issues_delivery_mode_check check (
      delivery_mode is null or delivery_mode in ('zone_run', 'reserve_run', 'express', 'next_week_run', 'unzoned'));
  end if;
end
$$;

-- ------------------------------------------------------------------
-- Slot calculation
-- ------------------------------------------------------------------
create or replace function core.m21_next_slot(p_district_id text, p_urgent boolean, p_at timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_set ops.delivery_settings%rowtype;
  v_zone ops.delivery_zones%rowtype;
  v_now timestamp := p_at at time zone 'Asia/Bangkok';
  v_today date := (p_at at time zone 'Asia/Bangkok')::date;
  v_week_end date := date_trunc('week', (p_at at time zone 'Asia/Bangkok')::date)::date + 6;
  v_d date;
  v_zone_date date;
  v_zone_cutoff timestamp;
  v_reserve date;
  v_reserve_cutoff timestamp;
  v_mode text;
  v_date date;
  v_cutoff timestamp;
  i integer;
begin
  select * into v_set from ops.delivery_settings where singleton;
  select z.* into v_zone
  from ops.delivery_zone_districts zd
  join ops.delivery_zones z on z.zone_code = zd.zone_code
  where zd.district_id = p_district_id;
  if not found then
    return jsonb_build_object('mode', 'unzoned', 'delivery_date', null, 'zone', null,
      'message', 'เขตนี้ยังไม่ได้กำหนดโซนส่งของ');
  end if;

  for i in 0..20 loop
    v_d := v_today + i;
    if extract(isodow from v_d) = v_zone.weekday
       and (v_d - v_set.cutoff_days_before)::timestamp + make_interval(hours => v_set.cutoff_hour) > v_now then
      v_zone_date := v_d;
      v_zone_cutoff := (v_d - v_set.cutoff_days_before)::timestamp + make_interval(hours => v_set.cutoff_hour);
      exit;
    end if;
  end loop;

  if v_zone_date <= v_week_end then
    v_mode := 'zone_run'; v_date := v_zone_date; v_cutoff := v_zone_cutoff;
  elsif coalesce(p_urgent, false) then
    for i in 0..6 loop
      v_d := v_today + i;
      if extract(isodow from v_d) = v_set.reserve_weekday
         and (v_d - v_set.cutoff_days_before)::timestamp + make_interval(hours => v_set.cutoff_hour) > v_now then
        v_reserve := v_d;
        v_reserve_cutoff := (v_d - v_set.cutoff_days_before)::timestamp + make_interval(hours => v_set.cutoff_hour);
        exit;
      end if;
    end loop;
    if v_reserve is not null and v_reserve < v_zone_date then
      v_mode := 'reserve_run'; v_date := v_reserve; v_cutoff := v_reserve_cutoff;
    else
      v_mode := 'express';
      v_date := v_today + 1;
      while extract(isodow from v_date) > 5 loop v_date := v_date + 1; end loop;
      v_cutoff := null;
    end if;
  else
    v_mode := 'next_week_run'; v_date := v_zone_date; v_cutoff := v_zone_cutoff;
  end if;

  return jsonb_build_object(
    'mode', v_mode,
    'delivery_date', v_date,
    'cutoff_at', case when v_cutoff is null then null else (v_cutoff at time zone 'Asia/Bangkok') end,
    'zone', v_zone.zone_code,
    'zone_name', v_zone.name_th,
    'vehicle', v_zone.vehicle,
    'zone_weekday', v_zone.weekday,
    'zone_next_run', v_zone_date,
    'message', case v_mode
      when 'zone_run' then 'พ่วงไปกับรอบส่งโซนนี้ในสัปดาห์นี้'
      when 'reserve_run' then 'เลยเวลาตัดรอบของโซนแล้ว · ด่วน จึงจัดเข้ารอบสำรองวันศุกร์'
      when 'express' then 'ด่วนและเลยรอบสำรองแล้ว · ต้องอนุมัติส่งพิเศษ (รถ 704 / รถว่าง)'
      else 'เลยเวลาตัดรอบแล้ว · ไม่ด่วน จึงไปกับรอบส่งโซนนี้สัปดาห์หน้า'
    end
  );
end;
$$;

-- ------------------------------------------------------------------
-- Abnormal request assessment
-- ------------------------------------------------------------------
create table if not exists ops.request_alerts (
  alert_id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('ad_hoc', 'change_request')),
  source_id uuid not null,
  district_id text not null,
  material_id text not null,
  requested_qty numeric not null,
  level text not null check (level in ('medium', 'high')),
  signals jsonb not null default '[]'::jsonb,
  baseline jsonb not null default '{}'::jsonb,
  reason text,
  requested_by uuid,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'dismissed')),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  unique (source, source_id)
);
create index if not exists request_alerts_status_idx on ops.request_alerts (status, created_at desc);
create index if not exists request_alerts_district_idx on ops.request_alerts (district_id, material_id, created_at desc);
alter table ops.request_alerts enable row level security;
revoke all on ops.request_alerts from public, anon, authenticated;

create or replace function core.m21_assess_request(
  p_district_id text,
  p_material_id text,
  p_qty numeric,
  p_exclude uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_hist_n integer;
  v_hist_max numeric;
  v_hist_avg numeric;
  v_last date;
  v_cmp numeric;
  v_stock numeric;
  v_months numeric;
  v_recent integer;
  v_signals jsonb := '[]'::jsonb;
  v_level text := 'normal';
  v_bump text;
begin
  with events as (
    select m.quantity as qty, (m.occurred_at at time zone 'Asia/Bangkok')::date as d
    from core.inventory_movements m
    left join core.replenishment_items i on i.replenishment_item_id = m.replenishment_item_id
    left join ops.ad_hoc_issues h on h.ad_hoc_issue_id = m.ad_hoc_issue_id
    where m.movement_type = 'ISSUE'
      and m.material_id = p_material_id
      and coalesce(i.district_id, h.district_id) = p_district_id
      and m.occurred_at > now() - interval '365 days'
    union all
    select l.issued_qty, coalesce(l.actual_date, l.plan_date)
    from ops.legacy_issue_history l
    where l.district_id = p_district_id and l.material_id = p_material_id
      and l.outcome in ('issued', 'adjusted') and coalesce(l.issued_qty, 0) > 0
      and coalesce(l.actual_date, l.plan_date) > current_date - 365
  )
  select count(*), max(qty), avg(qty), max(d) into v_hist_n, v_hist_max, v_hist_avg, v_last from events;

  select u.cmp_monthly into v_cmp
  from core.usage_rates u
  where u.material_id = p_material_id and u.district_id = p_district_id
  order by u.as_of_date desc, u.updated_at desc
  limit 1;

  select s.quantity_on_hand into v_stock
  from core.stock_snapshots s
  where s.material_id = p_material_id and s.location_id = 'DIST-' || p_district_id
  order by s.snapshot_at desc
  limit 1;

  select count(*) into v_recent
  from ops.ad_hoc_issues h
  where h.district_id = p_district_id and h.material_id = p_material_id
    and h.requested_at > now() - interval '30 days'
    and h.status not in ('rejected', 'cancelled')
    and (p_exclude is null or h.ad_hoc_issue_id <> p_exclude);

  if coalesce(v_cmp, 0) > 0 then
    v_months := round((coalesce(v_stock, 0) + p_qty) / v_cmp, 1);
  end if;

  if v_hist_n > 0 and v_hist_max > 0 and p_qty > 1.5 * v_hist_max then
    v_bump := case when p_qty > 3 * v_hist_max then 'high' else 'medium' end;
    v_signals := v_signals || jsonb_build_object('code', 'over_history', 'level', v_bump,
      'label', format('ขอ %s มากกว่าที่เคยจ่ายสูงสุด %s (%s เท่า)', trim(to_char(p_qty, 'FM999G999G990.##')),
        trim(to_char(v_hist_max, 'FM999G999G990.##')), round(p_qty / v_hist_max, 1)));
    v_level := case when v_bump = 'high' or v_level = 'high' then 'high' else 'medium' end;
  end if;
  if coalesce(v_cmp, 0) > 0 and p_qty > 3 * v_cmp then
    v_bump := case when p_qty > 6 * v_cmp then 'high' else 'medium' end;
    v_signals := v_signals || jsonb_build_object('code', 'over_cmp', 'level', v_bump,
      'label', format('ขอเท่ากับการใช้ %s เดือน (CMP %s/เดือน)', round(p_qty / v_cmp, 1),
        trim(to_char(v_cmp, 'FM999G999G990.##'))));
    v_level := case when v_bump = 'high' or v_level = 'high' then 'high' else 'medium' end;
  end if;
  if v_months is not null and v_months > 6 then
    v_bump := case when v_months > 9 then 'high' else 'medium' end;
    v_signals := v_signals || jsonb_build_object('code', 'months_after', 'level', v_bump,
      'label', format('รับแล้วเขตจะมีของพอใช้ %s เดือน (เกณฑ์ 6 เดือน)', v_months));
    v_level := case when v_bump = 'high' or v_level = 'high' then 'high' else 'medium' end;
  end if;
  if coalesce(v_hist_n, 0) = 0 and coalesce(v_cmp, 0) = 0 then
    v_signals := v_signals || jsonb_build_object('code', 'no_baseline', 'level', 'medium',
      'label', 'ไม่เคยจ่ายพัสดุนี้ให้เขตใน 12 เดือน และไม่มี CMP');
    v_level := case when v_level = 'high' then 'high' else 'medium' end;
  end if;
  if v_recent >= 2 then
    v_signals := v_signals || jsonb_build_object('code', 'repeated', 'level', 'medium',
      'label', format('ขอเพิ่มพัสดุนี้แล้ว %s ครั้งใน 30 วัน · ควรทบทวน Min/Max', v_recent));
    v_level := case when v_level = 'high' then 'high' else 'medium' end;
  end if;

  return jsonb_build_object(
    'level', v_level,
    'signals', v_signals,
    'baseline', jsonb_build_object(
      'history_count', coalesce(v_hist_n, 0),
      'history_max', v_hist_max,
      'history_avg', round(v_hist_avg, 2),
      'last_issue_date', v_last,
      'cmp', v_cmp,
      'district_stock', v_stock,
      'months_after', v_months,
      'recent_extra_requests', v_recent
    )
  );
end;
$$;

create or replace function core.m21_record_alert(
  p_source text, p_source_id uuid, p_district_id text, p_material_id text,
  p_qty numeric, p_reason text, p_requested_by uuid, p_assessment jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if coalesce(p_assessment ->> 'level', 'normal') = 'normal' then
    return;
  end if;
  insert into ops.request_alerts (source, source_id, district_id, material_id, requested_qty,
    level, signals, baseline, reason, requested_by)
  values (p_source, p_source_id, p_district_id, p_material_id, p_qty,
    p_assessment ->> 'level', p_assessment -> 'signals', p_assessment -> 'baseline',
    left(p_reason, 1000), p_requested_by)
  on conflict (source, source_id) do update
  set level = excluded.level, signals = excluded.signals, baseline = excluded.baseline,
      requested_qty = excluded.requested_qty;
end;
$$;

-- Ad hoc: slot + alert on insert
create or replace function ops.m21_ad_hoc_after_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_slot jsonb;
  v_check jsonb;
begin
  v_slot := core.m21_next_slot(new.district_id,
    coalesce(new.urgency_code, 'normal') <> 'normal', new.requested_at);
  v_check := core.m21_assess_request(new.district_id, new.material_id, new.requested_qty, new.ad_hoc_issue_id);
  update ops.ad_hoc_issues
  set delivery_mode = v_slot ->> 'mode',
      delivery_date = nullif(v_slot ->> 'delivery_date', '')::date,
      delivery_zone = v_slot ->> 'zone',
      cutoff_at = nullif(v_slot ->> 'cutoff_at', '')::timestamp at time zone 'Asia/Bangkok',
      alert_level = v_check ->> 'level'
  where ad_hoc_issue_id = new.ad_hoc_issue_id;
  perform core.m21_record_alert('ad_hoc', new.ad_hoc_issue_id, new.district_id, new.material_id,
    new.requested_qty, new.reason, new.requested_by, v_check);
  return null;
end;
$$;

drop trigger if exists m21_ad_hoc_after_insert on ops.ad_hoc_issues;
create trigger m21_ad_hoc_after_insert
  after insert on ops.ad_hoc_issues
  for each row execute function ops.m21_ad_hoc_after_insert();

-- District change request: alert on insert
create or replace function ops.m21_change_request_after_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_item core.replenishment_items%rowtype;
  v_check jsonb;
begin
  select * into v_item from core.replenishment_items where replenishment_item_id = new.replenishment_item_id;
  if not found then return null; end if;
  v_check := core.m21_assess_request(v_item.district_id, v_item.material_id, new.requested_qty, null);
  perform core.m21_record_alert('change_request', new.change_request_id, v_item.district_id,
    v_item.material_id, new.requested_qty, new.reason, new.requested_by, v_check);
  return null;
end;
$$;

drop trigger if exists m21_change_request_after_insert on ops.district_change_requests;
create trigger m21_change_request_after_insert
  after insert on ops.district_change_requests
  for each row execute function ops.m21_change_request_after_insert();

-- ------------------------------------------------------------------
-- Read models
-- ------------------------------------------------------------------
create or replace function core.m21_calendar()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
  select jsonb_build_object(
    'settings', (select to_jsonb(s) - 'singleton' from ops.delivery_settings s where singleton),
    'zones', coalesce((
      select jsonb_agg(jsonb_build_object(
        'zone_code', z.zone_code, 'name_th', z.name_th, 'weekday', z.weekday, 'vehicle', z.vehicle,
        'sort_order', z.sort_order,
        'districts', coalesce((
          select jsonb_agg(jsonb_build_object('district_id', zd.district_id,
            'district_name', d.district_name_th, 'stop_order', zd.stop_order) order by zd.stop_order)
          from ops.delivery_zone_districts zd
          join core.districts d on d.district_id = zd.district_id
          where zd.zone_code = z.zone_code), '[]'::jsonb)
      ) order by z.weekday, z.sort_order)
      from ops.delivery_zones z), '[]'::jsonb),
    'unzoned', coalesce((
      select jsonb_agg(jsonb_build_object('district_id', d.district_id, 'district_name', d.district_name_th))
      from core.districts d
      where d.is_active and not exists (select 1 from ops.delivery_zone_districts zd where zd.district_id = d.district_id)
    ), '[]'::jsonb),
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ad_hoc_issue_id', h.ad_hoc_issue_id, 'issue_number', h.issue_number,
        'district_id', h.district_id, 'district_name', d.district_name_th,
        'material_id', h.material_id, 'material_name', m.material_name, 'unit', m.unit,
        'requested_qty', h.requested_qty, 'status', h.status, 'urgency_code', h.urgency_code,
        'delivery_mode', h.delivery_mode, 'delivery_date', h.delivery_date, 'delivery_zone', h.delivery_zone,
        'alert_level', h.alert_level, 'requested_at', h.requested_at
      ) order by h.delivery_date, h.delivery_zone, h.requested_at)
      from ops.ad_hoc_issues h
      join core.districts d on d.district_id = h.district_id
      left join core.materials m on m.material_id = h.material_id
      where h.status in ('pending_approval', 'approved')
        and h.delivery_date >= (now() at time zone 'Asia/Bangkok')::date - 7
    ), '[]'::jsonb),
    'today', (now() at time zone 'Asia/Bangkok')::date
  );
$$;

create or replace function core.m21_update_calendar(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_zone jsonb;
  v_map jsonb;
  v_settings jsonb := p_body -> 'settings';
begin
  if jsonb_typeof(p_body -> 'zones') = 'array' then
    for v_zone in select value from jsonb_array_elements(p_body -> 'zones') loop
      update ops.delivery_zones
      set weekday = coalesce((v_zone ->> 'weekday')::smallint, weekday),
          vehicle = coalesce(nullif(btrim(v_zone ->> 'vehicle'), ''), vehicle),
          name_th = coalesce(nullif(btrim(v_zone ->> 'name_th'), ''), name_th),
          updated_at = now(), updated_by = auth.uid()
      where zone_code = v_zone ->> 'zone_code';
      if not found then
        raise exception 'ไม่พบโซน %', v_zone ->> 'zone_code';
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_body -> 'districts') = 'array' then
    for v_map in select value from jsonb_array_elements(p_body -> 'districts') loop
      insert into ops.delivery_zone_districts (district_id, zone_code, stop_order)
      values (v_map ->> 'district_id', v_map ->> 'zone_code', coalesce((v_map ->> 'stop_order')::smallint, 9))
      on conflict (district_id) do update
      set zone_code = excluded.zone_code, stop_order = excluded.stop_order;
    end loop;
  end if;
  if jsonb_typeof(v_settings) = 'object' then
    update ops.delivery_settings
    set cutoff_days_before = coalesce((v_settings ->> 'cutoff_days_before')::smallint, cutoff_days_before),
        cutoff_hour = coalesce((v_settings ->> 'cutoff_hour')::smallint, cutoff_hour),
        reserve_weekday = coalesce((v_settings ->> 'reserve_weekday')::smallint, reserve_weekday),
        plan_lock_weekday = coalesce((v_settings ->> 'plan_lock_weekday')::smallint, plan_lock_weekday),
        plan_lock_hour = coalesce((v_settings ->> 'plan_lock_hour')::smallint, plan_lock_hour),
        updated_at = now(), updated_by = auth.uid()
    where singleton;
  end if;
  return core.m21_calendar();
end;
$$;

create or replace function core.m21_alerts(p_query jsonb, p_scope_district text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, core, ops, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'alert_id', a.alert_id, 'source', a.source, 'source_id', a.source_id,
    'reference', coalesce(h.issue_number, p.plan_number),
    'district_id', a.district_id, 'district_name', d.district_name_th,
    'material_id', a.material_id, 'material_name', m.material_name, 'unit', m.unit,
    'requested_qty', a.requested_qty, 'level', a.level, 'signals', a.signals, 'baseline', a.baseline,
    'reason', a.reason, 'requested_by_name', coalesce(rq.display_name, h.requester_name, cr.requester_name),
    'status', a.status, 'review_note', a.review_note, 'reviewed_at', a.reviewed_at,
    'reviewed_by_name', rv.display_name, 'created_at', a.created_at,
    'request_status', coalesce(h.status, cr.status)
  ) order by (a.status = 'open') desc, a.created_at desc), '[]'::jsonb)
  from (
    select * from ops.request_alerts x
    where (p_scope_district is null or x.district_id = p_scope_district)
      and (nullif(p_query ->> 'status', '') is null or x.status = p_query ->> 'status')
      and (nullif(p_query ->> 'district_id', '') is null or x.district_id = p_query ->> 'district_id')
      and x.created_at > now() - make_interval(days => coalesce(nullif(p_query ->> 'days', '')::integer, 180))
    order by (x.status = 'open') desc, x.created_at desc
    limit 500
  ) a
  left join core.districts d on d.district_id = a.district_id
  left join core.materials m on m.material_id = a.material_id
  left join ops.ad_hoc_issues h on a.source = 'ad_hoc' and h.ad_hoc_issue_id = a.source_id
  left join ops.district_change_requests cr on a.source = 'change_request' and cr.change_request_id = a.source_id
  left join core.replenishment_items ri on ri.replenishment_item_id = cr.replenishment_item_id
  left join core.replenishment_plans p on p.replenishment_plan_id = ri.replenishment_plan_id
  left join public.user_profiles rq on rq.user_id = a.requested_by
  left join public.user_profiles rv on rv.user_id = a.reviewed_by;
$$;

create or replace function core.m21_review_alert(p_alert_id uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_decision text := lower(coalesce(p_body ->> 'decision', ''));
  v_note text := nullif(btrim(p_body ->> 'note'), '');
  v_row ops.request_alerts%rowtype;
begin
  if v_decision not in ('acknowledge', 'dismiss') then
    raise exception 'decision ต้องเป็น acknowledge หรือ dismiss';
  end if;
  if v_note is null or char_length(v_note) < 3 then
    raise exception 'กรุณาระบุหมายเหตุการตรวจสอบ';
  end if;
  update ops.request_alerts
  set status = case v_decision when 'acknowledge' then 'acknowledged' else 'dismissed' end,
      reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(v_note, 1000)
  where alert_id = p_alert_id and status = 'open'
  returning * into v_row;
  if not found then
    raise exception 'ไม่พบการแจ้งเตือนที่ยังเปิดอยู่';
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function core.m21_extra_report(p_query jsonb)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, core, ops
as $$
  with req as (
    select h.*, (h.requested_at at time zone 'Asia/Bangkok')::date as d
    from ops.ad_hoc_issues h
    where h.requested_at > now() - make_interval(days => coalesce(nullif(p_query ->> 'days', '')::integer, 90))
  )
  select jsonb_build_object(
    'days', coalesce(nullif(p_query ->> 'days', '')::integer, 90),
    'total', (select count(*) from req),
    'by_mode', coalesce((select jsonb_object_agg(coalesce(delivery_mode, 'unknown'), n) from (
      select delivery_mode, count(*) n from req group by 1) x), '{}'::jsonb),
    'by_urgency', coalesce((select jsonb_object_agg(coalesce(urgency_code, 'normal'), n) from (
      select urgency_code, count(*) n from req group by 1) x), '{}'::jsonb),
    'by_district', coalesce((select jsonb_agg(to_jsonb(x) order by x.requests desc) from (
      select r.district_id, d.district_name_th as district_name, count(*) as requests,
        count(*) filter (where coalesce(r.urgency_code, 'normal') <> 'normal') as urgent,
        count(*) filter (where r.alert_level in ('medium', 'high')) as alerts,
        count(distinct r.material_id) as materials
      from req r join core.districts d on d.district_id = r.district_id
      group by r.district_id, d.district_name_th) x), '[]'::jsonb),
    'repeats', coalesce((select jsonb_agg(to_jsonb(x) order by x.requests desc, x.qty desc) from (
      select r.district_id, d.district_name_th as district_name, r.material_id, m.material_name, m.unit,
        count(*) as requests, sum(r.requested_qty) as qty, max(r.d) as last_request
      from req r
      join core.districts d on d.district_id = r.district_id
      left join core.materials m on m.material_id = r.material_id
      group by r.district_id, d.district_name_th, r.material_id, m.material_name, m.unit
      having count(*) >= 2
      limit 100) x), '[]'::jsonb)
  );
$$;

revoke all on function core.m21_next_slot(text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function core.m21_assess_request(text, text, numeric, uuid) from public, anon, authenticated;
revoke all on function core.m21_record_alert(text, uuid, text, text, numeric, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function core.m21_calendar() from public, anon, authenticated;
revoke all on function core.m21_update_calendar(jsonb) from public, anon, authenticated;
revoke all on function core.m21_alerts(jsonb, text) from public, anon, authenticated;
revoke all on function core.m21_review_alert(uuid, jsonb) from public, anon, authenticated;
revoke all on function core.m21_extra_report(jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------
-- Dispatcher
-- ------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.m09_dispatch_impl_m21(text,text,jsonb,jsonb,text)') is null then
    alter function public.m09_dispatch(text, text, jsonb, jsonb, text)
      rename to m09_dispatch_impl_m21;
  end if;
end
$$;

create or replace function public.m09_dispatch(
  p_method text,
  p_path text,
  p_query jsonb default '{}'::jsonb,
  p_body jsonb default '{}'::jsonb,
  p_request_id text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, core
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_district_id text;
  v_method text := upper(coalesce(p_method, ''));
  v_result jsonb;
  v_id uuid;
  v_urgency text;
  v_slot jsonb;
  v_check jsonb;
begin
  if p_path in ('/v1/delivery/calendar', '/v1/ad-hoc/preview', '/v1/request-alerts', '/v1/extra-requests/report')
     or p_path ~ '^/v1/request-alerts/[0-9a-fA-F-]{36}/review$'
     or (p_path = '/v1/ad-hoc/issues' and v_method = 'POST') then
    if v_user_id is null then
      return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
    end if;
    select role::text, district_id into v_role, v_district_id
    from public.user_profiles where user_id = v_user_id and is_active;
    if v_role is null then
      return public.m09_error(403, 'forbidden', 'No application role is assigned', p_request_id);
    end if;

    if p_path = '/v1/delivery/calendar' and v_method = 'GET' then
      return public.m09_result(200, core.m21_calendar());
    end if;
    if p_path = '/v1/delivery/calendar' and v_method = 'POST' then
      if v_role not in ('admin', 'planner') then
        return public.m09_error(403, 'forbidden', 'Admin or planner role is required', p_request_id);
      end if;
      return public.m09_result(200, core.m21_update_calendar(coalesce(p_body, '{}'::jsonb)));
    end if;

    if p_path = '/v1/ad-hoc/preview' and v_method = 'POST' then
      if v_role not in ('admin', 'planner', 'district') then
        return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
      end if;
      if v_role = 'district' and p_body ->> 'district_id' is distinct from v_district_id then
        return public.m09_error(403, 'forbidden', 'District may only request for its own district', p_request_id);
      end if;
      if coalesce((p_body ->> 'requested_qty')::numeric, 0) <= 0 or nullif(p_body ->> 'material_id', '') is null then
        return public.m09_error(422, 'validation_error', 'material_id and positive requested_qty are required', p_request_id);
      end if;
      return public.m09_result(200, jsonb_build_object(
        'slot', core.m21_next_slot(p_body ->> 'district_id',
          coalesce(nullif(p_body ->> 'urgency_code', ''), 'normal') <> 'normal', now()),
        'check', core.m21_assess_request(p_body ->> 'district_id', p_body ->> 'material_id',
          (p_body ->> 'requested_qty')::numeric, null)));
    end if;

    if p_path = '/v1/ad-hoc/issues' and v_method = 'POST' then
      v_urgency := coalesce(nullif(p_body ->> 'urgency_code', ''), 'normal');
      if v_urgency not in ('normal', 'outage', 'stock_out_job', 'project_start', 'other_urgent') then
        return public.m09_error(422, 'validation_error', 'urgency_code is invalid', p_request_id);
      end if;
      if v_urgency <> 'normal' and char_length(btrim(coalesce(p_body ->> 'urgency_note', ''))) < 5 then
        return public.m09_error(422, 'validation_error', 'กรุณาระบุรายละเอียดความเร่งด่วน (อย่างน้อย 5 ตัวอักษร)', p_request_id);
      end if;
      v_result := public.m09_dispatch_impl_m21(p_method, p_path, p_query, p_body, p_request_id);
      if (v_result ->> 'status')::int <> 201 then
        return v_result;
      end if;
      v_id := (v_result #>> '{body,ad_hoc_issue_id}')::uuid;
      update ops.ad_hoc_issues
      set urgency_code = v_urgency,
          urgency_note = left(nullif(btrim(p_body ->> 'urgency_note'), ''), 1000)
      where ad_hoc_issue_id = v_id;
      select core.m21_next_slot(h.district_id, v_urgency <> 'normal', h.requested_at) into v_slot
      from ops.ad_hoc_issues h where h.ad_hoc_issue_id = v_id;
      update ops.ad_hoc_issues
      set delivery_mode = v_slot ->> 'mode',
          delivery_date = nullif(v_slot ->> 'delivery_date', '')::date,
          delivery_zone = v_slot ->> 'zone',
          cutoff_at = nullif(v_slot ->> 'cutoff_at', '')::timestamp at time zone 'Asia/Bangkok'
      where ad_hoc_issue_id = v_id;
      select jsonb_build_object('level', a.level, 'signals', a.signals, 'baseline', a.baseline)
      into v_check from ops.request_alerts a where a.source = 'ad_hoc' and a.source_id = v_id;
      return public.m09_result(201, jsonb_build_object(
        'ad_hoc_issue_id', v_id,
        'slot', v_slot,
        'check', coalesce(v_check, jsonb_build_object('level', 'normal', 'signals', '[]'::jsonb))));
    end if;

    if p_path = '/v1/request-alerts' and v_method = 'GET' then
      if v_role not in ('admin', 'planner', 'academic', 'district') then
        return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
      end if;
      return public.m09_result(200, core.m21_alerts(coalesce(p_query, '{}'::jsonb),
        case when v_role = 'district' then v_district_id end));
    end if;
    if p_path ~ '^/v1/request-alerts/[0-9a-fA-F-]{36}/review$' and v_method = 'POST' then
      if v_role not in ('admin', 'planner') then
        return public.m09_error(403, 'forbidden', 'Admin or planner role is required', p_request_id);
      end if;
      return public.m09_result(200, core.m21_review_alert(split_part(p_path, '/', 4)::uuid, p_body));
    end if;

    if p_path = '/v1/extra-requests/report' and v_method = 'GET' then
      if v_role not in ('admin', 'planner', 'academic', 'viewer') then
        return public.m09_error(403, 'forbidden', 'Insufficient application role', p_request_id);
      end if;
      return public.m09_result(200, core.m21_extra_report(coalesce(p_query, '{}'::jsonb)));
    end if;

    return public.m09_error(405, 'method_not_allowed', 'Method not allowed', p_request_id);
  end if;

  return public.m09_dispatch_impl_m21(p_method, p_path, p_query, p_body, p_request_id);
exception
  when invalid_text_representation or numeric_value_out_of_range
    or invalid_datetime_format or datetime_field_overflow then
    return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when others then
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.m09_dispatch(text, text, jsonb, jsonb, text)
  to authenticated;

commit;

-- Post-check (read only)
select
  (select count(*) from ops.delivery_zones) as zones,
  (select count(*) from ops.delivery_zone_districts) as zoned_districts,
  to_regprocedure('core.m21_assess_request(text,text,numeric,uuid)') is not null as alerts_ready;
