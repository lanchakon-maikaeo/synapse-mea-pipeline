-- Source file import history for the four operator-supplied files:
--   stock        Stock.xlsx               (daily)   district + warehouse stock
--   contracts    INPUT_รวมสัญญา           (daily)   contract / PO lines
--   receipts_105 INPUT_105                (daily)   Khlong Toei 105 receipts
--   usage        อัตราการใช้งาน.xlsx       (monthly) usage history and CMP
--
-- Every upload becomes an import run. Rows are first staged, compared with
-- the latest accepted value of each business key, and only an Admin commit
-- changes the accepted ("current") rows. History is kept as append-only
-- versions: new, changed, missing and reappeared rows retain before/after
-- payloads, so the accepted state at any committed run can be reconstructed
-- without storing every unchanged row every day (the managed database has a
-- small storage allowance). Staging rows are working data and are removed
-- once a run is committed or discarded; the run, its file checksum, actor,
-- timestamps and change summary are permanent.
--
-- Downstream planning is intentionally untouched: Core stock, CMP, FIFO and
-- replenishment keep reading their governed sources until promotion from
-- these accepted rows is approved separately. A new file therefore cannot
-- silently alter a locked operational plan.

begin;

create table if not exists ops.source_import_runs (
  import_run_id uuid primary key default gen_random_uuid(),
  source_kind text not null check (
    source_kind in ('stock', 'contracts', 'receipts_105', 'usage')
  ),
  file_name text not null check (length(btrim(file_name)) between 1 and 300),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  source_sheet text,
  source_metadata jsonb not null default '{}'::jsonb,
  parser_warnings jsonb not null default '[]'::jsonb check (
    jsonb_typeof(parser_warnings) = 'array'
  ),
  expected_row_count integer not null check (expected_row_count between 1 and 200000),
  status text not null default 'uploading' check (
    status in ('uploading', 'staged', 'committed', 'discarded')
  ),
  base_commit_run_id uuid references ops.source_import_runs (import_run_id),
  summary jsonb not null default '{}'::jsonb,
  warnings_acknowledged boolean not null default false,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  staged_at timestamptz,
  committed_by uuid references auth.users (id) on delete restrict,
  committed_at timestamptz,
  discarded_by uuid references auth.users (id) on delete restrict,
  discarded_at timestamptz,
  discard_reason text,
  constraint source_import_runs_commit_evidence_check check (
    status <> 'committed' or (committed_by is not null and committed_at is not null)
  ),
  constraint source_import_runs_discard_evidence_check check (
    status <> 'discarded' or (discarded_by is not null and discarded_at is not null)
  )
);

create index if not exists source_import_runs_kind_created_idx
  on ops.source_import_runs (source_kind, created_at desc);
create index if not exists source_import_runs_kind_committed_idx
  on ops.source_import_runs (source_kind, committed_at desc)
  where status = 'committed';
create index if not exists source_import_runs_created_by_idx
  on ops.source_import_runs (created_by);
create index if not exists source_import_runs_committed_by_idx
  on ops.source_import_runs (committed_by);
create index if not exists source_import_runs_discarded_by_idx
  on ops.source_import_runs (discarded_by);
create index if not exists source_import_runs_base_commit_idx
  on ops.source_import_runs (base_commit_run_id);

-- Working rows for a run that has not been committed or discarded yet.
create table if not exists ops.source_import_staging_rows (
  import_run_id uuid not null references ops.source_import_runs (import_run_id) on delete cascade,
  business_key text not null check (length(business_key) between 1 and 500),
  source_row_number integer not null check (source_row_number >= 1),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  row_hash text not null,
  change_type text check (change_type in ('new', 'changed', 'unchanged', 'reappeared')),
  primary key (import_run_id, business_key)
);

-- Latest accepted value of each business key.
create table if not exists ops.source_current_rows (
  source_kind text not null check (
    source_kind in ('stock', 'contracts', 'receipts_105', 'usage')
  ),
  business_key text not null,
  payload jsonb not null,
  row_hash text not null,
  source_row_number integer,
  first_import_run_id uuid not null references ops.source_import_runs (import_run_id),
  last_changed_run_id uuid not null references ops.source_import_runs (import_run_id),
  missing_since_run_id uuid references ops.source_import_runs (import_run_id),
  updated_at timestamptz not null default now(),
  primary key (source_kind, business_key)
);

