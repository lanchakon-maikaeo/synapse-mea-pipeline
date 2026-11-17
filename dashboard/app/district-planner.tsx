"use client";

import { useEffect, useRef, useState } from "react";
import { formatNumber } from "./lib";
import { RULE_LABELS, recommendedQty } from "./usage-bars";
import type { RecordRow } from "./use-synapse-backend";

// District-by-district planning: work one district at a time (system
// proposals, extra materials), review its summary, confirm, move on.

function text(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

export const SKIP_REASONS = [
  "เขตแจ้งว่ายังมีพอ",
  "รอสัญญาใหม่",
  "Stock คลังไม่พอ",
  "รวมไปรอบหน้า",
  "ไม่ใช่งาน/ใช้งานน้อย",
];

export const ADD_REASONS = [
  "งานโครงการของเขต",
  "สำรองกรณีฉุกเฉิน",
  "เขตร้องขอ",
  "ทดแทนพัสดุที่ขาด",
  "ผ่านทดสอบ",
];

export const OTHER_REASON = "__other";

/** A reason dropdown with "อื่น ๆ (ระบุเอง)" that opens a text box. */
/** What a line the system proposed but nobody picked is saved with. */
export const DEFAULT_SKIP_REASON = "ไม่ระบุเหตุผล";

function ReasonPicker({
  value,
  options,
  disabled,
  missing,
  emptyLabel = "— เลือกเหตุผล —",
  onChange,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  missing?: boolean;
  emptyLabel?: string;
  onChange: (reason: string) => void;
}) {
  const custom = Boolean(value) && !options.includes(value);
  const [otherOpen, setOtherOpen] = useState(custom);
  const [draft, setDraft] = useState(custom ? value : "");
  const showOther = otherOpen || custom;
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onChange(next);
  };
  return (
    <span className="reason-picker">
      <select
        value={showOther ? OTHER_REASON : value}
        disabled={disabled}
        className={missing && !value ? "missing" : ""}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const next = event.target.value;
          if (next === OTHER_REASON) {
            setOtherOpen(true);
            return;
          }
          setOtherOpen(false);
          setDraft("");
          onChange(next);
        }}
      >
        <option value="">{emptyLabel}</option>
        {options.map((reason) => (
          <option key={reason} value={reason}>{reason}</option>
        ))}
        <option value={OTHER_REASON}>อื่น ๆ (ระบุเอง)</option>
      </select>
      {showOther && (
        <input
          className="reason-other"
          type="text"
          autoFocus={!custom}
          disabled={disabled}
          maxLength={200}
          value={draft}
          placeholder="พิมพ์เหตุผล แล้วกด Enter"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
      )}
    </span>
  );
}

export type DistrictOption = { id: string; name: string };

export type DistrictStats = {
  needs: number;
  selected: number;
  added: number;
  undecided: number;
  confirmed: boolean;
  touched: boolean;
};

export type DistrictTab = "fill" | "add";

type Props = {
  canCreate: boolean;
  districts: DistrictOption[];
  activeDistrict: string;
  statsFor: (districtId: string) => DistrictStats;
  onSelectDistrict: (districtId: string) => void;
  tab: DistrictTab;
  onTab: (tab: DistrictTab) => void;
  /** Rows for the active district, one per material, latest plan version. */
  districtRows: RecordRow[];
  /** Materials the planner added to the active district. */
  addedRows: RecordRow[];
  itemId: (row: RecordRow) => string;
  needsFill: (row: RecordRow) => boolean;
  isSelected: (id: string) => boolean;
  onToggle: (row: RecordRow, checked: boolean) => void;
  quantityValue: (row: RecordRow) => string;
  onQuantity: (row: RecordRow, quantity: number) => void;
  plannerQuantity: (row: RecordRow) => number;
  warehouseQuantity: (row: RecordRow) => number;
  fifoShortage: (row: RecordRow) => number;
  focusedId: string;
  onFocus: (id: string) => void;
  skipReasons: Record<string, string>;
  onSkip: (row: RecordRow, reason: string | null) => void;
  addReasons: Record<string, string>;
  onAddReason: (row: RecordRow, reason: string) => void;
  materialCatalog: Array<{ id: string; name: string }>;
  /** whole Material Master, contract number or PO, searched on the server */
  searchRemote?: (term: string) => Promise<Array<{ id: string; name: string }>>;
  buildMaterialRow: (materialId: string) => RecordRow | null;
  onAddMaterial: (row: RecordRow, quantity: number) => void;
  onRemoveAdded: (row: RecordRow) => void;
  onConfirmDistrict: () => void;
  onUnconfirmDistrict: () => void;
};

