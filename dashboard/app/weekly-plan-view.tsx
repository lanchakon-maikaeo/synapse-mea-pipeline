"use client";

import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { apiRequest, formatDateTime, formatNumber, type Role } from "./lib";
import { type DashboardData, type RecordRow, type ReplenishmentResponsePayload } from "./use-synapse-backend";
import {
  DistrictPlanner,
  DistrictProgress,
  type DistrictStats,
  type DistrictTab,
} from "./district-planner";
import { DistrictConfirmationBoard } from "./district-confirmation";
import { PlanSubmitModal, type PlannerSelectionPayload } from "./plan-submit";
import { RULE_LABELS, UsageBars, recommendedQty } from "./usage-bars";

import { text, bool, record, Badge, LiveTable } from "./view-helpers";

export type PlannerDraft = {
  quantities: Record<string, string>;
  editedRows: Record<string, RecordRow>;
  selectedIds: Record<string, boolean>;
  searchMode: "district" | "material";
  query: string;
  /** District-by-district planning (คำนวณการจ่ายทีละเขต). */
  activeDistrict: string;
  districtTab: DistrictTab;
  confirmedDistricts: Record<string, string>;
  skipReasons: Record<string, string>;
  addedIds: Record<string, boolean>;
  addReasons: Record<string, string>;
};

export const emptyPlannerDraft: PlannerDraft = {
  quantities: {},
  editedRows: {},
  selectedIds: {},
  searchMode: "district",
  query: "",
  activeDistrict: "",
  districtTab: "fill",
  confirmedDistricts: {},
  skipReasons: {},
  addedIds: {},
  addReasons: {},
};

// Plan statuses that mean a calculated plan is already in the review/approval
// pipeline, so the summary page is meaningful even without a fresh selection.
export const SUMMARY_PLAN_STATUSES = new Set([
  "pending_district_confirmation",
  "district_review",
  "pending_review",
  "pending_approval",
  "pending_planner_approval",
  "pending_academic_approval",
  "locked",
]);

export function hasPlannerSelection(draft: PlannerDraft) {
  return Object.values(draft.selectedIds).some(Boolean);
}