create index if not exists source_current_rows_first_run_idx
  on ops.source_current_rows (first_import_run_id);
create index if not exists source_current_rows_last_changed_idx
  on ops.source_current_rows (last_changed_run_id);
create index if not exists source_current_rows_missing_idx
  on ops.source_current_rows (missing_since_run_id);

-- Append-only change history.
create table if not exists ops.source_row_versions (
  source_row_version_id bigint generated always as identity primary key,
  source_kind text not null,
  business_key text not null,
  import_run_id uuid not null references ops.source_import_runs (import_run_id),
  change_type text not null check (change_type in ('new', 'changed', 'missing', 'reappeared')),
  source_row_number integer,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now(),
  constraint source_row_versions_payload_check check (
    (change_type = 'new' and before_payload is null and after_payload is not null)
    or (change_type in ('changed', 'reappeared') and before_payload is not null and after_payload is not null)
    or (change_type = 'missing' and before_payload is not null and after_payload is null)
  )
);

create index if not exists source_row_versions_key_idx
  on ops.source_row_versions (source_kind, business_key, source_row_version_id);
create index if not exists source_row_versions_run_idx
  on ops.source_row_versions (import_run_id, change_type);

drop trigger if exists source_row_versions_append_only on ops.source_row_versions;
create trigger source_row_versions_append_only
  before update or delete on ops.source_row_versions
  for each row execute function audit.reject_append_only_mutation();

-- Runs keep their identity forever; only the workflow functions move status.
create or replace function ops.srcimp_guard_run_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ops.source_import_runs is retained as import evidence';
  end if;
  if old.status in ('committed', 'discarded') then
    raise exception 'Import run % is final (%)', old.import_run_id, old.status;
  end if;
  if new.import_run_id <> old.import_run_id
     or new.source_kind <> old.source_kind
     or new.file_sha256 <> old.file_sha256
     or new.file_name <> old.file_name
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'Import run identity fields are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists source_import_runs_guard on ops.source_import_runs;
create trigger source_import_runs_guard
  before update or delete on ops.source_import_runs
  for each row execute function ops.srcimp_guard_run_mutation();

alter table ops.source_import_runs enable row level security;
alter table ops.source_import_staging_rows enable row level security;
alter table ops.source_current_rows enable row level security;
alter table ops.source_row_versions enable row level security;
revoke all on ops.source_import_runs from public, anon, authenticated;
revoke all on ops.source_import_staging_rows from public, anon, authenticated;
revoke all on ops.source_current_rows from public, anon, authenticated;
revoke all on ops.source_row_versions from public, anon, authenticated;

