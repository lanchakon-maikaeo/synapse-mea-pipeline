-- SYNAPSE Wave 1 / M03: Raw ingestion and batch control
-- Includes reconciliation of existing contracts and the real DB_Material sheet.

begin;

alter table raw.import_batches
  add column if not exists connector_name text,
  add column if not exists source_entity text,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists error_message text;

create table if not exists raw.source_rows (
  source_row_id bigint generated always as identity primary key,
  batch_id uuid not null references raw.import_batches (batch_id) on delete restrict,
  source_entity text not null,
  source_sheet text,
  source_row_number integer not null check (source_row_number > 0),
  row_hash text not null check (row_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  ingested_at timestamptz not null default now(),
  unique (batch_id, source_entity, source_row_number)
);

create index if not exists source_rows_batch_entity_idx
  on raw.source_rows (batch_id, source_entity, source_row_number);

create index if not exists source_rows_row_hash_idx
  on raw.source_rows (row_hash);

create table if not exists ops.pipeline_runs (
  run_id uuid primary key default gen_random_uuid(),
  pipeline_name text not null,
  batch_id uuid references raw.import_batches (batch_id) on delete set null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  rows_read integer not null default 0 check (rows_read >= 0),
  rows_written integer not null default 0 check (rows_written >= 0),
  rows_rejected integer not null default 0 check (rows_rejected >= 0),
  metrics jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_pipeline_runs_updated_at on ops.pipeline_runs;
create trigger set_pipeline_runs_updated_at
  before update on ops.pipeline_runs
  for each row execute function audit.set_updated_at();

with contract_payloads as (
  select
    c.source_batch_id as batch_id,
    c.source_sheet,
    c.source_row_number,
    jsonb_build_object(
      'material_code', c.material_code,
      'item_description', c.item_description,
      'unit', c.unit,
      'procurement_code', c.procurement_code,
      'purchase_order', c.purchase_order,
      'contract_number', c.contract_number,
      'line_item', c.line_item,
      'vendor', c.vendor,
      'start_date', c.start_date,
      'quantity', c.quantity,
      'record_date', c.record_date,
      'bid_open_date', c.bid_open_date,
      'delivery_date', c.delivery_date,
      'acceptance_date', c.acceptance_date,
      'document_date', c.document_date,
      'end_date', c.end_date
    ) as payload
  from public.contracts c
)
insert into raw.source_rows (
  batch_id,
  source_entity,
  source_sheet,
  source_row_number,
  row_hash,
  payload
)
select
  batch_id,
  'contracts',
  source_sheet,
  source_row_number,
  encode(extensions.digest(payload::text, 'sha256'), 'hex'),
  payload
from contract_payloads
on conflict (batch_id, source_entity, source_row_number) do nothing;

update raw.import_batches b
set connector_name = coalesce(b.connector_name, 'excel'),
    source_entity = coalesce(b.source_entity, 'contracts'),
    started_at = coalesce(b.started_at, b.created_at),
    finished_at = coalesce(b.finished_at, b.imported_at, b.updated_at),
    row_count = (
      select count(*)
      from raw.source_rows r
      where r.batch_id = b.batch_id and r.source_entity = 'contracts'
    ),
    updated_at = now()
where b.source_checksum = '8ea7b0e712726e6cc1990f33b0031be231a91cc01fb4f8d96e6146d83e3cf9dd'
  and b.source_sheet = 'รวมสัญญา';

with material_batch as (
  insert into raw.import_batches (
    source_system,
    source_file,
    source_sheet,
    source_checksum,
    source_file_size_bytes,
    row_count,
    status,
    imported_at,
    connector_name,
    source_entity,
    started_at,
    finished_at,
    metadata
  )
  values (
    'excel',
    'MEA_VMI_Database_Template.xlsx',
    'DB_Material',
    '39c0735fea5e32c4c9056fdd75830f1e47bde43a71a51a67ca4e86e5bc557126',
    86871,
    203,
    'succeeded',
    now(),
    'excel',
    'materials',
    now(),
    now(),
    jsonb_build_object(
      'source_modified_at', '2026-07-12T15:08:02+07:00',
      'source_range', 'A1:H204',
      'header_rows', 1,
      'selection_reason', 'DB_Material is the real material master; mock transaction sheets are excluded'
    )
  )
  on conflict (source_checksum, source_sheet) do update
  set row_count = excluded.row_count,
      status = excluded.status,
      connector_name = excluded.connector_name,
      source_entity = excluded.source_entity,
      metadata = raw.import_batches.metadata || excluded.metadata,
      finished_at = coalesce(raw.import_batches.finished_at, now()),
      updated_at = now()
  returning batch_id
),
material_rows (source_row_number, payload) as (
  values
(2, '{"Material_ID":"471050004000","SAP_Material_ID":null,"Material_Name":"PVC CONDUIT 3/8 IN (15 MM) X 4 M.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (3, '{"Material_ID":"471050005000","SAP_Material_ID":null,"Material_Name":"PVC CONDUIT 1/2 IN (18 MM) X 4 M.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (4, '{"Material_ID":"471050010000","SAP_Material_ID":null,"Material_Name":"PVC CONDUIT 1 IN (25 MM) X 4 M.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (5, '{"Material_ID":"471051807500","SAP_Material_ID":null,"Material_Name":"RIGID STEEL CONDUIT SIZE 21, 3030 MM.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (6, '{"Material_ID":"471051820000","SAP_Material_ID":null,"Material_Name":"RIGID STEEL CONDUIT SIZE 53, 3025 MM.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (7, '{"Material_ID":"471051840000","SAP_Material_ID":null,"Material_Name":"RIGID STEEL CONDUIT SIZE 103, 3005 MM.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (8, '{"Material_ID":"471051850000","SAP_Material_ID":null,"Material_Name":"RIGID STEEL CONDUIT SIZE 129, 2995 MM.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (9, '{"Material_ID":"471053712500","SAP_Material_ID":null,"Material_Name":"RISER CONDUIT 125 mm (NORMINAL)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (10, '{"Material_ID":"471056025100","SAP_Material_ID":null,"Material_Name":"GALV. STEEL PIPE 65 mm. X 6 M.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (11, '{"Material_ID":"473049014000","SAP_Material_ID":null,"Material_Name":"HDPE CONDUIT CLASS I 140 MM (OD)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (12, '{"Material_ID":"473049606300","SAP_Material_ID":null,"Material_Name":"HDPE COUPLING (HDPE-HDPE) 63 MM","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (13, '{"Material_ID":"473049711000","SAP_Material_ID":null,"Material_Name":"HDPE COUPING (HDPE-RSC) 110 MM","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (14, '{"Material_ID":"473051940000","SAP_Material_ID":null,"Material_Name":"ELBOW 90 F/RIGID 4 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (15, '{"Material_ID":"473055211000","SAP_Material_ID":null,"Material_Name":"FLEXIBLE CONDUIT RAIN TIGHT 1 IN (H/M)","Category":null,"Unit":"เมตร","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (16, '{"Material_ID":"518069529900","SAP_Material_ID":null,"Material_Name":"DIE U31ART FOR BURNDY HYDRAULIC TOOL Y35","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (17, '{"Material_ID":"518069550000","SAP_Material_ID":null,"Material_Name":"DIE U-C FOR BUMDY TOOL Y35","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (18, '{"Material_ID":"521068030200","SAP_Material_ID":null,"Material_Name":"PVC METER BOARD 20 x 2 x 30CM","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (19, '{"Material_ID":"521068030400","SAP_Material_ID":null,"Material_Name":"PVC METER BOARD 20 x 2 x 120CM","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (20, '{"Material_ID":"521068103810","SAP_Material_ID":null,"Material_Name":"SECURITY SEALS (PLASTIC)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (21, '{"Material_ID":"521068103900","SAP_Material_ID":null,"Material_Name":"PADLOCK SEAL","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (22, '{"Material_ID":"521068115600","SAP_Material_ID":null,"Material_Name":"COPPER SEAL WIRE SPIRAL 0.50 MM X 100 M","Category":null,"Unit":"ม้วน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (23, '{"Material_ID":"551027011510","SAP_Material_ID":null,"Material_Name":"AL. CABLE CLAMP(SINGLE),TYPE AL1151","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (24, '{"Material_ID":"551027024110","SAP_Material_ID":null,"Material_Name":"AL. CABLE CLAMP(SINGLE),TYPE AL241-70","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (25, '{"Material_ID":"551027024120","SAP_Material_ID":null,"Material_Name":"AL. CABLE CLAMP(SINGLE),TYPE AL241-240","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (26, '{"Material_ID":"551027024140","SAP_Material_ID":null,"Material_Name":"AL. CABLE CLAMP(SINGLE),TYPE AL241-800","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (27, '{"Material_ID":"551027024310","SAP_Material_ID":null,"Material_Name":"AL. CABLE CLAMP(TREFOIL),TYPE AL243-70","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (28, '{"Material_ID":"551027024330","SAP_Material_ID":null,"Material_Name":"AL. CABLE CLAMP(TREFOIL),TYPE AL243-400","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (29, '{"Material_ID":"551027052300","SAP_Material_ID":null,"Material_Name":"AL CABLE CLAMP TYPE AL1151-RS","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (30, '{"Material_ID":"551027052400","SAP_Material_ID":null,"Material_Name":"AL CABLE CLAMP TYPE AL1152-RS","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (31, '{"Material_ID":"551027069100","SAP_Material_ID":null,"Material_Name":"AL. CABLE CLAMP(SINGLE),TYPE AL691","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (32, '{"Material_ID":"560500440800","SAP_Material_ID":null,"Material_Name":"MACHINE BOLT 1/2X8 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (33, '{"Material_ID":"560500441000","SAP_Material_ID":null,"Material_Name":"MACHINE BOLT 1/2X10 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (34, '{"Material_ID":"560500441200","SAP_Material_ID":null,"Material_Name":"MACHINE BOLT 1/2X12 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (35, '{"Material_ID":"560500551200","SAP_Material_ID":null,"Material_Name":"MACHINE BOLT 5/8X12 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (36, '{"Material_ID":"560501582600","SAP_Material_ID":null,"Material_Name":"STUD BOLT 1X26 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (37, '{"Material_ID":"560501582800","SAP_Material_ID":null,"Material_Name":"STUD BOLT 1X28 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (38, '{"Material_ID":"560501583000","SAP_Material_ID":null,"Material_Name":"STUD BOLT 1X30 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (39, '{"Material_ID":"560501583600","SAP_Material_ID":null,"Material_Name":"STUD BOLT 1X36 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (40, '{"Material_ID":"560501584600","SAP_Material_ID":null,"Material_Name":"STUD BOLT 1X46 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (41, '{"Material_ID":"560501585400","SAP_Material_ID":null,"Material_Name":"STUD BOLT 1x54 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (42, '{"Material_ID":"560502450000","SAP_Material_ID":null,"Material_Name":"MF LOCK NUT F/ 5/8 IN BOLT","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (43, '{"Material_ID":"561504150000","SAP_Material_ID":null,"Material_Name":"BRACKET F/STATIC GROUND WIRE 5/16 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (44, '{"Material_ID":"562063640000","SAP_Material_ID":null,"Material_Name":"CABLE ROUTE MARKER TYPE A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (45, '{"Material_ID":"562064000400","SAP_Material_ID":null,"Material_Name":"POLYPROPYLENE ROPE 12 MM. (1/2\")","Category":null,"Unit":"กิโลกรัม","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (46, '{"Material_ID":"592026910000","SAP_Material_ID":null,"Material_Name":"INSULATOR SLEEVE F/NETWORK FUSE(344-751)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (47, '{"Material_ID":"592032110630","SAP_Material_ID":null,"Material_Name":"HRC FUSE F/12kV RMU 63A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (48, '{"Material_ID":"592032111000","SAP_Material_ID":null,"Material_Name":"HRC FUSE F/12kV RMU 100A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (49, '{"Material_ID":"592032111250","SAP_Material_ID":null,"Material_Name":"HRC FUSE F/12kV RMU 125A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (50, '{"Material_ID":"592032120315","SAP_Material_ID":null,"Material_Name":"HRC FUSE F/24kV RMU 31.5A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (51, '{"Material_ID":"592032120400","SAP_Material_ID":null,"Material_Name":"HRC FUSE F/24kV RMU 40A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (52, '{"Material_ID":"592032120500","SAP_Material_ID":null,"Material_Name":"HRC FUSE F/24kV RMU 50A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (53, '{"Material_ID":"592032120630","SAP_Material_ID":null,"Material_Name":"HRC FUSE F/24kV RMU 63A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (54, '{"Material_ID":"592034101000","SAP_Material_ID":null,"Material_Name":"D-FUSE QUICK RESPONSE 10A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (55, '{"Material_ID":"592034800100","SAP_Material_ID":null,"Material_Name":"FUSE SWITCH DISCONNECTOR (FSD)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (56, '{"Material_ID":"592035725100","SAP_Material_ID":null,"Material_Name":"OUTDOOR POWER FUSE UNIT 25KV 250A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (57, '{"Material_ID":"592035730100","SAP_Material_ID":null,"Material_Name":"OUTDOOR POWER FUSE UNIT 25KV 300A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (58, '{"Material_ID":"592035740100","SAP_Material_ID":null,"Material_Name":"OUTDOOR POWER FUSE UNIT 24kV 400A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (59, '{"Material_ID":"592036200315","SAP_Material_ID":null,"Material_Name":"LV HRC FUSE BLADE CONTACT 315 A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (60, '{"Material_ID":"592036802500","SAP_Material_ID":null,"Material_Name":"AERIAL FUSE HOLDER 25A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (61, '{"Material_ID":"592036902500","SAP_Material_ID":null,"Material_Name":"SCREW CAP 25A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (62, '{"Material_ID":"592037100600","SAP_Material_ID":null,"Material_Name":"ADAPTER SCREW 6A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (63, '{"Material_ID":"592037105000","SAP_Material_ID":null,"Material_Name":"ADAPTER SCREW 50A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (64, '{"Material_ID":"592038410000","SAP_Material_ID":null,"Material_Name":"D/F CUTOUT 12kA 100A 25kV W/O BRACKET","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (65, '{"Material_ID":"592038411000","SAP_Material_ID":null,"Material_Name":"POLYMERIC FUSE CUTOUT 12 kA 100 A 25 kV","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (66, '{"Material_ID":"592038420000","SAP_Material_ID":null,"Material_Name":"D/F CUTOUT 12kA 200A 25kV W/O BRACKET","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (67, '{"Material_ID":"592038730200","SAP_Material_ID":null,"Material_Name":"OUTD.POW.FUSE 25KV400A AU.DROP OPEN TYPE","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (68, '{"Material_ID":"592047409000","SAP_Material_ID":null,"Material_Name":"SURGE ARRESTER 9 kV 5 kA","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (69, '{"Material_ID":"592047606900","SAP_Material_ID":null,"Material_Name":"SURGE ARRESTER 60 kV 10 kA","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (70, '{"Material_ID":"592538024020","SAP_Material_ID":null,"Material_Name":"RESIDUAL CURRENT CIRCUIT BREAKER 40A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (71, '{"Material_ID":"592538026320","SAP_Material_ID":null,"Material_Name":"RESIDUAL CURRENT CIRCUIT BREAKER 63A","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (72, '{"Material_ID":"592538960810","SAP_Material_ID":null,"Material_Name":"PLASTIC BARRIER F/ COMP. INSU. SUPPORTER","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (73, '{"Material_ID":"597031162000","SAP_Material_ID":null,"Material_Name":"PVC ELECTRICAL TAPE BLACK 19 MM. x 20 M.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (74, '{"Material_ID":"597031210500","SAP_Material_ID":null,"Material_Name":"FILLER TAPE 1-1/2 INX5 FT","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (75, '{"Material_ID":"597031213000","SAP_Material_ID":null,"Material_Name":"SILICONE RUBBER TAPE 1INX30FT","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (76, '{"Material_ID":"597031703400","SAP_Material_ID":null,"Material_Name":"RESIN SIZE C NO 4","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (77, '{"Material_ID":"597557504000","SAP_Material_ID":null,"Material_Name":"EXP.BOLT 12.0-13.0MM(1/2)LEN40.0-76.0 MM","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (78, '{"Material_ID":"597557505500","SAP_Material_ID":null,"Material_Name":"STAINL.EXP.BOLT 19-20MM(3/4)LEN 60-155MM","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (79, '{"Material_ID":"612063221020","SAP_Material_ID":null,"Material_Name":"BIRD GUARD ฝาครอบ BUSHING TYPE B","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (80, '{"Material_ID":"614505907100","SAP_Material_ID":null,"Material_Name":"CU.SLEEVE NON-INSUL(HEAVY DUTY)70 SQMM","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (81, '{"Material_ID":"614505918600","SAP_Material_ID":null,"Material_Name":"CU.SLEEVE NON-INSUL(HEAVY DUTY) 185 SQMM","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (82, '{"Material_ID":"614506361100","SAP_Material_ID":null,"Material_Name":"TAP COM CONN(CU) F/25-35 R &25-35 SQMM.T","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (83, '{"Material_ID":"614506364400","SAP_Material_ID":null,"Material_Name":"TAP COM CONN(CU C-FRAME)F240-185R.&185T","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (84, '{"Material_ID":"614506816700","SAP_Material_ID":null,"Material_Name":"HOT LINE CLAMP BRONZE F/ 35-70 SQMM. T","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (85, '{"Material_ID":"614507411100","SAP_Material_ID":null,"Material_Name":"TAP CONN COMPRESS 10 SQMM. R 6&10 SQMM.T","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (86, '{"Material_ID":"614507414300","SAP_Material_ID":null,"Material_Name":"TAP CONN.COMPRESS35-70SQMM.R 16-35SQMM.T","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (87, '{"Material_ID":"614507415100","SAP_Material_ID":null,"Material_Name":"TAP CONN COMPRESS 120 SQMM.R & 10 SQMM.T","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (88, '{"Material_ID":"614507472500","SAP_Material_ID":null,"Material_Name":"INSULATED CONNECTOR 6-25 R. 10-120T","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (89, '{"Material_ID":"614507474500","SAP_Material_ID":null,"Material_Name":"INSULATED CONNECTOR 6-70 R. 16-120 T","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (90, '{"Material_ID":"614507680100","SAP_Material_ID":null,"Material_Name":"NON TENSION SLEEVE 400 SQMM. AL","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (91, '{"Material_ID":"614509307010","SAP_Material_ID":null,"Material_Name":"CU LUG F/70 SQ.MM 1-HOLE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (92, '{"Material_ID":"614509625000","SAP_Material_ID":null,"Material_Name":"GUY CLAMP 2 BOLT F/5/16 IN GUY WIRE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (93, '{"Material_ID":"614509640000","SAP_Material_ID":null,"Material_Name":"GUY CLAMP 3 BOLT F/1/2 IN GUY WIRE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (94, '{"Material_ID":"614512300200","SAP_Material_ID":null,"Material_Name":"STEEL GROUND TERMINAL 45x60x6 mm","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (95, '{"Material_ID":"614513200700","SAP_Material_ID":null,"Material_Name":"PREFORM ARMOR GRIP SUS. F/400 SQMM. AAC","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (96, '{"Material_ID":"614513201000","SAP_Material_ID":null,"Material_Name":"PREFORM ARMOR GRIP SUPPORT F/400 SQMMAAC","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (97, '{"Material_ID":"614513303500","SAP_Material_ID":null,"Material_Name":"PREFORM DE. SERVICE GRIP F/35 SQMM. SDC","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (98, '{"Material_ID":"614513512000","SAP_Material_ID":null,"Material_Name":"PREFORM DE. GRIP, COATED F/120 SQMM. AWC","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (99, '{"Material_ID":"614513518500","SAP_Material_ID":null,"Material_Name":"PREFORM DE.GRIP,COATED F/185 SQMM.AWC","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (100, '{"Material_ID":"614513703500","SAP_Material_ID":null,"Material_Name":"PREFORM DE. GRIP,COATED F/35 SQMM. ASC","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (101, '{"Material_ID":"614513718500","SAP_Material_ID":null,"Material_Name":"PREFORM DE. GRIP,COATED F/185 SQMM. ASC","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (102, '{"Material_ID":"614513830000","SAP_Material_ID":null,"Material_Name":"PREFORM GUY GRIP DE. F/3/8 IN GUY WIRE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (103, '{"Material_ID":"614513840000","SAP_Material_ID":null,"Material_Name":"PREFORM GUY GRIP DE. F/1/2 IN GUY WIRE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (104, '{"Material_ID":"614514225000","SAP_Material_ID":null,"Material_Name":"PREFORM SPLICE F/5/16 IN GUY WIRE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (105, '{"Material_ID":"614519515000","SAP_Material_ID":null,"Material_Name":"ELECTROLYTIC COPPER CATHODE","Category":null,"Unit":"กิโลกรัม","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (106, '{"Material_ID":"614519520000","SAP_Material_ID":null,"Material_Name":"ALUMINUM INGOT","Category":null,"Unit":"กิโลกรัม","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (107, '{"Material_ID":"614520100310","SAP_Material_ID":null,"Material_Name":"PVC CABLE INSULATED (GREEN) 2.5 SQMM(CU)","Category":null,"Unit":"เมตร","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (108, '{"Material_ID":"614521600200","SAP_Material_ID":null,"Material_Name":"ALUMINUM TIE WIRE 6 AWG","Category":null,"Unit":"กิโลกรัม","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (109, '{"Material_ID":"614521712000","SAP_Material_ID":null,"Material_Name":"COPPER CONDUCTOR BARE 120 SQMM.","Category":null,"Unit":"เมตร","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (110, '{"Material_ID":"614521922500","SAP_Material_ID":null,"Material_Name":"COPPER BAR 1/4X2 IN X5 M","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (111, '{"Material_ID":"614522012000","SAP_Material_ID":null,"Material_Name":"COPPER BUS PIPE 3/4 IN X 6 M","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (112, '{"Material_ID":"614523171600","SAP_Material_ID":null,"Material_Name":"LINE LEAD (CU) 16 SQMM, SINGLE TERMINAL","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (113, '{"Material_ID":"614525302000","SAP_Material_ID":null,"Material_Name":"GRIP SUPPORT & RISER 1.75-2 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (114, '{"Material_ID":"614525500714","SAP_Material_ID":null,"Material_Name":"CERAMIC SPACER W/PLASTIC CLAMP TYPE 1","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (115, '{"Material_ID":"614525500750","SAP_Material_ID":null,"Material_Name":"CLAMP TYPE SPACED AERIAL CABLE SPACER","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (116, '{"Material_ID":"614525603600","SAP_Material_ID":null,"Material_Name":"PLASTIC GUARD FOR FLAT BRACE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (117, '{"Material_ID":"614525603900","SAP_Material_ID":null,"Material_Name":"PLASTIC CABLE GUARD, JUMBO SIZE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (118, '{"Material_ID":"614525610000","SAP_Material_ID":null,"Material_Name":"SPIKE F/BIRD PROTECTIVE DEVICE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (119, '{"Material_ID":"614525632000","SAP_Material_ID":null,"Material_Name":"COLD SHRINK SPLICE COVER KITS FOR ASC 18","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (120, '{"Material_ID":"614525903410","SAP_Material_ID":null,"Material_Name":"TERM KIT OUT F/TR STA 12/20kV F/35 SQ.MM","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (121, '{"Material_ID":"614525904700","SAP_Material_ID":null,"Material_Name":"TERM KIT OUT 12/20kV 240 SQMM. PRE","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (122, '{"Material_ID":"614525907200","SAP_Material_ID":null,"Material_Name":"TERM KIT OUT 12/20kV F/70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (123, '{"Material_ID":"614525907300","SAP_Material_ID":null,"Material_Name":"TERM KIT IND 12/20kV F/70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (124, '{"Material_ID":"614525907400","SAP_Material_ID":null,"Material_Name":"TERM KIT OUT TYPE II 12/20 kV F/70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (125, '{"Material_ID":"614525924200","SAP_Material_ID":null,"Material_Name":"TERM KIT OUT 12/20kV F/240 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (126, '{"Material_ID":"614525940200","SAP_Material_ID":null,"Material_Name":"TERM KIT OUT 12/20kV F/400 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (127, '{"Material_ID":"614525940300","SAP_Material_ID":null,"Material_Name":"TERM KIT IND 12/20kV F/400 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (128, '{"Material_ID":"614526004700","SAP_Material_ID":null,"Material_Name":"STR JOINT SPL KIT 12/20kV F/240 SQMM PRE","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (129, '{"Material_ID":"614526030700","SAP_Material_ID":null,"Material_Name":"STR JOINT SPL KIT 12/20kV F/70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (130, '{"Material_ID":"614526032400","SAP_Material_ID":null,"Material_Name":"STR JOINT SPL KIT 12/20kV F/240 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (131, '{"Material_ID":"614526034100","SAP_Material_ID":null,"Material_Name":"STR JOINT SPL KIT 12/20kV F/400 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (132, '{"Material_ID":"614526034300","SAP_Material_ID":null,"Material_Name":"STR JOINT SPL KIT 12/20kV F/800 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (133, '{"Material_ID":"614526052407","SAP_Material_ID":null,"Material_Name":"SPL KIT 240(24kV)-70(12kV) SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (134, '{"Material_ID":"614526052440","SAP_Material_ID":null,"Material_Name":"SPL KIT 400(12kV)-240(24kV) SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (135, '{"Material_ID":"614526431110","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 12kV 70-70-70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (136, '{"Material_ID":"614526432110","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 12kV 240-70-70 SQMM","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (137, '{"Material_ID":"614526432210","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 12kV 240-240-70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (138, '{"Material_ID":"614526432220","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 12kV 240-240-240 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (139, '{"Material_ID":"614526441111","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 12kV 70-70-70-70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (140, '{"Material_ID":"614526442211","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 12kV 240-240-70-70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (141, '{"Material_ID":"614526442212","SAP_Material_ID":null,"Material_Name":"COMPACT SPL.KIT 12KV 240-240-70-240 SQMM","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (142, '{"Material_ID":"614526442222","SAP_Material_ID":null,"Material_Name":"COMPACT SPL KIT 12KV 240-240-240-240SQMM","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (143, '{"Material_ID":"614526529401","SAP_Material_ID":null,"Material_Name":"ELBOW SPL KIT 24kV 400-400 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (144, '{"Material_ID":"614526531110","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24kV 70-70-70 SQMM","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (145, '{"Material_ID":"614526532110","SAP_Material_ID":null,"Material_Name":"COMP SPL 24kV 240-70-70 sqmm.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (146, '{"Material_ID":"614526532210","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24kV 240-240-70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (147, '{"Material_ID":"614526532220","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24KV 240-240-240 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (148, '{"Material_ID":"614526542210","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24kV 70-70-70-70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (149, '{"Material_ID":"614526542211","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24KV 240-240-70-70 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (150, '{"Material_ID":"614526542212","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24kV 240-240-70-240 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (151, '{"Material_ID":"614526542222","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24kV 240-240-240 240SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (152, '{"Material_ID":"614526543222","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24kV 400-240-240-240 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (153, '{"Material_ID":"614526543322","SAP_Material_ID":null,"Material_Name":"COMP SPL KIT 24kV 400-400-240-240 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (154, '{"Material_ID":"614526720000","SAP_Material_ID":null,"Material_Name":"CABLE PULLING LUBRICANT F/XLPE","Category":null,"Unit":"แกลลอน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (155, '{"Material_ID":"614526760100","SAP_Material_ID":null,"Material_Name":"DEADEND RECEPT F/12kV COMP SPL KIT","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (156, '{"Material_ID":"614526760300","SAP_Material_ID":null,"Material_Name":"INSULATING PLUG F/COMPACT SPL KIT","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (157, '{"Material_ID":"614526802400","SAP_Material_ID":null,"Material_Name":"PILLOW INSU TYPE A F/UG 12/20KV 400 SQMM","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (158, '{"Material_ID":"614527402000","SAP_Material_ID":null,"Material_Name":"CABLE TIE SELF-LOCKING 30 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (159, '{"Material_ID":"614527402200","SAP_Material_ID":null,"Material_Name":"CABLE TIE SELF-LOCKING (BLACK), 450 mm.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (160, '{"Material_ID":"614527432800","SAP_Material_ID":null,"Material_Name":"PILLOW INS TYPE B F/SUPPORT CABLE 69&115","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (161, '{"Material_ID":"614527781010","SAP_Material_ID":null,"Material_Name":"69 kV TERM KIT F/800 PORC (TR)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (162, '{"Material_ID":"614527782000","SAP_Material_ID":null,"Material_Name":"69 kV TERM KIT F/800 COMP (TR)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (163, '{"Material_ID":"614527782100","SAP_Material_ID":null,"Material_Name":"69 kV TERM KIT F/800 COMP (RS)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (164, '{"Material_ID":"614527880200","SAP_Material_ID":null,"Material_Name":"69 kV SPL KIT F/800 (ST)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (165, '{"Material_ID":"614527880300","SAP_Material_ID":null,"Material_Name":"69 kV SPL KIT F/800 (GS)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (166, '{"Material_ID":"614528012900","SAP_Material_ID":null,"Material_Name":"69 kV TERM KIT F/1200 (RS)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (167, '{"Material_ID":"614528080900","SAP_Material_ID":null,"Material_Name":"115 kV TERM KIT F/800 PORC (RS)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (168, '{"Material_ID":"614528080910","SAP_Material_ID":null,"Material_Name":"115 kV TERM KIT F/800 PORC (TR)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (169, '{"Material_ID":"614528082000","SAP_Material_ID":null,"Material_Name":"115 kV TERM KIT F/800 COMP (TR)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (170, '{"Material_ID":"614528180100","SAP_Material_ID":null,"Material_Name":"115 kV SPL KIT F/800 (GS)","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (171, '{"Material_ID":"614528200300","SAP_Material_ID":null,"Material_Name":"SUBMERSIBLE SEC.CONN.TYPE II(3-OUTLETS)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (172, '{"Material_ID":"614528200400","SAP_Material_ID":null,"Material_Name":"SUBMERSIBLE SEC.CONN.TYPE III(4-OUTLETS)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (173, '{"Material_ID":"614528200430","SAP_Material_ID":null,"Material_Name":"SUBM PIERCING 2ND CON F/ UG CABLE 70-240","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (174, '{"Material_ID":"614528200500","SAP_Material_ID":null,"Material_Name":"SUBMERSIBLE SEC.CONN.TYPE IV(5-OUTLETS)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (175, '{"Material_ID":"614528500300","SAP_Material_ID":null,"Material_Name":"HEAT SHRINKABLE END CAP,LARGE SIZE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (176, '{"Material_ID":"615515954400","SAP_Material_ID":null,"Material_Name":"STRAIN INSULATOR CLASS 54-4 F/24 KV","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (177, '{"Material_ID":"615516406900","SAP_Material_ID":null,"Material_Name":"HORIZONTAL LINE POST INSU. 69KV (SINGLE)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (178, '{"Material_ID":"615516407000","SAP_Material_ID":null,"Material_Name":"HORIZONTAL LINE POST INSU. 69KV (BUNDLE)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (179, '{"Material_ID":"615516411500","SAP_Material_ID":null,"Material_Name":"HORIZON. LINE POST INSU.115KV(STUD BASE)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (180, '{"Material_ID":"616517680100","SAP_Material_ID":null,"Material_Name":"STRAIN CL,795MCM  F/INSU 52-3(AL SOCKET)","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (181, '{"Material_ID":"616517904600","SAP_Material_ID":null,"Material_Name":"SUSPENSION CLAMP F/5/16 IN GROUND WIRE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (182, '{"Material_ID":"616517908100","SAP_Material_ID":null,"Material_Name":"TOP CLAMP F/LINE POST INSU.1000 MCM CU","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (183, '{"Material_ID":"616517980000","SAP_Material_ID":null,"Material_Name":"SUSPENSION CLAMP F/400 SQMM. AAC","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (184, '{"Material_ID":"616518052300","SAP_Material_ID":null,"Material_Name":"SOCKET CLEVIS, 5/8 IN BOLT F/INSU 52-3","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (185, '{"Material_ID":"616518100100","SAP_Material_ID":null,"Material_Name":"CLEVIS EYE, DEPTH 1 TO 1-1/16 IN","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (186, '{"Material_ID":"616518252300","SAP_Material_ID":null,"Material_Name":"BALL CLEVIS, 5/8 IN BOLT F/INSU.52-3","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (187, '{"Material_ID":"616518780100","SAP_Material_ID":null,"Material_Name":"FULL TENSION SLEEVE FOR 400 SQMM.","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (188, '{"Material_ID":"616518780650","SAP_Material_ID":null,"Material_Name":"AL DEADEND CONN 2-T(15 DEG) F/400 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (189, '{"Material_ID":"616518780850","SAP_Material_ID":null,"Material_Name":"AL COMP JUMPER CONN(15 DEG)F/400 SQMM.","Category":null,"Unit":"ชุด","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (190, '{"Material_ID":"621043515110","SAP_Material_ID":null,"Material_Name":"STREET LIGHT LUMINAIRE 150 W HPS HR TYPE","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (191, '{"Material_ID":"621045003800","SAP_Material_ID":null,"Material_Name":"LED LUMINAIRE CLASS P TYPE P38","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (192, '{"Material_ID":"621045500150","SAP_Material_ID":null,"Material_Name":"BALLAST F/METAL HALIDE LUMINAIRE 150 W","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (193, '{"Material_ID":"621045500250","SAP_Material_ID":null,"Material_Name":"BALLAST F/METAL HALIDE LUMINAIRE 250 W","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (194, '{"Material_ID":"621045500400","SAP_Material_ID":null,"Material_Name":"BALLAST F/METAL HALIDE LUMINAIRE 400 W","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (195, '{"Material_ID":"621045501000","SAP_Material_ID":null,"Material_Name":"BALLAST FOR HPI-T 1000 W 220V","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (196, '{"Material_ID":"621045540500","SAP_Material_ID":null,"Material_Name":"BALLAST F/HPS LAMP 400 W","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (197, '{"Material_ID":"621048210100","SAP_Material_ID":null,"Material_Name":"CAPACITOR 10 uF F/80W HP MERCURY LAMP","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (198, '{"Material_ID":"621048212000","SAP_Material_ID":null,"Material_Name":"CAPACITOR 12 uF F/125W HP MERCURY LAMP","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (199, '{"Material_ID":"621048225000","SAP_Material_ID":null,"Material_Name":"CAPACITOR 25 uF F/150W HPS LAMP","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (200, '{"Material_ID":"621048236000","SAP_Material_ID":null,"Material_Name":"CAPACITOR 36 uF F/250W HPS LAMP","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (201, '{"Material_ID":"624042401800","SAP_Material_ID":null,"Material_Name":"FLUORESCENT LAMP 18W DAYLIGHT","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (202, '{"Material_ID":"624042612600","SAP_Material_ID":null,"Material_Name":"HIGH-PRESSURE MERCURY VAPOUR LAMP 125 W","Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (203, '{"Material_ID":"841571800500","SAP_Material_ID":null,"Material_Name":"CANVAS WORKING GLOVES","Category":null,"Unit":"คู่","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb),
    (204, '{"Material_ID":"None","SAP_Material_ID":null,"Material_Name":null,"Category":null,"Unit":"อัน","Weight_per_Unit_kg":"0","Lot_Size":1,"MOQ":1}'::jsonb)
)
insert into raw.source_rows (
  batch_id,
  source_entity,
  source_sheet,
  source_row_number,
  row_hash,
  payload
)
select
  b.batch_id,
  'materials',
  'DB_Material',
  r.source_row_number,
  encode(extensions.digest(r.payload::text, 'sha256'), 'hex'),
  r.payload
from material_batch b
cross join material_rows r
on conflict (batch_id, source_entity, source_row_number) do nothing;

alter table raw.source_rows enable row level security;
alter table ops.pipeline_runs enable row level security;

revoke all on raw.source_rows, ops.pipeline_runs from public, anon, authenticated;
grant all on raw.source_rows, ops.pipeline_runs to service_role;
grant usage, select on all sequences in schema raw, ops to service_role;

insert into ops.schema_migrations (
  version,
  module,
  description,
  source_file
)
values (
  '202607150001',
  'M03',
  'Raw source rows, pipeline runs, idempotency and reconciliation of contracts plus the real DB_Material master.',
  'supabase/migrations/202607150001_m03_raw_ingestion.sql'
)
on conflict (version) do update
set description = excluded.description,
    source_file = excluded.source_file;

commit;