export function WeeklyPlanView({
  actionBusy,
  dataLoading = false,
  token = null,
  data,
  role,
  mode,
  draft,
  setDraft,
  summaryAvailable,
  onOpenCalculate,
  onOpenSummary,
  onApprove,
  onCancel,
  onCreate,
  onIssue,
  onReview,
  onRespond,
  onVersion,
  onConfirmPending,
  onOpenTransport,
  onSubmitSelection,
  onRecalculate,
  actionError = "",
}: {
  actionBusy: boolean;
  dataLoading?: boolean;
  token?: string | null;
  data: DashboardData;
  role: Role;
  /**
   * calculate: planner build step only (คำนวณการจ่าย)
   * summary: draft confirmation → district review → approval (สรุปการจ่าย)
   * full: legacy single-page flow used by roles that do not calculate
   */
  mode: "calculate" | "summary" | "full";
  draft: PlannerDraft;
  setDraft: Dispatch<SetStateAction<PlannerDraft>>;
  summaryAvailable: boolean;
  onOpenCalculate: () => void;
  onOpenSummary: () => void;
  onApprove: (planId: string, note?: string) => Promise<boolean>;
  onCancel: (planId: string, reason: string) => Promise<boolean>;
  onCreate: () => Promise<boolean>;
  onRecalculate?: (planId: string) => Promise<boolean>;
  onIssue: (planId: string) => Promise<boolean>;
  onReview: (
    requestId: string,
    decision: "approved" | "rejected",
    note: string,
  ) => Promise<boolean>;
  onRespond: (
    itemId: string,
    payload: ReplenishmentResponsePayload,
  ) => Promise<boolean>;
  onVersion: (planId: string, reason: string) => Promise<boolean>;
  onConfirmPending?: (planId: string, requesterName: string) => Promise<boolean>;
  onOpenTransport?: () => void;
  onSubmitSelection?: (planId: string, payload: PlannerSelectionPayload) => Promise<boolean>;
  actionError?: string;
}) {
  const [workflowStep, setWorkflowStepState] = useState(() =>
    mode === "summary"
      ? hasPlannerSelection(draft)
        ? 2
        : 3
      : mode === "calculate"
        ? 0
        : role === "district"
          ? 3
          : role === "academic"
            ? 5
            : 0,
  );
  // In split mode the build step lives on คำนวณการจ่าย and every later step
  // lives on สรุปการจ่าย; crossing that boundary changes page instead of step.
  const setWorkflowStep = (step: number) => {
    if (mode === "calculate" && step >= 2) {
      if (summaryAvailable || hasPlannerSelection(draft)) onOpenSummary();
      return;
    }
    if (mode === "summary" && step < 2) {
      onOpenCalculate();
      return;
    }
    if (mode === "summary" && step === 2 && !hasPlannerSelection(draft)) {
      setWorkflowStepState(3);
      return;
    }
    setWorkflowStepState(step);
  };
  // Planner work-in-progress is lifted to the page shell so it survives the
  // move between the calculation page and the summary page.
  const draftField =
    <K extends keyof PlannerDraft>(key: K) =>
    (value: SetStateAction<PlannerDraft[K]>) =>
      setDraft((current) => ({
        ...current,
        [key]:
          typeof value === "function"
            ? (value as (previous: PlannerDraft[K]) => PlannerDraft[K])(
                current[key],
              )
            : value,
      }));
  const searchMode = draft.searchMode;
  const setSearchMode = draftField("searchMode");
  const query = draft.query;
  const setQuery = draftField("query");
  const [focusedItemId, setFocusedItemId] = useState("");
  const plannerQuantities = draft.quantities;
  const setPlannerQuantities = draftField("quantities");
  const editedPlanningRows = draft.editedRows;
  const setEditedPlanningRows = draftField("editedRows");
  const selectedPlanningIds = draft.selectedIds;
  const setSelectedPlanningIds = draftField("selectedIds");
  const setDistrictTab = draftField("districtTab");
  const setConfirmedDistricts = draftField("confirmedDistricts");
  const setSkipReasons = draftField("skipReasons");
  const setAddedIds = draftField("addedIds");
  const setAddReasons = draftField("addReasons");
  const [responseRow, setResponseRow] = useState<RecordRow | null>(null);
  const [decision, setDecision] =
    useState<ReplenishmentResponsePayload["decision"]>("confirm");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [requester, setRequester] = useState("");
  const [planAction, setPlanAction] = useState<{
    type: "approve" | "cancel" | "version";
    row: RecordRow;
  } | null>(null);
  const [planNote, setPlanNote] = useState("");

  const itemId = (row: RecordRow) =>
    text(
      row.replenishment_item_id,
      `${text(row.district_id, "")}|${text(row.material_id, "")}`,
    );
  // Materials found by searching the server (whole Material Master, contract
  // number or PO) for "เพิ่มรายการพัสดุ"
  const [remoteCatalog, setRemoteCatalog] = useState<RecordRow[]>([]);
  const [contractLots, setContractLots] = useState<RecordRow[] | null>(null);
  const searchRemote = async (term: string) => {
    if (!token || term.trim().length < 3) return [];
    const needle = term.trim();
    const [materials, lots] = await Promise.all([
      apiRequest<RecordRow[]>(`/v1/reference/materials?search=${encodeURIComponent(needle)}&limit=20`, token).catch(() => []),
      // contract number / PO: look up the contract lots once
      /^(M[A-Z]\d|\d{6,})/i.test(needle) || needle.includes("-")
        ? contractLots ?? apiRequest<RecordRow[]>("/v1/contract-lots?scope=all", token).catch(() => [])
        : Promise.resolve([] as RecordRow[]),
    ]);
    if (lots.length && !contractLots) setContractLots(lots);
    const upper = needle.toUpperCase();
    const fromContracts = lots
      .filter((lot) =>
        text(lot.contract_number, "").toUpperCase().includes(upper) ||
        text(lot.purchase_order, "").includes(needle))
      .map((lot) => ({
        material_id: lot.material_id,
        material_name: `${text(lot.material_name, "")} · สัญญา ${text(lot.contract_number, text(lot.purchase_order))}`,
        search_key: `${text(lot.contract_number, "")} ${text(lot.purchase_order, "")}`,
      }));
    const found = [...materials, ...fromContracts];
    setRemoteCatalog((current) => [...current, ...found].slice(-200));
    return found.map((row) => ({
      id: text(row.material_id),
      name: `${text(row.material_name)} ${text(row.search_key, "")}`.trim(),
    }));
  };
  const materialCatalog = [
    ...new Map(
      [...data.materials, ...data.replenishment, ...data.stock, ...remoteCatalog].map((row) => [
        text(row.material_id),
        {
          id: text(row.material_id),
          name: text(row.material_name),
        },
      ]),
    ).values(),
  ].filter((material) => material.id && material.id !== "—");
  const materialTerm = query.trim().toLowerCase();
  const materialToken = query.split(":")[0].trim();
  const selectedMaterial =
    searchMode === "material" && materialTerm
      ? materialCatalog.find((material) => material.id === materialToken) ??
        materialCatalog.find((material) =>
          `${material.id} : ${material.name}`.toLowerCase().includes(materialTerm),
        )
      : null;
  // One row per district + material: the same item appears once per plan
  // version, so keep the row from the newest plan.
  const latestReplenishment = (() => {
    const order = (row: RecordRow) =>
      `${text(row.week_start_date, "")}|${String(Number(row.version_no ?? 0)).padStart(6, "0")}|${text(row.updated_at, "")}`;
    const byKey = new Map<string, RecordRow>();
    data.replenishment.forEach((row) => {
      if (text(row.item_status, "") === "cancelled") return;
      if (["cancelled", "completed"].includes(text(row.plan_status, ""))) return;
      const key = `${text(row.district_id)}|${text(row.material_id)}`;
      const current = byKey.get(key);
      if (!current || order(row) > order(current)) byKey.set(key, row);
    });
    return [...byKey.values()];
  })();
  const districtReference = [
    ...new Map(
      [...data.districts, ...data.stock, ...data.replenishment].map((row) => [
        text(row.district_id),
        {
          district_id: text(row.district_id),
          district_name_th: text(row.district_name_th),
        },
      ]),
    ).values(),
  ].filter((district) => district.district_id && district.district_id !== "—");
  const materialRowFor = (
    material: { id: string; name: string },
    district: { district_id: string; district_name_th: string },
  ): RecordRow => {
        const stock =
          data.stock.find(
            (row) =>
              text(row.material_id) === material.id &&
              text(row.district_id) === district.district_id,
          ) ?? {};
        const queued =
          latestReplenishment.find(
            (row) =>
              text(row.material_id) === material.id &&
              text(row.district_id) === district.district_id,
          ) ?? {};
        const currentStock = Number(stock.current_stock_qty ?? 0);
        const cmp = Number(stock.cmp_monthly ?? queued.cmp_monthly ?? 0);
        const months = cmp > 0 ? currentStock / cmp : 0;
        const minFill = Math.max(0, Math.round(cmp * 4 - currentStock));
        const maxFill = Math.max(0, Math.round(cmp * 6 - currentStock));
        const needsFill = cmp > 0 && months <= 3.5 && maxFill > 0;
        return {
          ...stock,
          ...queued,
          ...district,
          material_id: material.id,
          material_name: material.name,
          current_stock_qty: currentStock,
          cmp_monthly: cmp,
          months_available: months,
          min_fill_qty: Number(queued.min_fill_qty ?? minFill),
          max_fill_qty: Number(queued.max_fill_qty ?? maxFill),
          suggested_qty: Number(
            queued.suggested_qty ?? (needsFill ? maxFill : 0),
          ),
          needs_fill: needsFill,
          material_search_row: true,
        };
  };
  const materialRows: RecordRow[] = selectedMaterial
    ? districtReference.map((district) => materialRowFor(selectedMaterial, district))
    : [];
  const canPlanDistricts = role === "admin" || role === "planner";
  const districtFlow = searchMode === "district" && canPlanDistricts;
  const rowNeedsFill = (row: RecordRow) =>
    Boolean(row.needs_fill ?? Number(row.suggested_qty ?? 0) > 0);
  const flowDistricts = [
    ...new Map(
      [...data.districts, ...latestReplenishment].map((row) => [
        text(row.district_id),
        { id: text(row.district_id), name: text(row.district_name_th) },
      ]),
    ).values(),
  ]
    .filter((district) => district.id && district.id !== "—")
    .sort((left, right) => left.id.localeCompare(right.id));
  const addedRowsAll = Object.values(editedPlanningRows).filter(
    (row) => draft.addedIds[itemId(row)],
  );
  const systemRowsByDistrict = latestReplenishment.reduce<Record<string, RecordRow[]>>(
    (groups, row) => {
      if (draft.addedIds[itemId(row)]) return groups;
      const key = text(row.district_id);
      (groups[key] ??= []).push(row);
      return groups;
    },
    {},
  );
  const isPicked = (row: RecordRow) =>
    Boolean(selectedPlanningIds[itemId(row)]) &&
    Number(plannerQuantities[itemId(row)] ?? (row.replenishment_item_id ? recommendedQty(row) : 0)) > 0;
  const districtStats = (districtId: string): DistrictStats => {
    const systemRows = systemRowsByDistrict[districtId] ?? [];
    const needs = systemRows.filter(rowNeedsFill);
    const added = addedRowsAll.filter((row) => text(row.district_id) === districtId);
    const selected = systemRows.filter(isPicked).length;
    const undecided = needs.filter(
      (row) => !isPicked(row) && !draft.skipReasons[itemId(row)],
    ).length;
    return {
      needs: needs.length,
      selected,
      added: added.length,
      undecided,
      confirmed: Boolean(draft.confirmedDistricts[districtId]),
      touched:
        selected > 0 ||
        added.length > 0 ||
        systemRows.some((row) => draft.skipReasons[itemId(row)]),
    };
  };
  const activeDistrict =
    (draft.activeDistrict &&
      flowDistricts.some((district) => district.id === draft.activeDistrict) &&
      draft.activeDistrict) ||
    flowDistricts.find(
      (district) =>
        !draft.confirmedDistricts[district.id] &&
        (systemRowsByDistrict[district.id] ?? []).some(rowNeedsFill),
    )?.id ||
    flowDistricts[0]?.id ||
    "";
  const activeSystemRows = systemRowsByDistrict[activeDistrict] ?? [];
  const activeAddedRows = addedRowsAll.filter(
    (row) => text(row.district_id) === activeDistrict,
  );
  const activeDistrictInfo = districtReference.find(
    (district) => district.district_id === activeDistrict,
  ) ?? { district_id: activeDistrict, district_name_th: "" };
  const rows = (
    districtFlow
      ? [...activeSystemRows, ...activeAddedRows]
      : searchMode === "district"
        ? latestReplenishment.filter((row) => {
            const value = query.trim().toLowerCase();
            return !value || text(row.district_id).toLowerCase().includes(value);
          })
        : materialRows
  ).sort(
    (left, right) =>
      Number(Boolean(right.needs_fill ?? Number(right.suggested_qty ?? 0) > 0)) -
        Number(Boolean(left.needs_fill ?? Number(left.suggested_qty ?? 0) > 0)) ||
      Number(right.priority_score ?? 0) - Number(left.priority_score ?? 0) ||
      text(left.district_id).localeCompare(text(right.district_id)),
  );

  const defaultPlannerQuantity = (row: RecordRow) =>
    row.replenishment_item_id ? Number(row.planner_qty ?? recommendedQty(row)) : 0;
  const focusedRow =
    rows.find((row) => itemId(row) === focusedItemId) ?? rows[0] ?? null;
  const plannerQuantity = (row: RecordRow) => {
    const value = Number(
      plannerQuantities[itemId(row)] ?? defaultPlannerQuantity(row),
    );
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const selectedRows =
    role === "district"
      ? data.replenishment
      : [
          ...new Map(
            [...data.replenishment, ...Object.values(editedPlanningRows)].map(
              (row) => [itemId(row), row],
            ),
          ).values(),
        ].filter(
          (row) =>
            Boolean(selectedPlanningIds[itemId(row)]) &&
            plannerQuantity(row) > 0,
        );
  const warehouseQuantity = (row: RecordRow) =>
    data.warehouseStock
      .filter(
        (stock) =>
          text(stock.material_id) === text(row.material_id) &&
          text(stock.location_id) === "WH-KT",
      )
      .reduce((sum, stock) => sum + Number(stock.quantity_on_hand ?? 0), 0);
  // All districts together must not take more than Khlong Toei holds
  const plannedTotalByMaterial = selectedRows.reduce<Map<string, number>>(
    (totals, row) =>
      totals.set(
        text(row.material_id),
        (totals.get(text(row.material_id)) ?? 0) + plannerQuantity(row),
      ),
    new Map(),
  );
  const overWarehouse = (row: RecordRow) =>
    (plannedTotalByMaterial.get(text(row.material_id)) ?? 0) >
    warehouseQuantity(row);
  const overWarehouseMaterials = [
    ...new Map(
      selectedRows
        .filter(overWarehouse)
        .map((row) => [text(row.material_id), row]),
    ).values(),
  ];
  // Contract-lot rows (M29) carry no packing data: quantities are in the
  // material's own unit (EA / SET / KG ... from Material Master)
  const isContractLot = (row: RecordRow) => text(row.fifo_source, "") === "contract_lots";
  const unitOf = (row: RecordRow) =>
    text(
      row.unit ??
        data.materials.find((material) => text(material.material_id) === text(row.material_id))?.unit ??
        data.warehouseStock.find((stock) => text(stock.material_id) === text(row.material_id))?.unit ??
        data.warehouseStock.find((stock) => text(stock.material_id) === text(row.material_id))?.base_unit,
      "",
    );
  const packagingLabel = (row: RecordRow) => {
    if (isContractLot(row)) return unitOf(row);
    const labels: Record<string, string> = {
      FULL_PALLET: "Full Pallet",
      BOX: "Box",
      CRATE: "Crate",
      BUNDLE: "Bundle",
      LOOSE: "Bundle/Loose",
      LONG_MATERIAL: "Long Material",
    };
    return labels[text(row.unit_type, "LOOSE")] ?? text(row.unit_type, "Handling Unit");
  };
  const packSize = (row: RecordRow) => {
    const value = Number(
      row.units_per_handling_unit ?? row.initial_qty ?? row.allocatable_qty ?? 1,
    );
    return Number.isFinite(value) && value > 0 ? value : 1;
  };
  const packingText = (row: RecordRow, quantity: number) => {
    if (isContractLot(row)) return `${formatNumber(quantity, 2)} ${unitOf(row)}`;
    const label = packagingLabel(row);
    const size = packSize(row);
    if (size <= 1 || ["LOOSE", "LONG_MATERIAL"].includes(text(row.unit_type))) {
      return `${formatNumber(quantity, 0)} ${label}`;
    }
    const whole = Math.floor(quantity / size);
    const loose = quantity - whole * size;
    const parts = [];
    if (whole > 0) {
      parts.push(
        `${formatNumber(whole, 0)} ${label} × ${formatNumber(size, 0)} EA`,
      );
    }
    if (loose > 0) {
      parts.push(
        `เปิด ${label} หยิบย่อย ${formatNumber(loose, 0)} EA`,
      );
    }
    return parts.join(" + ") || `0 ${label}`;
  };
  const fifoPlanFor = (planningRow: RecordRow) => {
    let remaining = plannerQuantity(planningRow);
    const picks = data.fifo
      .filter(
        (row) =>
          text(row.material_id) === text(planningRow.material_id) &&
          text(row.location_id) === "WH-KT",
      )
      .sort(
        (left, right) =>
          Number(left.fifo_sequence ?? 0) -
          Number(right.fifo_sequence ?? 0),
      )
      .map((row) => {
        const available = Math.max(0, Number(row.allocatable_qty ?? 0));
        const quantity = Math.min(available, remaining);
        remaining -= quantity;
        return { row, quantity };
      })
      .filter((pick) => pick.quantity > 0);
    return {
      picks,
      shortage: remaining,
      detail: picks.length
        ? picks
            .map(
              ({ row, quantity }, index) =>
                `#${index + 1} ${text(row.contract_number)} · ${text(
                  row.handling_unit_code,
                )} × ${formatNumber(quantity, 0)} EA (${packingText(
                  row,
                  quantity,
                )})`,
            )
            .join(" | ")
        : "ยังไม่มี FIFO พร้อมหยิบ",
    };
  };
  const focusedRecommendation = focusedRow
    ? data.recommendations.find(
        (row) => itemId(row) === itemId(focusedRow),
      ) ?? null
    : null;
  const focusedEvidence = record(focusedRecommendation?.evidence);
  const focusedFifo = focusedRow
    ? data.fifo
        .filter(
          (row) =>
            text(row.material_id) === text(focusedRow.material_id) &&
            text(row.location_id) === "WH-KT",
        )
        .sort(
          (left, right) =>
            Number(left.fifo_sequence ?? 0) -
            Number(right.fifo_sequence ?? 0),
        )
    : [];
  const fifoPreviewResult = focusedFifo.reduce<{
    rows: RecordRow[];
    remaining: number;
  }>((state, row) => {
      const allocatable = Math.max(0, Number(row.allocatable_qty ?? 0));
      const allocated = Math.min(allocatable, state.remaining);
      return {
        rows: [...state.rows, { ...row, preview_allocated_qty: allocated }],
        remaining: state.remaining - allocated,
      };
    }, { rows: [], remaining: focusedRow ? plannerQuantity(focusedRow) : 0 });
  const fifoPreview = fifoPreviewResult.rows;
  const fifoRemaining = fifoPreviewResult.remaining;
  const districtSummary = (() => {
    const summary = new Map<
      string,
      { district: string; name: string; items: number; quantity: number }
    >();
    selectedRows.forEach((row) => {
      const district = text(row.district_id);
      const current = summary.get(district) ?? {
        district,
        name: text(row.district_name_th),
        items: 0,
        quantity: 0,
      };
      current.items += 1;
      current.quantity += plannerQuantity(row);
      summary.set(district, current);
    });
    return [...summary.values()].sort((left, right) =>
      left.district.localeCompare(right.district),
    );
  })();
  const planTotals = {
    lines: selectedRows.length,
    districts: districtSummary.length,
    materials: new Set(selectedRows.map((row) => text(row.material_id))).size,
    quantity: selectedRows.reduce(
      (sum, row) => sum + plannerQuantity(row),
      0,
    ),
  };

  const plans = useMemo(() => {
    const unique = new Map<string, RecordRow>();
    data.replenishment.forEach((row) => {
      unique.set(text(row.replenishment_plan_id), row);
    });
    return [...unique.values()];
  }, [data.replenishment]);

  const canCreate = role === "admin" || role === "planner";
  const canRespond = ["admin", "planner", "district"].includes(role);

  // Planner selection → server plan. The open plan for the week holds the
  // system proposal; the planner's picks replace it before districts confirm.
  const openPlanStatuses = new Set([
    "draft",
    "pending_district_confirmation",
    "district_review",
  ]);
  const targetPlan = data.replenishment
    .filter((row) => openPlanStatuses.has(text(row.plan_status, "")))
    .sort((left, right) =>
      `${text(right.week_start_date, "")}|${String(Number(right.version_no ?? 0)).padStart(6, "0")}`.localeCompare(
        `${text(left.week_start_date, "")}|${String(Number(left.version_no ?? 0)).padStart(6, "0")}`,
      ),
    )[0];
  const targetPlanId = text(targetPlan?.replenishment_plan_id, "");
  const planStartedAt = data.replenishment
    .filter((row) => text(row.replenishment_plan_id) === targetPlanId)
    .map((row) => text(row.created_at, ""))
    .filter(Boolean)
    .sort()[0];
  const lineKey = (row: RecordRow) => `${text(row.district_id)}|${text(row.material_id)}`;
  const targetItems = data.replenishment.filter(
    (row) =>
      text(row.replenishment_plan_id) === targetPlanId &&
      ["draft", "pending"].includes(text(row.item_status, "")),
  );
  const targetByKey = new Map(targetItems.map((row) => [lineKey(row), row]));
  const selectedKeys = new Set(selectedRows.map(lineKey));
  const selectionPayload: PlannerSelectionPayload = {
    lines: selectedRows.map((row) => {
      const system = targetByKey.get(lineKey(row));
      return {
        replenishment_item_id: system ? text(system.replenishment_item_id) : null,
        district_id: text(row.district_id),
        district_name_th: text(row.district_name_th, ""),
        material_id: text(row.material_id),
        material_name: text(row.material_name, ""),
        quantity: plannerQuantity(row),
        system_quantity: system ? Number(system.suggested_qty ?? 0) : null,
        source: system ? "system" : "added",
        reason: system ? "" : (draft.addReasons[itemId(row)] ?? ""),
      };
    }),
    dropped: targetItems
      .filter((row) => !selectedKeys.has(lineKey(row)))
      .map((row) => ({
        replenishment_item_id: text(row.replenishment_item_id),
        district_id: text(row.district_id),
        district_name_th: text(row.district_name_th, ""),
        material_id: text(row.material_id),
        material_name: text(row.material_name, ""),
        system_quantity: Number(row.suggested_qty ?? 0),
        reason: draft.skipReasons[itemId(row)] || "ไม่ได้เลือกเข้าแผน",
      })),
  };
  const usedDistrictFlow = Object.keys(draft.confirmedDistricts).length > 0;
  const unconfirmedSendDistricts = usedDistrictFlow
    ? [...new Set(selectionPayload.lines.map((line) => line.district_id))]
        .filter((id) => !draft.confirmedDistricts[id])
        .sort()
    : [];
  const [submitOpen, setSubmitOpen] = useState(false);
  const openResponse = (row: RecordRow) => {
    setResponseRow(row);
    setDecision("confirm");
    setQuantity(text(row.planner_qty ?? row.suggested_qty, "0"));
    setReason("");
    setRequester("");
  };
  const submitResponse = async (event: FormEvent) => {
    event.preventDefault();
    if (!responseRow) return;
    const confirmedQty = decision === "reject" ? 0 : Number(quantity);
    if (
      !Number.isFinite(confirmedQty) ||
      confirmedQty < 0 ||
      reason.trim().length < 3 ||
      requester.trim().length < 2
    ) {
      return;
    }
    const ok = await onRespond(text(responseRow.replenishment_item_id), {
      decision,
      confirmed_qty: confirmedQty,
      reason: reason.trim(),
      requester_name: requester.trim(),
    });
    if (ok) setResponseRow(null);
  };
  const submitPlanAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!planAction) return;
    const planId = text(planAction.row.replenishment_plan_id);
    const ok =
      planAction.type === "approve"
        ? await onApprove(planId, planNote)
        : planAction.type === "cancel"
          ? await onCancel(planId, planNote)
          : await onVersion(planId, planNote);
    if (ok) {
      setPlanAction(null);
      setPlanNote("");
    }
  };
  const unconfirmDistrict = (districtId: string) =>
    setConfirmedDistricts((current) => {
      if (!current[districtId]) return current;
      const next = { ...current };
      delete next[districtId];
      return next;
    });
  const touchRow = (row: RecordRow) => {
    setEditedPlanningRows((current) => ({ ...current, [itemId(row)]: row }));
    unconfirmDistrict(text(row.district_id));
  };
  const districtPlannerHandlers = {
    onSelectDistrict: (districtId: string) =>
      setDraft((current) => ({ ...current, activeDistrict: districtId, districtTab: "fill" })),
    onToggle: (row: RecordRow, checked: boolean) => {
      const id = itemId(row);
      setFocusedItemId(id);
      touchRow(row);
      setSelectedPlanningIds((current) => ({ ...current, [id]: checked }));
      if (checked) {
        setSkipReasons((current) => {
          if (!current[id]) return current;
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    },
    onQuantity: (row: RecordRow, nextQuantity: number) => {
      const id = itemId(row);
      touchRow(row);
      setPlannerQuantities((current) => ({ ...current, [id]: String(nextQuantity) }));
      if (nextQuantity === 0) {
        setSelectedPlanningIds((current) => ({ ...current, [id]: false }));
      }
    },
    onSkip: (row: RecordRow, reason: string | null) => {
      const id = itemId(row);
      unconfirmDistrict(text(row.district_id));
      setSkipReasons((current) => {
        const next = { ...current };
        if (reason) next[id] = reason;
        else delete next[id];
        return next;
      });
      if (reason) setSelectedPlanningIds((current) => ({ ...current, [id]: false }));
    },
    onAddReason: (row: RecordRow, reason: string) => {
      unconfirmDistrict(text(row.district_id));
      setAddReasons((current) => ({ ...current, [itemId(row)]: reason }));
    },
    onAddMaterial: (row: RecordRow, addQuantity: number) => {
      const id = itemId(row);
      touchRow(row);
      setAddedIds((current) => ({ ...current, [id]: true }));
      setPlannerQuantities((current) => ({ ...current, [id]: String(addQuantity) }));
      setSelectedPlanningIds((current) => ({ ...current, [id]: true }));
      setFocusedItemId(id);
    },
    onRemoveAdded: (row: RecordRow) => {
      const id = itemId(row);
      unconfirmDistrict(text(row.district_id));
      setAddedIds((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setSelectedPlanningIds((current) => ({ ...current, [id]: false }));
      setAddReasons((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    onConfirmDistrict: () => {
      const confirmedAt = new Date().toISOString();
      const nextConfirmed = { ...draft.confirmedDistricts, [activeDistrict]: confirmedAt };
      const start = flowDistricts.findIndex((district) => district.id === activeDistrict);
      const ordered = [...flowDistricts.slice(start + 1), ...flowDistricts.slice(0, start)];
      const next =
        ordered.find(
          (district) =>
            !nextConfirmed[district.id] &&
            (systemRowsByDistrict[district.id] ?? []).some(rowNeedsFill),
        ) ?? ordered.find((district) => !nextConfirmed[district.id]);
      setDraft((current) => ({
        ...current,
        confirmedDistricts: { ...current.confirmedDistricts, [activeDistrict]: confirmedAt },
        activeDistrict: next?.id ?? current.activeDistrict,
        districtTab: "fill",
      }));
    },
    onUnconfirmDistrict: () => unconfirmDistrict(activeDistrict),
  };
  const confirmedDistrictCount = flowDistricts.filter(
    (district) => draft.confirmedDistricts[district.id],
  ).length;
  const activePhase = workflowStep < 2 ? 0 : workflowStep < 5 ? 1 : 2;
  const districtOptions = [
    ...new Map(
      [...data.districts, ...data.replenishment].map((row) => [
        text(row.district_id),
        {
          id: text(row.district_id),
          name: text(row.district_name_th),
        },
      ]),
    ).values(),
  ]
    .filter((district) => district.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const materialOptions = materialCatalog.map(
    (material) => `${material.id} : ${material.name}`,
  );

  // No plan round yet: show only the start step, the rest opens after it.
  // A cancelled or finished round does not count: the planner starts a new one
  const hasOpenRound = data.replenishment.some(
    (row) => !["cancelled", "completed"].includes(text(row.plan_status, "")),
  );
  if (mode === "calculate" && canCreate && !hasOpenRound && workflowStep < 2) {
    return (
      <div className="stack">
        <section className="panel plan-start" aria-label="เริ่มรอบแผน">
          <span className="plan-start-step">ขั้นแรก</span>
          <h3>เริ่มรอบแผนการจ่ายสัปดาห์นี้</h3>
          <p>
            ระบบจะคำนวณรายการที่เขตต้องเติมจาก Stock เขตและ CMP ชุดที่ส่งเข้าระบบคำนวณล่าสุด
            เมื่อกดแล้วจึงจะแสดงรายการให้เลือกพัสดุ กรอก Planner Qty และสรุปการจ่าย
          </p>
          <ol className="plan-start-flow">
            <li><b>1</b><span>เริ่มรอบแผน<small>คำนวณจากข้อมูลล่าสุด</small></span></li>
            <li><b>2</b><span>Build Plan<small>เลือกพัสดุ · กำหนดจำนวน</small></span></li>
            <li><b>3</b><span>District Review<small>เขตยืนยันรายรายการ</small></span></li>
            <li><b>4</b><span>Approve &amp; Lock<small>Planner → วิชาการ → Lock FIFO</small></span></li>
          </ol>
          <button
            type="button"
            className="btn primary plan-start-button"
            disabled={actionBusy || dataLoading}
            onClick={() => void onCreate()}
          >
            {actionBusy
              ? "กำลังคำนวณและโหลดรายการ…"
              : dataLoading
                ? "กำลังโหลดข้อมูล…"
                : "เริ่มรอบแผนจากข้อมูลล่าสุด"}
          </button>
          {actionBusy && (
            <p className="plan-start-wait" role="status">
              ระบบกำลังคำนวณจาก Stock เขต 18 เขตและ CMP ใช้เวลาประมาณ 10–30 วินาที เสร็จแล้วรายการจะขึ้นเอง
            </p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="stack">
      <section className="workflow planner-workflow" aria-label="ขั้นตอนแผนการจ่าย">
        {[
          { step: "1", name: "Build Plan", note: "เลือกพัสดุ · กำหนดจำนวน · ดู AI + FIFO", go: 0 },
          { step: "2", name: "District Review", note: "สรุปแผน · เขตยืนยันรายรายการ · Planner ตรวจการเปลี่ยน", go: 2 },
          { step: "3", name: "Approve & Lock", note: "Planner → วิชาการ → Lock FIFO", go: 5 },
        ].map((phase, index) => (
          <button
            type="button"
            className={`workflow-step ${
              index < activePhase
                ? "done"
                : index === activePhase
                  ? "current"
                  : ""
            }`}
            key={phase.name}
            disabled={
              mode === "calculate" &&
              index > 0 &&
              !summaryAvailable &&
              !selectedRows.length
            }
            title={
              mode === "calculate" &&
              index > 0 &&
              !summaryAvailable &&
              !selectedRows.length
                ? "คำนวณและเลือกรายการเข้าแผนก่อน จึงจะเปิดหน้าสรุปการจ่ายได้"
                : undefined
            }
            onClick={() => setWorkflowStep(phase.go)}
          >
            <span>{phase.step}</span>
            <div>
              <strong>{phase.name}</strong>
              <small>{phase.note}</small>
            </div>
            {index < 2 && <i />}
          </button>
        ))}
      </section>

      {targetPlan && (
        <section className="plan-banner" aria-label="แผนที่กำลังทำ">
          <span className="plan-banner-label">แผนที่กำลังทำ</span>
          <strong>
            {text(targetPlan.plan_number)}-V{text(targetPlan.version_no, "1")}
          </strong>
          <span className="plan-banner-meta">
            สัปดาห์จ่าย {new Date(`${text(targetPlan.week_start_date, "")}T00:00:00`).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" })}
            {planStartedAt ? ` · เริ่มรอบ ${formatDateTime(planStartedAt)}` : ""}
            {" · "}
            {{
              draft: "ร่าง",
              pending_district_confirmation: "รอเขตยืนยัน",
              district_review: "รอเขตยืนยัน",
            }[text(targetPlan.plan_status, "")] ?? text(targetPlan.plan_status)}
          </span>
        </section>
      )}

      {(workflowStep === 0 || workflowStep === 1) && (
        <>
          {!(districtFlow && data.replenishment.length > 0) && (
          <section className="filter-bar planner-filter">
            <div className="search-switch" role="group" aria-label="ค้นหาตาม">
              <button
                type="button"
                className={searchMode === "district" ? "active" : ""}
                onClick={() => {
                  setSearchMode("district");
                  setQuery("");
                }}
              >
                ค้นหารายเขต
              </button>
              <button
                type="button"
                className={searchMode === "material" ? "active" : ""}
                onClick={() => {
                  setSearchMode("material");
                  setQuery(materialOptions[0] ?? "");
                }}
              >
                ค้นหารายพัสดุ
              </button>
            </div>
            {searchMode === "district" ? (
              districtFlow ? (
                <span className="district-flow-note">
                  ทำทีละเขต · ยืนยันแล้ว {formatNumber(confirmedDistrictCount)} จาก{" "}
                  {formatNumber(flowDistricts.length)} เขต · เลือกเขตจากแถบด้านล่าง
                </span>
              ) : (
              <select
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="เลือกการไฟฟ้าเขต"
              >
                <option value="">ทุกเขตที่เข้าเกณฑ์</option>
                {districtOptions.map((district) => (
                  <option key={district.id} value={district.id}>
                    {district.id} : {district.name}
                  </option>
                ))}
              </select>
              )
            ) : (
              <>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="พิมพ์รหัสหรือชื่อพัสดุ"
                  aria-label="ค้นหารายพัสดุ"
                  list="weekly-material-options"
                />
                <datalist id="weekly-material-options">
                  {materialOptions.map((material) => (
                    <option key={material} value={material} />
                  ))}
                </datalist>
              </>
            )}
            {canCreate && !hasOpenRound ? (
              <button
                className="btn primary"
                disabled={actionBusy}
                onClick={() => void onCreate()}
              >
                เริ่มรอบแผนจากข้อมูลล่าสุด
              </button>
            ) : (
              <>
              {canCreate && onRecalculate && targetPlanId && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={actionBusy}
                  title="ใช้ Stock คลังคลองเตย / Stock เขต / อัตราการใช้ที่ยืนยันล่าสุด กับรายการที่เขตยังไม่ยืนยัน"
                  onClick={() => void onRecalculate(targetPlanId)}
                >
                  {actionBusy ? "กำลังคำนวณใหม่…" : "คำนวณใหม่ด้วย Stock ล่าสุด"}
                </button>
              )}
              <button
                type="button"
                className="btn primary"
                disabled={!selectedRows.length}
                onClick={() => setWorkflowStep(2)}
              >
                {mode === "calculate"
                  ? `สรุปการจ่าย (${formatNumber(selectedRows.length)}) →`
                  : `ยืนยันรายการที่เลือก (${formatNumber(selectedRows.length)})`}
              </button>
              </>
            )}
          </section>
          )}

          <section className="planner-preview-note">
            <strong>Candidate Source</strong>
            <span>
              รายเขตแสดงเฉพาะพัสดุที่ต้องเติม · รายพัสดุแสดงครบทั้ง 18 เขต
              พร้อมสถานะต้องเติม/ไม่ต้องเติม · กรอก Planner Qty แล้วเลือก
              “เข้าแผน” เฉพาะรายการที่ต้องการยืนยัน
            </span>
          </section>

          {districtFlow && (
            <DistrictProgress
              districts={flowDistricts}
              activeDistrict={activeDistrict}
              statsFor={districtStats}
              onSelectDistrict={districtPlannerHandlers.onSelectDistrict}
              onSwitchToMaterial={() => {
                setSearchMode("material");
                setQuery(materialOptions[0] ?? "");
              }}
            />
          )}

          <section className="planner-workspace-grid">
            <article className="panel planner-picker">
              {districtFlow ? (
                <DistrictPlanner
                  canCreate={canCreate}
                  districts={flowDistricts}
                  activeDistrict={activeDistrict}
                  statsFor={districtStats}
                  onSelectDistrict={districtPlannerHandlers.onSelectDistrict}
                  tab={draft.districtTab}
                  onTab={(tab) => setDistrictTab(tab)}
                  districtRows={activeSystemRows}
                  addedRows={activeAddedRows}
                  itemId={itemId}
                  needsFill={rowNeedsFill}
                  isSelected={(id) => Boolean(selectedPlanningIds[id])}
                  onToggle={districtPlannerHandlers.onToggle}
                  quantityValue={(row) =>
                    plannerQuantities[itemId(row)] ?? String(defaultPlannerQuantity(row))
                  }
                  onQuantity={districtPlannerHandlers.onQuantity}
                  plannerQuantity={plannerQuantity}
                  warehouseQuantity={warehouseQuantity}
                  fifoShortage={(row) => fifoPlanFor(row).shortage}
                  focusedId={itemId(focusedRow ?? {})}
                  onFocus={setFocusedItemId}
                  skipReasons={draft.skipReasons}
                  onSkip={districtPlannerHandlers.onSkip}
                  addReasons={draft.addReasons}
                  onAddReason={districtPlannerHandlers.onAddReason}
                  materialCatalog={materialCatalog}
                  searchRemote={token ? searchRemote : undefined}
                  buildMaterialRow={(materialId) => {
                    const material = materialCatalog.find((item) => item.id === materialId);
                    return material ? materialRowFor(material, activeDistrictInfo) : null;
                  }}
                  onAddMaterial={districtPlannerHandlers.onAddMaterial}
                  onRemoveAdded={districtPlannerHandlers.onRemoveAdded}
                  onConfirmDistrict={districtPlannerHandlers.onConfirmDistrict}
                  onUnconfirmDistrict={districtPlannerHandlers.onUnconfirmDistrict}
                />
              ) : (
              <>
              <div className="panel-title">
                <div>
                  <span>PLANNER WORKSPACE</span>
                  <h3>กรอกจำนวน → เลือกเข้าแผน → ยืนยันรายการที่เลือก</h3>
                </div>
                <b>
                  {formatNumber(selectedRows.length)} เลือกแล้ว ·{" "}
                  {formatNumber(rows.length)} พบ
                </b>
              </div>
              <div className="planner-selection-tools">
                <span>
                  Planner Qty แก้ไขได้ทุกแถว การกรอกจำนวนยังไม่ถือว่ายืนยัน
                  จนกว่าจะเลือกเข้าแผน
                </span>
                <div>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={!canCreate}
                    onClick={() => {
                      setEditedPlanningRows((current) => ({
                        ...current,
                        ...Object.fromEntries(rows.map((row) => [itemId(row), row])),
                      }));
                      setSelectedPlanningIds((current) => ({
                        ...current,
                        ...Object.fromEntries(
                          rows
                            .filter((row) => plannerQuantity(row) > 0)
                            .map((row) => [itemId(row), true]),
                        ),
                      }));
                    }}
                  >
                    เลือกทุกแถวที่มี Qty
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={!canCreate}
                    onClick={() =>
                      setSelectedPlanningIds((current) => ({
                        ...current,
                        ...Object.fromEntries(rows.map((row) => [itemId(row), false])),
                      }))
                    }
                  >
                    ล้างที่เลือกในหน้านี้
                  </button>
                </div>
              </div>
              {rows.length ? (
                <div className="live-table-wrap">
                  <table className="live-table planner-item-table">
                    <thead>
                      <tr>
                        <th>เลือกเข้าแผน</th>
                        <th>สถานะการเติม</th>
                        <th>การไฟฟ้าเขต</th>
                        <th>พัสดุ</th>
                        <th>Stock คลังกลาง</th>
                        <th>Stock เขต</th>
                        <th>CMP</th>
                        <th>MIN</th>
                        <th>MAX</th>
                        <th>เหลือ (เดือน)</th>
                        <th>✦ แนะนำ</th>
                        <th>Planner Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const id = itemId(row);
                        const needsFill = Boolean(
                          row.needs_fill ??
                            Number(row.suggested_qty ?? 0) > 0,
                        );
                        const quantity = plannerQuantity(row);
                        return (
                          <tr
                            key={id}
                            className={`${itemId(focusedRow ?? {}) === id ? "selected" : ""} ${
                              selectedPlanningIds[id] ? "in-plan" : ""
                            }`}
                            onClick={() => setFocusedItemId(id)}
                          >
                            <td className="plan-select-cell">
                              <label>
                                <input
                                  type="checkbox"
                                  checked={Boolean(selectedPlanningIds[id])}
                                  disabled={!canCreate || quantity <= 0}
                                  onChange={(event) => {
                                    setFocusedItemId(id);
                                    setEditedPlanningRows((current) => ({
                                      ...current,
                                      [id]: row,
                                    }));
                                    setSelectedPlanningIds((current) => ({
                                      ...current,
                                      [id]: event.target.checked,
                                    }));
                                  }}
                                  aria-label={`เลือกพัสดุ ${text(row.material_id)} เขต ${text(row.district_id)} เข้าแผน`}
                                />
                                <span>
                                  {selectedPlanningIds[id]
                                    ? "เลือกแล้ว"
                                    : quantity > 0
                                      ? "เลือก"
                                      : "ใส่ Qty ก่อน"}
                                </span>
                              </label>
                            </td>
                            <td>
                              <span
                                className={`stock-state ${needsFill ? "needs-fill" : "no-fill"}`}
                              >
                                {needsFill ? "ต้องเติม" : "ไม่ต้องเติม"}
                              </span>
                            </td>
                            <td>
                              <strong>{text(row.district_id)} : {text(row.district_name_th)}</strong>
                            </td>
                            <td>
                              <strong>{text(row.material_id)}</strong>
                              <small>{text(row.material_name)}</small>
                            </td>
                            <td>{formatNumber(warehouseQuantity(row), 0)}</td>
                            <td>{formatNumber(row.current_stock_qty, 0)}</td>
                            <td>{formatNumber(row.cmp_monthly, 0)}</td>
                            <td>{formatNumber(row.min_fill_qty, 0)}</td>
                            <td>{formatNumber(row.max_fill_qty, 0)}</td>
                            <td>{formatNumber(row.months_available, 1)}M</td>
                            <td className="recommend">
                              <span className="ai-suggestion" title={text(row.ai_reason, "")}>
                                ✦ {formatNumber(recommendedQty(row), 0)}
                              </span>
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
                            </td>
                            <td>
                              <input
                                className="planner-qty"
                                type="number"
                                min="0"
                                step="1"
                                disabled={!canCreate}
                                value={
                                  plannerQuantities[id] ??
                                  String(defaultPlannerQuantity(row))
                                }
                                onFocus={() => setFocusedItemId(id)}
                                onChange={(event) => {
                                  const nextQuantity = Math.max(
                                    0,
                                    Math.round(Number(event.target.value) || 0),
                                  );
                                  setEditedPlanningRows((current) => ({
                                    ...current,
                                    [id]: row,
                                  }));
                                  setPlannerQuantities((current) => ({
                                    ...current,
                                    [id]: String(nextQuantity),
                                  }));
                                  if (nextQuantity === 0) {
                                    setSelectedPlanningIds((current) => ({
                                      ...current,
                                      [id]: false,
                                    }));
                                  }
                                }}
                                aria-label={`จำนวนจ่าย ${text(row.material_id)} เขต ${text(row.district_id)}`}
                              />
                            </td>
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
                    {searchMode === "material"
                      ? "เลือกหรือพิมพ์พัสดุเพื่อดูครบทั้ง 18 เขต"
                      : "เขตนี้ยังไม่มีพัสดุที่เข้าเกณฑ์เติม"}
                  </h3>
                  <p>Planner สามารถสลับวิธีค้นหาได้โดยข้อมูลในแผนไม่หาย</p>
                </article>
              )}
              </>
              )}
            </article>

            <aside className="panel planner-evidence">
              <div className="panel-title">
                <div>
                  <span>AI + FIFO EVIDENCE</span>
                  <h3>
                    {focusedRow
                      ? `${text(focusedRow.material_id)} · ${text(
                          focusedRow.district_id,
                        )} : ${text(focusedRow.district_name_th)}`
                      : "เลือกรายการเพื่อดูหลักฐาน"}
                  </h3>
                </div>
                {focusedRow && (
                  <Badge>{text(focusedRow.priority_band)}</Badge>
                )}
              </div>
              {focusedRow ? (
                <div className="evidence-body">
                  <div className="suggestion-card">
                    <span>
                      ✦ แนะนำจากการใช้จริง
                      {focusedRow.ai_rule != null &&
                        ` · ${RULE_LABELS[text(focusedRow.ai_rule)] ?? text(focusedRow.ai_rule)}`}
                    </span>
                    <strong>{formatNumber(recommendedQty(focusedRow), 0)}</strong>
                    <small>
                      {text(
                        focusedRow.ai_reason,
                        text(focusedRecommendation?.method, "ยังไม่มีข้อมูลการใช้ — ใช้สูตรเติมถึง MAX"),
                      )}
                      {focusedRow.ai_rule != null &&
                        ` · สูตรเดิม (MAX) ${formatNumber(focusedRow.suggested_qty, 0)}`}
                    </small>
                    {Array.isArray(focusedRow.ai_usage) && (
                      <div className="suggestion-usage">
                        <UsageBars
                          values={(focusedRow.ai_usage as unknown[]).map(Number)}
                          labels={(focusedRow.ai_usage_labels as unknown[] | undefined ?? []).map(String)}
                        />
                      </div>
                    )}
                    <Badge>
                      {text(
                        focusedRecommendation?.source_freshness_status,
                        "evidence_pending",
                      )}
                    </Badge>
                  </div>
                  <dl className="evidence-metrics">
                    <div>
                      <dt>Stock คลังคลองเตย</dt>
                      <dd>{formatNumber(warehouseQuantity(focusedRow), 0)}</dd>
                    </div>
                    <div>
                      <dt>Stock เขต</dt>
                      <dd>{formatNumber(focusedRow.current_stock_qty, 0)}</dd>
                    </div>
                    <div>
                      <dt>CMP / เดือน</dt>
                      <dd>{formatNumber(focusedRow.cmp_monthly, 0)}</dd>
                    </div>
                    <div>
                      <dt>เดือนที่เหลือ</dt>
                      <dd>{formatNumber(focusedRow.months_available, 1)}M</dd>
                    </div>
                    <div>
                      <dt>MIN Fill · 4M</dt>
                      <dd>{formatNumber(focusedRow.min_fill_qty, 0)}</dd>
                    </div>
                    <div>
                      <dt>MAX Fill · 6M</dt>
                      <dd>{formatNumber(focusedRow.max_fill_qty, 0)}</dd>
                    </div>
                    <div>
                      <dt>Planner Qty</dt>
                      <dd>{formatNumber(plannerQuantity(focusedRow), 0)}</dd>
                    </div>
                  </dl>
                  <div className="evidence-policy">
                    <strong>หลักฐานการคำนวณ</strong>
                    <p>
                      CMP: {text(focusedEvidence.cmp_formula, "รอหลักฐาน")} ·
                      Trigger ≤ {text(focusedEvidence.trigger_months, "3.5")}M ·
                      Target {text(focusedEvidence.min_months, "4")}–{text(
                        focusedEvidence.max_months,
                        "6",
                      )}M
                    </p>
                  </div>
                  <div className="fifo-preview">
                    <header>
                      <div>
                        <span>FIFO + PACKING PICK PLAN</span>
                        <strong>
                          สัญญาทั้งหมดเรียงเก่า → ใหม่ พร้อม Full Pallet / Box /
                          Crate / หน่วยย่อย
                        </strong>
                      </div>
                      <b>
                        หยิบรวม {formatNumber(plannerQuantity(focusedRow), 0)} EA
                      </b>
                    </header>
                    {fifoPreview.length ? (
                      <div className="fifo-preview-list">
                        {fifoPreview.map((row) => {
                          const plannedPick = Number(
                            row.preview_allocated_qty ?? 0,
                          );
                          return (
                          <article
                            className={plannedPick > 0 ? "planned-pick" : ""}
                            key={`${text(row.handling_unit_id ?? row.lot_code, "")}-${text(row.material_id)}-${text(row.fifo_sequence)}`}
                          >
                            <div>
                              <strong>
                                #{text(row.fifo_sequence)} ·{" "}
                                {text(row.handling_unit_code)}
                              </strong>
                              <small>
                                รับ {text(row.acceptance_date)} · งวด{" "}
                                {text(row.installment_no)}
                              </small>
                            </div>
                            <div>
                              <span>
                                PO {text(row.purchase_order)} · สัญญา{" "}
                                {text(row.contract_number)} · {text(row.vendor_name)}
                              </span>
                              <b className="pick-mark">
                                {plannedPick > 0
                                  ? `✓ ${packingText(row, plannedPick)}`
                                  : "— ไม่หยิบ"}
                              </b>
                              <small>
                                พร้อมหยิบ {packingText(
                                  row,
                                  Number(row.allocatable_qty ?? 0),
                                )} · Remain{" "}
                                {formatNumber(
                                  Number(row.allocatable_qty ?? 0) -
                                    Number(row.preview_allocated_qty ?? 0),
                                  0,
                                )} {unitOf(row)}
                              </small>
                              {plannedPick > 0 && !isContractLot(row) &&
                                plannedPick < Number(row.allocatable_qty ?? 0) && (
                                  <small className="packing-opened">
                                    เปิด {packagingLabel(row)} แล้ว ต้องเก็บ Remain
                                    ใน HU เดิม
                                  </small>
                                )}
                            </div>
                          </article>
                        )})}
                      </div>
                    ) : (
                      <div className="evidence-empty">
                        <strong>ยังไม่มีหลักฐาน FIFO ที่พร้อมจ่าย</strong>
                        <p>
                          ระบบไม่เลือกสัญญา ผู้ขาย หรือพาเลทจำลองแทนข้อมูลจริง
                        </p>
                      </div>
                    )}
                    {fifoRemaining > 0 && (
                      <div className="fifo-shortage">
                        หลักฐาน FIFO ขาด {formatNumber(fifoRemaining, 0)} หน่วย
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="evidence-empty">
                  <strong>ยังไม่ได้เลือกรายการ</strong>
                  <p>กด “ดู AI + FIFO” จากรายการทางซ้าย</p>
                </div>
              )}
            </aside>
          </section>
          <div className="planner-next">
            <div>
              <strong>{formatNumber(selectedRows.length)} รายการที่เลือก</strong>
              <small>
                ตรวจ Planner Qty และ Packing/FIFO ก่อนยืนยันเป็น Draft Plan
              </small>
            </div>
            <button
              type="button"
              className="btn primary"
              disabled={!selectedRows.length}
              onClick={() => setWorkflowStep(2)}
            >
              {mode === "calculate"
                ? `คำนวณเสร็จ · ไปหน้าสรุปการจ่าย (${formatNumber(selectedRows.length)}) →`
                : `ยืนยันรายการที่เลือกเข้า Draft Plan (${formatNumber(selectedRows.length)}) →`}
            </button>
          </div>
        </>
      )}

      {workflowStep === 2 && mode === "summary" && !selectedRows.length && (
        <article className="workspace-empty">
          <i>—</i>
          <h3>ยังไม่มีรายการที่คำนวณเข้าแผน</h3>
          <p>
            ไปที่หน้า “คำนวณการจ่าย” กรอก Planner Qty และเลือกรายการเข้าแผนก่อน
            แล้วระบบจะสรุปการจ่ายให้ที่หน้านี้
          </p>
          <button
            type="button"
            className="btn primary"
            onClick={onOpenCalculate}
          >
            ไปหน้าคำนวณการจ่าย
          </button>
        </article>
      )}

      {workflowStep === 2 && (mode !== "summary" || selectedRows.length > 0) && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>DRAFT PLAN CONFIRMATION</span>
              <h3>รายการที่ Planner เลือกแล้ว — ตรวจจำนวนและแผนหยิบก่อนส่งเขต</h3>
            </div>
            <b>{formatNumber(districtSummary.length)} เขต</b>
          </div>
          <section className="plan-summary-kpis">
            {[
              ["รายการจ่าย", planTotals.lines, "รายการ"],
              ["การไฟฟ้าเขต", planTotals.districts, "เขต"],
              ["พัสดุ", planTotals.materials, "รหัส"],
              ["Planner Qty รวม", planTotals.quantity, "หน่วย"],
            ].map(([label, value, unit]) => (
              <article key={String(label)}>
                <span>{label}</span>
                <strong>{formatNumber(value, 0)}</strong>
                <small>{unit}</small>
              </article>
            ))}
          </section>
          <LiveTable
            rows={districtSummary}
            empty="ยังไม่ได้เลือกรายการ"
            columns={[
              [
                "เขต",
                (row) => (
                  <span>
                    <strong>{text(row.district)}</strong>
                    <small>{text(row.name)}</small>
                  </span>
                ),
              ],
              ["จำนวนรายการ", (row) => formatNumber(row.items)],
              ["จำนวนจ่ายรวม", (row) => formatNumber(row.quantity, 0)],
              [
                "ตรวจรายการ",
                (row) => (
                  <button
                    type="button"
                    className="table-action"
                    onClick={() => {
                      setSearchMode("district");
                      setQuery(text(row.district));
                      setWorkflowStep(0);
                    }}
                  >
                    เปิดรายการเขต
                  </button>
                ),
              ],
            ]}
          />
          {overWarehouseMaterials.length > 0 && (
            <div className="kt-over-box" role="alert">
              <strong>
                รวมทุกเขตเกิน Stock คลังคลองเตย {formatNumber(overWarehouseMaterials.length)} รายการ
              </strong>
              <span>
                {overWarehouseMaterials
                  .slice(0, 8)
                  .map(
                    (row) =>
                      `${text(row.material_id)} (ต้องการ ${formatNumber(
                        plannedTotalByMaterial.get(text(row.material_id)) ?? 0,
                        0,
                      )} · มี ${formatNumber(warehouseQuantity(row), 0)})`,
                  )
                  .join(" · ")}
                {overWarehouseMaterials.length > 8 ? " …" : ""} — ปรับ Planner Qty ให้ไม่เกินของที่มี
                ส่วนที่เกินจะขึ้นเป็น “ขาด” ตอนล็อกแผน
              </span>
            </div>
          )}
          <div className="plan-line-summary">
            <strong>รายการทั้งหมดในแผน</strong>
            <LiveTable
              rows={selectedRows}
              empty="ยังไม่มีรายการในแผน"
              columns={[
                [
                  "การไฟฟ้าเขต",
                  (row) => `${text(row.district_id)} : ${text(row.district_name_th)}`,
                ],
                [
                  "พัสดุ",
                  (row) => (
                    <span>
                      <strong>{text(row.material_id)}</strong>
                      <small>{text(row.material_name)}</small>
                    </span>
                  ),
                ],
                [
                  "Stock คลังกลาง",
                  (row) => (
                    <span>
                      {formatNumber(warehouseQuantity(row), 0)}
                      {overWarehouse(row) && (
                        <small className="shortage-text">
                          รวมทุกเขต{" "}
                          {formatNumber(plannedTotalByMaterial.get(text(row.material_id)) ?? 0, 0)}{" "}
                          เกิน Stock
                        </small>
                      )}
                    </span>
                  ),
                ],
                ["Stock เขต", (row) => formatNumber(row.current_stock_qty, 0)],
                ["MIN", (row) => formatNumber(row.min_fill_qty, 0)],
                ["MAX", (row) => formatNumber(row.max_fill_qty, 0)],
                ["✦ แนะนำ", (row) => formatNumber(recommendedQty(row), 0)],
                ["Planner Qty", (row) => formatNumber(plannerQuantity(row), 0)],
                [
                  "สถานะ",
                  (row) => (
                    <span
                      className={`stock-state ${
                        Number(row.cmp_monthly ?? 0) > 0 &&
                        Number(row.months_available ?? 0) <= 3.5
                          ? "needs-fill"
                          : "no-fill"
                      }`}
                    >
                      {Number(row.cmp_monthly ?? 0) > 0 &&
                      Number(row.months_available ?? 0) <= 3.5
                        ? "ต้องเติม"
                        : "ไม่ต้องเติม"}
                    </span>
                  ),
                ],
                [
                  "แผนหยิบ FIFO + Packing",
                  (row) => (
                    <span>
                      <strong>{fifoPlanFor(row).detail}</strong>
                      {fifoPlanFor(row).shortage > 0 && (
                        <small className="shortage-text">
                          ขาด {formatNumber(fifoPlanFor(row).shortage, 0)} หน่วย
                        </small>
                      )}
                    </span>
                  ),
                ],
              ]}
            />
          </div>
          <div className="pipeline-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => setWorkflowStep(0)}
            >
              {mode === "summary" ? "← กลับไปหน้าคำนวณการจ่าย" : "← กลับไปแก้รายการ"}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={
                !selectedRows.length ||
                (Boolean(onSubmitSelection) && canCreate && !targetPlanId)
              }
              title={
                onSubmitSelection && canCreate && !targetPlanId
                  ? "ยังไม่มีรอบแผนของสัปดาห์นี้ในระบบ — กด “เริ่มรอบแผนจากข้อมูลล่าสุด” ก่อน"
                  : undefined
              }
              onClick={() =>
                onSubmitSelection && canCreate
                  ? setSubmitOpen(true)
                  : setWorkflowStep(3)
              }
            >
              ตรวจและส่งแผนให้เขตยืนยัน →
            </button>
          </div>
        </section>
      )}

      {workflowStep === 3 && canCreate && (
        <DistrictConfirmationBoard
          rows={data.replenishment}
          districts={districtOptions}
          role={role}
          canRespond={canRespond}
          actionBusy={actionBusy}
          onRespond={openResponse}
          onConfirmPending={onConfirmPending}
          onReviewChanges={() => setWorkflowStep(4)}
          onApprove={() => setWorkflowStep(5)}
          onOpenTransport={onOpenTransport}
          onOpenCalculate={() => setWorkflowStep(0)}
        />
      )}

      {workflowStep === 3 && !canCreate && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>DISTRICT LINE CONFIRMATION</span>
              <h3>เขตยืนยันเป็นรายรายการ ไม่ยืนยันรวมทั้งแผน</h3>
            </div>
            <b>{formatNumber(selectedRows.length)} รายการ</b>
          </div>
          <LiveTable
            rows={selectedRows}
            empty="ยังไม่มีรายการส่งให้เขต"
            columns={[
              ["เขต", (row) => row.district_id],
              [
                "พัสดุ",
                (row) => (
                  <span>
                    <strong>{text(row.material_id)}</strong>
                    <small>{text(row.material_name)}</small>
                  </span>
                ),
              ],
              ["Planner Qty", (row) => formatNumber(plannerQuantity(row), 0)],
              ["เขตขอ", (row) => formatNumber(row.requested_qty, 0)],
              ["หลังจ่าย", (row) => `${formatNumber(row.projected_months_after, 1)}M`],
              ["ผลตอบ", (row) => <Badge>{text(row.item_status)}</Badge>],
              ["ผู้ขอ", (row) => row.requester_name],
              [
                "ยืนยันรายการ",
                (row) => (
                  <button
                    type="button"
                    className="table-action"
                    disabled={
                      !canRespond ||
                      !["draft", "pending", "change_requested"].includes(
                        text(row.item_status),
                      )
                    }
                    onClick={() => openResponse(row)}
                  >
                    Confirm / Change / Reject
                  </button>
                ),
              ],
            ]}
          />
        </section>
      )}

      {workflowStep === 4 && (
        <ChangeReviewView
          actionBusy={actionBusy}
          data={data}
          role={role}
          onReview={onReview}
        />
      )}

      {workflowStep === 5 && (
        <>
          <section className="panel">
            <div className="panel-title">
              <div>
                <span>SEQUENTIAL APPROVAL</span>
                <h3>Planner อนุมัติ → วิชาการอนุมัติ → Lock + Reserve FIFO</h3>
              </div>
            </div>
            <LiveTable
              rows={plans}
              empty="ยังไม่มีแผน"
              columns={[
                ["แผน", (row) => `${text(row.plan_number)}-V${text(row.version_no)}`],
                ["สัปดาห์", (row) => row.week_start_date],
                ["สถานะ", (row) => <Badge>{text(row.plan_status)}</Badge>],
                ["Planner", (row) => formatDateTime(row.planner_approved_at)],
                ["วิชาการ / Lock", (row) => formatDateTime(row.locked_at)],
                [
                  "การดำเนินการ",
                  (row) => {
                    const status = text(row.plan_status);
                    const canApprove =
                      (status === "pending_planner_approval" &&
                        ["admin", "planner"].includes(role)) ||
                      (status === "pending_academic_approval" &&
                        ["admin", "academic"].includes(role));
                    const canIssue =
                      status === "locked" && ["admin", "picker"].includes(role);
                    return (
                      <span className="table-actions">
                        {canApprove && (
                          <button
                            className="table-action"
                            onClick={() => setPlanAction({ type: "approve", row })}
                          >
                            {status === "pending_academic_approval"
                              ? "วิชาการอนุมัติและ Lock"
                              : "Planner อนุมัติ"}
                          </button>
                        )}
                        {canIssue && (
                          <button
                            className="table-action"
                            disabled={actionBusy}
                            onClick={() =>
                              void onIssue(text(row.replenishment_plan_id))
                            }
                          >
                            จ่ายตาม FIFO
                          </button>
                        )}
                        {["admin", "planner"].includes(role) &&
                          !["completed", "cancelled"].includes(status) && (
                            <button
                              className="table-action"
                              onClick={() =>
                                setPlanAction({ type: "cancel", row })
                              }
                            >
                              ยกเลิก
                            </button>
                          )}
                        {["admin", "planner"].includes(role) &&
                          status === "locked" && (
                            <button
                              className="table-action"
                              onClick={() =>
                                setPlanAction({ type: "version", row })
                              }
                            >
                              ออกเวอร์ชันใหม่
                            </button>
                          )}
                      </span>
                    );
                  },
                ],
              ]}
            />
          </section>
          <section className="panel">
            <div className="panel-title">
              <div>
                <span>AUDIT TRAIL</span>
                <h3>ประวัติการยืนยันและอนุมัติ</h3>
              </div>
            </div>
            <LiveTable
              rows={data.approvals.slice(0, 20)}
              empty="ยังไม่มีประวัติการอนุมัติ"
              columns={[
                ["เวลา", (row) => formatDateTime(row.acted_at)],
                ["ขั้นตอน", (row) => <Badge>{text(row.approval_stage)}</Badge>],
                ["ผล", (row) => row.decision],
                ["บทบาท", (row) => row.actor_role],
                ["เขต", (row) => row.district_id],
                ["หมายเหตุ", (row) => row.note],
              ]}
            />
          </section>
        </>
      )}

      {submitOpen && onSubmitSelection && (
        <PlanSubmitModal
          planLabel={`${text(targetPlan?.plan_number ?? targetPlan?.plan_code)}-V${text(targetPlan?.version_no, "1")}`}
          weekLabel={`สัปดาห์ ${text(targetPlan?.week_start_date)}`}
          payload={selectionPayload}
          unconfirmedDistricts={unconfirmedSendDistricts}
          busy={actionBusy}
          error={actionError}
          onClose={() => setSubmitOpen(false)}
          onSubmit={async () => {
            const ok = await onSubmitSelection(targetPlanId, selectionPayload);
            if (!ok) return;
            setSubmitOpen(false);
            setDraft(emptyPlannerDraft);
            setWorkflowStepState(3);
          }}
        />
      )}

      {responseRow && (
        <div className="import-review-backdrop" role="dialog" aria-modal="true">
        <form className="pipeline-form dc-response" onSubmit={submitResponse}>
          <div className="panel-title">
            <div>
              <span>การตอบกลับของเขต</span>
              <h3>
                {text(responseRow.material_id)} · District{" "}
                {text(responseRow.district_id)}
              </h3>
            </div>
            <button
              className="btn ghost"
              type="button"
              onClick={() => setResponseRow(null)}
            >
              ปิด
            </button>
          </div>
          <div className="form-grid">
            <label>
              การตัดสินใจ
              <select
                value={decision}
                onChange={(event) =>
                  setDecision(
                    event.target.value as ReplenishmentResponsePayload["decision"],
                  )
                }
              >
                <option value="confirm">Confirm</option>
                <option value="change">Change quantity</option>
                <option value="reject">Reject</option>
              </select>
            </label>
            <label>
              จำนวน
              <input
                type="number"
                min="0"
                step="any"
                value={decision === "reject" ? "0" : quantity}
                disabled={decision === "reject"}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </label>
            <label>
              ชื่อผู้ขอ
              <input
                value={requester}
                onChange={(event) => setRequester(event.target.value)}
                maxLength={200}
                required
              />
            </label>
            <label className="wide">
              เหตุผล / หลักฐาน
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                required
              />
            </label>
          </div>
          <div className="pipeline-actions">
            <button className="btn primary" disabled={actionBusy}>
              บันทึกการตอบกลับของเขต
            </button>
          </div>
        </form>
        </div>
      )}

      {planAction && (
        <form className="pipeline-form compact" onSubmit={submitPlanAction}>
          <div className="panel-title">
            <div>
              <span>การจัดการแผน</span>
              <h3>
                {planAction.type.toUpperCase()} ·{" "}
                {text(planAction.row.plan_number)}
              </h3>
            </div>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setPlanAction(null)}
            >
              ปิด
            </button>
          </div>
          <label>
            หมายเหตุ / เหตุผล
            <textarea
              value={planNote}
              onChange={(event) => setPlanNote(event.target.value)}
              required={
                planAction.type !== "approve" ||
                text(planAction.row.plan_status) ===
                  "pending_academic_approval" ||
                bool(planAction.row.special_approval_required)
              }
              placeholder={
                planAction.type === "approve"
                  ? "หากมีรายการเกิน 9 เดือน วิชาการต้องระบุหมายเหตุ"
                  : "จำเป็นสำหรับการยกเลิก/ออกเวอร์ชันใหม่"
              }
            />
          </label>
          <div className="pipeline-actions">
            <button className="btn primary" disabled={actionBusy}>
              ยืนยัน {planAction.type}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function ChangeReviewView({
  actionBusy,
  data,
  role,
  onReview,
}: {
  actionBusy: boolean;
  data: DashboardData;
  role: Role;
  onReview: (
    requestId: string,
    decision: "approved" | "rejected",
    note: string,
  ) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [note, setNote] = useState("");
  const canReview = role === "admin" || role === "planner";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || note.trim().length < 3) return;
    const ok = await onReview(
      text(selected.change_request_id),
      decision,
      note.trim(),
    );
    if (ok) setSelected(null);
  };
  return (
    <div className="stack">
      <section className="plain-notice warning">
        <i>!</i>
        <div>
          <strong>คำขอที่คงคลังเกิน 6 เดือน ต้องผ่านการตรวจ</strong>
          <p>
            คงคลังเกิน 9 เดือน ต้องขออนุมัติพิเศษ และการอนุมัติของวิชาการ
            ต้องแนบหมายเหตุหลักฐาน
          </p>
        </div>
      </section>
      <section className="panel">
        <LiveTable
          rows={data.changeRequests}
          empty="ไม่มีคำขอเปลี่ยนแปลงจากเขต"
          columns={[
            ["แผน", (row) => row.plan_number],
            ["วัสดุ", (row) => row.material_id],
            ["เขต", (row) => row.district_id],
            ["ฐาน", (row) => formatNumber(row.baseline_qty, 2)],
            ["ขอเบิก", (row) => formatNumber(row.requested_qty, 2)],
            ["คงคลังหลังจ่าย", (row) => `${formatNumber(row.projected_months_after, 1)}M`],
            ["ความเสี่ยง", (row) => <Badge>{text(row.risk_level)}</Badge>],
            ["ผู้ขอ", (row) => row.requester_name],
            ["สถานะ", (row) => <Badge>{text(row.status)}</Badge>],
            [
              "ตรวจ",
              (row) => (
                <button
                  className="table-action"
                  disabled={!canReview || row.status !== "pending_review"}
                  onClick={() => {
                    setSelected(row);
                    setNote("");
                  }}
                >
                  ตรวจหลักฐาน
                </button>
              ),
            ],
          ]}
        />
      </section>
      {selected && (
        <form className="pipeline-form compact" onSubmit={submit}>
          <div className="form-grid">
            <label>
              การตัดสินใจ
              <select
                value={decision}
                onChange={(event) =>
                  setDecision(event.target.value as "approved" | "rejected")
                }
              >
                <option value="approved">Approve change</option>
                <option value="rejected">Reject and use baseline</option>
              </select>
            </label>
            <label className="wide">
              หมายเหตุการตรวจ
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                required
              />
            </label>
          </div>
          <div className="pipeline-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => setSelected(null)}
            >
              ยกเลิก
            </button>
            <button className="btn primary" disabled={actionBusy}>
              บันทึกผล Review
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
