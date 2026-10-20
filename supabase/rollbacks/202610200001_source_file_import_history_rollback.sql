-- Source file import history: emergency rollback.
--
-- Non-destructive. Import runs, accepted rows and the append-only version
-- history are retained as evidence; only the authenticated entry point is
-- withdrawn so no new upload, comparison or commit can happen until a
-- reviewed forward migration restores it. The dashboard then shows that the
-- database is not ready and keeps working in local check-only mode.

begin;

revoke execute on function public.srcimp_dispatch(text, text, jsonb, jsonb, text)
  from authenticated;

-- Abandon uncommitted drafts and release their working rows.
update ops.source_import_runs
set status = 'discarded',
    discarded_by = created_by,
    discarded_at = now(),
    discard_reason = 'Rolled back: source import entry point withdrawn'
where status in ('uploading', 'staged');

delete from ops.source_import_staging_rows;

commit;