export function DistrictProgress({
  districts,
  activeDistrict,
  statsFor,
  onSelectDistrict,
  onSwitchToMaterial,
}: Pick<Props, "districts" | "activeDistrict" | "statsFor" | "onSelectDistrict"> & {
  onSwitchToMaterial?: () => void;
}) {
  const confirmedCount = districts.filter((d) => statsFor(d.id).confirmed).length;
  const inProgress = districts.filter((d) => {
    const stats = statsFor(d.id);
    return !stats.confirmed && (stats.touched || d.id === activeDistrict);
  }).length;
  const pct = districts.length ? (confirmedCount / districts.length) * 100 : 0;
  return (
    <section className="panel district-progress" aria-label="ความคืบหน้ารายเขต">
      <div className="district-progress-head">
        <div>
          <span>ความคืบหน้ารายเขต</span>
          <strong>
            ยืนยันแล้ว {formatNumber(confirmedCount)} จาก {formatNumber(districts.length)} เขต
          </strong>
          <small>
            กำลังทำ {formatNumber(inProgress)} · ยังไม่เริ่ม{" "}
            {formatNumber(Math.max(0, districts.length - confirmedCount - inProgress))}
          </small>
        </div>
        <div className="district-progress-side">
          <div className="district-progress-bar" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </div>
          {onSwitchToMaterial && (
            <button type="button" className="btn ghost" onClick={onSwitchToMaterial}>
              ค้นหารายพัสดุ (ดูครบ 18 เขต)
            </button>
          )}
        </div>
      </div>
      <div className="district-chip-grid">
        {districts.map((district) => {
          const stats = statsFor(district.id);
          const state = stats.confirmed
            ? "confirmed"
            : district.id === activeDistrict
              ? "active"
              : stats.touched
                ? "touched"
                : "idle";
          return (
            <button
              type="button"
              key={district.id}
              className={`district-chip ${state}`}
              aria-pressed={district.id === activeDistrict}
              onClick={() => onSelectDistrict(district.id)}
            >
              <b>{district.id}</b>
              <strong>{district.name}</strong>
              <small>
                {stats.confirmed
                  ? "✓ ยืนยันแล้ว"
                  : stats.needs || stats.added
                    ? `เลือก ${formatNumber(stats.selected)}/${formatNumber(stats.needs)}${
                        stats.added ? ` +${formatNumber(stats.added)}` : ""
                      }`
                    : "ไม่มีรายการต้องเติม"}
              </small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function DistrictPlanner(props: Props) {
  const {
    canCreate,
    districts,
    activeDistrict,
    statsFor,
    tab,
    onTab,
    districtRows,
    addedRows,
    itemId,
    needsFill,
    isSelected,
    onToggle,
    quantityValue,
    onQuantity,
    plannerQuantity,
    warehouseQuantity,
    fifoShortage,
    focusedId,
    onFocus,
    skipReasons,
    onSkip,
    addReasons,
    onAddReason,
    materialCatalog,
    searchRemote,
    buildMaterialRow,
    onAddMaterial,
    onRemoveAdded,
    onConfirmDistrict,
    onUnconfirmDistrict,
  } = props;
  const [filter, setFilter] = useState<"needs" | "undecided" | "all">("needs");
  const [search, setSearch] = useState("");
  const [addQty, setAddQty] = useState<Record<string, string>>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [fifoAck, setFifoAck] = useState(false);

  const district = districts.find((d) => d.id === activeDistrict);
  const stats = statsFor(activeDistrict);
  const undecided = (row: RecordRow) =>
    needsFill(row) && !isSelected(itemId(row)) && !skipReasons[itemId(row)];
  const visibleRows = districtRows.filter((row) =>
    filter === "all" ? true : filter === "undecided" ? undecided(row) : needsFill(row),
  );
  const addedIds = new Set(addedRows.map(itemId));
  const term = search.trim().toLowerCase();
  const [remote, setRemote] = useState<{ term: string; rows: Array<{ id: string; name: string }> }>({ term: "", rows: [] });
  const [remoteBusy, setRemoteBusy] = useState(false);
  // the parent passes a new function every render: search only when the term changes
  const searchRemoteRef = useRef(searchRemote);
  useEffect(() => {
    searchRemoteRef.current = searchRemote;
  });
  const canSearchRemote = Boolean(searchRemote);
  useEffect(() => {
    const searchFn = searchRemoteRef.current;
    if (!searchFn || term.length < 3) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setRemoteBusy(true);
      try {
        const rows = await searchFn(term);
        if (!cancelled) setRemote({ term, rows });
      } finally {
        if (!cancelled) setRemoteBusy(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canSearchRemote, term]);
  const remoteRows = remote.term === term ? remote.rows : [];
  const searchResults = term.length >= 2
    ? [...new Map([...materialCatalog, ...remoteRows].map((m) => [m.id, m])).values()]
        .filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(term))
        .slice(0, 20)
        .map((m) => districtRows.find((r) => text(r.material_id) === m.id) ?? buildMaterialRow(m.id))
        .filter((row): row is RecordRow => Boolean(row))
    : [];

  const selectedSystemRows = districtRows.filter((row) => isSelected(itemId(row)) && plannerQuantity(row) > 0);
  const selectedAddedRows = addedRows.filter((row) => isSelected(itemId(row)) && plannerQuantity(row) > 0);
  const planRows = [...selectedSystemRows, ...selectedAddedRows];
  const undecidedRows = districtRows.filter(undecided);
  const addedMissingReason = addedRows.filter((row) => !addReasons[itemId(row)]);
  const addedZeroQty = addedRows.filter((row) => plannerQuantity(row) <= 0);
  const overMax = planRows.filter((row) => {
    const max = Number(row.max_fill_qty ?? 0);
    return max > 0 && plannerQuantity(row) > max;
  });
  const shortages = planRows.filter((row) => fifoShortage(row) > 0);
  // lines left undecided are saved as "ไม่ระบุเหตุผล" when the district is confirmed
  const blockers =
    addedMissingReason.length +
    addedZeroQty.length +
    (shortages.length && !fifoAck ? 1 : 0);
  const canConfirm = canCreate && blockers === 0;

  const reasonWhyNotProposed = (row: RecordRow) => {
    const cmp = Number(row.cmp_monthly ?? 0);
    const months = Number(row.months_available ?? 0);
    if (cmp <= 0) return "เขตนี้ไม่มีประวัติการใช้ (CMP = 0)";
    if (months > 3.5) return `ยังพอใช้ ${formatNumber(months, 1)} เดือน (เกินเกณฑ์ 3.5)`;
    if (Number(row.max_fill_qty ?? 0) <= 0) return "Stock เขตถึง MAX แล้ว";
    return "ระบบเสนอให้เติม";
  };

  const fifoCell = (row: RecordRow) => {
    if (!isSelected(itemId(row)) || plannerQuantity(row) <= 0) return <span className="dp-muted">—</span>;
    const short = fifoShortage(row);
    return short > 0 ? (
      <span className="dp-bad">ขาด {formatNumber(short, 0)}</span>
    ) : (
      <span className="dp-good">✓ พร้อมจ่าย</span>
    );
  };

  // Move between the quantity boxes of the fill list with Enter / ↑ / ↓.
  const focusQty = (id: string, step: number) => {
    const boxes = [...document.querySelectorAll<HTMLInputElement>("input[data-fill-qty]")];
    const index = boxes.findIndex((box) => box.dataset.fillQty === id);
    const next = boxes[index + step];
    if (next) {
      next.focus();
      next.select();
    }
  };
  const focusOwnQty = (id: string) =>
    window.setTimeout(() => {
      const box = document.querySelector<HTMLInputElement>(`input[data-fill-qty="${CSS.escape(id)}"]`);
      box?.focus();
      box?.select();
    }, 0);

  const quantityInput = (row: RecordRow, fillList = false) => (
    <input
      className="planner-qty"
      type="number"
      min="0"
      step="1"
      disabled={!canCreate}
      value={quantityValue(row)}
      data-fill-qty={fillList ? itemId(row) : undefined}
      onFocus={(event) => {
        onFocus(itemId(row));
        event.currentTarget.select();
      }}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        const next = Math.max(0, Math.round(Number(event.target.value) || 0));
        onQuantity(row, next);
        // typing a quantity puts the line in the plan
        if (fillList && next > 0 && !isSelected(itemId(row))) onToggle(row, true);
      }}
      onKeyDown={(event) => {
        if (!fillList) return;
        if (event.key === "Enter" || event.key === "ArrowDown") {
          event.preventDefault();
          focusQty(itemId(row), 1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          focusQty(itemId(row), -1);
        }
      }}
      aria-label={`จำนวนจ่าย ${text(row.material_id)} เขต ${activeDistrict}`}
    />
  );

  return (
    <>
      <div className="district-head">
        <div>
          <span>เขตที่กำลังทำ</span>
          <h3>
            {activeDistrict} : {district?.name ?? "—"}
            {stats.confirmed && <em className="dp-confirmed">✓ ยืนยันแล้ว</em>}
          </h3>
        </div>
        <div className="district-counters">
          <span><b>{formatNumber(stats.needs)}</b> ต้องเติมตามระบบ</span>
          <span><b className="dp-brand">{formatNumber(stats.selected)}</b> เลือกแล้ว</span>
          <span className={stats.undecided ? "attn" : ""}><b className={stats.undecided ? "dp-warn" : ""}>{formatNumber(stats.undecided)}</b> ยังไม่ตัดสินใจ</span>
          <span><b>{formatNumber(stats.added)}</b> เพิ่มรายพัสดุ</span>
        </div>
      </div>

      <nav className="district-tabs" aria-label="ขั้นตอนของเขต">
        <button type="button" className={tab === "fill" ? "active" : ""} onClick={() => onTab("fill")}>
          <i>1</i>รายการที่ต้องเติม ({formatNumber(stats.needs)})
        </button>
        <button type="button" className={tab === "add" ? "active" : ""} onClick={() => onTab("add")}>
          <i>2</i>เพิ่มรายพัสดุ ({formatNumber(stats.added)})
        </button>
        <button type="button" onClick={() => setReviewOpen(true)}>
          <i>3</i>ตรวจสรุปและยืนยันเขต
        </button>
      </nav>

      {tab === "fill" ? (
        <>
          <div className="district-filters" role="group" aria-label="กรองรายการ">
            {(
              [
                ["needs", `ต้องเติม (${formatNumber(stats.needs)})`],
                ["undecided", `ยังไม่ตัดสินใจ (${formatNumber(stats.undecided)})`],
                ["all", `ทั้งหมด (${formatNumber(districtRows.length)})`],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                className={filter === key ? "active" : ""}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
            <span>1 แถวต่อพัสดุ (ใช้ข้อมูลแผนเวอร์ชันล่าสุด) · คลิกแถวเพื่อดูหลักฐาน FIFO</span>
          </div>
          {visibleRows.length ? (
            <div className="live-table-wrap">
              <table className="live-table planner-item-table district-table">
                <thead>
                  <tr>
                    <th>เลือก · จำนวนจ่าย · ✦ แนะนำ</th>
                    <th>พัสดุ</th>
                    <th>สถานะ</th>
                    <th>Stock คลัง</th>
                    <th>Stock เขต</th>
                    <th>CMP</th>
                    <th>MIN–MAX</th>
                    <th>เหลือ</th>
                    <th>FIFO</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const id = itemId(row);
                    const selected = isSelected(id);
                    const quantity = plannerQuantity(row);
                    const skip = skipReasons[id];
                    return (
                      <tr
                        key={id}
                        className={`${focusedId === id ? "selected" : ""} ${selected ? "in-plan" : ""}`}
                        onClick={() => onFocus(id)}
                      >
                        <td className="plan-select-cell">
                          <div className="pick-qty">
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!canCreate}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                if (checked && quantity <= 0) {
                                  // no quantity yet: take the recommendation, or ask for one
                                  const suggested = Math.round(recommendedQty(row));
                                  if (suggested > 0) {
                                    onQuantity(row, suggested);
                                    onToggle(row, true);
                                  }
                                  focusOwnQty(id);
                                  return;
                                }
                                onToggle(row, checked);
                                if (checked) focusOwnQty(id);
                              }}
                              aria-label={`เลือกพัสดุ ${text(row.material_id)} เข้าแผน`}
                            />
                            {quantityInput(row, true)}
                          </div>
                          <div className="pick-ai" title={text(row.ai_reason, "")}>
                            <button
                              type="button"
                              className="ai-suggestion"
                              disabled={!canCreate || Math.round(recommendedQty(row)) <= 0}
                              onClick={(event) => {
                                event.stopPropagation();
                                const suggested = Math.round(recommendedQty(row));
                                onQuantity(row, suggested);
                                if (suggested > 0 && !selected) onToggle(row, true);
                                focusOwnQty(id);
                              }}
                            >
                              ✦ แนะนำ {formatNumber(recommendedQty(row), 0)}
                            </button>
                            {row.ai_rule != null && (
                              <small className="ai-rule">
                                {RULE_LABELS[text(row.ai_rule)] ?? text(row.ai_rule)}
                                {recommendedQty(row) !== Number(row.suggested_qty ?? 0) &&
                                  ` · MAX ${formatNumber(row.suggested_qty, 0)}`}
                                {Number(row.ai_kt_short ?? 0) > 0 && (
                                  <b className="shortage-text"> · คลองเตยขาด {formatNumber(row.ai_kt_short, 0)}</b>
                                )}
                              </small>
                            )}
                          </div>
                        </td>
                        <td>
                          <strong>{text(row.material_id)}</strong>
                          <small>{text(row.material_name)}</small>
                        </td>
                        <td>
                          <span className={`stock-state ${needsFill(row) ? "needs-fill" : "no-fill"}`}>
                            {needsFill(row) ? "ต้องเติม" : "ไม่ต้องเติม"}
                          </span>
                          {skip && <small className="dp-muted">ไม่เติม: {skip}</small>}
                        </td>
                        <td>{formatNumber(warehouseQuantity(row), 0)}</td>
                        <td>{formatNumber(row.current_stock_qty, 0)}</td>
                        <td>{formatNumber(row.cmp_monthly, 0)}</td>
                        <td>
                          {formatNumber(row.min_fill_qty, 0)}–{formatNumber(row.max_fill_qty, 0)}
                        </td>
                        <td>{formatNumber(row.months_available, 1)}M</td>
                        <td>{fifoCell(row)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <article className="workspace-empty">
              <i>—</i>
              <h3>
                {filter === "undecided"
                  ? "ตัดสินใจครบทุกรายการแล้ว"
                  : "เขตนี้ยังไม่มีพัสดุที่เข้าเกณฑ์เติม"}
              </h3>
              <p>เพิ่มพัสดุอื่นให้เขตนี้ได้ที่แท็บ “เพิ่มรายพัสดุ”</p>
            </article>
          )}
        </>
      ) : (
        <div className="district-add">
          <label className="district-search">
            <span>ค้นหาพัสดุที่จะเพิ่มให้เขต {activeDistrict}</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="พิมพ์รหัส / ชื่อพัสดุ / เลขสัญญา / PO อย่างน้อย 2 ตัวอักษร"
            />
            <small>แสดง Stock และ CMP ของเขตนี้ พร้อมเหตุผลที่ระบบไม่ได้เสนอ</small>
          </label>
          {searchResults.length > 0 && (
            <div className="live-table-wrap">
              <table className="live-table district-table">
                <thead>
                  <tr>
                    <th>พัสดุ</th>
                    <th>Stock คลัง</th>
                    <th>Stock เขต</th>
                    <th>CMP</th>
                    <th>ทำไมระบบไม่เสนอ</th>
                    <th>Qty</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((row) => {
                    const id = itemId(row);
                    const proposed = districtRows.some(
                      (r) => text(r.material_id) === text(row.material_id) && needsFill(r),
                    );
                    const alreadyAdded = addedIds.has(id);
                    return (
                      <tr key={id} onClick={() => onFocus(id)}>
                        <td>
                          <strong>{text(row.material_id)}</strong>
                          <small>{text(row.material_name)}</small>
                        </td>
                        <td>{formatNumber(warehouseQuantity(row), 0)}</td>
                        <td>{formatNumber(row.current_stock_qty, 0)}</td>
                        <td>{formatNumber(row.cmp_monthly, 0)}</td>
                        <td>
                          {proposed ? (
                            <span className="dp-good">อยู่ในรายการที่ต้องเติมแล้ว</span>
                          ) : alreadyAdded ? (
                            <span className="dp-good">เพิ่มแล้ว</span>
                          ) : (
                            reasonWhyNotProposed(row)
                          )}
                        </td>
                        <td>
                          {!proposed && !alreadyAdded && (
                            <input
                              className="planner-qty"
                              type="number"
                              min="0"
                              step="1"
                              disabled={!canCreate}
                              value={addQty[id] ?? ""}
                              placeholder="0"
                              onChange={(event) =>
                                setAddQty((current) => ({ ...current, [id]: event.target.value }))
                              }
                              aria-label={`จำนวนที่จะเพิ่ม ${text(row.material_id)}`}
                            />
                          )}
                        </td>
                        <td>
                          {proposed ? (
                            <button type="button" className="btn ghost" onClick={() => onTab("fill")}>
                              ไปที่รายการ
                            </button>
                          ) : !alreadyAdded ? (
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={!canCreate || !(Number(addQty[id]) > 0)}
                              onClick={() => {
                                onAddMaterial(row, Math.round(Number(addQty[id])));
                                setAddQty((current) => ({ ...current, [id]: "" }));
                              }}
                            >
                              + เพิ่มเข้าเขต
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {remoteBusy && <p className="dp-muted">กำลังค้นใน Material Master และรวมสัญญา…</p>}
          {term.length >= 2 && !remoteBusy && searchResults.length === 0 && (
            <p className="dp-muted">ไม่พบพัสดุที่ตรงกับ “{search}”</p>
          )}

          <div className="district-added-head">
            <h4>เพิ่มรายพัสดุแล้ว ({formatNumber(addedRows.length)})</h4>
            <span>ทุกรายการที่เพิ่มต้องมีเหตุผล เพื่อให้ผู้อนุมัติเห็นว่าทำไมนอกเหนือจากระบบเสนอ</span>
          </div>
          {addedRows.length ? (
            <div className="live-table-wrap">
              <table className="live-table district-table">
                <tbody>
                  {addedRows.map((row) => {
                    const id = itemId(row);
                    return (
                      <tr key={id} className={focusedId === id ? "selected" : ""} onClick={() => onFocus(id)}>
                        <td>
                          <strong>{text(row.material_id)}</strong>
                          <small>{text(row.material_name)}</small>
                        </td>
                        <td>{quantityInput(row)}</td>
                        <td>
                          <label className="dp-reason">
                            <span>เหตุผลที่เพิ่ม</span>
                            <ReasonPicker
                              value={addReasons[id] ?? ""}
                              options={ADD_REASONS}
                              disabled={!canCreate}
                              missing
                              onChange={(reason) => onAddReason(row, reason)}
                            />
                          </label>
                        </td>
                        <td>{fifoCell(row)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn ghost dp-remove"
                            disabled={!canCreate}
                            onClick={() => onRemoveAdded(row)}
                          >
                            นำออก
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="dp-muted">ยังไม่ได้เพิ่มพัสดุให้เขตนี้</p>
          )}
        </div>
      )}

      <div className="district-footer">
        <div>
          <strong>
            เลือกแล้ว {formatNumber(stats.selected)} จาก {formatNumber(stats.needs)} รายการที่ต้องเติม
            {stats.added ? ` + เพิ่มรายพัสดุ ${formatNumber(stats.added)}` : ""}
          </strong>
          <small className={stats.undecided ? "dp-warn" : ""}>
            {stats.confirmed
              ? "เขตนี้ยืนยันแล้ว · ถ้าแก้รายการ ระบบจะยกเลิกการยืนยันให้อัตโนมัติ"
              : stats.undecided
                ? `ยังไม่ได้เลือก ${formatNumber(stats.undecided)} รายการ — ถ้าไม่เลือก ระบบบันทึกว่า “${DEFAULT_SKIP_REASON}” ตอนยืนยันเขต`
                : "ตัดสินใจครบทุกรายการแล้ว"}
          </small>
        </div>
        <div>
          {tab === "fill" ? (
            <button type="button" className="btn ghost" onClick={() => onTab("add")}>
              + เพิ่มรายพัสดุ
            </button>
          ) : (
            <button type="button" className="btn ghost" onClick={() => onTab("fill")}>
              ← รายการที่ต้องเติม
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setFifoAck(false);
              setReviewOpen(true);
            }}
          >
            ตรวจสรุปเขต {activeDistrict} →
          </button>
        </div>
      </div>

      {reviewOpen && (
        <div
          className="import-review-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setReviewOpen(false);
          }}
        >
          <section
            className="import-review-modal district-review"
            role="dialog"
            aria-modal="true"
            aria-labelledby="district-review-title"
          >
            <header>
              <div>
                <span>ตรวจสรุปก่อนยืนยันเขต</span>
                <h3 id="district-review-title">
                  เขต {activeDistrict} : {district?.name ?? "—"}
                </h3>
                <p>ยืนยันแล้วยังแก้ไขได้ จนกว่าจะสร้าง Draft Plan ในหน้าสรุปการจ่าย</p>
              </div>
              <button type="button" onClick={() => setReviewOpen(false)} aria-label="ปิดหน้าตรวจสรุป">
                ×
              </button>
            </header>

            <div className="dr-body">
              <div className="dr-stats">
                <div><span>ต้องเติมตามระบบ</span><strong>{formatNumber(stats.needs)}</strong></div>
                <div><span>เลือกเข้าแผน</span><strong className="dp-brand">{formatNumber(selectedSystemRows.length)}</strong></div>
                <div><span>เพิ่มรายพัสดุ</span><strong>{formatNumber(selectedAddedRows.length)}</strong></div>
                <div><span>รวมในแผนเขตนี้</span><strong>{formatNumber(planRows.length)}</strong><small>รายการ · ไม่รวมจำนวนข้ามหน่วย</small></div>
              </div>

              <ul className="dr-checks">
                <li className="ok">✓ ทุกรายการในแผนมี Planner Qty มากกว่า 0 ({formatNumber(planRows.length)} รายการ)</li>
                <li className="ok">
                  {undecidedRows.length
                    ? `• ระบบให้เติมแต่ไม่ได้เลือก ${formatNumber(undecidedRows.length)} รายการ — จะบันทึกว่า “${DEFAULT_SKIP_REASON}” เปลี่ยนเหตุผลได้ถ้าต้องการ`
                    : "✓ ตัดสินใจครบทุกรายการที่ระบบให้เติม"}
                </li>
                <li className={addedMissingReason.length || addedZeroQty.length ? "warn" : "ok"}>
                  {addedMissingReason.length || addedZeroQty.length
                    ? `! รายการที่เพิ่มเองยังไม่มีเหตุผล ${formatNumber(addedMissingReason.length)} · ยังไม่มีจำนวน ${formatNumber(addedZeroQty.length)}`
                    : "✓ รายการที่เพิ่มเองมีเหตุผลและจำนวนครบ"}
                </li>
                <li className={overMax.length ? "warn" : "ok"}>
                  {overMax.length
                    ? `! เกิน MAX (6 เดือน) ${formatNumber(overMax.length)} รายการ — ตรวจจำนวนอีกครั้ง`
                    : "✓ ไม่มีรายการเกิน MAX (6 เดือน)"}
                </li>
                <li className={shortages.length ? "bad" : "ok"}>
                  {shortages.length
                    ? `! หลักฐาน FIFO ขาด ${formatNumber(shortages.length)} รายการ: ${shortages
                        .map((row) => `${text(row.material_id)} ขาด ${formatNumber(fifoShortage(row), 0)}`)
                        .join(", ")}`
                    : "✓ หลักฐาน FIFO ครบทุกรายการ"}
                </li>
              </ul>

              {undecidedRows.length > 0 && (
                <div className="dr-section warn">
                  <h4>ระบบให้เติม แต่ยังไม่ได้เลือก ({formatNumber(undecidedRows.length)})</h4>
                  {undecidedRows.map((row) => (
                    <div className="dr-row" key={itemId(row)}>
                      <span>
                        <b>{text(row.material_id)}</b> {text(row.material_name)}
                      </span>
                      <span className="dp-muted">ระบบเสนอ {formatNumber(recommendedQty(row), 0)}</span>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={!canCreate || plannerQuantity(row) <= 0}
                        onClick={() => onToggle(row, true)}
                      >
                        เลือกเข้าแผน ({formatNumber(plannerQuantity(row), 0)})
                      </button>
                      <label className="dp-reason inline">
                        <span>ไม่เติมรอบนี้ เพราะ</span>
                        <ReasonPicker
                          value=""
                          options={SKIP_REASONS}
                          disabled={!canCreate}
                          emptyLabel={`${DEFAULT_SKIP_REASON} (ค่าเริ่มต้น)`}
                          onChange={(reason) => reason && onSkip(row, reason)}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}

              <div className="dr-section">
                <h4>รายการในแผนเขต {activeDistrict} ({formatNumber(planRows.length)})</h4>
                {planRows.length ? (
                  <div className="live-table-wrap">
                    <table className="live-table district-table">
                      <thead>
                        <tr><th>ที่มา</th><th>พัสดุ</th><th>Planner Qty</th><th>FIFO</th><th>หมายเหตุ</th></tr>
                      </thead>
                      <tbody>
                        {planRows.map((row) => {
                          const id = itemId(row);
                          const added = addedIds.has(id);
                          return (
                            <tr key={id}>
                              <td>{added ? <b>เพิ่มเอง</b> : "ระบบเสนอ"}</td>
                              <td><strong>{text(row.material_id)}</strong><small>{text(row.material_name)}</small></td>
                              <td>{formatNumber(plannerQuantity(row), 0)}</td>
                              <td>{fifoCell(row)}</td>
                              <td>{added ? text(addReasons[id], "ยังไม่ระบุเหตุผล") : ""}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="dp-muted">ยังไม่มีรายการในแผนของเขตนี้ — ยืนยันได้ถ้าเขตนี้ไม่ต้องจ่ายรอบนี้</p>
                )}
              </div>

              {Object.entries(skipReasons).some(([id]) => districtRows.some((row) => itemId(row) === id)) && (
                <div className="dr-section">
                  <h4>ไม่เติมรอบนี้</h4>
                  {districtRows
                    .filter((row) => skipReasons[itemId(row)])
                    .map((row) => (
                      <div className="dr-row" key={itemId(row)}>
                        <span><b>{text(row.material_id)}</b> {text(row.material_name)}</span>
                        <span className="dp-muted">{skipReasons[itemId(row)]}</span>
                        <button type="button" className="btn ghost" disabled={!canCreate} onClick={() => onSkip(row, null)}>
                          ยกเลิก
                        </button>
                      </div>
                    ))}
                </div>
              )}

              {shortages.length > 0 && (
                <label className="dr-ack">
                  <input type="checkbox" checked={fifoAck} onChange={(event) => setFifoAck(event.target.checked)} />
                  <span>
                    <b>รับทราบ</b> ว่ามี {formatNumber(shortages.length)} รายการที่หลักฐาน FIFO ยังไม่ครบ
                    คลังต้องจัดพาเลท/หน่วยจัดเก็บก่อนจ่าย
                  </span>
                </label>
              )}
            </div>

            <footer className="dr-footer">
              <span className={blockers ? "dp-warn" : "dp-good"}>
                {stats.confirmed
                  ? "เขตนี้ยืนยันแล้ว"
                  : blockers
                    ? `เหลือ ${formatNumber(blockers)} เรื่องต้องจัดการก่อนยืนยัน`
                    : "พร้อมยืนยันเขตนี้"}
              </span>
              <div>
                <button type="button" className="btn ghost" onClick={() => setReviewOpen(false)}>
                  ← กลับไปแก้ไข
                </button>
                {stats.confirmed ? (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={!canCreate}
                    onClick={() => {
                      onUnconfirmDistrict();
                      setReviewOpen(false);
                    }}
                  >
                    ยกเลิกการยืนยันเขตนี้
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!canConfirm}
                    onClick={() => {
                      undecidedRows.forEach((row) => onSkip(row, DEFAULT_SKIP_REASON));
                      onConfirmDistrict();
                      setReviewOpen(false);
                      setFifoAck(false);
                    }}
                  >
                    ยืนยันเขต {activeDistrict} แล้วไปเขตถัดไป →
                  </button>
                )}
              </div>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
