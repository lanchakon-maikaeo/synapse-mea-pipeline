-- M23: short, readable plan codes.
--
--   KT-001-W33-10/08/69   (shown with the version: KT-001-W33-10/08/69-V1)
--   │  │   │   └ Monday of the delivery week, dd/mm/yy (Buddhist year)
--   │  │   └ ISO week of the delivery week
--   │  └ running number of plans for this warehouse within the Buddhist year
--   └ warehouse code (WH-KT → KT), so a second warehouse gets its own series
--
-- A revision keeps the code of its root plan; only version_no changes.
-- Existing plans are renumbered in creation order.

begin;

create or replace function core.m23_warehouse_code(p_location_id text)
returns text
language sql
stable
set search_path = pg_catalog, core
as $$
  select upper(regexp_replace(coalesce(
    (select l.warehouse_id from core.locations l where l.location_id = p_location_id),
    p_location_id, 'WH-KT'), '^WH-', ''));
$$;

create or replace function core.m23_plan_code(p_wh text, p_seq integer, p_week date)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select p_wh || '-' || lpad(p_seq::text, 3, '0')
    || '-W' || to_char(p_week, 'IW')
    || '-' || to_char(p_week, 'DD/MM/') || lpad(((extract(year from p_week)::int + 543) % 100)::text, 2, '0');
$$;

create or replace function core.m23_next_plan_seq(p_wh text, p_week date)
returns integer
language sql
stable
set search_path = pg_catalog, core
as $$
  select coalesce(max(substring(p.plan_number from '^[A-Z0-9]+-(\d+)-')::int), 0) + 1
  from core.replenishment_plans p
  where p.plan_number like p_wh || '-%'
    and right(p.plan_number, 2) = lpad(((extract(year from p_week)::int + 543) % 100)::text, 2, '0');
$$;

create or replace function core.m23_assign_plan_code()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_wh text;
begin
  if new.parent_plan_id is not null then
    -- revisions carry the root plan's code
    select p.plan_number into new.plan_number
    from core.replenishment_plans p where p.replenishment_plan_id = new.parent_plan_id;
    return new;
  end if;
  -- only the generator's old-style number (RP-IYYY-IW-xxxxxxxx) or an empty one is replaced
  if new.plan_number is not null and new.plan_number !~ '^RP-\d{4}-\d{2}-[0-9A-F]{8}$' then
    return new;
  end if;
  v_wh := core.m23_warehouse_code(new.origin_location_id);
  perform pg_advisory_xact_lock(hashtextextended('plan-code:' || v_wh, 0));
  new.plan_number := core.m23_plan_code(v_wh, core.m23_next_plan_seq(v_wh, new.week_start_date), new.week_start_date);
  return new;
end;
$$;

drop trigger if exists m23_assign_plan_code on core.replenishment_plans;
create trigger m23_assign_plan_code
  before insert on core.replenishment_plans
  for each row execute function core.m23_assign_plan_code();

-- Renumber existing plans (root plans in creation order, revisions follow their root)
with roots as (
  select p.replenishment_plan_id, p.week_start_date,
    core.m23_warehouse_code(p.origin_location_id) as wh,
    row_number() over (
      partition by core.m23_warehouse_code(p.origin_location_id), extract(year from p.week_start_date)
      order by p.created_at, p.replenishment_plan_id) as seq
  from core.replenishment_plans p
  where p.parent_plan_id is null
),
codes as (
  select r.replenishment_plan_id as root_id, core.m23_plan_code(r.wh, r.seq::int, r.week_start_date) as code
  from roots r
)
update core.replenishment_plans p
set plan_number = c.code
from codes c
where coalesce(p.parent_plan_id, p.replenishment_plan_id) = c.root_id
  and p.plan_number is distinct from c.code;

commit;

select plan_number || '-V' || version_no as plan_code, week_start_date, status
from core.replenishment_plans
order by created_at;