-- Business keys are computed in the database so a client cannot redefine
-- record identity. They match the keys used by the browser parser.
create or replace function ops.srcimp_business_key(p_kind text, p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_parts text[];
begin
  case p_kind
    when 'stock' then
      -- Matches pipeline/actual_workbooks.py: absent storage is "<missing>".
      v_parts := array[
        p_payload ->> 'sap_plant_code',
        coalesce(nullif(btrim(p_payload ->> 'storage_location_code'), ''), '<missing>'),
        p_payload ->> 'material_id'
      ];
      -- Repeated plant+storage+material rows in one SAP export keep their
      -- file order as an occurrence suffix (#2, #3, …) and are flagged.
      if coalesce((p_payload ->> 'duplicate_occurrence')::integer, 1) > 1 then
        v_parts[3] := v_parts[3] || '#' || (p_payload ->> 'duplicate_occurrence');
      end if;
    when 'usage' then
      v_parts := array[p_payload ->> 'material_id', p_payload ->> 'sap_plant_code'];
    when 'contracts' then
      v_parts := array[
        coalesce(p_payload ->> 'material_code', ''),
        p_payload ->> 'purchase_order',
        regexp_replace(coalesce(p_payload ->> 'line_item', ''), '^0+(?=\d)', '')
      ];
    when 'receipts_105' then
      v_parts := array[
        p_payload ->> 'material_document',
        p_payload ->> 'material_code',
        p_payload ->> 'purchase_order',
        coalesce(p_payload ->> 'gr_gi_slip', ''),
        coalesce(p_payload ->> 'item', ''),
        coalesce(p_payload ->> 'storage_location', ''),
        coalesce(p_payload ->> 'posting_date', '')
      ];
      if p_payload ->> 'source_layout' = 'sap_105_14' then
        v_parts := v_parts || array[coalesce(p_payload ->> 'quantity', '')];
      end if;
    else
      raise exception 'Unsupported source kind %', p_kind;
  end case;

  if p_kind in ('stock', 'usage') and exists (
    select 1 from unnest(v_parts) part where nullif(btrim(part), '') is null
  ) then
    raise exception 'Row is missing an identity field for %', p_kind;
  end if;
  if p_kind = 'contracts' and (v_parts[2] is null or v_parts[3] = '') then
    raise exception 'Contract row requires purchase_order and line_item';
  end if;
  if p_kind = 'receipts_105' and (v_parts[1] is null or v_parts[2] is null or v_parts[3] is null) then
    raise exception 'Receipt row requires material_document, material_code and purchase_order';
  end if;

  return array_to_string(v_parts, '|');
end;
$$;

create or replace function ops.srcimp_actor_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role::text
  from public.user_profiles
  where user_id = (select auth.uid()) and is_active
$$;

create or replace function ops.srcimp_latest_commit(p_kind text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select import_run_id
  from ops.source_import_runs
  where source_kind = p_kind and status = 'committed'
  order by committed_at desc, import_run_id desc
  limit 1
$$;

create or replace function ops.srcimp_run_json(p_run ops.source_import_runs)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'import_run_id', p_run.import_run_id,
    'source_kind', p_run.source_kind,
    'file_name', p_run.file_name,
    'file_sha256', p_run.file_sha256,
    'file_size_bytes', p_run.file_size_bytes,
    'source_sheet', p_run.source_sheet,
    'source_metadata', p_run.source_metadata,
    'parser_warnings', p_run.parser_warnings,
    'expected_row_count', p_run.expected_row_count,
    'status', p_run.status,
    'summary', p_run.summary,
    'warnings_acknowledged', p_run.warnings_acknowledged,
    'created_by', p_run.created_by,
    'created_by_name', (select display_name from public.user_profiles where user_id = p_run.created_by),
    'created_at', p_run.created_at,
    'staged_at', p_run.staged_at,
    'committed_by', p_run.committed_by,
    'committed_by_name', (select display_name from public.user_profiles where user_id = p_run.committed_by),
    'committed_at', p_run.committed_at,
    'discarded_at', p_run.discarded_at,
    'discard_reason', p_run.discard_reason,
    'is_stale', p_run.status = 'staged'
      and p_run.base_commit_run_id is distinct from ops.srcimp_latest_commit(p_run.source_kind),
    'same_file_as_latest_commit', exists (
      select 1 from ops.source_import_runs latest
      where latest.import_run_id = ops.srcimp_latest_commit(p_run.source_kind)
        and latest.import_run_id <> p_run.import_run_id
        and latest.file_sha256 = p_run.file_sha256
    )
  )
$$;

create or replace function ops.srcimp_create_run(p_body jsonb)
returns ops.source_import_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run ops.source_import_runs;
begin
  -- Abandoned drafts older than two days release their working rows.
  update ops.source_import_runs
  set status = 'discarded',
      discarded_by = created_by,
      discarded_at = now(),
      discard_reason = 'Draft expired without commit'
  where status in ('uploading', 'staged')
    and created_at < now() - interval '2 days';
  delete from ops.source_import_staging_rows s
  using ops.source_import_runs r
  where r.import_run_id = s.import_run_id and r.status = 'discarded';

  insert into ops.source_import_runs (
    source_kind, file_name, file_sha256, file_size_bytes, source_sheet,
    source_metadata, parser_warnings, expected_row_count, created_by
  )
  values (
    p_body ->> 'source_kind',
    left(btrim(p_body ->> 'file_name'), 300),
    lower(p_body ->> 'file_sha256'),
    nullif(p_body ->> 'file_size_bytes', '')::bigint,
    left(nullif(btrim(p_body ->> 'source_sheet'), ''), 200),
    coalesce(p_body -> 'source_metadata', '{}'::jsonb),
    coalesce(p_body -> 'parser_warnings', '[]'::jsonb),
    (p_body ->> 'expected_row_count')::integer,
    auth.uid()
  )
  returning * into v_run;
  return v_run;
end;
$$;

create or replace function ops.srcimp_append_rows(p_run_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run ops.source_import_runs;
  v_inserted integer;
  v_total integer;
begin
  select * into v_run from ops.source_import_runs where import_run_id = p_run_id for update;
  if not found then
    raise exception 'srcimp:404:Import run not found';
  end if;
  if v_run.status <> 'uploading' then
    raise exception 'srcimp:409:Import run is no longer accepting rows (%)', v_run.status;
  end if;
  if v_run.created_by <> auth.uid() and ops.srcimp_actor_role() <> 'admin' then
    raise exception 'srcimp:403:Only the uploader or an admin may add rows';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'srcimp:422:rows must be an array of 1 to 5000 items';
  end if;

  begin
    insert into ops.source_import_staging_rows (
      import_run_id, business_key, source_row_number, payload, row_hash
    )
    select
      p_run_id,
      ops.srcimp_business_key(v_run.source_kind, item -> 'payload'),
      (item ->> 'row_number')::integer,
      item -> 'payload',
      md5((item -> 'payload')::text)
    from jsonb_array_elements(p_rows) item;
  exception
    when unique_violation then
      raise exception 'srcimp:422:Duplicate business key in this file; review the source before importing';
  end;
  get diagnostics v_inserted = row_count;

  select count(*) into v_total from ops.source_import_staging_rows where import_run_id = p_run_id;
  if v_total > v_run.expected_row_count then
    raise exception 'srcimp:422:More rows uploaded (%) than declared (%)', v_total, v_run.expected_row_count;
  end if;
  return jsonb_build_object('import_run_id', p_run_id, 'inserted', v_inserted, 'uploaded', v_total,
    'expected', v_run.expected_row_count);
end;
$$;

create or replace function ops.srcimp_stage(p_run_id uuid)
returns ops.source_import_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run ops.source_import_runs;
  v_total integer;
  v_summary jsonb;
begin
  select * into v_run from ops.source_import_runs where import_run_id = p_run_id for update;
  if not found then
    raise exception 'srcimp:404:Import run not found';
  end if;
  if v_run.status not in ('uploading', 'staged') then
    raise exception 'srcimp:409:Import run is %', v_run.status;
  end if;
  if v_run.created_by <> auth.uid() and ops.srcimp_actor_role() <> 'admin' then
    raise exception 'srcimp:403:Only the uploader or an admin may stage this run';
  end if;
  select count(*) into v_total from ops.source_import_staging_rows where import_run_id = p_run_id;
  if v_total <> v_run.expected_row_count then
    raise exception 'srcimp:422:Upload incomplete: % of % rows received', v_total, v_run.expected_row_count;
  end if;

  update ops.source_import_staging_rows s
  set change_type = coalesce((
    select case
      when c.row_hash <> s.row_hash then 'changed'
      when c.missing_since_run_id is not null then 'reappeared'
      else 'unchanged'
    end
    from ops.source_current_rows c
    where c.source_kind = v_run.source_kind and c.business_key = s.business_key
  ), 'new')
  where s.import_run_id = p_run_id;

  select jsonb_build_object(
    'total_rows', v_total,
    'new', count(*) filter (where change_type = 'new'),
    'changed', count(*) filter (where change_type = 'changed'),
    'reappeared', count(*) filter (where change_type = 'reappeared'),
    'unchanged', count(*) filter (where change_type = 'unchanged'),
    'missing', (
      select count(*) from ops.source_current_rows c
      where c.source_kind = v_run.source_kind
        and c.missing_since_run_id is null
        and not exists (
          select 1 from ops.source_import_staging_rows s
          where s.import_run_id = p_run_id and s.business_key = c.business_key
        )
    ),
    'previously_accepted_rows', (
      select count(*) from ops.source_current_rows c
      where c.source_kind = v_run.source_kind and c.missing_since_run_id is null
    )
  ) into v_summary
  from ops.source_import_staging_rows
  where import_run_id = p_run_id;

  update ops.source_import_runs
  set status = 'staged',
      staged_at = now(),
      base_commit_run_id = ops.srcimp_latest_commit(source_kind),
      summary = v_summary
  where import_run_id = p_run_id
  returning * into v_run;
  return v_run;
end;
$$;

create or replace function ops.srcimp_changes(p_run_id uuid, p_type text, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_run ops.source_import_runs;
  v_rows jsonb;
begin
  select * into v_run from ops.source_import_runs where import_run_id = p_run_id;
  if not found then
    raise exception 'srcimp:404:Import run not found';
  end if;
  if p_type not in ('new', 'changed', 'reappeared', 'missing') then
    raise exception 'srcimp:422:type must be new, changed, reappeared or missing';
  end if;

  if v_run.status = 'committed' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'business_key', v.business_key,
      'source_row_number', v.source_row_number,
      'before', v.before_payload,
      'after', v.after_payload
    ) order by v.source_row_version_id), '[]'::jsonb) into v_rows
    from (
      select * from ops.source_row_versions
      where import_run_id = p_run_id and change_type = p_type
      order by source_row_version_id
      limit p_limit offset p_offset
    ) v;
  elsif v_run.status = 'staged' and p_type = 'missing' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'business_key', c.business_key,
      'source_row_number', c.source_row_number,
      'before', c.payload,
      'after', null
    ) order by c.business_key), '[]'::jsonb) into v_rows
    from (
      select * from ops.source_current_rows c
      where c.source_kind = v_run.source_kind
        and c.missing_since_run_id is null
        and not exists (
          select 1 from ops.source_import_staging_rows s
          where s.import_run_id = p_run_id and s.business_key = c.business_key
        )
      order by c.business_key
      limit p_limit offset p_offset
    ) c;
  elsif v_run.status = 'staged' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'business_key', s.business_key,
      'source_row_number', s.source_row_number,
      'before', c.payload,
      'after', s.payload
    ) order by s.source_row_number), '[]'::jsonb) into v_rows
    from (
      select * from ops.source_import_staging_rows
      where import_run_id = p_run_id and change_type = p_type
      order by source_row_number
      limit p_limit offset p_offset
    ) s
    left join ops.source_current_rows c
      on c.source_kind = v_run.source_kind and c.business_key = s.business_key;
  else
    v_rows := '[]'::jsonb;
  end if;
  return jsonb_build_object('import_run_id', p_run_id, 'type', p_type, 'rows', v_rows);
