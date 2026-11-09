-- M30: "ใช้ชุดนี้" with an unchanged usage (CMP) file kept no CMP.
--
-- The calculation only trusts usage / stock rows observed by the latest
-- promotion (ops.actual_workbook_imports). When the usage file had not changed
-- since the previous promotion, its evidence rows already existed and
-- "on conflict do nothing" left them on the previous promotion, so the new
-- promotion had no CMP at all and no material needed filling.
--
-- 1. m24_promote_import_center: evidence that already exists moves to the
--    promotion that observed it again (usage and stock).
-- 2. Repair: evidence of the files used by the latest promotion moves to it.

begin;

do $$
declare
  v_def text := pg_get_functiondef('core.m24_promote_import_center(text,text)'::regprocedure);
  v_new text;
  v_old_stock text := 'on conflict (stock_snapshot_id, source_row_id) do nothing;';
  v_new_stock text := 'on conflict (stock_snapshot_id, source_row_id) do update
    set actual_workbook_import_id = excluded.actual_workbook_import_id, -- M30: observed again
        change_ticket = excluded.change_ticket, verified_by = excluded.verified_by, verified_at = excluded.verified_at;';
  v_old_usage text := 'on conflict (usage_rate_id, source_row_id) do nothing;';
  v_new_usage text := 'on conflict (usage_rate_id, source_row_id) do update
    set actual_workbook_import_id = excluded.actual_workbook_import_id, -- M30: observed again
        change_ticket = excluded.change_ticket, verified_by = excluded.verified_by, verified_at = excluded.verified_at;';
begin
  if position('M30: observed again' in v_def) = 0 then
    v_new := replace(replace(v_def, v_old_stock, v_new_stock), v_old_usage, v_new_usage);
    if length(v_new) - length(v_def) <> (length(v_new_stock) - length(v_old_stock)) + (length(v_new_usage) - length(v_old_usage)) then
      raise exception 'M30: m24_promote_import_center did not match the expected text';
    end if;
    execute v_new;
  end if;
end
$$;

-- Repair the latest promotion
with latest as (
  select actual_workbook_import_id, usage_checksum, stock_checksum, change_ticket
  from ops.actual_workbook_imports
  where status = 'succeeded'
  order by finished_at desc nulls last, started_at desc
  limit 1
)
update reference_data.usage_observation_evidence e
set actual_workbook_import_id = l.actual_workbook_import_id
from latest l
where e.source_checksum = l.usage_checksum
  and e.verification_status = 'source_observed'
  and e.actual_workbook_import_id is distinct from l.actual_workbook_import_id;

commit;

select count(*) filter (where cmp_monthly is not null) as with_cmp,
  count(*) as rows,
  count(*) filter (where months_available <= 3.5 and cmp_monthly > 0) as below_trigger
from analytics.stock_health_at(now());
