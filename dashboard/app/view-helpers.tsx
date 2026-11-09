"use client";

import { isValidElement, type ReactNode } from "react";
import { formatDateTime } from "./lib";
import { type DashboardData, type RecordRow } from "./use-synapse-backend";

export function text(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

export function bool(value: unknown) {
  return value === true || value === "true";
}

export function record(value: unknown): RecordRow {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordRow)
    : {};
}

export function rows(value: unknown): RecordRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is RecordRow =>
          row !== null && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

export function latestSnapshot(data: DashboardData) {
  const timestamps = [...data.warehouseStock, ...data.stock]
    .map((row) => new Date(String(row.snapshot_at ?? "")).getTime())
    .filter(Number.isFinite);
  return timestamps.length
    ? formatDateTime(new Date(Math.max(...timestamps)).toISOString())
    : "รอข้อมูลจริง";
}

export function statusClass(value: unknown) {
  const status = text(value, "").toLowerCase();
  if (
    status.includes("locked") ||
    status.includes("approved") ||
    status.includes("completed") ||
    status.includes("issued") ||
    status.includes("confirmed") ||
    status.includes("fresh")
  ) {
    return "normal";
  }
  if (
    status.includes("high") ||
    status.includes("critical") ||
    status.includes("reject") ||
    status.includes("cancel") ||
    status.includes("quarantine")
  ) {
    return "critical";
  }
  return "urgent";
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className={`badge ${statusClass(children)}`}>
      <i />
      {children}
    </span>
  );
}

export function LiveTable({
  columns,
  empty,
  rows,
}: {
  columns: Array<[string, (row: RecordRow) => ReactNode | unknown]>;
  empty: string;
  rows: RecordRow[];
}) {
  if (!rows.length) {
    return (
      <article className="workspace-empty">
        <i>—</i>
        <h3>{empty}</h3>
        <p>ระบบไม่สร้างข้อมูลจำลองขึ้นมาแทนข้อมูลจริง</p>
      </article>
    );
  }
  return (
    <div className="live-table-wrap">
      <table className="live-table">
        <thead>
          <tr>
            {columns.map(([label]) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${text(
                row.replenishment_item_id ??
                  row.handling_unit_id ??
                  row.ad_hoc_issue_id ??
                  row.inventory_movement_id ??
                  row.material_id ??
                  "row",
              )}-${index}`}
            >
              {columns.map(([label, render]) => {
                const value = render(row);
                return (
                  <td key={label}>
                    {isValidElement(value) ? value : text(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function exportCsv(
  filename: string,
  headers: string[],
  rowsToExport: Array<Array<unknown>>,
) {
  const encodeCell = (value: unknown) => {
    const raw = text(value);
    const spreadsheetSafe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
  };
  const csv = [headers, ...rowsToExport]
    .map((row) => row.map(encodeCell).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