end;
$$;

create or replace function ops.srcimp_commit(p_run_id uuid, p_acknowledge_warnings boolean)
returns ops.source_import_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run ops.source_import_runs;
  v_user uuid := auth.uid();
begin
  select * into v_run from ops.source_import_runs where import_run_id = p_run_id for update;
  if not found then
    raise exception 'srcimp:404:Import run not found';
  end if;
  -- One commit at a time per source kind keeps base_commit checks exact.
  perform pg_advisory_xact_lock(hashtextextended('srcimp:' || v_run.source_kind, 0));
  if v_run.status <> 'staged' then
    raise exception 'srcimp:409:Only a staged import can be committed (current: %)', v_run.status;
  end if;
  if v_run.base_commit_run_id is distinct from ops.srcimp_latest_commit(v_run.source_kind) then
    raise exception 'srcimp:409:A newer import of this file type was committed after this one was checked; upload and check it again';
  end if;
  if jsonb_array_length(v_run.parser_warnings) > 0 and not coalesce(p_acknowledge_warnings, false) then
    raise exception 'srcimp:422:Parser warnings must be acknowledged before commit';
  end if;

  insert into ops.source_row_versions (
    source_kind, business_key, import_run_id, change_type, source_row_number,
    before_payload, after_payload
  )
  select v_run.source_kind, s.business_key, p_run_id, s.change_type, s.source_row_number,
    c.payload, s.payload
  from ops.source_import_staging_rows s
  left join ops.source_current_rows c
    on c.source_kind = v_run.source_kind and c.business_key = s.business_key
  where s.import_run_id = p_run_id
    and s.change_type in ('new', 'changed', 'reappeared')
  order by s.source_row_number;

  insert into ops.source_row_versions (
    source_kind, business_key, import_run_id, change_type, source_row_number,
    before_payload, after_payload
  )
  select c.source_kind, c.business_key, p_run_id, 'missing', c.source_row_number, c.payload, null
  from ops.source_current_rows c
  where c.source_kind = v_run.source_kind
    and c.missing_since_run_id is null
    and not exists (
      select 1 from ops.source_import_staging_rows s
      where s.import_run_id = p_run_id and s.business_key = c.business_key
    )
  order by c.business_key;

  update ops.source_current_rows c
  set missing_since_run_id = p_run_id,
      updated_at = now()
  where c.source_kind = v_run.source_kind
    and c.missing_since_run_id is null
    and not exists (
      select 1 from ops.source_import_staging_rows s
      where s.import_run_id = p_run_id and s.business_key = c.business_key
    );

  insert into ops.source_current_rows (
    source_kind, business_key, payload, row_hash, source_row_number,
    first_import_run_id, last_changed_run_id
  )
  select v_run.source_kind, s.business_key, s.payload, s.row_hash, s.source_row_number,
    p_run_id, p_run_id
  from ops.source_import_staging_rows s
  where s.import_run_id = p_run_id and s.change_type = 'new';

  update ops.source_current_rows c
  set payload = s.payload,
      row_hash = s.row_hash,
      source_row_number = s.source_row_number,
      last_changed_run_id = p_run_id,
      missing_since_run_id = null,
      updated_at = now()
  from ops.source_import_staging_rows s
  where s.import_run_id = p_run_id
    and s.change_type in ('changed', 'reappeared')
    and c.source_kind = v_run.source_kind
    and c.business_key = s.business_key;

  -- Unchanged rows keep their accepted value; only their source row number
  -- may move inside the new file, which is not a business change.
  update ops.source_current_rows c
  set source_row_number = s.source_row_number
  from ops.source_import_staging_rows s
  where s.import_run_id = p_run_id
    and s.change_type = 'unchanged'
    and c.source_kind = v_run.source_kind
    and c.business_key = s.business_key
    and c.source_row_number is distinct from s.source_row_number;

  delete from ops.source_import_staging_rows where import_run_id = p_run_id;

  update ops.source_import_runs
  set status = 'committed',
      committed_by = v_user,
      committed_at = now(),
      warnings_acknowledged = coalesce(p_acknowledge_warnings, false)
  where import_run_id = p_run_id
  returning * into v_run;
  return v_run;
