"use client";

import { formatDateTime } from "./lib";
import type { DraftSyncStatus } from "./planner-draft-sync";

/** Where the planner's work is saved, shown on คำนวณการจ่าย. */
export function DraftSyncBadge({ status }: { status: DraftSyncStatus }) {
  if (status.state === "off") return null;
  const label =
    status.state === "loading"
      ? "กำลังโหลดงานที่บันทึกไว้…"
      : status.state === "saving"
        ? "กำลังบันทึก…"
        : status.state === "saved"
          ? `บันทึกในระบบกลางแล้ว${status.at ? ` · ${formatDateTime(status.at)}` : ""} · ทุกคนในทีมเห็นงานเดียวกัน`
          : status.state === "local"
            ? status.message ?? "บันทึกไว้ในเครื่องนี้"
            : status.message ?? "บันทึกไม่สำเร็จ";
  const others = Object.entries(status.by ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([district, who]) => `${district} ${who.name}`);
  return (
    <div className={`draft-sync ${status.state}`} role="status" aria-live="polite">
      <i aria-hidden="true" />
      <span>{label}</span>
      {status.state === "saved" && status.message && <b>{status.message}</b>}
      {others.length > 0 && <small title={others.join("\n")}>มีงานบันทึก {others.length} เขต</small>}
    </div>
  );
}
