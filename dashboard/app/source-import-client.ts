import { publicConfig } from "./lib";

export type SourceKind = "stock" | "district_stock" | "contracts" | "receipts_105" | "usage" | "materials";
export type ChangeType = "new" | "changed" | "reappeared" | "missing";

export type ImportSummary = {
  total_rows?: number;
  new?: number;
  changed?: number;
  reappeared?: number;
  unchanged?: number;
  missing?: number;
  previously_accepted_rows?: number;
};

export type ImportRun = {
  import_run_id: string;
  source_kind: SourceKind;
  file_name: string;
  file_sha256: string;
  file_size_bytes: number | null;
  source_sheet: string | null;
  source_metadata: Record<string, unknown>;
  parser_warnings: string[];
  expected_row_count: number;
  status: "uploading" | "staged" | "committed" | "discarded";
  summary: ImportSummary;
  warnings_acknowledged: boolean;
  created_by_name: string | null;
  created_at: string;
  staged_at: string | null;
  committed_by_name: string | null;
  committed_at: string | null;
  discarded_at: string | null;
  discard_reason: string | null;
  is_stale: boolean;
  same_file_as_latest_commit: boolean;
};

export type CurrentSourceState = Record<SourceKind, {
  accepted_rows: number;
  missing_rows: number;
  latest_commit: ImportRun | null;
}>;

export type ChangeRow = {
  business_key: string;
  source_row_number: number | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export class SourceImportError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The managed database has not received the import-history migration yet. */
export function isImportBackendMissing(reason: unknown) {
  return reason instanceof SourceImportError &&
    (reason.status === 404 || reason.status === 502 || reason.status === 503);
}

async function call<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const search = query ? `?${new URLSearchParams(query).toString()}` : "";
  const response = await fetch(`${publicConfig.apiBaseUrl}/v1/source-imports${path}${search}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as
    T & { error?: { message?: string; request_id?: string } };
  if (!response.ok) {
    const requestId = payload.error?.request_id ? ` • Request ${payload.error.request_id}` : "";
    throw new SourceImportError(
      `${payload.error?.message ?? `คำขอไม่สำเร็จ (${response.status})`}${requestId}`,
      response.status,
    );
  }
  return payload;
}

// The same-origin API accepts at most 1 MB per request.
const MAX_CHUNK_BYTES = 750_000;
const MAX_CHUNK_ROWS = 2000;

export function chunkRows<T>(rows: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (current.length && (bytes + size > MAX_CHUNK_BYTES || current.length >= MAX_CHUNK_ROWS)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export const sourceImportApi = {
  current: (token: string) => call<CurrentSourceState>(token, "GET", "/current"),
  runs: (token: string, limit = 30) =>
    call<ImportRun[]>(token, "GET", "/runs", undefined, { limit: String(limit) }),
  /** All accepted rows of one file type (vendor and monthly history omitted). */
  async currentRows(token: string, kind: SourceKind): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < 200000; offset += 5000) {
      const page = await call<{ total: number; rows: Array<Record<string, unknown>> }>(
        token, "GET", "/current-rows", undefined,
        { source_kind: kind, limit: "5000", offset: String(offset) });
      rows.push(...page.rows);
      if (rows.length >= page.total || page.rows.length === 0) break;
    }
    return rows;
  },
  changes: (token: string, runId: string, type: ChangeType, limit = 25) =>
    call<{ rows: ChangeRow[] }>(token, "GET", `/runs/${runId}/changes`, undefined,
      { type, limit: String(limit) }),
  commit: (token: string, runId: string, acknowledgeWarnings: boolean) =>
    call<ImportRun>(token, "POST", `/runs/${runId}/commit`, { acknowledge_warnings: acknowledgeWarnings }),
  discard: (token: string, runId: string, reason: string) =>
    call<ImportRun>(token, "POST", `/runs/${runId}/discard`, { reason }),

  /** Create a run, upload every row in size-bounded chunks, then compare. */
  async upload(
    token: string,
    file: {
      kind: SourceKind;
      name: string;
      sha256: string;
      size: number;
      sheet: string;
      metadata: Record<string, unknown>;
      warnings: string[];
      rows: Array<{ row_number: number; payload: unknown }>;
    },
    onProgress: (uploaded: number, total: number) => void,
  ): Promise<ImportRun> {
    const run = await call<ImportRun>(token, "POST", "/runs", {
      source_kind: file.kind,
      file_name: file.name,
      file_sha256: file.sha256,
      file_size_bytes: file.size,
      source_sheet: file.sheet,
      source_metadata: file.metadata,
      parser_warnings: file.warnings,
      expected_row_count: file.rows.length,
    });
    try {
      let uploaded = 0;
      for (const chunk of chunkRows(file.rows)) {
        await call(token, "POST", `/runs/${run.import_run_id}/rows`, { rows: chunk });
        uploaded += chunk.length;
        onProgress(uploaded, file.rows.length);
      }
      return await call<ImportRun>(token, "POST", `/runs/${run.import_run_id}/stage`, {});
    } catch (reason) {
      // Release the half-uploaded draft so it does not linger as working data.
      await call(token, "POST", `/runs/${run.import_run_id}/discard`,
        { reason: "Upload failed before comparison" }).catch(() => undefined);
      throw reason;
    }
  },
};
