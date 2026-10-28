"use client";

import { Fragment, useState } from "react";
import { formatDateTime, formatNumber } from "./lib";
import type { RecordRow } from "./use-synapse-backend";

// สรุปการจ่าย · District confirmation board.
// Central staff check how each of the 18 districts answered every line of the
// plan, clear what is still open, then move the plan to approval / transport.

function text(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

type LineState = "pending" | "confirmed" | "changed" | "rejected" | "cancelled";

const PENDING = new Set(["draft", "pending"]);
const CONFIRMED = new Set([
  "district_confirmed",
  "confirmed",
  "planner_approved",
  "approved",
  "locked",
  "issued",
  "shipped",
]);
const REJECTED = new Set(["district_rejected", "rejected"]);
const CLOSED_PLAN = new Set(["cancelled", "completed"]);

export function lineState(row: RecordRow): LineState {
  const status = text(row.item_status, "");
  if (status === "change_requested") return "changed";
  if (REJECTED.has(status)) return "rejected";
  if (CONFIRMED.has(status)) return "confirmed";
  if (status === "cancelled") return "cancelled";
  return PENDING.has(status) || !status ? "pending" : "pending";
}

const LINE_LABEL: Record<LineState, string> = {
  pending: "รอเขตตอบ",
  confirmed: "ยืนยัน",
  changed: "ขอเปลี่ยนจำนวน",
  rejected: "ไม่รับ",
  cancelled: "ยกเลิก",
};

const PLAN_LABEL: Record<string, string> = {
  draft: "ร่างแผน",
  district_review: "รอเขตยืนยัน",
  pending_district_confirmation: "รอเขตยืนยัน",
  pending_planner_approval: "รอ Planner อนุมัติ",
  pending_academic_approval: "รอวิชาการอนุมัติ",
  locked: "Lock แล้ว · พร้อมจัดรถ",
  completed: "จ่ายครบแล้ว",
  cancelled: "ยกเลิก",
};

type DistrictState = "pending" | "changed" | "complete" | "none";

const DISTRICT_LABEL: Record<DistrictState, string> = {
  pending: "รอเขตตอบ",
  changed: "รอตรวจคำขอเปลี่ยน",
  complete: "ยืนยันครบ",
  none: "ไม่มีรายการรอบนี้",
};

type DistrictRow = {
  id: string;
  name: string;
  lines: RecordRow[];
  pending: number;
  confirmed: number;
  changed: number;
  rejected: number;
  planQty: number;
  answeredQty: number;
  lastAt: string;
  requester: string;
  onBehalf: boolean;
  state: DistrictState;
};

type Filter = "all" | "open" | DistrictState;

const planQty = (row: RecordRow) => Number(row.suggested_qty ?? 0) || 0;
const answeredQty = (row: RecordRow) => {
  const state = lineState(row);
  if (state === "pending") return 0;
  if (state === "rejected") return 0;
  return (
    Number(row.final_qty ?? row.confirmed_qty ?? row.requested_qty ?? row.suggested_qty ?? 0) ||
    0
  );
};
const answeredAt = (row: RecordRow) =>
  text(row.district_confirmed_at ?? row.district_responded_at, "");

type Props = {
  rows: RecordRow[];
  districts: Array<{ id: string; name: string }>;
  role: string;
  canRespond: boolean;
  actionBusy: boolean;
  onRespond: (row: RecordRow) => void;
  onConfirmPending?: (planId: string, requesterName: string) => Promise<boolean>;
  onReviewChanges: () => void;
  onApprove: () => void;
  onOpenTransport?: () => void;
  onOpenCalculate: () => void;
};

export function DistrictConfirmationBoard({
  rows,
  districts,
  role,
  canRespond,
  actionBusy,
  onRespond,
  onConfirmPending,
  onReviewChanges,
  onApprove,
  onOpenTransport,
  onOpenCalculate,
}: Props) {
  // One board per plan; default to the newest plan that is still open.
  const plans = [
    ...new Map(
      rows
        .filter((row) => row.replenishment_plan_id)
        .map((row) => [text(row.replenishment_plan_id), row]),
    ).values(),
  ].sort((left, right) => {
    const key = (row: RecordRow) =>
      `${CLOSED_PLAN.has(text(row.plan_status, "")) ? 0 : 1}|${text(
        row.week_start_date,
        "",
      )}|${String(Number(row.version_no ?? 0)).padStart(4, "0")}|${text(row.created_at, "")}`;
    return key(right).localeCompare(key(left));
  });
  const [planId, setPlanId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openDistrict, setOpenDistrict] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkName, setBulkName] = useState("");
  const [bulkAck, setBulkAck] = useState(false);

  const plan = plans.find((row) => text(row.replenishment_plan_id) === planId) ?? plans[0];

  if (!plan) {
    return (
      <section className="panel">
        <article className="workspace-empty">
          <i>—</i>
          <h3>ยังไม่มีแผนที่ส่งให้เขตยืนยัน</h3>
          <p>
            สร้าง Draft Plan จากหน้า “คำนวณการจ่าย” ก่อน
            แล้วผลการยืนยันของแต่ละเขตจะมาสรุปที่หน้านี้
          </p>
          <button type="button" className="btn primary" onClick={onOpenCalculate}>
            ไปหน้าคำนวณการจ่าย
          </button>
        </article>
      </section>
    );
  }

  const currentPlanId = text(plan.replenishment_plan_id);
  const planStatus = text(plan.plan_status, "");
  const planLines = rows.filter(
    (row) =>
      text(row.replenishment_plan_id) === currentPlanId && lineState(row) !== "cancelled",
  );

  const allDistricts = [
    ...new Map(
      [...districts, ...planLines.map((row) => ({
        id: text(row.district_id),
        name: text(row.district_name_th),
      }))].map((district) => [district.id, district]),
    ).values(),
  ]
    .filter((district) => district.id && district.id !== "—")
    .sort((left, right) => left.id.localeCompare(right.id));

  const districtRows: DistrictRow[] = allDistricts.map((district) => {
    const lines = planLines
      .filter((row) => text(row.district_id) === district.id)
      .sort((left, right) => text(left.material_id).localeCompare(text(right.material_id)));
    const count = (state: LineState) => lines.filter((row) => lineState(row) === state).length;
    const pending = count("pending");
    const changed = count("changed");
    const answered = lines
      .filter((row) => answeredAt(row))
      .sort((left, right) => answeredAt(right).localeCompare(answeredAt(left)));
    return {
      id: district.id,
      name: district.name !== "—" ? district.name : text(lines[0]?.district_name_th),
      lines,
      pending,
      confirmed: count("confirmed"),
      changed,
      rejected: count("rejected"),
      planQty: lines.reduce((sum, row) => sum + planQty(row), 0),
      answeredQty: lines.reduce((sum, row) => sum + answeredQty(row), 0),
      lastAt: answeredAt(answered[0] ?? {}),
      requester: text(answered[0]?.requester_name, ""),
      onBehalf: lines.some((row) => row.confirmed_on_behalf === true),
      state: !lines.length
        ? "none"
        : pending > 0
          ? "pending"
          : changed > 0
            ? "changed"
            : "complete",
    };
  });

  const total = {
    districts: districtRows.length,
    withLines: districtRows.filter((row) => row.state !== "none").length,
    done: districtRows.filter((row) => row.state === "complete").length,
    pendingDistricts: districtRows.filter((row) => row.state === "pending").length,
    changedDistricts: districtRows.filter((row) => row.state === "changed").length,
    lines: planLines.length,
    pending: districtRows.reduce((sum, row) => sum + row.pending, 0),
    confirmed: districtRows.reduce((sum, row) => sum + row.confirmed, 0),
    changed: districtRows.reduce((sum, row) => sum + row.changed, 0),
    rejected: districtRows.reduce((sum, row) => sum + row.rejected, 0),
    planQty: districtRows.reduce((sum, row) => sum + row.planQty, 0),
    answeredQty: districtRows.reduce((sum, row) => sum + row.answeredQty, 0),
  };
  const locked =
    planStatus === "locked" ||
    planStatus === "completed" ||
    (planLines.length > 0 &&
      planLines.every((row) => ["locked", "issued"].includes(text(row.item_status, ""))));
  const approvalStarted = [
    "pending_planner_approval",
    "pending_academic_approval",
  ].includes(planStatus);
  const allAnswered = total.pending === 0;
  const changesCleared = total.changed === 0;
  const readyForApproval = allAnswered && changesCleared && !locked;
  const pct = total.withLines ? (total.done / total.withLines) * 100 : 0;

  const checks: Array<{ ok: boolean; current: boolean; title: string; note: string }> = [
    {
      ok: allAnswered,
      current: !allAnswered,
      title: "เขตตอบครบทุกรายการ",
      note: allAnswered
        ? `${formatNumber(total.withLines)} เขตที่มีรายการตอบครบแล้ว`
        : `รอ ${formatNumber(total.pendingDistricts)} เขต · ${formatNumber(total.pending)} รายการ`,
    },
    {
      ok: allAnswered && changesCleared,
      current: allAnswered && !changesCleared,
      title: "ตรวจคำขอเปลี่ยนจำนวน",
      note: changesCleared
        ? "ไม่มีคำขอเปลี่ยนค้าง"
        : `ค้าง ${formatNumber(total.changed)} รายการ ใน ${formatNumber(total.changedDistricts)} เขต`,
    },
    {
      ok: locked,
      current: readyForApproval,
      title: "Planner → วิชาการ อนุมัติ และ Lock",
      note: locked
        ? "Lock แผนและจอง FIFO แล้ว"
        : approvalStarted
          ? PLAN_LABEL[planStatus]
          : "รอให้เขตตอบครบก่อน",
    },
    {
      ok: false,
      current: locked,
      title: "ส่งต่อจัดรถขนส่ง",
      note: locked ? "พร้อมจัดรถตามเขตปลายทาง" : "ทำได้หลัง Lock แผน",
    },
  ];

  const filtered = districtRows.filter((row) =>
    filter === "all"
      ? true
      : filter === "open"
        ? row.state === "pending" || row.state === "changed"
        : row.state === filter,
  );
  const filterCount = (value: Filter) =>
    value === "all"
      ? districtRows.length
      : value === "open"
        ? total.pendingDistricts + total.changedDistricts
        : districtRows.filter((row) => row.state === value).length;

  const nextAction = locked
    ? onOpenTransport
      ? { label: "ไปจัดรถขนส่ง →", run: onOpenTransport }
      : null
    : !allAnswered
      ? null
      : !changesCleared
        ? { label: `ไปตรวจคำขอเปลี่ยน (${formatNumber(total.changed)}) →`, run: onReviewChanges }
        : { label: "ไปอนุมัติแผน (Planner → วิชาการ) →", run: onApprove };

  const canBulk = role === "admin" && Boolean(onConfirmPending) && total.pending > 0 && !locked;

  return (
    <section className="panel dc-board">
      <header className="dc-head">
        <div>
          <span>DISTRICT CONFIRMATION SUMMARY</span>
          <h3>ผลการยืนยันรายการพัสดุของ {formatNumber(total.districts)} เขต</h3>
          <p>
            ตรวจว่าทุกเขตตอบครบ · คำขอเปลี่ยนจำนวนได้รับการตรวจ ·
            แล้วส่งแผนไปอนุมัติและจัดรถขนส่ง
          </p>
        </div>
        <label className="dc-plan">
          <span>แผน</span>
          {plans.length > 1 ? (
            <select value={currentPlanId} onChange={(event) => setPlanId(event.target.value)}>
              {plans.map((row) => (
                <option key={text(row.replenishment_plan_id)} value={text(row.replenishment_plan_id)}>
                  {text(row.plan_number ?? row.plan_code)} · V{text(row.version_no, "1")} ·{" "}
                  {PLAN_LABEL[text(row.plan_status, "")] ?? text(row.plan_status)}
                </option>
              ))}
            </select>
          ) : (
            <strong>
              {text(plan.plan_number ?? plan.plan_code)} · V{text(plan.version_no, "1")}
            </strong>
          )}
          <small>
            สัปดาห์ {text(plan.week_start_date)} ·{" "}
            <b className={`dc-plan-status ${locked ? "ok" : "wait"}`}>
              {PLAN_LABEL[planStatus] ?? text(plan.plan_status)}
            </b>
            {plan.response_due_at ? ` · เขตตอบภายใน ${formatDateTime(plan.response_due_at)}` : ""}
          </small>
        </label>
      </header>

      <div className="dc-kpis">
        <article className="dc-kpi-main">
          <span>เขตยืนยันครบ</span>
          <strong>
            {formatNumber(total.done)}
            <small> / {formatNumber(total.withLines)} เขตที่มีรายการ</small>
          </strong>
          <div className="dc-bar" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </div>
          <small>
            อีก {formatNumber(total.districts - total.withLines)} เขตไม่มีรายการจ่ายรอบนี้
          </small>
        </article>
        <article>
          <span>รายการทั้งหมด</span>
          <strong>{formatNumber(total.lines)}</strong>
          <small>
            <b className="dp-good">ยืนยัน {formatNumber(total.confirmed)}</b> ·{" "}
            <b className="dp-bad">ไม่รับ {formatNumber(total.rejected)}</b>
          </small>
        </article>
        <article className={total.pending ? "warn" : ""}>
          <span>รอเขตตอบ</span>
          <strong>{formatNumber(total.pending)}</strong>
          <small>{formatNumber(total.pendingDistricts)} เขต</small>
        </article>
        <article className={total.changed ? "warn" : ""}>
          <span>ขอเปลี่ยนจำนวน</span>
          <strong>{formatNumber(total.changed)}</strong>
          <small>รอ Planner ตรวจ</small>
        </article>
        <article>
          <span>จำนวนจ่ายที่เขตยืนยัน</span>
          <strong>{formatNumber(total.answeredQty, 0)}</strong>
          <small>จากแผน {formatNumber(total.planQty, 0)} หน่วย</small>
        </article>
      </div>

      <ol className="dc-checks">
        {checks.map((check, index) => (
          <li
            key={check.title}
            className={check.ok ? "ok" : check.current ? "current" : ""}
          >
            <i>{check.ok ? "✓" : index + 1}</i>
            <div>
              <strong>{check.title}</strong>
              <small>{check.note}</small>
            </div>
          </li>
        ))}
      </ol>

      <div className="dc-toolbar">
        <div className="district-filters dc-filters">
          {(
            [
              ["all", "ทุกเขต"],
              ["open", "ยังค้าง"],
              ["pending", "รอเขตตอบ"],
              ["changed", "รอตรวจคำขอเปลี่ยน"],
              ["complete", "ยืนยันครบ"],
              ["none", "ไม่มีรายการ"],
            ] as Array<[Filter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {label} ({formatNumber(filterCount(value))})
            </button>
          ))}
        </div>
        {canBulk && (
          <button
            type="button"
            className="btn ghost"
            disabled={actionBusy}
            onClick={() => {
              setBulkOpen(true);
              setBulkAck(false);
            }}
          >
            ยืนยันแทนเขตที่ค้าง ({formatNumber(total.pending)})
          </button>
        )}
      </div>

      <div className="live-table-wrap">
        <table className="live-table dc-table">
          <thead>
            <tr>
              <th>การไฟฟ้าเขต</th>
              <th>สถานะเขต</th>
              <th>รายการ</th>
              <th>ยืนยัน</th>
              <th>ขอเปลี่ยน</th>
              <th>ไม่รับ</th>
              <th>รอตอบ</th>
              <th>จำนวนตามแผน</th>
              <th>เขตยืนยัน</th>
              <th>ผู้ยืนยัน · เวลา</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="dp-muted">
                  ไม่มีเขตในกลุ่มนี้
                </td>
              </tr>
            )}
            {filtered.map((row) => {
              const open = openDistrict === row.id;
              const diff = row.answeredQty - row.planQty;
              return (
                <Fragment key={row.id}>
                  <tr className={`dc-row ${row.state} ${open ? "open" : ""}`}>
                    <td>
                      <strong>{row.id}</strong>
                      <small>{row.name}</small>
                    </td>
                    <td>
                      <span className={`dc-state ${row.state}`}>{DISTRICT_LABEL[row.state]}</span>
                    </td>
                    <td>{row.lines.length ? formatNumber(row.lines.length) : "—"}</td>
                    <td className={row.confirmed ? "dp-good" : "dp-muted"}>
                      {row.lines.length ? formatNumber(row.confirmed) : "—"}
                    </td>
                    <td className={row.changed ? "dp-warn" : "dp-muted"}>
                      {row.lines.length ? formatNumber(row.changed) : "—"}
                    </td>
                    <td className={row.rejected ? "dp-bad" : "dp-muted"}>
                      {row.lines.length ? formatNumber(row.rejected) : "—"}
                    </td>
                    <td className={row.pending ? "dp-accent" : "dp-muted"}>
                      {row.lines.length ? formatNumber(row.pending) : "—"}
                    </td>
                    <td>{row.lines.length ? formatNumber(row.planQty, 0) : "—"}</td>
                    <td>
                      {row.lines.length && row.state !== "pending" ? (
                        <>
                          {formatNumber(row.answeredQty, 0)}
                          {diff !== 0 && (
                            <small className={diff < 0 ? "dp-bad" : "dp-warn"}>
                              {diff > 0 ? "+" : ""}
                              {formatNumber(diff, 0)} จากแผน
                            </small>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {row.lastAt ? (
                        <>
                          {row.requester || "—"}
                          <small>
                            {formatDateTime(row.lastAt)}
                            {row.onBehalf ? " · ยืนยันแทนเขต" : ""}
                          </small>
                        </>
                      ) : (
                        <span className="dp-muted">—</span>
                      )}
                    </td>
                    <td>
                      {row.lines.length > 0 && (
                        <button
                          type="button"
                          className="table-action"
                          aria-expanded={open}
                          onClick={() => setOpenDistrict(open ? "" : row.id)}
                        >
                          {open ? "ซ่อนรายการ ▴" : "ดูรายการ ▾"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="dc-detail">
                      <td colSpan={11}>
                        <table className="dc-lines">
                          <thead>
                            <tr>
                              <th>พัสดุ</th>
                              <th>แผน</th>
                              <th>เขตขอ</th>
                              <th>จำนวนสุดท้าย</th>
                              <th>ผลตอบ</th>
                              <th>เหตุผล / หมายเหตุเขต</th>
                              <th>ผู้ขอ</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.lines.map((line) => {
                              const state = lineState(line);
                              const editable =
                                canRespond &&
                                !locked &&
                                ["draft", "pending", "change_requested"].includes(
                                  text(line.item_status, ""),
                                );
                              return (
                                <tr key={text(line.replenishment_item_id)}>
                                  <td>
                                    <strong>{text(line.material_id)}</strong>
                                    <small>{text(line.material_name)}</small>
                                  </td>
                                  <td>{formatNumber(planQty(line), 0)}</td>
                                  <td>
                                    {state === "pending"
                                      ? "—"
                                      : formatNumber(line.requested_qty ?? line.confirmed_qty, 0)}
                                  </td>
                                  <td>{state === "pending" ? "—" : formatNumber(answeredQty(line), 0)}</td>
                                  <td>
                                    <span className={`dc-line ${state}`}>{LINE_LABEL[state]}</span>
                                  </td>
                                  <td className="dc-note">
                                    {text(line.district_note ?? line.response_reason, "—")}
                                  </td>
                                  <td>{text(line.requester_name)}</td>
                                  <td>
                                    {editable && (
                                      <button
                                        type="button"
                                        className="table-action"
                                        onClick={() => onRespond(line)}
                                      >
                                        {state === "changed" ? "แก้คำตอบ" : "บันทึกคำตอบแทนเขต"}
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="dc-footer">
        <div>
          <strong>
            {locked
              ? "แผนนี้ Lock แล้ว — ส่งต่อจัดรถขนส่งได้"
              : !allAnswered
                ? `ยังรอเขตตอบ ${formatNumber(total.pendingDistricts)} เขต (${formatNumber(total.pending)} รายการ)`
                : !changesCleared
                  ? `เขตตอบครบแล้ว · เหลือคำขอเปลี่ยน ${formatNumber(total.changed)} รายการให้ Planner ตรวจ`
                  : "ทุกเขตตอบครบและไม่มีคำขอเปลี่ยนค้าง — ส่งแผนไปอนุมัติได้"}
          </strong>
          <small>
            ข้อมูลจัดรถใช้จำนวนที่เขตยืนยันหลัง Lock แผน · รายการที่เขตไม่รับจะไม่ถูกจัดส่ง
          </small>
        </div>
        <div>
          <button type="button" className="btn ghost" onClick={onOpenCalculate}>
            ← กลับไปหน้าคำนวณการจ่าย
          </button>
          {nextAction ? (
            <button type="button" className="btn primary" onClick={nextAction.run}>
              {nextAction.label}
            </button>
          ) : (
            <button type="button" className="btn primary" disabled>
              รอเขตตอบให้ครบก่อน
            </button>
          )}
        </div>
      </footer>

      {bulkOpen && onConfirmPending && (
        <div className="import-review-backdrop" role="dialog" aria-modal="true">
          <div className="import-review-modal dc-bulk">
            <header>
              <div>
                <span>ยืนยันแทนเขต</span>
                <h3>ยืนยันรายการค้าง {formatNumber(total.pending)} รายการตามจำนวนในแผน</h3>
                <p>
                  ใช้เมื่อเขตแจ้งยืนยันผ่านช่องทางอื่นแล้ว ระบบจะบันทึกว่าเป็นการยืนยันแทนเขต
                </p>
              </div>
              <button type="button" aria-label="ปิด" onClick={() => setBulkOpen(false)}>
                ×
              </button>
            </header>
            <div className="dr-body">
              <ul className="dc-bulk-list">
                {districtRows
                  .filter((row) => row.pending > 0)
                  .map((row) => (
                    <li key={row.id}>
                      <strong>
                        {row.id} : {row.name}
                      </strong>
                      <span>{formatNumber(row.pending)} รายการ</span>
                    </li>
                  ))}
              </ul>
              <label className="dc-bulk-name">
                <span>ชื่อผู้ยืนยันแทนเขต</span>
                <input
                  value={bulkName}
                  maxLength={200}
                  onChange={(event) => setBulkName(event.target.value)}
                  placeholder="ชื่อ-นามสกุล"
                />
              </label>
              <label className="dr-ack">
                <input
                  type="checkbox"
                  checked={bulkAck}
                  onChange={(event) => setBulkAck(event.target.checked)}
                />
                <span>ได้รับการยืนยันจากเขตเหล่านี้แล้ว และยืนยันตามจำนวนในแผน</span>
              </label>
            </div>
            <footer className="dr-footer">
              <span className="dp-muted">รายการที่ยืนยันแล้วจะไม่ถูกแก้ไข</span>
              <div>
                <button type="button" className="btn ghost" onClick={() => setBulkOpen(false)}>
                  ยกเลิก
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={actionBusy || !bulkAck || bulkName.trim().length < 2}
                  onClick={async () => {
                    const ok = await onConfirmPending(currentPlanId, bulkName.trim());
                    if (ok) setBulkOpen(false);
                  }}
                >
                  ยืนยันแทน {formatNumber(total.pending)} รายการ
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