end;
$$;

create or replace function ops.srcimp_discard(p_run_id uuid, p_reason text)
returns ops.source_import_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run ops.source_import_runs;
begin
  select * into v_run from ops.source_import_runs where import_run_id = p_run_id for update;
  if not found then
    raise exception 'srcimp:404:Import run not found';
  end if;
  if v_run.status not in ('uploading', 'staged') then
    raise exception 'srcimp:409:Import run is already %', v_run.status;
  end if;
  if v_run.created_by <> auth.uid() and ops.srcimp_actor_role() <> 'admin' then
    raise exception 'srcimp:403:Only the uploader or an admin may discard this run';
  end if;
  delete from ops.source_import_staging_rows where import_run_id = p_run_id;
  update ops.source_import_runs
  set status = 'discarded',
      discarded_by = auth.uid(),
      discarded_at = now(),
      discard_reason = left(nullif(btrim(p_reason), ''), 500)
  where import_run_id = p_run_id
  returning * into v_run;
  return v_run;
end;
$$;

create or replace function public.srcimp_dispatch(
  p_method text,
  p_path text,
  p_query jsonb default '{}'::jsonb,
  p_body jsonb default '{}'::jsonb,
  p_request_id text default 'unknown'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_method text := upper(coalesce(p_method, ''));
  v_count integer;
  v_match text[];
  v_run_id uuid;
  v_run ops.source_import_runs;
  v_payload jsonb;
  v_limit integer;
  v_offset integer;
  v_parts text[];
begin
  if v_user_id is null then
    return public.m09_error(401, 'unauthorized', 'Missing or invalid bearer token', p_request_id);
  end if;
  v_role := ops.srcimp_actor_role();
  if v_role is null then
    return public.m09_error(403, 'forbidden', 'No application role is assigned', p_request_id);
  end if;
  if v_role not in ('admin', 'planner') then
    return public.m09_error(403, 'forbidden', 'Admin or planner role is required for source imports', p_request_id);
  end if;

  insert into ops.api_rate_limit_windows (user_id, window_start, request_count)
  values (v_user_id, date_trunc('minute', clock_timestamp()), 1)
  on conflict (user_id, window_start) do update
  set request_count = ops.api_rate_limit_windows.request_count + 1,
      updated_at = now()
  returning request_count into v_count;
  if v_count > 120 then
    return public.m09_error(429, 'rate_limited', 'Too many requests', p_request_id);
  end if;

  if v_method = 'GET' and p_path = '/v1/source-imports/runs' then
    v_limit := least(greatest(coalesce(nullif(p_query ->> 'limit', '')::integer, 30), 1), 200);
    select coalesce(jsonb_agg(ops.srcimp_run_json(r) order by r.created_at desc), '[]'::jsonb)
    into v_payload
    from (
      select * from ops.source_import_runs
      where (nullif(p_query ->> 'source_kind', '') is null or source_kind = p_query ->> 'source_kind')
      order by created_at desc
      limit v_limit
    ) r;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'GET' and p_path = '/v1/source-imports/current' then
    select coalesce(jsonb_object_agg(kind, jsonb_build_object(
      'accepted_rows', (select count(*) from ops.source_current_rows c
        where c.source_kind = kind and c.missing_since_run_id is null),
      'missing_rows', (select count(*) from ops.source_current_rows c
        where c.source_kind = kind and c.missing_since_run_id is not null),
      'latest_commit', (select ops.srcimp_run_json(r) from ops.source_import_runs r
        where r.import_run_id = ops.srcimp_latest_commit(kind))
    )), '{}'::jsonb)
    into v_payload
    from unnest(array['stock', 'contracts', 'receipts_105', 'usage']) kind;
    return public.m09_result(200, v_payload);
  end if;

  -- Accepted rows for the material summary on the Import page. Vendor names
  -- stay hidden (Business Rules v1) and the monthly usage history is left out
  -- to keep the response small; both remain in the stored history.
  if v_method = 'GET' and p_path = '/v1/source-imports/current-rows' then
    if coalesce(p_query ->> 'source_kind', '') not in ('stock', 'contracts', 'receipts_105', 'usage') then
      return public.m09_error(422, 'validation_error', 'source_kind is invalid', p_request_id);
    end if;
    v_limit := least(greatest(coalesce(nullif(p_query ->> 'limit', '')::integer, 5000), 1), 5000);
    v_offset := greatest(coalesce(nullif(p_query ->> 'offset', '')::integer, 0), 0);
    select jsonb_build_object(
      'source_kind', p_query ->> 'source_kind',
      'total', (select count(*) from ops.source_current_rows c
        where c.source_kind = p_query ->> 'source_kind' and c.missing_since_run_id is null),
      'rows', coalesce(jsonb_agg(c.payload - 'vendor' - 'monthly_usage' order by c.business_key), '[]'::jsonb)
    )
    into v_payload
    from (
      select business_key, payload from ops.source_current_rows
      where source_kind = p_query ->> 'source_kind' and missing_since_run_id is null
      order by business_key
      limit v_limit offset v_offset
    ) c;
    return public.m09_result(200, v_payload);
  end if;

  if v_method = 'POST' and p_path = '/v1/source-imports/runs' then
    if coalesce(p_body ->> 'source_kind', '') not in ('stock', 'contracts', 'receipts_105', 'usage') then
      return public.m09_error(422, 'validation_error', 'source_kind is invalid', p_request_id);
    end if;
    if coalesce(p_body ->> 'file_sha256', '') !~ '^[0-9a-fA-F]{64}$' then
      return public.m09_error(422, 'validation_error', 'file_sha256 must be a SHA-256 hex digest', p_request_id);
    end if;
    if nullif(btrim(p_body ->> 'file_name'), '') is null then
      return public.m09_error(422, 'validation_error', 'file_name is required', p_request_id);
    end if;
    if coalesce(p_body ->> 'expected_row_count', '') !~ '^\d+$' then
      return public.m09_error(422, 'validation_error', 'expected_row_count is required', p_request_id);
    end if;
    v_run := ops.srcimp_create_run(p_body);
    return public.m09_result(201, ops.srcimp_run_json(v_run));
  end if;

  v_match := regexp_match(
    p_path,
    '^/v1/source-imports/runs/([0-9a-fA-F-]{36})(?:/(rows|stage|commit|discard|changes))?$'
  );
  if v_match is null then
    return public.m09_error(404, 'not_found', 'Source import path not found', p_request_id);
  end if;
  v_run_id := v_match[1]::uuid;

  if v_method = 'GET' and v_match[2] is null then
    select * into v_run from ops.source_import_runs where import_run_id = v_run_id;
    if not found then
      return public.m09_error(404, 'not_found', 'Import run not found', p_request_id);
    end if;
    return public.m09_result(200, ops.srcimp_run_json(v_run));
  end if;

  if v_method = 'GET' and v_match[2] = 'changes' then
    v_limit := least(greatest(coalesce(nullif(p_query ->> 'limit', '')::integer, 50), 1), 500);
    v_offset := greatest(coalesce(nullif(p_query ->> 'offset', '')::integer, 0), 0);
    return public.m09_result(200, ops.srcimp_changes(
      v_run_id, coalesce(nullif(p_query ->> 'type', ''), 'changed'), v_limit, v_offset));
  end if;

  if v_method = 'POST' and v_match[2] = 'rows' then
    return public.m09_result(200, ops.srcimp_append_rows(v_run_id, p_body -> 'rows'));
  end if;

  if v_method = 'POST' and v_match[2] = 'stage' then
    v_run := ops.srcimp_stage(v_run_id);
    return public.m09_result(200, ops.srcimp_run_json(v_run));
  end if;

  if v_method = 'POST' and v_match[2] = 'commit' then
    if v_role <> 'admin' then
      return public.m09_error(403, 'forbidden', 'Admin role is required to confirm an import', p_request_id);
    end if;
    v_run := ops.srcimp_commit(v_run_id, coalesce((p_body ->> 'acknowledge_warnings')::boolean, false));
    return public.m09_result(200, ops.srcimp_run_json(v_run));
  end if;

  if v_method = 'POST' and v_match[2] = 'discard' then
    v_run := ops.srcimp_discard(v_run_id, p_body ->> 'reason');
    return public.m09_result(200, ops.srcimp_run_json(v_run));
  end if;

  return public.m09_error(405, 'method_not_allowed', 'Method not allowed for this path', p_request_id);
exception
  when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
    return public.m09_error(422, 'validation_error', left(sqlerrm, 500), p_request_id);
  when others then
    if sqlerrm like 'srcimp:%' then
      v_parts := regexp_match(sqlerrm, '^srcimp:(\d{3}):(.*)$');
      return public.m09_error(
        v_parts[1]::integer,
        case v_parts[1]
          when '403' then 'forbidden'
          when '404' then 'not_found'
          when '409' then 'conflict'
          else 'validation_error'
        end,
        left(v_parts[2], 500),
        p_request_id
      );
    end if;
    return public.m09_error(400, 'bad_request', left(sqlerrm, 500), p_request_id);
end;
$$;

revoke all on function ops.srcimp_business_key(text, jsonb) from public, anon, authenticated;
revoke all on function ops.srcimp_actor_role() from public, anon, authenticated;
revoke all on function ops.srcimp_latest_commit(text) from public, anon, authenticated;
revoke all on function ops.srcimp_run_json(ops.source_import_runs) from public, anon, authenticated;
revoke all on function ops.srcimp_create_run(jsonb) from public, anon, authenticated;
revoke all on function ops.srcimp_append_rows(uuid, jsonb) from public, anon, authenticated;
revoke all on function ops.srcimp_stage(uuid) from public, anon, authenticated;
revoke all on function ops.srcimp_changes(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function ops.srcimp_commit(uuid, boolean) from public, anon, authenticated;
revoke all on function ops.srcimp_discard(uuid, text) from public, anon, authenticated;
revoke all on function ops.srcimp_guard_run_mutation() from public, anon, authenticated;
revoke all on function public.srcimp_dispatch(text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.srcimp_dispatch(text, text, jsonb, jsonb, text)
  to authenticated;

comment on table ops.source_import_runs is
  'One upload of Stock, contracts, 105 receipts or usage/CMP: file checksum, actor, workflow status and change summary.';
comment on table ops.source_import_staging_rows is
  'Working rows of an uncommitted import run; removed when the run is committed or discarded.';
comment on table ops.source_current_rows is
  'Latest accepted value per source business key. Rows absent from a newer file are flagged, never deleted.';
comment on table ops.source_row_versions is
  'Append-only history of new, changed, missing and reappeared source rows with before/after payloads.';

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202610200001',
  'source-file-imports',
  'Governed history for daily Stock, contracts, 105 receipts and monthly usage/CMP file imports.',
  'supabase/migrations/202610200001_source_file_import_history.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;
