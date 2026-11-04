-- M26b
-- 1. "ส่งข้อมูลเข้าระบบคำนวณ" with a full district Stock file (10,020 rows) takes
--    about 8 s, and the authenticated role is cut off at 8 s, so the promotion
--    was cancelled ("Supabase API request failed"). PostgREST applies a
--    function's statement_timeout to the request, so the API dispatcher gets 60 s.
-- 2. รวมสัญญา is kept cumulatively, like 105: a contract line missing from a
--    newer, shorter export keeps its last known values in the contract-lot
--    matching instead of disappearing.

begin;

alter function public.m09_dispatch(text, text, jsonb, jsonb, text) set statement_timeout = '60s';

do $$
declare
  v_def text := pg_get_functiondef('core.m26_lot_rows()'::regprocedure);
  v_new text;
begin
  if position('contracts_cumulative' in v_def) = 0 then
    v_new := replace(v_def,
      $q$    where c.source_kind = 'contracts'
      and c.missing_since_run_id is null$q$,
      $q$    where c.source_kind = 'contracts' -- contracts_cumulative: missing lines keep their last values$q$);
    if v_new = v_def then
      raise exception 'M26b: m26_lot_rows did not match the expected text';
    end if;
    execute v_new;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';

select core.m26_contract_lots() -> 'summary' as summary;
