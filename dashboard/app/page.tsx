"use client";

import {
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { apiRequest, formatDateTime, formatNumber, type Role } from "./lib";
import {
  parseVmiHistory,
  snapshotIso,
  toLocalDateTimeInput,
} from "./pipeline-validation";
import {
  useSynapseBackend,
  type AdHocIssuePayload,
  type DashboardData,
  type ReceiptPayload,
  type RecordRow,
  type ReplenishmentResponsePayload,
  type VmiContext,
  type VmiInputPayload,
} from "./use-synapse-backend";
import FifoPackagingSetupView from "./fifo-packaging-setup";
import SourceImportCenter from "./import-center";
import { ImportPromotionPanel } from "./import-promotion";
import {
  DistrictPlanner,
  DistrictProgress,
  type DistrictStats,
  type DistrictTab,
} from "./district-planner";
import { DistrictConfirmationBoard } from "./district-confirmation";
import { PlanSubmitModal, type PlannerSelectionPayload } from "./plan-submit";
import { PageHero } from "./page-hero";
import { PackingEntryView } from "./packing-entry";
import { ContractLotsView } from "./contract-lots";
import { DistrictUsageView } from "./district-usage";
import { RULE_LABELS, UsageBars, recommendedQty } from "./usage-bars";
import { LegacyHistoryImportView } from "./legacy-history-import";
import { OperationHistoryView } from "./operation-history";
import { demoHistoryPayload } from "./history-demo";
import { UserManagementView } from "./user-management";
import { AccessRequestForm } from "./access-request-form";
import { CheckSummary, RequestAlertsView, type RequestCheck } from "./request-alerts";
import { DeliveryCalendarView, MODE_LABEL, URGENCY_LABEL } from "./delivery-calendar";
import { DispatchBoardView } from "./dispatch-board";

type SlotPreview = {
  mode: string;
  delivery_date: string | null;
  cutoff_at: string | null;
  zone: string | null;
  zone_name?: string;
  vehicle?: string | null;
  message: string;
};
import { demoUsersPayload } from "./users-demo";
import { DEMO_MODE } from "./demo-data";
import {
  TransportModule,
  transportNavForRole,
  transportTitleFor,
  type TransportView,
} from "./transport";

type ViewKey =
  | "dashboard"
  | "weekly"
  | "summary"
  | "recommendations"
  | "advisory"
  | "changes"
  | "approvals"
  | "fifo"
  | "receiving"
  | "adhoc"
  | "trace"
  | "stock"
  | "data"
  | "import"
  | "fifo_setup"
  | "packing"
  | "lots"
  | "usage"
  | "legacy_history"
  | "history"
  | "users"
  | "delivery"
  | "alerts"
  | "input"
  | "operations"
  | "release";

type PageState = {
  moduleKey: "warehouse" | "transport";
  view: ViewKey;
  transportView: TransportView;
};

function pageLabel(state: PageState, role: Role) {
  if (state.moduleKey === "transport") return `ระบบขนส่ง · ${transportTitleFor(state.transportView)[1]}`;
  if (state.view === "dashboard") return "แดชบอร์ด";
  return (
    navByRole[role].flatMap((group) => group.items).find(([key]) => key === state.view)?.[1] ??
    titles[state.view]?.[1] ??
    ""
  );
}

type PlannerDraft = {
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

const emptyPlannerDraft: PlannerDraft = {
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
const SUMMARY_PLAN_STATUSES = new Set([
  "pending_district_confirmation",
  "district_review",
  "pending_review",
  "pending_approval",
  "pending_planner_approval",
  "pending_academic_approval",
  "locked",
]);

function hasPlannerSelection(draft: PlannerDraft) {
  return Object.values(draft.selectedIds).some(Boolean);
}

type NavGroup = {
  label: string;
  items: Array<[ViewKey, string, string]>;
};

const navByRole: Record<Role, NavGroup[]> = {
  admin: [
    {
      label: "IMPORT CENTER",
      items: [
        ["import", "Import Data", "⇧"],
        ["legacy_history", "ประวัติจากระบบเดิม", "⇣"],
        ["data", "ข้อมูล SAP / คุณภาพ", "▥"],
        ["packing", "ข้อมูล Packing", "▧"],
        ["fifo_setup", "FIFO / Packaging Setup", "▣"],
      ],
    },
    {
      label: "เมนูหลัก",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "คำนวณการจ่าย", "▤"],
        ["summary", "สรุปการจ่าย", "☰"],
        ["usage", "การใช้งานรายเขต", "▥"],
        ["changes", "ตรวจคำขอผิดปกติ", "!"],
        ["alerts", "แจ้งเตือนเบิกผิดปกติ", "⚠"],
        ["history", "ประวัติการดำเนินงาน", "☷"],
        ["approvals", "ประวัติแผนการจ่าย", "✓"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
      ],
    },
    {
      label: "คลังสินค้า",
      items: [
        ["lots", "ของเข้าคลังตามสัญญา", "▧"],
        ["delivery", "ปฏิทินส่งของ", "▣"],
        ["fifo", "FIFO & พาเลท", "▦"],
        ["receiving", "รับพัสดุเข้าคลัง", "＋"],
        ["adhoc", "จ่ายกรณีพิเศษ", "↗"],
      ],
    },
    {
      label: "ข้อมูล & ควบคุม",
      items: [
        ["stock", "ข้อมูล Stock", "◫"],
        ["input", "อัปเดต Stock", "↻"],
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["advisory", "เฝ้าระวังของค้าง", "◈"],
      ],
    },
    {
      label: "ผู้ดูแลระบบ",
      items: [
        ["users", "จัดการผู้ใช้งาน", "⚇"],
        ["operations", "ศูนย์ควบคุม", "⚙"],
        ["release", "ขอบเขตรุ่น", "◉"],
      ],
    },
  ],
  planner: [
    {
      label: "วางแผน",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "คำนวณการจ่าย", "▤"],
        ["summary", "สรุปการจ่าย", "☰"],
        ["usage", "การใช้งานรายเขต", "▥"],
        ["lots", "ของเข้าคลังตามสัญญา", "▧"],
        ["changes", "ตรวจคำขอผิดปกติ", "!"],
        ["alerts", "แจ้งเตือนเบิกผิดปกติ", "⚠"],
        ["history", "ประวัติการดำเนินงาน", "☷"],
        ["approvals", "ประวัติแผนการจ่าย", "✓"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["advisory", "เฝ้าระวังของค้าง", "◈"],
      ],
    },
    {
      label: "คลังสินค้า",
      items: [
        ["delivery", "ปฏิทินส่งของ", "▣"],
        ["fifo", "FIFO & พาเลท", "▦"],
        ["adhoc", "จ่ายกรณีพิเศษ", "↗"],
        ["packing", "ข้อมูล Packing", "▧"],
        ["stock", "ข้อมูล Stock", "◫"],
        ["input", "อัปเดต Stock", "↻"],
      ],
    },
  ],
  academic: [
    {
      label: "ตรวจวิชาการ",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "อนุมัติวิชาการ", "✓"],
        ["changes", "หลักฐานคำขอผิดปกติ", "!"],
        ["alerts", "แจ้งเตือนเบิกผิดปกติ", "⚠"],
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["usage", "การใช้งานรายเขต", "▥"],
        ["approvals", "ประวัติการอนุมัติ", "◷"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
        ["history", "ประวัติการดำเนินงาน", "☷"],
      ],
    },
    {
      label: "หลักฐานสต็อก",
      items: [
        ["fifo", "FIFO & พาเลท", "▦"],
        ["stock", "ข้อมูล Stock", "◫"],
      ],
    },
  ],
  picker: [
    {
      label: "งานคลัง",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "แผนที่ล็อกแล้ว", "▤"],
        ["delivery", "ปฏิทินส่งของ", "▣"],
        ["fifo", "FIFO & พาเลท", "▦"],
        ["receiving", "รับพัสดุเข้าคลัง", "＋"],
        ["lots", "ของเข้าคลังตามสัญญา", "▧"],
        ["packing", "ข้อมูล Packing", "▧"],
        ["adhoc", "จ่ายกรณีพิเศษ", "↗"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
        ["history", "ประวัติการดำเนินงาน", "☷"],
      ],
    },
  ],
  district: [
    {
      label: "เขต",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "ยืนยันรายการพัสดุ", "✓"],
        ["changes", "คำขอเปลี่ยนของฉัน", "!"],
        ["adhoc", "ขอจ่ายกรณีพิเศษ", "↗"],
        ["delivery", "วันส่งของประจำเขต", "▣"],
        ["stock", "Stock เขต", "◫"],
        ["usage", "การใช้งานของเขต", "▥"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
        ["history", "ประวัติการดำเนินงาน", "☷"],
      ],
    },
  ],
  viewer: [
    {
      label: "อ่านอย่างเดียว",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "แผนการจ่าย", "▤"],
        ["usage", "การใช้งานรายเขต", "▥"],
        ["lots", "ของเข้าคลังตามสัญญา", "▧"],
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["fifo", "FIFO & พาเลท", "▦"],
        ["stock", "ข้อมูล Stock", "◫"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
        ["history", "ประวัติการดำเนินงาน", "☷"],
      ],
    },
  ],
};

// Related pages share one menu entry and are switched with tabs on the page.
// The first key is the one shown in the menu; the others become tabs.
const VIEW_GROUPS: Array<{ keys: ViewKey[]; navLabel?: string }> = [
  { keys: ["weekly", "summary"] },
  { keys: ["history", "approvals", "trace"] },
  { keys: ["changes", "alerts"] },
  { keys: ["import", "legacy_history", "data"], navLabel: "นำเข้าข้อมูล" },
  { keys: ["packing", "fifo_setup"] },
  { keys: ["stock", "input"], navLabel: "Stock (ดู / อัปเดต)" },
  { keys: ["recommendations", "advisory"], navLabel: "หลักฐาน & เฝ้าระวัง" },
  { keys: ["operations", "release"] },
];

function viewGroup(view: ViewKey, allowed: Set<ViewKey>) {
  const group = VIEW_GROUPS.find((item) => item.keys.includes(view));
  if (!group) return null;
  const keys = group.keys.filter((key) => allowed.has(key));
  return keys.length > 1 ? { ...group, keys } : null;
}

function ViewTabs({
  view,
  role,
  hiddenViews,
  navigate,
}: {
  view: ViewKey;
  role: Role;
  hiddenViews: Set<ViewKey>;
  navigate: (view: ViewKey) => void;
}) {
  const items = navByRole[role].flatMap((group) => group.items);
  const allowed = new Set(items.map(([key]) => key).filter((key) => !hiddenViews.has(key)));
  const group = viewGroup(view, allowed);
  if (!group) return null;
  return (
    <div className="view-tabs" role="tablist">
      {group.keys.map((key) => {
        const item = items.find(([itemKey]) => itemKey === key);
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={view === key ? "active" : ""}
            onClick={() => navigate(key)}
          >
            <i aria-hidden="true">{item?.[2]}</i>
            {item?.[1] ?? key}
          </button>
        );
      })}
    </div>
  );
}

const titles: Record<ViewKey, [string, string, string]> = {
  dashboard: [
    "ภาพรวม",
    "ภาพรวมงานคลังพัสดุ",
    "สถานะงานตามสิทธิ์ของคุณ อัปเดตแบบเรียลไทม์",
  ],
  weekly: [
    "แผนการจ่าย",
    "แผนการจ่ายรายสัปดาห์",
    "ขั้นตอน: เขต → ผู้วางแผน → วิชาการ → ล็อก → จ่ายแบบ FIFO",
  ],
  summary: [
    "สรุปการจ่าย",
    "สรุปแผนการจ่ายรายสัปดาห์",
    "ขั้นตอน: ตรวจรายการที่คำนวณ → เขตยืนยัน → ผู้วางแผน → วิชาการ → ล็อก FIFO",
  ],
  recommendations: [
    "หลักฐานปริมาณ",
    "หลักฐานการคำนวณปริมาณ",
    "คำนวณจากข้อมูลจริงตามเกณฑ์ ไม่มีการสร้างตัวเลขเองหรืออนุมัติอัตโนมัติ",
  ],
  advisory: [
    "การเฝ้าระวัง",
    "เฝ้าระวังของค้าง / ของเคลื่อนไหวช้า",
    "สัญญาณความเสี่ยงจากข้อมูลจริง เป็นข้อมูลประกอบการตัดสินใจเท่านั้น",
  ],
  changes: [
    "ตรวจคำขอ",
    "ตรวจคำขอที่ผิดปกติ",
    "ตรวจการเปลี่ยนจำนวน และเดือนคงคลังที่เกิน 6 เดือน / 9 เดือน",
  ],
  approvals: [
    "ประวัติ",
    "ไทม์ไลน์การอนุมัติ",
    "บันทึกทุกขั้นตอน: เขต ผู้วางแผน วิชาการ ล็อก ยกเลิก และการออกเวอร์ชันใหม่",
  ],
  fifo: [
    "งานคลัง",
    "FIFO พาเลท และจำนวนคงเหลือ",
    "จ่ายหน่วยที่เปิดก่อน แล้วเรียงตามวันรับ ใบสั่งซื้อ และรายการ",
  ],
  receiving: [
    "รับพัสดุ",
    "รับพัสดุเข้าคลัง",
    "ผูกทุกล็อตและหน่วยจัดเก็บเข้ากับสัญญาและหลักฐานการรับพัสดุ",
  ],
  adhoc: [
    "จ่ายกรณีพิเศษ",
    "การจ่ายกรณีพิเศษ",
    "แยกการอนุมัติออกจากการจ่ายจริง และไม่กระทบแผนการจ่ายรายสัปดาห์",
  ],
  trace: [
    "สอบกลับ",
    "สอบกลับการจ่าย",
    "ค้นย้อนกลับจากการจ่ายไปถึงพาเลท ล็อต สัญญา และผู้ขาย",
  ],
  stock: [
    "ข้อมูลสต็อก",
    "สุขภาพสต็อก",
    "นับเฉพาะของพร้อมใช้ หากไม่มีข้อมูลจะแสดงเป็น 0 พร้อมหมายเหตุ",
  ],
  data: [
    "ข้อมูลต้นทาง",
    "สัญญาและคุณภาพข้อมูล",
    "ลำดับที่มาของข้อมูลจากต้นทางถึงระบบ พร้อมหลักฐานคุณภาพ",
  ],
  import: [
    "Data Import",
    "นำเข้าและประมวลผลข้อมูล",
    "ตรวจสอบ แปลง และเตรียมข้อมูลจาก SAP ให้พร้อมใช้งานในแต่ละ Module",
  ],
  fifo_setup: [
    "FIFO Setup",
    "FIFO, Packaging & Opening Setup",
    "ตรวจ Packing เริ่มต้นหน่วยขนถ่าย กระทบยอด และ Publish หลักฐาน FIFO ก่อนเริ่มใช้งานจริง",
  ],
  usage: [
    "การใช้งานรายเขต",
    "ยอดใช้จริง ประวัติการจ่าย และยอดแนะนำ รายเขต รายพัสดุ",
    "ดูยอดเบิกใช้ 12 เดือน ประวัติจ่าย / ไม่รับของ จากไฟล์คลังคลองเตยและ SYNAPSE พร้อมเหตุผลของยอดแนะนำ · ส่งออก Excel ได้",
  ],
  lots: [
    "ของเข้าคลัง",
    "ของเข้าคลังตามสัญญา (รวมสัญญา × 105 × Stock)",
    "คัดเฉพาะสัญญาที่เกี่ยวกับคลองเตย · ผ่านตรวจรับและมี 105 = จ่ายได้ · ผ่านตรวจรับแต่ยังไม่ Key 105 ผู้วางแผนยืนยันจ่ายได้ และระบบบวกเข้า Stock คลองเตยให้",
  ],
  packing: [
    "ข้อมูล Packing",
    "ข้อมูล Packing รายสัญญา",
    "กรอกขนาดกล่องและพาเลทของของที่รับเข้าแล้ว (105) แยกตามผู้ขาย/สัญญา/PO · ใช้คำนวณการจัดรถ",
  ],
  delivery: [
    "ปฏิทินส่งของ",
    "ปฏิทินส่งของรายสัปดาห์",
    "วันส่งประจำโซน เวลาตัดรอบคำขอเพิ่ม คำขอที่พ่วงแต่ละรอบ และรายงานเขตที่ขอเพิ่มบ่อย",
  ],
  alerts: [
    "แจ้งเตือน",
    "แจ้งเตือนเบิกผิดปกติ",
    "คำขอที่มากกว่าที่เคยจ่าย มากกว่า CMP หรือทำให้เขตมีของเกิน 6 เดือน พร้อมประวัติการตรวจ",
  ],
  users: [
    "ผู้ดูแลระบบ",
    "จัดการผู้ใช้งาน",
    "อนุมัติคำขอสิทธิ์ กำหนดบทบาทและเขต ระงับบัญชี และดูประวัติการเปลี่ยนสิทธิ์ทั้งหมด",
  ],
  history: [
    "ประวัติการดำเนินงาน",
    "ประวัติการดำเนินงานทั้งหมด",
    "รวมทุกเหตุการณ์ในที่เดียว: แผน การตอบของเขต คำขอผิดปกติ การจ่ายจริง จ่ายกรณีพิเศษ สต็อก ขนส่ง และประวัติจากระบบเดิม",
  ],
  legacy_history: [
    "ประวัติจากระบบเดิม",
    "ยกประวัติการจ่ายจากระบบเดิม",
    "นำเข้าประวัติจ่ายได้ตามแผน / ปรับจำนวน / ไม่รับของ จากไฟล์คำนวณการจ่ายเดิม",
  ],
  input: [
    "อัปเดตสต็อก",
    "บันทึกสต็อกและการใช้งาน",
    "บันทึกสต็อกรายวันและการใช้งานรายเดือน พร้อมอ้างอิงแหล่งที่มา",
  ],
  operations: [
    "ศูนย์ควบคุม",
    "ศูนย์ควบคุมการทำงาน",
    "สุขภาพระบบ การแจ้งเตือน การสำรองข้อมูล และหลักฐานการติดตั้ง",
  ],
  release: [
    "ขอบเขตระบบ",
    "ขอบเขตการใช้งาน",
    "เกณฑ์การจ่ายเวอร์ชัน 1 พร้อมพรีวิวระบบขนส่งแบบจำกัด",
  ],
};

function text(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

function bool(value: unknown) {
  return value === true || value === "true";
}

function record(value: unknown): RecordRow {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordRow)
    : {};
}

function rows(value: unknown): RecordRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is RecordRow =>
          row !== null && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

function latestSnapshot(data: DashboardData) {
  const timestamps = [...data.warehouseStock, ...data.stock]
    .map((row) => new Date(String(row.snapshot_at ?? "")).getTime())
    .filter(Number.isFinite);
  return timestamps.length
    ? formatDateTime(new Date(Math.max(...timestamps)).toISOString())
    : "รอข้อมูลจริง";
}

function statusClass(value: unknown) {
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

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className={`badge ${statusClass(children)}`}>
      <i />
      {children}
    </span>
  );
}

function LiveTable({
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

function Login({
  busy,
  error,
  onLogin,
}: {
  busy: boolean;
  error: string;
  onLogin: (identifier: string, password: string) => Promise<boolean>;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onLogin(identifier, password);
  };
  return (
    <main className="login-page">
      <section className="login-visual">
        <div className="login-brand">
          <b>MEA</b>
          <span>
            <strong>MEA Synapse</strong>
            <small>งานคลังพัสดุ</small>
          </span>
        </div>
        <div className="login-copy">
          <span>ระบบบริหารงานคลังพัสดุ</span>
          <h1>
            จัดการสต็อกได้
            <br />
            สอบกลับได้ทุกขั้นตอน
          </h1>
          <p>
            วางแผนการจ่ายรายสัปดาห์ ยืนยันโดยเขต อนุมัติตามลำดับ จ่ายแบบ FIFO
            จ่ายกรณีพิเศษ และสอบกลับได้ครบในที่เดียว
          </p>
        </div>
        <div className="login-metrics">
          <span>
            <strong>2401</strong> คลังคลองเตย
          </span>
          <span>
            <strong>0001</strong> ที่จัดเก็บ
          </span>
          <span>
            <strong>18</strong> เขต
          </span>
        </div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <span className="demo-tag">
            <i /> เข้าสู่ระบบอย่างปลอดภัย
          </span>
          <div className="login-heading">
            <h2>เข้าสู่ระบบ MEA Synapse</h2>
            <p>ระบบจะกำหนดสิทธิ์และพื้นที่รับผิดชอบให้คุณโดยอัตโนมัติ</p>
          </div>
          <label>
            ชื่อผู้ใช้หรืออีเมล
            <input
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            รหัสผ่าน
            <div className="password-field">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                aria-label={showPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? "ซ่อน" : "แสดง"}
              </button>
            </div>
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button
            className="btn primary login-submit"
            type="submit"
            disabled={busy}
          >
            {busy ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"} <span>→</span>
          </button>
          <div className="login-assurance">
            <span>กำหนดสิทธิ์ตามบทบาท</span>
            <i />
            <span>ข้อมูลตามพื้นที่รับผิดชอบ</span>
          </div>
          <button type="button" className="login-request-link" onClick={() => setRequestOpen(true)}>
            ยังไม่มีบัญชี? <b>ขอสิทธิ์ใช้งาน →</b>
          </button>
        </form>
      </section>
      {requestOpen && <AccessRequestForm onClose={() => setRequestOpen(false)} />}
    </main>
  );
}

function Sidebar({
  active,
  hiddenViews,
  role,
  open,
  navigate,
  close,
  snapshot,
  moduleKey,
  setModule,
  transportView,
  setTransportView,
}: {
  active: ViewKey;
  hiddenViews: Set<ViewKey>;
  role: Role;
  open: boolean;
  navigate: (view: ViewKey) => void;
  close: () => void;
  snapshot: string;
  moduleKey: "warehouse" | "transport";
  setModule: (value: "warehouse" | "transport") => void;
  transportView: TransportView;
  setTransportView: (value: TransportView) => void;
}) {
  const roleName: Record<Role, string> = {
    admin: "เจ้าหน้าที่ส่วนกลาง",
    planner: "ผู้วางแผน",
    academic: "เจ้าหน้าที่วิชาการ",
    picker: "เจ้าหน้าที่คลัง",
    district: "เจ้าหน้าที่เขต",
    viewer: "ผู้อ่านข้อมูล",
  };
  const switchBtn = (key: "warehouse" | "transport", label: string) => (
    <button
      type="button"
      aria-pressed={moduleKey === key}
      onClick={() => setModule(key)}
      style={{
        flex: 1,
        padding: "8px 6px",
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,.15)",
        background:
          moduleKey === key ? "#1f6fd1" : "rgba(255,255,255,.06)",
        color: moduleKey === key ? "#fff" : "rgba(255,255,255,.7)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <>
      <button
        className={`scrim ${open ? "show" : ""}`}
        onClick={close}
        aria-label="Close menu"
      />
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand">
          <span>MEA</span>
          <div>
            <strong>MEA Synapse</strong>
            <small>งานคลังพัสดุ</small>
          </div>
        </div>
        <div className="user-scope">
          <i>{roleName[role].charAt(0)}</i>
          <div>
            <small>บทบาทของคุณ</small>
            <strong>{roleName[role]}</strong>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, padding: "0 12px 6px" }}>
          {switchBtn("warehouse", "คลังพัสดุ")}
          {switchBtn("transport", "ระบบขนส่ง")}
        </div>
        <nav>
          {moduleKey === "warehouse"
            ? navByRole[role].map((group) => {
                const navAllowed = new Set(
                  navByRole[role]
                    .flatMap((item) => item.items.map(([key]) => key))
                    .filter((key) => !hiddenViews.has(key)),
                );
                const entries = group.items
                  .filter(([key]) => navAllowed.has(key))
                  .map(([key, label, icon]) => ({ key, label, icon, group: viewGroup(key, navAllowed) }))
                  .filter((entry) => !entry.group || entry.group.keys[0] === entry.key);
                if (!entries.length) return null;
                return (
                <section key={group.label}>
                  <p>{group.label}</p>
                  {entries.map(({ key, label, icon, group: viewSet }) => {
                    const isActive = active === key || Boolean(viewSet?.keys.includes(active));
                    return (
                    <button
                      type="button"
                      key={key}
                      className={`${isActive ? "active" : ""} ${
                        key === "import" ? "import-nav-button" : ""
                      }`}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => {
                        navigate(key);
                        close();
                      }}
                    >
                      <i>{icon}</i>
                      <span>{viewSet?.navLabel ?? label}</span>
                    </button>
                    );
                  })}
                </section>
                );
              })
            : (
                <section>
                  <p>ระบบขนส่ง</p>
                  {transportNavForRole(role).map(([key, label, icon]) => (
                    <button
                      type="button"
                      key={key}
                      className={transportView === key ? "active" : ""}
                      aria-current={transportView === key ? "page" : undefined}
                      onClick={() => {
                        setTransportView(key);
                        close();
                      }}
                    >
                      <i>{icon}</i>
                      <span>{label}</span>
                    </button>
                  ))}
                </section>
              )}
        </nav>
        <div className="release-badge">
          <small>ข้อมูลล่าสุด</small>
          <strong>{snapshot}</strong>
          <span>ข้อมูลจริงจากระบบงาน</span>
        </div>
      </aside>
    </>
  );
}

function Header({
  title,
  loading,
  openMenu,
  logout,
  navigate,
  refresh,
  snapshot,
}: {
  title: string;
  loading: boolean;
  openMenu: () => void;
  logout: () => void;
  navigate: (view: ViewKey) => void;
  refresh: () => void;
  snapshot: string;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim().toLowerCase();
    const target: ViewKey =
      value.includes("trace") || value.includes("สอบกลับ")
        ? "trace"
        : value.includes("pallet") || value.includes("fifo")
          ? "fifo"
          : value.includes("ad-hoc") || value.includes("ฉุกเฉิน")
            ? "adhoc"
            : value.includes("stock")
              ? "stock"
              : value.includes("request") || value.includes("คำขอ")
                ? "changes"
                : "weekly";
    navigate(target);
    setQuery("");
  };
  return (
    <header className="topbar">
      <button className="menu" onClick={openMenu} aria-label="Open menu">
        ☰
      </button>
      <div className="breadcrumb">
        <span>MEA Synapse</span>
        <i>/</i>
        <strong>{title}</strong>
      </div>
      <div className="header-actions">
        <form className="global-search" onSubmit={submit}>
          <button type="submit" aria-label="Search">
            ⌕
          </button>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ค้นหาเมนู"
          />
          <kbd>Ctrl K</kbd>
        </form>
        <button
          type="button"
          className="last-sync live-sync"
          onClick={refresh}
          disabled={loading}
        >
          <i /> {loading ? "กำลังซิงก์…" : snapshot}
        </button>
        <button type="button" className="btn ghost logout" onClick={logout}>
          ออกจากระบบ
        </button>
      </div>
    </header>
  );
}

function DashboardView({
  data,
  role,
  navigate,
}: {
  data: DashboardData;
  role: Role;
  navigate: (view: ViewKey) => void;
}) {
  const plans = useMemo(() => {
    const byId = new Map<string, RecordRow>();
    data.replenishment.forEach((row) => {
      const id = text(row.replenishment_plan_id);
      if (!id) return;
      const current = byId.get(id);
      if (!current || text(row.updated_at) > text(current.updated_at)) byId.set(id, row);
    });
    return [...byId.values()].sort((left, right) =>
      `${text(right.week_start_date)}-${Number(right.version_no ?? 0)}-${text(right.updated_at)}`.localeCompare(
        `${text(left.week_start_date)}-${Number(left.version_no ?? 0)}-${text(left.updated_at)}`,
      ),
    );
  }, [data.replenishment]);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const effectivePlanId = plans.some(
    (row) => text(row.replenishment_plan_id) === selectedPlanId,
  )
    ? selectedPlanId
    : text(plans[0]?.replenishment_plan_id);
  const planRows = data.replenishment.filter(
    (row) => text(row.replenishment_plan_id) === effectivePlanId,
  );
  const plan = plans.find(
    (row) => text(row.replenishment_plan_id) === effectivePlanId,
  );
  const weeklyIssues = data.traceability.filter(
    (row) =>
      text(row.replenishment_plan_id) === effectivePlanId &&
      text(row.issue_type).toUpperCase() === "WEEKLY_PLAN",
  );
  const plannedQtyFor = (row: RecordRow) =>
    Number(row.final_qty ?? row.confirmed_qty ?? row.suggested_qty ?? 0);
  const issuedByItem = weeklyIssues.reduce<Record<string, number>>((totals, row) => {
    const itemId = text(row.replenishment_item_id);
    totals[itemId] = (totals[itemId] ?? 0) + Number(row.issued_qty ?? 0);
    return totals;
  }, {});
  const issuedLineCount = planRows.filter(
    (row) => (issuedByItem[text(row.replenishment_item_id)] ?? 0) > 0,
  ).length;
  const completedLineCount = planRows.filter((row) => {
    const target = plannedQtyFor(row);
    return target > 0 && (issuedByItem[text(row.replenishment_item_id)] ?? 0) >= target;
  }).length;
  const remainingLineCount = Math.max(0, planRows.length - completedLineCount);
  const completionPct = planRows.length > 0
    ? Math.min(100, (completedLineCount / planRows.length) * 100)
    : 0;
  const plannedDistricts = new Set(planRows.map((row) => text(row.district_id)).filter(Boolean));
  const issuedDistricts = new Set(weeklyIssues.map((row) => text(row.district_id)).filter(Boolean));
  const planChanges = data.changeRequests.filter(
    (row) => text(row.replenishment_plan_id) === effectivePlanId,
  );
  const pendingChanges = planChanges.filter((row) => row.status === "pending_review").length;
  // Follow-up work across every plan, not only the plan selected above.
  const awaitingDistrictLines = data.replenishment.filter((row) =>
    ["draft", "pending", "change_requested"].includes(text(row.item_status)),
  ).length;
  const pendingChangesAllPlans = data.changeRequests.filter(
    (row) => text(row.status) === "pending_review",
  ).length;
  const changedLines = planRows.filter((row) => {
    const requested = Number(row.requested_qty ?? row.confirmed_qty ?? 0);
    const suggested = Number(row.suggested_qty ?? 0);
    return requested > 0 && requested !== suggested;
  }).length;
  const fifoGapLines = planRows.filter(
    (row) =>
      plannedQtyFor(row) > 0 &&
      Number(row.allocated_qty ?? 0) < plannedQtyFor(row),
  ).length;
  const pendingAdHoc = data.adHocIssues.filter(
    (row) => !["issued", "rejected", "cancelled"].includes(text(row.status)),
  ).length;
  const weekStart = plan?.week_start_date ? new Date(`${text(plan.week_start_date)}T00:00:00`) : null;
  const weekDays = Array.from({ length: 5 }, (_, index) => {
    const date = weekStart ? new Date(weekStart.getTime() + index * 86400000) : null;
    const key = date ? date.toISOString().slice(0, 10) : "";
    const rows = weeklyIssues.filter((row) => text(row.occurred_at).slice(0, 10) === key);
    return {
      date,
      lines: new Set(rows.map((row) => text(row.replenishment_item_id))).size,
    };
  });
  const weekEnd = weekStart ? new Date(weekStart.getTime() + 5 * 86400000) : null;
  const dashboardReferenceTime = Date.parse(
    text(data.operations?.checked_at ?? data.operations?.generated_at ?? plan?.updated_at),
  );
  const overdue = Boolean(
    weekEnd &&
      Number.isFinite(dashboardReferenceTime) &&
      dashboardReferenceTime >= weekEnd.getTime() &&
      completionPct < 100,
  );
  const planHealth = completionPct >= 100
    ? { tone: "good", label: "จ่ายครบตามแผน" }
    : overdue
      ? { tone: "danger", label: "เลยกำหนดและยังจ่ายไม่ครบ" }
      : { tone: "warning", label: "กำลังดำเนินการ" };
  const varianceRows = planRows
    .map((row) => {
      const target = plannedQtyFor(row);
      const actual = issuedByItem[text(row.replenishment_item_id)] ?? 0;
      return { row, target, actual, gap: Math.max(0, target - actual) };
    })
    .filter((item) => item.gap > 0)
    .sort((left, right) => right.gap - left.gap)
    .slice(0, 8);
  const latestIssues = [...weeklyIssues]
    .sort((left, right) => text(right.occurred_at).localeCompare(text(left.occurred_at)))
    .slice(0, 8);
  const nextView: ViewKey =
    role === "picker"
      ? "fifo"
      : role === "district"
        ? "weekly"
        : role === "academic"
          ? "weekly"
          : "changes";
  const statusIcon = planHealth.tone === "good" ? "✓" : planHealth.tone === "danger" ? "!" : "◷";
  const planStatusLabel: Record<string, string> = {
    draft: "ร่างแผน",
    district_review: "รอเขตยืนยัน",
    pending_district_confirmation: "รอเขตยืนยัน",
    pending_planner_approval: "รอ Planner อนุมัติ",
    pending_academic_approval: "รอวิชาการอนุมัติ",
    locked: "Lock แล้ว",
    completed: "จ่ายครบแล้ว",
    cancelled: "ยกเลิก",
  };
  const pctOf = (value: number) =>
    planRows.length ? Math.min(100, (value / planRows.length) * 100) : 0;
  const maxDayLines = Math.max(1, ...weekDays.map((day) => day.lines));
  const todayKey = Number.isFinite(dashboardReferenceTime)
    ? new Date(dashboardReferenceTime).toISOString().slice(0, 10)
    : "";
  const [heroEyebrow, heroTitle, heroDescription] = titles.dashboard;
  return (
    <div className="stack">
      <PageHero
        icon="⌂"
        eyebrow={heroEyebrow}
        title={heroTitle}
        description={heroDescription}
        aside={
          <>
            <label className="hero-chip hero-select">
              <span>แผนที่กำลังติดตาม</span>
              <select value={effectivePlanId} onChange={(event) => setSelectedPlanId(event.target.value)}>
                {plans.length ? plans.map((row) => (
                  <option key={text(row.replenishment_plan_id)} value={text(row.replenishment_plan_id)}>
                    {text(row.plan_number) || text(row.replenishment_plan_id).slice(0, 8)}-V{formatNumber(row.version_no ?? 1)} · {planStatusLabel[text(row.plan_status)] ?? text(row.plan_status)}
                  </option>
                )) : <option value="">ยังไม่มีแผนการจ่าย</option>}
              </select>
              <small>
                {plan
                  ? `สัปดาห์ ${text(plan.week_start_date)} · ${formatNumber(plannedDistricts.size)} เขต`
                  : "เลือกแผนเพื่อเริ่มติดตาม"}
              </small>
            </label>
            <div className={`hero-progress ${planHealth.tone}`}>
              <div
                className="hero-ring"
                style={{ ["--pct" as string]: `${completionPct}%` }}
                role="img"
                aria-label={`จ่ายครบ ${formatNumber(completionPct, 1)}%`}
              >
                <strong>{formatNumber(completionPct, 0)}%</strong>
              </div>
              <div>
                <span className={`hero-status ${planHealth.tone}`}>
                  <i aria-hidden="true">{statusIcon}</i>
                  {planHealth.label}
                </span>
                <strong>
                  {formatNumber(completedLineCount)} / {formatNumber(planRows.length)}
                </strong>
                <small>รายการจ่ายครบตามแผน</small>
              </div>
            </div>
          </>
        }
      />

      <section className="dash-kpis">
        {[
          { tone: "plan", icon: "▤", label: "รายการตามแผน", value: planRows.length, note: `${formatNumber(plannedDistricts.size)} เขตในแผน`, pct: planRows.length ? 100 : 0 },
          { tone: "started", icon: "↗", label: "เริ่มจ่ายแล้ว", value: issuedLineCount, note: `${formatNumber(issuedDistricts.size)} เขตมี Inventory Movement`, pct: pctOf(issuedLineCount) },
          { tone: "done", icon: "✓", label: "จ่ายครบแล้ว", value: completedLineCount, note: "ครบตามจำนวนของแต่ละรายการ", pct: pctOf(completedLineCount) },
          { tone: "left", icon: "◷", label: "รายการคงเหลือ", value: remainingLineCount, note: "ยังไม่จ่ายหรือจ่ายไม่ครบ", pct: pctOf(remainingLineCount) },
        ].map((card) => (
          <article key={card.label} className={`dash-kpi ${card.tone}`}>
            <header>
              <i aria-hidden="true">{card.icon}</i>
              <span>{card.label}</span>
              <em>{formatNumber(card.pct, 0)}%</em>
            </header>
            <strong>{formatNumber(card.value)}</strong>
            <div className="dash-kpi-bar" aria-hidden="true"><b style={{ width: `${card.pct}%` }} /></div>
            <small>{card.note}</small>
          </article>
        ))}
      </section>

      <section className="dash-row">
        <article className="panel dash-week">
          <div className="panel-title">
            <div><span>ผลจ่ายรายวัน</span><h3>ความคืบหน้าจันทร์–ศุกร์</h3></div>
            <b>{formatNumber(issuedLineCount)} รายการเริ่มจ่าย</b>
          </div>
          <div className="dash-bars" role="list" aria-label="จำนวนรายการที่มีการจ่ายจริงต่อวัน">
            {weekDays.every((day) => day.lines === 0) && (
              <p className="dash-bars-empty">ยังไม่มีการจ่ายจริงในสัปดาห์ของแผนนี้</p>
            )}
            {weekDays.map((day, index) => {
              const key = day.date ? day.date.toISOString().slice(0, 10) : "";
              const dayName = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์"][index];
              const dateLabel = day.date
                ? day.date.toLocaleDateString("th-TH", { day: "numeric", month: "short" })
                : "—";
              return (
                <div
                  key={index}
                  role="listitem"
                  className={`dash-bar ${key && key === todayKey ? "today" : ""}`}
                  title={`${dayName} ${dateLabel}: ${formatNumber(day.lines)} รายการ`}
                >
                  <div className="dash-bar-track">
                    <em>{formatNumber(day.lines)}</em>
                    <b style={{ height: `${day.lines ? Math.max(6, (day.lines / maxDayLines) * 100) : 0}%` }} />
                  </div>
                  <strong>{dayName}</strong>
                  <small>{dateLabel}</small>
                </div>
              );
            })}
          </div>
          <p className="distribution-data-note">นับรายการที่มี Inventory Movement จริงในแต่ละวัน โดยไม่นำหน่วยของวัสดุต่างชนิดมารวมกัน</p>
        </article>

        <article className="panel dash-followup">
          <div className="panel-title">
            <div><span>งานที่ต้องติดตาม (ทุกแผน)</span><h3>รอเขตยืนยันและคำขอเปลี่ยน</h3></div>
          </div>
          <div className="dash-follow-list">
            <button type="button" className={awaitingDistrictLines ? "warn" : ""} onClick={() => navigate("weekly")}>
              <i aria-hidden="true">✉</i>
              <span><b>รอเขตตอบ</b><small>ส่งให้เขตแล้ว เขตยังไม่ยืนยัน</small></span>
              <strong>{formatNumber(awaitingDistrictLines)}</strong>
            </button>
            <button type="button" className={pendingChangesAllPlans ? "warn" : ""} onClick={() => navigate("changes")}>
              <i aria-hidden="true">⇄</i>
              <span><b>คำขอเปลี่ยนรอตรวจ</b><small>คำขอแก้แผนจากเขตที่ยังไม่ได้ตรวจ</small></span>
              <strong>{formatNumber(pendingChangesAllPlans)}</strong>
            </button>
            <button type="button" className={pendingAdHoc ? "warn" : ""} onClick={() => navigate("adhoc")}>
              <i aria-hidden="true">↗</i>
              <span><b>กรณีพิเศษรอดำเนินการ</b><small>แยกออกจากแผนสัปดาห์</small></span>
              <strong>{formatNumber(pendingAdHoc)}</strong>
            </button>
          </div>
        </article>
      </section>

      <section className="dash-row">
        <article className="panel dash-variance">
          <div className="panel-title">
            <div><span>รายการค้างตามแผน</span><h3>วัสดุที่ยังจ่ายไม่ครบ</h3></div>
            <b className="count">{varianceRows.length}</b>
          </div>
          <div className="dash-variance-list">
            {varianceRows.length ? varianceRows.map(({ row, target, actual, gap }) => (
              <article key={text(row.replenishment_item_id)}>
                <div className="dash-variance-name">
                  <strong>{text(row.material_id)}</strong>
                  <small>เขต {text(row.district_id)} · {text(row.material_name)}</small>
                </div>
                <div className="dash-variance-progress">
                  <div aria-hidden="true"><b style={{ width: `${target ? Math.min(100, (actual / target) * 100) : 0}%` }} /></div>
                  <small>จ่ายแล้ว {formatNumber(actual, 0)} / {formatNumber(target, 0)}</small>
                </div>
                <div className="dash-variance-gap"><span>ค้าง</span><strong>{formatNumber(gap, 0)}</strong></div>
              </article>
            )) : <p className="empty-copy">ไม่มีรายการค้างในแผนนี้</p>}
          </div>
        </article>
        <article className="panel dash-exceptions">
          <div className="panel-title">
            <div><span>ข้อยกเว้นที่ต้องจัดการ</span><h3>สิ่งที่ทำให้แผนเสี่ยงไม่สำเร็จ</h3></div>
          </div>
          <div className="dash-follow-list">
            <button type="button" className={fifoGapLines ? "warn" : ""} onClick={() => navigate("fifo")}>
              <i aria-hidden="true">▦</i>
              <span><b>หลักฐาน FIFO ยังไม่ครบ</b><small>เปิดตรวจหน่วยจัดเก็บที่พร้อมจ่าย</small></span>
              <strong>{formatNumber(fifoGapLines)}</strong>
            </button>
            <button type="button" className={changedLines ? "warn" : ""} onClick={() => navigate("weekly")}>
              <i aria-hidden="true">±</i>
              <span><b>รายการเปลี่ยนจากแผน</b><small>เขตขอต่างจากที่ระบบเสนอ</small></span>
              <strong>{formatNumber(changedLines)}</strong>
            </button>
            <button type="button" className={pendingChanges ? "warn" : ""} onClick={() => navigate("changes")}>
              <i aria-hidden="true">⇄</i>
              <span><b>คำขอเปลี่ยนรอตรวจ (แผนนี้)</b><small>ตรวจผลกระทบก่อนจ่าย</small></span>
              <strong>{formatNumber(pendingChanges)}</strong>
            </button>
            <button type="button" className="go" onClick={() => navigate(nextView)}>
              <i aria-hidden="true">→</i>
              <span><b>เปิดงานที่ต้องดำเนินการ</b><small>ไปยังหน้าปฏิบัติงานตามสิทธิ์</small></span>
              <strong>›</strong>
            </button>
          </div>
        </article>
      </section>

      <section className="panel distribution-latest-issues">
        <div className="panel-title">
          <div><span>การจ่ายจริงล่าสุด</span><h3>หลักฐานการเคลื่อนไหวที่สอบกลับได้</h3></div>
          <b>{formatNumber(weeklyIssues.length)} movements</b>
        </div>
        <LiveTable
          rows={latestIssues}
          empty="แผนนี้ยังไม่มีการจ่ายจริง"
          columns={[
            ["เวลา", (row) => formatDateTime(row.occurred_at)],
            ["วัสดุ", (row) => row.material_id],
            ["เขต", (row) => row.district_id],
            ["จำนวน", (row) => formatNumber(row.issued_qty, 2)],
            ["HU", (row) => row.handling_unit_code],
            ["Lot", (row) => row.lot_code],
            ["ผู้จ่าย", (row) => row.performed_by],
          ]}
        />
      </section>
    </div>
  );
}

function WeeklyPlanView({
  actionBusy,
  dataLoading = false,
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
  const materialCatalog = [
    ...new Map(
      [...data.materials, ...data.replenishment, ...data.stock].map((row) => [
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
  const packagingLabel = (row: RecordRow) => {
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
                                )} EA
                              </small>
                              {plannedPick > 0 &&
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

function RecommendationView({ data }: { data: DashboardData }) {
  return (
    <div className="stack">
      <section className="recommend-banner">
        <div>
          <span>เกณฑ์การจ่าย</span>
          <h3>เกณฑ์ CMP + จุดสั่ง 3.5 เดือน + ขั้นต่ำ 4 เดือน + สูงสุด 6 เดือน</h3>
          <p>
            CMP = ค่าเฉลี่ยการใช้ (ปีก่อน, 12/6/4 เดือน) จ่ายไม่เต็มพาเลทได้
            และไม่บังคับปัดจำนวนเป็นขั้น
          </p>
        </div>
        <div>
          <strong>{formatNumber(data.recommendations.length)}</strong>
          <small>รายการหลักฐาน</small>
        </div>
      </section>
      <section className="panel">
        <LiveTable
          rows={data.recommendations}
          empty="ยังไม่มีหลักฐานการคำนวณปริมาณ"
          columns={[
            ["แผน", (row) => row.plan_number],
            ["วัสดุ", (row) => row.material_id],
            ["เขต", (row) => row.district_id],
            ["สต็อก", (row) => formatNumber(row.current_stock_qty, 2)],
            ["CMP", (row) => formatNumber(row.cmp_monthly, 2)],
            ["เดือน", (row) => formatNumber(row.months_available, 1)],
            ["MIN", (row) => formatNumber(row.min_fill_qty, 2)],
            ["MAX", (row) => formatNumber(row.max_fill_qty, 2)],
            ["แนะนำ", (row) => formatNumber(row.recommended_qty, 2)],
            ["แหล่งที่มา", (row) => <Badge>{text(row.source_freshness_status)}</Badge>],
          ]}
        />
      </section>
    </div>
  );
}

// --- Wave-3 intelligence: obsolescence / slow-mover advisory ----------------
// A client-side port of the deterministic months-of-cover + threshold logic in
// intelligence/src/synapse_intelligence/obsolescence.py, computed from the real
// Quantity Recommendation Evidence. Advisory only: it never mutates Business
// Rules v1 or any plan, and shows only what the available evidence supports
// (demand volatility / forecast history is not exposed to the browser).
type AdvisoryLevel = "critical" | "warning" | "watch" | "none";

const ADVISORY_STYLE: Record<AdvisoryLevel, { bg: string; fg: string; label: string }> = {
  critical: { bg: "#fee4e2", fg: "#b42318", label: "Critical" },
  warning: { bg: "#fef0c7", fg: "#b54708", label: "Warning" },
  watch: { bg: "#d1e9ff", fg: "#175cd3", label: "Watch" },
  none: { bg: "#dcfae6", fg: "#067647", label: "OK" },
};

const ADVISORY_COPY: Record<
  AdvisoryLevel,
  { title: string; description: string; action: string }
> = {
  critical: {
    title: "ต้องดำเนินการทันที",
    description: "ของค้างรุนแรงหรือไม่มีการใช้",
    action: "ตรวจสอบสต็อกและเสนอแนวทางจัดการ",
  },
  warning: {
    title: "ควรวางแผนแก้ไข",
    description: "คงคลังเกินเกณฑ์ 6 เดือน",
    action: "ทบทวนแผนจ่ายและปริมาณคงเหลือ",
  },
  watch: {
    title: "เฝ้าดูแนวโน้ม",
    description: "เริ่มเข้าใกล้เกณฑ์ของค้าง",
    action: "ติดตามรอบถัดไป ยังไม่ต้องดำเนินการ",
  },
  none: {
    title: "อยู่ในเกณฑ์ปกติ",
    description: "ยังไม่พบสัญญาณของค้าง",
    action: "ไม่ต้องดำเนินการ",
  },
};

function advisoryFor(row: RecordRow): { level: AdvisoryLevel; reason: string } {
  const cmp = Number(row.cmp_monthly);
  const stock = Number(row.current_stock_qty);
  const months = Number(row.months_available);
  if (Number.isFinite(cmp) && cmp <= 0 && Number.isFinite(stock) && stock > 0) {
    return { level: "critical", reason: "ไม่มีการใช้ (CMP=0) แต่ยังมีสต็อกค้าง — เสี่ยงเป็นของตาย" };
  }
  if (Number.isFinite(months) && months > 9) {
    return { level: "critical", reason: `คงคลัง ${months.toFixed(1)} เดือน (>9 — ต้องอนุมัติวิชาการ)` };
  }
  if (Number.isFinite(months) && months > 6) {
    return { level: "warning", reason: `คงคลัง ${months.toFixed(1)} เดือน (>6 — overstock)` };
  }
  if (Number.isFinite(months) && months > 4.5) {
    return { level: "watch", reason: `คงคลัง ${months.toFixed(1)} เดือน — เริ่มเข้าใกล้ overstock` };
  }
  return { level: "none", reason: "อยู่ในเกณฑ์ปกติ" };
}

function RiskBadge({ level }: { level: AdvisoryLevel }) {
  const style = ADVISORY_STYLE[level];
  return (
    <span
      style={{
        display: "inline-flex",
        padding: "2px 10px",
        borderRadius: 999,
        background: style.bg,
        color: style.fg,
        fontWeight: 600,
        fontSize: "0.78rem",
      }}
    >
      {style.label}
    </span>
  );
}

function IntelligenceAdvisoryView({ data }: { data: DashboardData }) {
  const scored = data.recommendations.map((row) => ({ row, advisory: advisoryFor(row) }));
  const counts = scored.reduce(
    (acc, { advisory }) => {
      acc[advisory.level] += 1;
      return acc;
    },
    { critical: 0, warning: 0, watch: 0, none: 0 } as Record<AdvisoryLevel, number>,
  );
  const [selectedLevel, setSelectedLevel] = useState<AdvisoryLevel>(() => {
    if (counts.critical) return "critical";
    if (counts.warning) return "warning";
    if (counts.watch) return "watch";
    return "none";
  });
  const [query, setQuery] = useState("");
  const grouped = scored.reduce(
    (acc, { row, advisory }) => {
      acc[advisory.level].push({
        ...row,
        __level: advisory.level,
        __reason: advisory.reason,
      });
      return acc;
    },
    { critical: [], warning: [], watch: [], none: [] } as Record<AdvisoryLevel, RecordRow[]>,
  );
  const normalizedQuery = query.trim().toLowerCase();
  const selectedRows = grouped[selectedLevel].filter((row) => {
    if (!normalizedQuery) return true;
    return [row.material_id, row.material_name, row.district_id, row.district_name_th]
      .map((value) => text(value).toLowerCase())
      .some((value) => value.includes(normalizedQuery));
  });
  const visibleRows = selectedRows.slice(0, normalizedQuery ? 50 : 20);
  const flaggedCount = counts.critical + counts.warning + counts.watch;
  const selectedCopy = ADVISORY_COPY[selectedLevel];
  return (
    <div className="stack advisory-page">
      <section className="recommend-banner">
        <div>
          <span>การเฝ้าระวัง</span>
          <h3>ความเสี่ยงของค้าง / ของเคลื่อนไหวช้า</h3>
          <p>
            คำนวณจากข้อมูลจริง (CMP, สต็อก, เดือนคงคลัง) เป็น
            <strong>ข้อมูลประกอบการตัดสินใจ</strong>{" "}
            เท่านั้น ไม่เปลี่ยนเกณฑ์การจ่าย และไม่อนุมัติอัตโนมัติ
          </p>
        </div>
        <div>
          <strong>{formatNumber(flaggedCount)}</strong>
          <small>ต้องเฝ้าระวัง จากทั้งหมด {formatNumber(scored.length)} รายการ</small>
        </div>
      </section>
      <section className="advisory-summary" aria-label="สรุปความเสี่ยง">
        {(["critical", "warning", "watch", "none"] as AdvisoryLevel[]).map((level) => (
          <button
            className={`advisory-summary-card ${level} ${selectedLevel === level ? "active" : ""}`}
            key={level}
            type="button"
            aria-pressed={selectedLevel === level}
            onClick={() => setSelectedLevel(level)}
          >
            <span><RiskBadge level={level} /> เลือกดู</span>
            <strong>{formatNumber(counts[level])}</strong>
            <h3>{ADVISORY_COPY[level].title}</h3>
            <p>{ADVISORY_COPY[level].description}</p>
            <small>{ADVISORY_COPY[level].action}</small>
          </button>
        ))}
      </section>
      <section className={`panel advisory-detail ${selectedLevel}`}>
        <header className="advisory-detail-head">
          <div>
            <RiskBadge level={selectedLevel} />
            <h3>{selectedCopy.title}</h3>
            <p>{selectedCopy.action}</p>
          </div>
          <strong>{formatNumber(selectedRows.length)} รายการ</strong>
        </header>
        <div className="advisory-search">
          <label>
            <span>⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ค้นหารหัส/ชื่อพัสดุ หรือเขต"
              aria-label="ค้นหารายการเฝ้าระวัง"
            />
          </label>
          {query ? <button type="button" onClick={() => setQuery("")}>ล้างการค้นหา</button> : null}
        </div>
        {visibleRows.length ? (
          <div className="advisory-item-grid">
            {visibleRows.map((row, index) => (
              <article key={`${text(row.material_id)}-${text(row.district_id)}-${index}`}>
                <div>
                  <strong>{text(row.material_id)}</strong>
                  <span>เขต {text(row.district_id)} · {text(row.district_name_th)}</span>
                </div>
                <p>{text(row.material_name) || "ไม่มีชื่อพัสดุ"}</p>
                <dl>
                  <div><dt>สต็อก</dt><dd>{formatNumber(row.current_stock_qty, 2)}</dd></div>
                  <div><dt>CMP / เดือน</dt><dd>{formatNumber(row.cmp_monthly, 2)}</dd></div>
                  <div><dt>คงคลัง</dt><dd>{formatNumber(row.months_available, 1)} เดือน</dd></div>
                </dl>
                <footer>{text(row.__reason)}</footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="advisory-empty">
            <i>✓</i>
            <div>
              <h3>{query ? "ไม่พบรายการที่ค้นหา" : `ไม่มีรายการกลุ่ม “${selectedCopy.title}”`}</h3>
              <p>{query ? "ลองค้นหาด้วยรหัสพัสดุหรือเลขเขตอีกครั้ง" : "สถานะนี้ไม่มีงานที่ต้องเปิดตรวจสอบ"}</p>
            </div>
          </div>
        )}
        {selectedRows.length > visibleRows.length ? (
          <p className="advisory-more">
            แสดง {formatNumber(visibleRows.length)} จาก {formatNumber(selectedRows.length)} รายการ — ใช้ช่องค้นหาเพื่อหารายการที่ต้องการ
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ChangeReviewView({
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

function ApprovalView({ data }: { data: DashboardData }) {
  return (
    <section className="panel">
      <LiveTable
        rows={data.approvals}
        empty="ยังไม่มีประวัติการอนุมัติ"
        columns={[
          ["เวลา", (row) => formatDateTime(row.acted_at)],
          ["แผน", (row) => text(row.replenishment_plan_id).slice(0, 8)],
          ["ขั้นตอน", (row) => <Badge>{text(row.approval_stage)}</Badge>],
          ["ผล", (row) => row.decision],
          ["บทบาท", (row) => row.actor_role],
          ["ผู้ทำ", (row) => text(row.actor_id).slice(0, 8)],
          ["เขต", (row) => row.district_id],
          ["หมายเหตุ", (row) => row.note],
        ]}
      />
    </section>
  );
}

function exportCsv(
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

function FifoView({
  actionBusy,
  data,
  role,
  onReconcile,
}: {
  actionBusy: boolean;
  data: DashboardData;
  role: Role;
  onReconcile: (
    handlingUnitId: string,
    status: "OPEN" | "SEALED",
    reason: string,
  ) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const [resolvedStatus, setResolvedStatus] = useState<"OPEN" | "SEALED">(
    "OPEN",
  );
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const canReconcile = role === "admin" || role === "picker";
  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (row: RecordRow, fields: string[]) =>
    !normalizedQuery ||
    fields.some((field) => text(row[field]).toLowerCase().includes(normalizedQuery));
  const filteredWarehouseStock = data.warehouseStock.filter((row) =>
    matchesQuery(row, ["material_id", "material_name", "unit", "location_name_th", "snapshot_at"]),
  );
  const filteredFifo = data.fifo.filter((row) =>
    matchesQuery(row, [
      "fifo_sequence", "handling_unit_code", "opening_status", "material_id",
      "acceptance_date", "purchase_order", "line_item", "lot_code",
    ]),
  );
  const filteredHandlingUnits = data.handlingUnits.filter((row) =>
    matchesQuery(row, [
      "handling_unit_code", "material_id", "opening_status",
      "traceability_status", "acceptance_date",
    ]),
  );
  const exportDate = new Date().toISOString().slice(0, 10);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || reason.trim().length < 3) return;
    const ok = await onReconcile(
      text(selected.handling_unit_id),
      resolvedStatus,
      reason.trim(),
    );
    if (ok) setSelected(null);
  };
  return (
    <div className="stack">
      <section className="inventory-summary">
        <article>
          <span>หน่วยจัดเก็บ</span>
          <strong>{formatNumber(data.handlingUnits.length)}</strong>
          <small>ทุกสถานะ</small>
        </article>
        <article>
          <span>Open</span>
          <strong>
            {formatNumber(
              data.handlingUnits.filter((row) => row.opening_status === "OPEN")
                .length,
            )}
          </strong>
          <small>เปิดจ่ายก่อนปิดผนึก</small>
        </article>
        <article className="danger">
          <span>สถานะการเปิดไม่ทราบ</span>
          <strong>
            {formatNumber(
              data.handlingUnits.filter(
                (row) => row.opening_status === "OPENING_UNKNOWN",
              ).length,
            )}
          </strong>
          <small>บล็อกจนกว่าจะยืนยัน</small>
        </article>
        <article>
          <span>พร้อมจ่าย</span>
          <strong>
            {formatNumber(
              data.fifo.reduce(
                (sum, row) => sum + Number(row.allocatable_qty ?? 0),
                0,
              ),
              2,
            )}
          </strong>
          <small>หน่วยนับพื้นฐาน</small>
        </article>
      </section>
      <section className="fifo-search-bar">
        <label>
          <span>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ค้นหารหัส/ชื่อพัสดุ, HU, PO, Lot, สถานที่ หรือสถานะ"
            aria-label="ค้นหาข้อมูล FIFO และสต็อก"
          />
        </label>
        <div>
          <strong>
            พบ {formatNumber(
              filteredWarehouseStock.length + filteredFifo.length + filteredHandlingUnits.length,
            )} รายการ
          </strong>
          <small>
            สต็อก {formatNumber(filteredWarehouseStock.length)} · FIFO {formatNumber(filteredFifo.length)} · HU {formatNumber(filteredHandlingUnits.length)}
          </small>
        </div>
        {query ? (
          <button className="btn light" type="button" onClick={() => setQuery("")}>
            ล้างการค้นหา
          </button>
        ) : null}
      </section>
      {data.warehouseStock.length > 0 && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>ข้อมูลสต็อกคลังจริง</span>
              <h3>สต็อกที่รอลงทะเบียนหน่วยจัดเก็บ</h3>
            </div>
            <div className="panel-title-actions">
              <b>{formatNumber(filteredWarehouseStock.length)} รายการ</b>
              <button
                className="btn light"
                type="button"
                disabled={!filteredWarehouseStock.length}
                onClick={() =>
                  exportCsv(
                    `warehouse-stock-${exportDate}.csv`,
                    ["รหัสพัสดุ", "รายละเอียด", "จำนวน", "หน่วย", "สถานที่", "เวลาข้อมูล"],
                    filteredWarehouseStock.map((row) => [
                      row.material_id, row.material_name, row.quantity_on_hand,
                      row.unit, row.location_name_th, row.snapshot_at,
                    ]),
                  )
                }
              >
                ⇩ Export CSV
              </button>
            </div>
          </div>
          {!data.handlingUnits.length && (
            <aside className="plain-notice warning">
              <i>!</i>
              <div>
                <strong>มีสต็อกอยู่ แต่ยังไม่ได้ลงทะเบียนหน่วยจัดเก็บ</strong>
                <p>
                  ยอดสต็อกจากแหล่งข้อมูลจริงแสดงด้านล่าง กรุณาลงทะเบียนการรับพัสดุ
                  หรือหน่วยที่เปิดแล้วก่อนจ่ายแบบ FIFO ระบบจะไม่สร้างข้อมูลพาเลทหรือสัญญาขึ้นเอง
                </p>
              </div>
            </aside>
          )}
          <LiveTable
            rows={filteredWarehouseStock.slice(0, 100)}
            empty={query ? "ไม่พบข้อมูลสต็อกที่ตรงกับคำค้นหา" : "ยังไม่มีข้อมูลสต็อกคลัง"}
            columns={[
              ["วัสดุ", (row) => row.material_id],
              ["รายละเอียด", (row) => row.material_name],
              ["จำนวน", (row) => formatNumber(row.quantity_on_hand, 2)],
              ["รวมผ่านตรวจรับ (รอ 105)", (row) =>
                row.passed_test_qty ? `+${formatNumber(Number(row.passed_test_qty), 2)} (SAP ${formatNumber(Number(row.sap_quantity ?? 0), 2)})` : "—"],
              ["หน่วย", (row) => row.unit],
              ["สถานที่", (row) => row.location_name_th],
              ["เวลาข้อมูล", (row) => formatDateTime(row.snapshot_at)],
            ]}
          />
        </section>
      )}
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>คิว FIFO</span>
            <h3>จ่ายหน่วยที่เปิดก่อน แล้วเรียงตามวันรับ / PO / รายการ</h3>
          </div>
          <div className="panel-title-actions">
            <b>{formatNumber(filteredFifo.length)} รายการ</b>
            <button
              className="btn light"
              type="button"
              disabled={!filteredFifo.length}
              onClick={() =>
                exportCsv(
                  `fifo-queue-${exportDate}.csv`,
                  ["ลำดับ", "HU", "สถานะ", "รหัสพัสดุ", "พร้อมจ่าย", "จอง", "คงเหลือ", "วันรับ", "PO", "รายการ", "Lot"],
                  filteredFifo.map((row) => [
                    row.fifo_sequence, row.handling_unit_code, row.opening_status,
                    row.material_id, row.available_qty, row.reserved_qty,
                    row.allocatable_qty, row.acceptance_date, row.purchase_order,
                    row.line_item, row.lot_code,
                  ]),
                )
              }
            >
              ⇩ Export CSV
            </button>
          </div>
        </div>
        <LiveTable
          rows={filteredFifo}
          empty={query ? "ไม่พบคิว FIFO ที่ตรงกับคำค้นหา" : "ไม่มีหน่วยจัดเก็บที่พร้อมจ่าย"}
          columns={[
            ["ลำดับ", (row) => row.fifo_sequence],
            ["HU", (row) => row.handling_unit_code],
            ["สถานะ", (row) => <Badge>{text(row.opening_status)}</Badge>],
            ["วัสดุ", (row) => row.material_id],
            ["พร้อมจ่าย", (row) => formatNumber(row.available_qty, 2)],
            ["จอง", (row) => formatNumber(row.reserved_qty, 2)],
            ["คงเหลือ", (row) => formatNumber(row.allocatable_qty, 2)],
            ["วันรับ", (row) => row.acceptance_date],
            ["PO / รายการ", (row) => `${text(row.purchase_order)} / ${text(row.line_item)}`],
            ["Lot", (row) => row.lot_code],
          ]}
        />
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>หน่วยจัดเก็บทั้งหมด</span>
            <h3>หน่วยที่ถูกบล็อก หมด หรือกักกัน</h3>
          </div>
          <div className="panel-title-actions">
            <b>{formatNumber(filteredHandlingUnits.length)} รายการ</b>
            <button
              className="btn light"
              type="button"
              disabled={!filteredHandlingUnits.length}
              onClick={() =>
                exportCsv(
                  `handling-units-${exportDate}.csv`,
                  ["HU", "รหัสพัสดุ", "สถานะ", "สถานะสอบกลับ", "พร้อมจ่าย", "วันรับ"],
                  filteredHandlingUnits.map((row) => [
                    row.handling_unit_code, row.material_id, row.opening_status,
                    row.traceability_status, row.available_qty, row.acceptance_date,
                  ]),
                )
              }
            >
              ⇩ Export CSV
            </button>
          </div>
        </div>
        <LiveTable
          rows={filteredHandlingUnits}
          empty={query ? "ไม่พบหน่วยจัดเก็บที่ตรงกับคำค้นหา" : "ยังไม่มีหน่วยจัดเก็บ"}
          columns={[
            ["HU", (row) => row.handling_unit_code],
            ["วัสดุ", (row) => row.material_id],
            ["สถานะ", (row) => <Badge>{text(row.opening_status)}</Badge>],
            ["สอบกลับ", (row) => <Badge>{text(row.traceability_status)}</Badge>],
            ["พร้อมจ่าย", (row) => formatNumber(row.available_qty, 2)],
            ["วันรับ", (row) => row.acceptance_date],
            [
              "ยืนยัน",
              (row) => (
                <button
                  className="table-action"
                  disabled={
                    !canReconcile || row.opening_status !== "OPENING_UNKNOWN"
                  }
                  onClick={() => {
                    setSelected(row);
                    setReason("");
                  }}
                >
                  ยืนยัน Opening
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
              สถานะที่แก้ไข
              <select
                value={resolvedStatus}
                onChange={(event) =>
                  setResolvedStatus(event.target.value as "OPEN" | "SEALED")
                }
              >
                <option value="OPEN">OPEN</option>
                <option value="SEALED">SEALED</option>
              </select>
            </label>
            <label className="wide">
              จำนวน / หลักฐานการรับ
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
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
              บันทึกการยืนยัน
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ReceivingView({
  actionBusy,
  data,
  onReceive,
}: {
  actionBusy: boolean;
  data: DashboardData;
  onReceive: (payload: ReceiptPayload) => Promise<boolean>;
}) {
  const [contractItemId, setContractItemId] = useState("");
  const [acceptanceDate, setAcceptanceDate] = useState("");
  const [quantity, setQuantity] = useState("");
  const [handlingUnitCode, setHandlingUnitCode] = useState("");
  const [unitType, setUnitType] =
    useState<ReceiptPayload["unit_type"]>("FULL_PALLET");
  const [openingStatus, setOpeningStatus] =
    useState<ReceiptPayload["opening_status"]>("SEALED");
  const [installment, setInstallment] = useState("");
  const [source, setSource] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload: ReceiptPayload = {
      contract_item_id: Number(contractItemId),
      location_id: "WH-KT",
      acceptance_date: acceptanceDate,
      quantity: Number(quantity),
      handling_unit_code: handlingUnitCode.trim(),
      unit_type: unitType,
      opening_status: openingStatus,
      installment_no: installment.trim() || undefined,
      source_reference: source.trim(),
    };
    if (
      !Number.isInteger(payload.contract_item_id) ||
      payload.contract_item_id <= 0 ||
      !Number.isFinite(payload.quantity) ||
      payload.quantity <= 0
    ) {
      return;
    }
    const ok = await onReceive(payload);
    if (ok) {
      setQuantity("");
      setHandlingUnitCode("");
      setSource("");
    }
  };
  return (
    <div className="stack">
      <section className="plain-notice info">
        <i>i</i>
        <div>
          <strong>คลังคลองเตย = โรงงาน 2401 / ที่จัดเก็บ 0001</strong>
          <p>
            หน่วยที่สถานะ OPENING_UNKNOWN จะยังจ่ายแบบ FIFO ไม่ได้
            จนกว่าเจ้าหน้าที่คลังจะบันทึกหลักฐานยืนยัน
          </p>
        </div>
      </section>
      <form className="pipeline-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="wide">
            รายการสัญญา
            <select
              value={contractItemId}
              onChange={(event) => setContractItemId(event.target.value)}
              required
            >
              <option value="">เลือก PO / รายการ / วัสดุ</option>
              {data.receiptOptions.map((row) => (
                <option
                  key={text(row.contract_item_id)}
                  value={text(row.contract_item_id)}
                >
                  {text(row.purchase_order)} / {text(row.line_item)} ·{" "}
                  {text(row.material_id)} · {text(row.vendor_name)}
                </option>
              ))}
            </select>
          </label>
          <label>
            วันที่รับ
            <input
              type="date"
              value={acceptanceDate}
              onChange={(event) => setAcceptanceDate(event.target.value)}
              required
            />
          </label>
          <label>
            จำนวน
            <input
              type="number"
              min="0.000001"
              step="any"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              required
            />
          </label>
          <label>
            รหัสหน่วยจัดเก็บ
            <input
              value={handlingUnitCode}
              onChange={(event) => setHandlingUnitCode(event.target.value)}
              required
            />
          </label>
          <label>
            ประเภทหน่วย
            <select
              value={unitType}
              onChange={(event) =>
                setUnitType(event.target.value as ReceiptPayload["unit_type"])
              }
            >
              {[
                "FULL_PALLET",
                "BOX",
                "CRATE",
                "BUNDLE",
                "LOOSE",
                "LONG_MATERIAL",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            สถานะการเปิด
            <select
              value={openingStatus}
              onChange={(event) =>
                setOpeningStatus(
                  event.target.value as ReceiptPayload["opening_status"],
                )
              }
            >
              <option value="SEALED">SEALED</option>
              <option value="OPENING_UNKNOWN">OPENING_UNKNOWN</option>
            </select>
          </label>
          <label>
            งวด
            <input
              value={installment}
              onChange={(event) => setInstallment(event.target.value)}
            />
          </label>
          <label className="wide">
            อ้างอิงแหล่งที่มา / หลักฐานการรับ
            <textarea
              value={source}
              onChange={(event) => setSource(event.target.value)}
              required
            />
          </label>
        </div>
        <div className="pipeline-actions">
          <button className="btn primary" disabled={actionBusy}>
            รับหน่วยจัดเก็บเข้าคลัง
          </button>
        </div>
      </form>
    </div>
  );
}

function AdHocView({
  actionBusy,
  data,
  role,
  token,
  onApprove,
  onCreate,
  onIssue,
}: {
  actionBusy: boolean;
  data: DashboardData;
  role: Role;
  token: string | null;
  onApprove: (issueId: string, note: string) => Promise<boolean>;
  onCreate: (payload: AdHocIssuePayload) => Promise<boolean>;
  onIssue: (issueId: string) => Promise<boolean>;
}) {
  const [materialId, setMaterialId] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [requester, setRequester] = useState("");
  const [reason, setReason] = useState("");
  const [urgency, setUrgency] = useState("normal");
  const [urgencyNote, setUrgencyNote] = useState("");
  const [preview, setPreview] = useState<{ slot: SlotPreview; check: RequestCheck } | null>(null);
  const effectiveDistrict = districtId;
  useEffect(() => {
    const qty = Number(quantity);
    if (!token || !materialId || !effectiveDistrict || !Number.isFinite(qty) || qty <= 0) {
      const reset = window.setTimeout(() => setPreview(null), 0);
      return () => window.clearTimeout(reset);
    }
    const timer = window.setTimeout(() => {
      apiRequest<{ slot: SlotPreview; check: RequestCheck }>("/v1/ad-hoc/preview", token, {
        method: "POST",
        body: JSON.stringify({ material_id: materialId, district_id: effectiveDistrict, requested_qty: qty, urgency_code: urgency }),
      })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [token, materialId, effectiveDistrict, quantity, urgency]);
  const [approveRow, setApproveRow] = useState<RecordRow | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const canCreate = ["admin", "planner", "district"].includes(role);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload: AdHocIssuePayload = {
      material_id: materialId,
      district_id: effectiveDistrict,
      urgency_code: urgency,
      urgency_note: urgency === "normal" ? "" : urgencyNote.trim(),
      requested_qty: Number(quantity),
      requester_name: requester.trim(),
      reason: reason.trim(),
      idempotency_key: crypto.randomUUID(),
    };
    if (
      !payload.material_id ||
      !payload.district_id ||
      (urgency !== "normal" && urgencyNote.trim().length < 5) ||
      !Number.isFinite(payload.requested_qty) ||
      payload.requested_qty <= 0
    ) {
      return;
    }
    const ok = await onCreate(payload);
    if (ok) {
      setQuantity("");
      setReason("");
      setUrgency("normal");
      setUrgencyNote("");
      setPreview(null);
    }
  };
  const approve = async (event: FormEvent) => {
    event.preventDefault();
    if (!approveRow || approvalNote.trim().length < 3) return;
    const ok = await onApprove(
      text(approveRow.ad_hoc_issue_id),
      approvalNote.trim(),
    );
    if (ok) setApproveRow(null);
  };
  return (
    <div className="stack">
      {canCreate && (
        <form className="pipeline-form" onSubmit={submit}>
          <div className="form-grid">
            <label>
              วัสดุ
              <select
                value={materialId}
                onChange={(event) => setMaterialId(event.target.value)}
                required
              >
                <option value="">เลือกวัสดุ</option>
                {data.materials.map((row) => (
                  <option key={text(row.material_id)} value={text(row.material_id)}>
                    {text(row.material_id)} · {text(row.material_name)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              เขต
              <select
                value={districtId}
                onChange={(event) => setDistrictId(event.target.value)}
                required
              >
                <option value="">เลือกเขต</option>
                {data.districts.map((row) => (
                  <option key={text(row.district_id)} value={text(row.district_id)}>
                    {text(row.district_id)} · {text(row.district_name_th)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              จำนวน
              <input
                type="number"
                min="0.000001"
                step="any"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </label>
            <label>
              ชื่อผู้ขอ
              <input
                value={requester}
                onChange={(event) => setRequester(event.target.value)}
                required
              />
            </label>
            <label>
              ความเร่งด่วน
              <select value={urgency} onChange={(event) => setUrgency(event.target.value)}>
                {Object.entries(URGENCY_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </label>
            {urgency !== "normal" && (
              <label>
                รายละเอียดความเร่งด่วน (จำเป็น)
                <input
                  value={urgencyNote}
                  onChange={(event) => setUrgencyNote(event.target.value)}
                  placeholder="เช่น สายขาดจากพายุ ถ.ร่มเกล้า เลขงานซ่อม …"
                  required
                />
              </label>
            )}
            <label className="wide">
              เหตุผลกรณีพิเศษ / หลักฐาน
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </label>
          </div>
          {preview && (
            <div className="ah-preview">
              <div className={`ah-slot ${preview.slot.mode}`}>
                <small>วันที่ของจะไปถึง</small>
                <strong>{preview.slot.delivery_date ? new Date(`${preview.slot.delivery_date}T00:00:00`).toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "short" }) : "—"}</strong>
                <span>{MODE_LABEL[preview.slot.mode] ?? preview.slot.mode}{preview.slot.vehicle ? ` · ${preview.slot.vehicle}` : ""}</span>
                <p>{preview.slot.message}</p>
                {preview.slot.cutoff_at && (
                  <small>ตัดรอบ {new Date(preview.slot.cutoff_at).toLocaleString("th-TH", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })}</small>
                )}
              </div>
              <CheckSummary
                check={preview.check}
                unit={text(data.materials.find((row) => text(row.material_id) === materialId)?.unit ?? "", "")}
              />
            </div>
          )}
          <div className="pipeline-actions">
            <button className="btn primary" disabled={actionBusy}>
              สร้างรายการจ่ายกรณีพิเศษ
            </button>
          </div>
        </form>
      )}
      <section className="panel">
        <LiveTable
          rows={data.adHocIssues}
          empty="ยังไม่มีรายการจ่ายกรณีพิเศษ"
          columns={[
            ["เลขที่จ่าย", (row) => row.issue_number],
            ["วัสดุ", (row) => row.material_id],
            ["เขต", (row) => row.district_id],
            ["จำนวน", (row) => formatNumber(row.requested_qty, 2)],
            ["จ่ายแล้ว", (row) => formatNumber(row.allocated_qty, 2)],
            [
              "ส่งรอบ",
              (row) => (
                <span>
                  {row.delivery_date ? new Date(`${text(row.delivery_date)}T00:00:00`).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" }) : "—"}
                  <small>{MODE_LABEL[text(row.delivery_mode, "")] ?? ""}{row.urgency_code && row.urgency_code !== "normal" ? ` · ${URGENCY_LABEL[text(row.urgency_code)] ?? ""}` : ""}</small>
                </span>
              ),
            ],
            [
              "ตรวจปริมาณ",
              (row) =>
                row.alert_level === "high" ? <Badge>ผิดปกติมาก</Badge>
                : row.alert_level === "medium" ? <Badge>สูงกว่าปกติ</Badge>
                : row.alert_level === "normal" ? "ปกติ" : "—",
            ],
            ["ผู้ขอ", (row) => row.requester_name],
            ["สถานะ", (row) => <Badge>{text(row.status)}</Badge>],
            [
              "การดำเนินการ",
              (row) => (
                <span className="table-actions">
                  {["admin", "planner"].includes(role) &&
                    row.status === "pending_approval" && (
                      <button
                        className="table-action"
                        onClick={() => {
                          setApproveRow(row);
                          setApprovalNote("");
                        }}
                      >
                        อนุมัติ
                      </button>
                    )}
                  {["admin", "picker"].includes(role) &&
                    row.status === "approved" && (
                      <button
                        className="table-action"
                        disabled={actionBusy}
                        onClick={() =>
                          void onIssue(text(row.ad_hoc_issue_id))
                        }
                      >
                        จ่าย
                      </button>
                    )}
                </span>
              ),
            ],
          ]}
        />
      </section>
      {approveRow && (
        <form className="pipeline-form compact" onSubmit={approve}>
          <label>
            หมายเหตุการอนุมัติ
            <textarea
              value={approvalNote}
              onChange={(event) => setApprovalNote(event.target.value)}
              required
            />
          </label>
          <div className="pipeline-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => setApproveRow(null)}
            >
              ยกเลิก
            </button>
            <button className="btn primary" disabled={actionBusy}>
              อนุมัติ + จอง FIFO
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function TraceView({
  actionBusy,
  data,
  role,
  onReturn,
}: {
  actionBusy: boolean;
  data: DashboardData;
  role: Role;
  onReturn: (
    sourceIssueMovementId: string,
    quantity: number,
    damaged: boolean,
    reason: string,
  ) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [returnRow, setReturnRow] = useState<RecordRow | null>(null);
  const [returnQty, setReturnQty] = useState("");
  const [damaged, setDamaged] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const canReturn = ["admin", "picker"].includes(role);
  const rows = data.traceability.filter((row) => {
    const value = query.trim().toLowerCase();
    return (
      !value ||
      Object.values(row)
        .map((item) => text(item, ""))
        .join(" ")
        .toLowerCase()
        .includes(value)
    );
  });
  const submitReturn = async (event: FormEvent) => {
    event.preventDefault();
    if (!returnRow) return;
    const quantity = Number(returnQty);
    const sourceId = text(returnRow.inventory_movement_id);
    if (
      !sourceId ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity > Number(returnRow.issued_qty) ||
      returnReason.trim().length < 3
    ) {
      return;
    }
    const ok = await onReturn(
      sourceId,
      quantity,
      damaged,
      returnReason.trim(),
    );
    if (ok) {
      setReturnRow(null);
      setReturnQty("");
      setDamaged(false);
      setReturnReason("");
    }
  };
  return (
    <div className="stack">
      <section className="filter-bar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ค้นหา: เลขที่จ่าย / วัสดุ / หน่วยจัดเก็บ / สัญญา / PO / ผู้ขาย"
          aria-label="ค้นหาการสอบกลับ"
        />
      </section>
      <section className="panel">
        <LiveTable
          rows={rows}
          empty="ยังไม่มีการจ่ายสต็อก"
          columns={[
            ["จ่ายเมื่อ", (row) => formatDateTime(row.occurred_at)],
            ["เลขที่จ่าย", (row) => row.issue_reference],
            ["ประเภท", (row) => <Badge>{text(row.issue_type)}</Badge>],
            ["เขต", (row) => row.district_id],
            ["วัสดุ", (row) => row.material_id],
            ["จำนวน", (row) => formatNumber(row.issued_qty, 2)],
            ["HU", (row) => row.handling_unit_code],
            ["Lot", (row) => row.lot_code],
            ["วันรับ", (row) => row.acceptance_date],
            ["PO / รายการ", (row) => `${text(row.purchase_order)} / ${text(row.line_item)}`],
            ["สัญญา", (row) => row.contract_number],
            ["ผู้ขาย", (row) => row.vendor_name],
            ...(canReturn
              ? [
                  [
                    "รับคืน",
                    (row: RecordRow) => (
                      <button
                        type="button"
                        className="table-action"
                        onClick={() => {
                          setReturnRow(row);
                          setReturnQty("");
                          setDamaged(false);
                          setReturnReason("");
                        }}
                      >
                        รับคืน
                      </button>
                    ),
                  ] as [string, (row: RecordRow) => ReactNode],
                ]
              : []),
          ]}
        />
      </section>
      {returnRow && (
        <form className="pipeline-form compact" onSubmit={submitReturn}>
          <div className="panel-title">
            <div>
              <span>บันทึกการรับคืน</span>
              <h3>
                {text(returnRow.issue_reference)} ·{" "}
                {text(returnRow.handling_unit_code)}
              </h3>
            </div>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setReturnRow(null)}
            >
              ปิด
            </button>
          </div>
          <div className="form-grid">
            <label>
              จำนวนรับคืน (สูงสุด {formatNumber(returnRow.issued_qty, 2)})
              <input
                type="number"
                min="0.000001"
                max={Number(returnRow.issued_qty)}
                step="any"
                value={returnQty}
                onChange={(event) => setReturnQty(event.target.value)}
                required
              />
            </label>
            <label className="pipeline-check">
              <input
                type="checkbox"
                checked={damaged}
                onChange={(event) => setDamaged(event.target.checked)}
              />
              ชำรุด / ทดสอบไม่ผ่าน → กักกัน
            </label>
            <label className="wide">
              เหตุผลการรับคืน / หลักฐาน
              <textarea
                value={returnReason}
                onChange={(event) => setReturnReason(event.target.value)}
                minLength={3}
                required
              />
            </label>
          </div>
          <div className="pipeline-actions">
            <button className="btn primary" disabled={actionBusy}>
              บันทึกรับคืน
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function StockView({ data }: { data: DashboardData }) {
  const hasTestFixture = data.stock.some(
    (row) =>
      row.fixture_backed === true ||
      row.fixture_backed === "true" ||
      row.input_data_class === "test_fixture" ||
      row.input_data_class === "mixed",
  );
  return (
    <div className="stack">
      {hasTestFixture && (
        <section className="plain-notice warning">
          <i>!</i>
          <div>
            <strong>กำลังใช้ข้อมูลทดสอบ (UAT)</strong>
            <p>
              สต็อกเขตหรือ CMP ในหน้านี้มีค่าจากไฟล์ทดสอบรวมอยู่ด้วย
              ไม่ใช่ข้อมูลจริงจาก SAP และห้ามใช้ตัดสินใจจ่ายจริง
            </p>
          </div>
        </section>
      )}
      <section className="plain-notice info">
        <i>i</i>
        <div>
          <strong>หลักเกณฑ์การนับสต็อก</strong>
          <p>
            นับเฉพาะของพร้อมใช้ ไม่รวมของระหว่างโอน หากไม่มีข้อมูลวัสดุ + คลัง
            จะแสดงเป็น 0 พร้อมหมายเหตุ “ไม่มีข้อมูล / ถือเป็น 0”
          </p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>สุขภาพสต็อกเขต</span>
            <h3>สต็อกและ CMP ล่าสุด</h3>
          </div>
          <b>{formatNumber(data.stock.length)}</b>
        </div>
        <LiveTable
          rows={data.stock}
          empty="ยังไม่มีข้อมูลสต็อกเขต"
          columns={[
            ["วัสดุ", (row) => row.material_id],
            ["เขต", (row) => row.district_id],
            ["สต็อก", (row) => formatNumber(row.current_stock_qty, 2)],
            ["CMP", (row) => formatNumber(row.cmp_monthly, 2)],
            ["เดือน", (row) => formatNumber(row.months_available, 1)],
            ["สถานะ", (row) => <Badge>{text(row.health_band)}</Badge>],
            ["แหล่งที่มา", (row) => row.stock_source_status],
            ["เวลาข้อมูล", (row) => formatDateTime(row.snapshot_at)],
          ]}
        />
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>สต็อกคลัง</span>
            <h3>ข้อมูลสต็อกจริงคลังคลองเตย</h3>
          </div>
          <b>{formatNumber(data.warehouseStock.length)}</b>
        </div>
        <LiveTable
          rows={data.warehouseStock}
          empty="ยังไม่มีข้อมูลสต็อกคลัง"
          columns={[
            ["วัสดุ", (row) => row.material_id],
            ["รายละเอียด", (row) => row.material_name],
            ["จำนวน", (row) => formatNumber(row.quantity_on_hand, 2)],
            ["หน่วย", (row) => row.unit],
            ["สถานที่", (row) => row.location_name_th],
            ["เวลาข้อมูล", (row) => formatDateTime(row.snapshot_at)],
          ]}
        />
      </section>
    </div>
  );
}

type ImportSourceKey = "stock" | "usage" | "contracts" | "history";
const importSequence: ImportSourceKey[] = [
  "stock",
  "usage",
  "contracts",
  "history",
];
const historicalSheetNames = [
  "History จ่ายได้ตามแผน",
  "History ไม่รับของ",
];
type ImportedSheet = {
  headers: string[];
  rows: string[][];
  sheetName: string;
  totalRows: number;
};
type ImportHistoryRecord = {
  id: string;
  sourceKey: ImportSourceKey;
  fileName: string;
  importedAt: string;
  importedBy: string;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  status: "published" | "needs_review" | "failed";
  version: number;
};

type PublishedDataSnapshot = {
  id: string;
  version: number;
  publishedAt: string;
  publishedBy: string;
  batches: Array<{
    sourceKey: ImportSourceKey;
    fileName: string;
    acceptedCount: number;
    rejectedCount: number;
    version: number;
  }>;
};

const publishedSnapshotStorageKey = "mea-synapse.local-published-data-snapshot";

function loadPublishedSnapshot(): PublishedDataSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(publishedSnapshotStorageKey);
    if (!value) return null;
    const parsed = JSON.parse(value) as PublishedDataSnapshot;
    return parsed?.id && parsed?.publishedAt && Array.isArray(parsed.batches)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

const initialImportHistory: ImportHistoryRecord[] = [
  {
    id: "IMP-ST-20260721-003",
    sourceKey: "stock",
    fileName: "Stock_2026-07-21.xlsx",
    importedAt: "2026-07-21T07:00:00+07:00",
    importedBy: "Admin",
    rowCount: 2_223,
    acceptedCount: 2_218,
    rejectedCount: 5,
    status: "published",
    version: 3,
  },
  {
    id: "IMP-PO-20260721-006",
    sourceKey: "contracts",
    fileName: "รวมสัญญา_2026-07-21.xlsx",
    importedAt: "2026-07-21T06:30:00+07:00",
    importedBy: "Admin",
    rowCount: 4_806,
    acceptedCount: 4_791,
    rejectedCount: 15,
    status: "published",
    version: 6,
  },
  {
    id: "IMP-HX-20260718-002",
    sourceKey: "history",
    fileName: "คลังคลองเตย_2026-07-18.xlsx",
    importedAt: "2026-07-18T15:42:00+07:00",
    importedBy: "Admin",
    rowCount: 1_348,
    acceptedCount: 1_348,
    rejectedCount: 0,
    status: "published",
    version: 2,
  },
  {
    id: "IMP-CM-20260701-004",
    sourceKey: "usage",
    fileName: "อัตราการใช้งาน_2026-07.xlsx",
    importedAt: "2026-07-01T09:15:00+07:00",
    importedBy: "Admin",
    rowCount: 2_000,
    acceptedCount: 1_992,
    rejectedCount: 8,
    status: "published",
    version: 4,
  },
  {
    id: "IMP-ST-20260720-002",
    sourceKey: "stock",
    fileName: "Stock_2026-07-20.xlsx",
    importedAt: "2026-07-20T07:02:00+07:00",
    importedBy: "Admin",
    rowCount: 2_218,
    acceptedCount: 2_218,
    rejectedCount: 0,
    status: "published",
    version: 2,
  },
  {
    id: "IMP-PO-20260720-005",
    sourceKey: "contracts",
    fileName: "รวมสัญญา_2026-07-20.xlsx",
    importedAt: "2026-07-20T06:35:00+07:00",
    importedBy: "Admin",
    rowCount: 4_781,
    acceptedCount: 4_769,
    rejectedCount: 12,
    status: "published",
    version: 5,
  },
];

const importProfiles: Record<
  ImportSourceKey,
  {
    title: string;
    subtitle: string;
    schedule: string;
    icon: string;
    fileHint: string;
    required: Array<{ label: string; aliases: string[] }>;
    rules: string[];
  }
> = {
  stock: {
    title: "Stock Snapshot",
    subtitle: "Stock คลังกลางและคลังเขตจาก SAP",
    schedule: "รายวัน",
    icon: "ST",
    fileHint: "Stock.xlsx",
    required: [
      {
        label: "Material",
        aliases: ["material", "materialnumber", "materialno", "วัสดุ", "เลขวัสดุ", "รหัสวัสดุ"],
      },
      { label: "Plant", aliases: ["plant", "โรงงาน"] },
      {
        label: "Storage Location",
        aliases: ["storagelocation", "sloc", "ที่เก็บสินค้า", "สถานที่เก็บ", "คลังย่อย"],
      },
      {
        label: "Unrestricted",
        aliases: ["unrestricted", "ไม่จำกัด", "ยอดไม่จำกัด"],
      },
    ],
    rules: [
      "ใช้ Stock คอลัมน์ไม่จำกัดเท่านั้น",
      "คลังคลองเตย = Plant 2401 / Storage Location 0001",
      "Stock เขตสรุปทุก Storage Location ที่อนุญาตของ Plant นั้น",
    ],
  },
  usage: {
    title: "Usage Rate / CMP",
    subtitle: "ประวัติการใช้งานและค่า CMP รายเดือน",
    schedule: "รายเดือน",
    icon: "CM",
    fileHint: "อัตราการใช้งาน.xlsx",
    required: [
      {
        label: "Material",
        aliases: ["material", "materialnumber", "materialno", "วัสดุ", "เลขวัสดุ", "รหัสวัสดุ"],
      },
      { label: "LY", aliases: ["ly", "lastyear"] },
      { label: "12M", aliases: ["12m", "12เดือน"] },
      { label: "6M", aliases: ["6m", "6เดือน"] },
      { label: "4M", aliases: ["4m", "4เดือน"] },
    ],
    rules: [
      "เครื่องหมาย - แทนเดือนที่ไม่มีการใช้งานและตีค่าเป็น 0",
      "CMP = ค่าเฉลี่ย LY, 12M, 6M และ 4M",
      "CMP ปัดเป็นจำนวนเต็มก่อนคำนวณแผน",
    ],
  },
  contracts: {
    title: "Contract & Delivery Lot",
    subtitle: "สัญญา PO ผู้ขาย และงวดส่งมอบ",
    schedule: "รายวัน",
    icon: "PO",
    fileHint: "รวมสัญญา.xlsx",
    required: [
      {
        label: "Material",
        aliases: ["material", "materialnumber", "materialno", "วัสดุ", "เลขวัสดุ", "รหัสวัสดุ"],
      },
      {
        label: "PO / Contract",
        aliases: ["po", "purchaseorder", "สัญญา", "เลขที่po", "รหัสจัดหา"],
      },
      {
        label: "Accepted Date",
        aliases: ["วันผ่านตรวจรับ", "accepteddate", "receiptdate", "วันที่รับ"],
      },
    ],
    rules: [
      "นำเข้าเฉพาะแถวที่มี Material",
      "อัปเดตของเดิมและเพิ่มสัญญาใหม่ใน Snapshot เดียวกัน",
      "ใช้วันผ่านตรวจรับเป็นหลักฐานลำดับ FIFO",
    ],
  },
  history: {
    title: "Historical Distribution Data",
    subtitle: "ประวัติการจ่ายได้ตามแผนและประวัติไม่รับของสำหรับ AI",
    schedule: "นำเข้าข้อมูลตั้งต้น",
    icon: "HX",
    fileHint: "คลังคลองเตย (1).xlsx",
    required: [
      { label: "Material", aliases: ["material", "รหัสพัสดุ", "รหัสวัสดุ"] },
      {
        label: "District",
        aliases: ["sourcesheet", "district", "เขต", "การไฟฟ้าเขต"],
      },
      {
        label: "Planned Quantity",
        aliases: ["จำนวนการเติมเต็มพัสดุ", "plannedquantity", "plannerqty"],
      },
      {
        label: "Actual Quantity",
        aliases: ["จำนวนที่จ่ายได้จริง", "actualquantity", "actualqty"],
      },
      {
        label: "Outcome",
        aliases: ["สถานะการจ่าย", "outcome", "status"],
      },
    ],
    rules: [
      "อ่านเฉพาะชีท History จ่ายได้ตามแผน และ History ไม่รับของ",
      "เก็บผลลัพธ์ ACCEPTED และ REJECTED แยกกัน โดยไม่ตีความการไม่รับเป็น Usage = 0",
      "ใช้ประวัติรายรายการเป็น Evidence ของ AI Suggestion และการแจ้งเตือนคำขอผิดปกติ",
    ],
  },
};

function normalizeImportHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_./\\()\-]+/g, "");
}

function findImportColumn(headers: string[], aliases: string[]) {
  // Excel rows can be sparse when the source sheet contains blank columns.
  // Array#map preserves those empty slots, while findIndex still visits them
  // as undefined values. Normalize every position explicitly so Historical
  // sheets with column gaps can be matched safely.
  const normalizedHeaders = Array.from(
    { length: headers.length },
    (_, index) => normalizeImportHeader(headers[index]),
  );
  const normalizedAliases = aliases.map(normalizeImportHeader).filter(Boolean);
  const exactIndex = normalizedHeaders.findIndex((header) =>
    normalizedAliases.includes(header),
  );
  if (exactIndex >= 0) return exactIndex;
  return normalizedHeaders.findIndex((header) =>
    normalizedAliases.some(
      (alias) => alias.length >= 3 && (header.includes(alias) || alias.includes(header)),
    ),
  );
}

function importedSheetFromMatrix(
  matrix: string[][],
  sheetName: string,
  required: Array<{ label: string; aliases: string[] }>,
): ImportedSheet {
  const candidates = matrix.slice(0, 30);
  let headerIndex = 0;
  let bestScore = -1;
  candidates.forEach((row, index) => {
    const score = required.filter(
      (requirement) => findImportColumn(row, requirement.aliases) >= 0,
    ).length;
    if (score > bestScore) {
      bestScore = score;
      headerIndex = index;
    }
  });
  return {
    headers: matrix[headerIndex] ?? [],
    rows: matrix.slice(headerIndex + 1, headerIndex + 5001),
    sheetName,
    totalRows: Math.max(0, matrix.length - headerIndex - 1),
  };
}

function parseCsvMatrix(source: string) {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) matrix.push(row);
  return matrix;
}

function excelColumnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return [...letters].reduce(
    (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
    0,
  ) - 1;
}

function parseExcelWorksheet(
  parser: DOMParser,
  source: Uint8Array,
  shared: string[],
) {
  const worksheet = parser.parseFromString(
    new TextDecoder().decode(source),
    "text/xml",
  );
  return [...worksheet.getElementsByTagName("row")]
    .map((rowNode) => {
      const values: string[] = [];
      [...rowNode.getElementsByTagName("c")].forEach((cellNode) => {
        const column = excelColumnIndex(cellNode.getAttribute("r") ?? "A1");
        const kind = cellNode.getAttribute("t") ?? "";
        const raw = cellNode.getElementsByTagName("v")[0]?.textContent ?? "";
        const value =
          kind === "s"
            ? shared[Number(raw)] ?? ""
            : kind === "inlineStr"
              ? cellNode.getElementsByTagName("is")[0]?.textContent ?? ""
              : raw;
        values[column] = value.trim();
      });
      return values;
    })
    .filter((row) => row.some(Boolean));
}

async function readImportSheets(
  file: File,
  required: Array<{ label: string; aliases: string[] }>,
  requestedSheetNames?: string[],
): Promise<ImportedSheet[]> {
  if (file.name.toLowerCase().endsWith(".csv")) {
    if (requestedSheetNames?.length) {
      throw new Error("ข้อมูล Historical ต้องเป็นไฟล์ .xlsx ที่มี 2 ชีทตามที่กำหนด");
    }
    const matrix = parseCsvMatrix(await file.text());
    return [importedSheetFromMatrix(matrix, "CSV", required)];
  }

  const { strFromU8, unzipSync } = await import("fflate");
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const parser = new DOMParser();
  const sharedXml = archive["xl/sharedStrings.xml"];
  const shared = sharedXml
    ? [...parser.parseFromString(strFromU8(sharedXml), "text/xml").getElementsByTagName("si")].map(
        (node) => node.textContent ?? "",
      )
    : [];
  const workbookXml = archive["xl/workbook.xml"];
  if (!workbookXml) throw new Error("ไม่พบ Workbook ในไฟล์ Excel");
  const workbook = parser.parseFromString(strFromU8(workbookXml), "text/xml");
  const relationshipXml = archive["xl/_rels/workbook.xml.rels"];
  const relationships = relationshipXml
    ? [...parser.parseFromString(strFromU8(relationshipXml), "text/xml").getElementsByTagName("Relationship")]
    : [];
  const targetById = new Map(
    relationships.map((node) => [
      node.getAttribute("Id") ?? "",
      node.getAttribute("Target") ?? "",
    ]),
  );
  const fallbackPaths = Object.keys(archive)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/sheet(\d+)/i)?.[1] ?? 0);
      const rightNumber = Number(right.match(/sheet(\d+)/i)?.[1] ?? 0);
      return leftNumber - rightNumber;
    });
  const workbookSheets = [...workbook.getElementsByTagName("sheet")].map(
    (node, index) => {
      const relationshipId = node.getAttribute("r:id") ?? "";
      const target = targetById.get(relationshipId) ?? "";
      const path = target
        ? target.startsWith("/")
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, "")}`
        : fallbackPaths[index];
      return {
        name: node.getAttribute("name") ?? `Sheet ${index + 1}`,
        path,
      };
    },
  );
  const selected = requestedSheetNames?.length
    ? requestedSheetNames.map((requestedName) =>
        workbookSheets.find(
          (item) => normalizeImportHeader(item.name) === normalizeImportHeader(requestedName),
        ),
      )
    : [workbookSheets[0]];
  if (selected.some((item) => !item?.path || !archive[item.path])) {
    const missingNames = requestedSheetNames?.filter(
      (requestedName) =>
        !workbookSheets.some(
          (item) => normalizeImportHeader(item.name) === normalizeImportHeader(requestedName),
        ),
    );
    throw new Error(
      missingNames?.length
        ? `ไม่พบชีทที่จำเป็น: ${missingNames.join(", ")}`
        : "ไม่พบ Worksheet ในไฟล์ Excel",
    );
  }
  return selected.map((item) => {
    const matrix = parseExcelWorksheet(parser, archive[item!.path], shared);
    return importedSheetFromMatrix(matrix, item!.name, required);
  });
}

async function readImportSheet(
  file: File,
  required: Array<{ label: string; aliases: string[] }>,
): Promise<ImportedSheet> {
  const sheets = await readImportSheets(file, required);
  if (!sheets[0]) throw new Error("ไม่พบ Worksheet ในไฟล์ Excel");
  return sheets[0];
}

function DataImportView({ onOpenPlanner }: { onOpenPlanner: () => void }) {
  const [sourceKey, setSourceKey] = useState<ImportSourceKey>("stock");
  const [completedSequence, setCompletedSequence] = useState<ImportSourceKey[]>([]);
  // Start empty during SSR, then restore the local snapshot on the client.
  // This avoids a server/client HTML mismatch when the browser already has a
  // previously published Local Demo snapshot in localStorage.
  const [publishedSnapshot, setPublishedSnapshot] = useState<PublishedDataSnapshot | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<ImportedSheet | null>(null);
  const [historicalSheets, setHistoricalSheets] = useState<ImportedSheet[]>([]);
  const [history, setHistory] = useState<ImportHistoryRecord[]>(
    initialImportHistory,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [manualMapping, setManualMapping] = useState<Record<string, number>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const profile = importProfiles[sourceKey];
  const latestImport = history[0] ?? null;
  const nextRequiredSource = importSequence[completedSequence.length] ?? null;
  const sequenceComplete = completedSequence.length === importSequence.length;
  const snapshotPublishedAt = publishedSnapshot?.publishedAt ?? null;

  useEffect(() => {
    const restoreSnapshot = window.setTimeout(() => {
      setPublishedSnapshot(loadPublishedSnapshot());
    }, 0);
    return () => window.clearTimeout(restoreSnapshot);
  }, []);

  const validation = useMemo(() => {
    if (!sheet) return null;
    const sheetsToValidate =
      sourceKey === "history" && historicalSheets.length ? historicalSheets : [sheet];
    const createMatches = (candidate: ImportedSheet) =>
      profile.required.map((requirement) => {
        const manuallySelected = Object.prototype.hasOwnProperty.call(
          manualMapping,
          requirement.label,
        );
        return {
          ...requirement,
          manuallySelected,
          index: manuallySelected
            ? manualMapping[requirement.label]
            : findImportColumn(candidate.headers, requirement.aliases),
        };
      });
    const sheetStats = sheetsToValidate.map((candidate) => {
      const candidateMatches = createMatches(candidate);
      const materialColumn =
        candidateMatches.find((item) => item.label === "Material")?.index ?? -1;
      const invalidRows = candidate.rows.filter((row) =>
        materialColumn >= 0 ? !String(row[materialColumn] ?? "").trim() : false,
      ).length;
      return {
        sheet: candidate,
        matches: candidateMatches,
        missing: candidateMatches.filter((item) => item.index < 0),
        invalidRows,
        validRows: Math.max(0, candidate.totalRows - invalidRows),
      };
    });
    const matches = createMatches(sheet);
    const missingLabels = new Set(
      sheetStats.flatMap((item) => item.missing.map((match) => match.label)),
    );
    const invalidRows = sheetStats.reduce((sum, item) => sum + item.invalidRows, 0);
    const totalRows = sheetStats.reduce((sum, item) => sum + item.sheet.totalRows, 0);
    return {
      matches,
      missing: profile.required.filter((item) => missingLabels.has(item.label)),
      invalidRows,
      validRows: Math.max(0, totalRows - invalidRows),
      totalRows,
      sheetStats,
    };
  }, [historicalSheets, manualMapping, profile, sheet, sourceKey]);

  const resetFile = () => {
    setFile(null);
    setSheet(null);
    setHistoricalSheets([]);
    setError("");
    setReviewOpen(false);
    setManualMapping({});
    if (inputRef.current) inputRef.current.value = "";
  };

  const loadFile = async (nextFile: File | undefined) => {
    if (!nextFile) return;
    if (!/\.(xlsx|csv)$/i.test(nextFile.name)) {
      setError("รองรับเฉพาะไฟล์ .xlsx และ .csv");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const parsedSheets =
        sourceKey === "history"
          ? await readImportSheets(nextFile, profile.required, historicalSheetNames)
          : [await readImportSheet(nextFile, profile.required)];
      const parsed = parsedSheets[0];
      if (!parsed?.headers.length) throw new Error("ไม่พบหัวตารางในไฟล์");
      setFile(nextFile);
      setSheet(parsed);
      setHistoricalSheets(sourceKey === "history" ? parsedSheets : []);
      setReviewOpen(true);
    } catch (loadError) {
      setFile(null);
      setSheet(null);
      setHistoricalSheets([]);
      setError(
        loadError instanceof Error ? loadError.message : "ไม่สามารถอ่านไฟล์ได้",
      );
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void loadFile(event.target.files?.[0]);
  };

  const confirmImport = () => {
    if (!file || !sheet || !validation || validation.missing.length || busy) return;
    const sourceIndex = importSequence.indexOf(sourceKey);
    if (sourceIndex !== completedSequence.length) return;
    const nextVersion =
      Math.max(
        0,
        ...history
          .filter((record) => record.sourceKey === sourceKey)
          .map((record) => record.version),
      ) + 1;
    const nextRecord: ImportHistoryRecord = {
      id: `IMP-${sourceKey.toUpperCase()}-${Date.now()}`,
      sourceKey,
      fileName: file.name,
      importedAt: new Date().toISOString(),
      importedBy: "Admin",
      rowCount: validation.totalRows,
      acceptedCount: validation.validRows,
      rejectedCount: validation.invalidRows,
      status: validation.invalidRows > 0 ? "needs_review" : "published",
      version: nextVersion,
    };
    setHistory((current) => [nextRecord, ...current]);
    const nextCompleted = [...completedSequence, sourceKey];
    setCompletedSequence(nextCompleted);
    const nextSource = importSequence[nextCompleted.length];
    setReviewOpen(false);
    setFile(null);
    setSheet(null);
    setHistoricalSheets([]);
    setError("");
    setManualMapping({});
    if (inputRef.current) inputRef.current.value = "";
    if (nextSource) setSourceKey(nextSource);
  };

  const restartSequence = () => {
    setCompletedSequence([]);
    setSourceKey("stock");
    resetFile();
  };

  const publishSnapshot = () => {
    if (!sequenceComplete) return;
    const publishedAt = new Date().toISOString();
    const nextVersion = (publishedSnapshot?.version ?? 0) + 1;
    const nextSnapshot: PublishedDataSnapshot = {
      id: `SNAP-${publishedAt.replace(/[-:TZ.]/g, "").slice(0, 14)}-V${nextVersion}`,
      version: nextVersion,
      publishedAt,
      publishedBy: "Admin",
      batches: importSequence.map((key) => {
        const record = [...history]
          .filter((item) => item.sourceKey === key)
          .sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0];
        return {
          sourceKey: key,
          fileName: record?.fileName ?? "—",
          acceptedCount: record?.acceptedCount ?? 0,
          rejectedCount: record?.rejectedCount ?? 0,
          version: record?.version ?? 0,
        };
      }),
    };
    window.localStorage.setItem(publishedSnapshotStorageKey, JSON.stringify(nextSnapshot));
    setPublishedSnapshot(nextSnapshot);
  };

  useEffect(() => {
    if (!reviewOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") resetFile();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [reviewOpen]);

  return (
    <div className="stack import-page">
      <section className="import-hero">
        <div>
          <span>DATA FOUNDATION · LOCAL / STAGING</span>
          <h2>จากไฟล์ SAP สู่ข้อมูลพร้อมใช้งาน</h2>
          <p>
            นำเข้า ตรวจสอบ และประมวลผลเป็น Snapshot ก่อนส่งต่อให้แต่ละ Module
            โดยไม่เขียนทับข้อมูลเดิมทันที
          </p>
        </div>
        <div className="import-hero-actions">
          <div className="import-hero-state">
            <i />
            <span>
              <small>Environment</small>
              <strong>LOCAL PREVIEW</strong>
            </span>
          </div>
        </div>
      </section>

      <section className="import-overview" aria-label="สถานะการนำเข้าล่าสุด">
        <article className="import-latest-card">
          <span>LAST IMPORT</span>
          <strong>{latestImport ? formatDateTime(latestImport.importedAt) : "—"}</strong>
          <small>
            {latestImport
              ? `${importProfiles[latestImport.sourceKey].title} · ${latestImport.fileName}`
              : "ยังไม่มีประวัติการนำเข้า"}
          </small>
        </article>
        <article>
          <span>IMPORT BATCHES</span>
          <strong>{formatNumber(history.length)}</strong>
          <small>เก็บเป็นเวอร์ชัน ไม่เขียนทับประวัติ</small>
        </article>
        <article>
          <span>ACCEPTED ROWS</span>
          <strong>
            {formatNumber(history.reduce((sum, record) => sum + record.acceptedCount, 0))}
          </strong>
          <small>จำนวนแถวที่ผ่านการตรวจทั้งหมด</small>
        </article>
        <article>
          <span>NEEDS REVIEW</span>
          <strong>
            {formatNumber(history.reduce((sum, record) => sum + record.rejectedCount, 0))}
          </strong>
          <small>เก็บแยกเพื่อตรวจสอบ ไม่ทิ้งข้อมูล</small>
        </article>
      </section>

      <section className="panel import-sequence-panel" aria-label="ลำดับการนำเข้าข้อมูล">
        <div className="panel-title import-sequence-title">
          <div>
            <span>ORDERED IMPORT · ADMIN WORKFLOW</span>
            <h3>นำเข้าข้อมูลตามลำดับ 1–4 เพื่อป้องกันข้อมูลตกหล่น</h3>
            <p>
              เลือกไฟล์จากกล่องปัจจุบัน ตรวจสอบข้อมูลใน Pop-up และกดยืนยัน
              ระบบจึงจะเปิดกล่องถัดไปให้อัตโนมัติ
            </p>
          </div>
          <div className={`import-sequence-progress ${sequenceComplete ? "complete" : ""}`}>
            <strong>{completedSequence.length} / {importSequence.length}</strong>
            <small>{sequenceComplete ? "ครบทุกแหล่งข้อมูล" : "เสร็จแล้วในรอบนี้"}</small>
          </div>
        </div>

        <div className="import-sequence-grid">
          {importSequence.map((key, index) => {
            const item = importProfiles[key];
            const completed = completedSequence.includes(key);
            const current = key === nextRequiredSource && !sequenceComplete;
            const locked = index > completedSequence.length;
            const selected = sourceKey === key;
            return (
              <button
                type="button"
                key={key}
                className={`${selected ? "selected" : ""} ${completed ? "completed" : ""} ${current ? "current" : ""}`}
                disabled={locked}
                aria-current={selected ? "step" : undefined}
                aria-label={
                  current
                    ? `Import ${item.fileHint}`
                    : completed
                      ? `${item.title} ยืนยันแล้ว`
                      : `${item.title} รอขั้นตอนก่อนหน้า`
                }
                onClick={() => {
                  if (locked || completed) return;
                  setSourceKey(key);
                  resetFile();
                  window.setTimeout(() => inputRef.current?.click(), 0);
                }}
              >
                <i>{completed ? "✓" : locked ? "🔒" : index + 1}</i>
                <span>
                  <b>STEP {index + 1}</b>
                  <strong>{item.title}</strong>
                  <small>{item.fileHint} · {item.schedule}</small>
                  <em>
                    {completed
                      ? "✓ ยืนยันแล้ว"
                      : current
                        ? "⇧ Import File"
                        : "🔒 รอขั้นตอนก่อนหน้า"}
                  </em>
                </span>
              </button>
            );
          })}
        </div>

        <input
          ref={inputRef}
          className="import-hidden-input"
          type="file"
          accept=".xlsx,.csv"
          onChange={onFileChange}
          aria-label={`เลือกไฟล์ ${profile.fileHint}`}
        />

        {error && (
          <div className="form-error import-sequence-error" role="alert">
            {error}
          </div>
        )}

        <footer className={`import-readiness-strip ${sequenceComplete ? "ready" : ""} ${snapshotPublishedAt ? "published" : ""}`}>
          <div>
            <i>{sequenceComplete ? "✓" : "!"}</i>
            <span>
              <strong>
                {sequenceComplete && snapshotPublishedAt
                  ? "Data Snapshot: Published"
                  : sequenceComplete
                    ? "Data Readiness: Ready to publish"
                    : snapshotPublishedAt
                      ? "Data Snapshot: Published · new import in progress"
                    : "Data Readiness: In progress"}
              </strong>
              <small>
                {sequenceComplete && snapshotPublishedAt
                  ? `Snapshot v${publishedSnapshot?.version} · ${publishedSnapshot?.id} · ยืนยันเมื่อ ${formatDateTime(snapshotPublishedAt)}`
                  : sequenceComplete
                    ? "ข้อมูลทั้ง 4 แหล่งผ่านการตรวจแล้ว กรุณายืนยันก่อนส่งต่อให้ Module"
                    : snapshotPublishedAt
                      ? `Planner ใช้ Snapshot v${publishedSnapshot?.version} ล่าสุดได้ระหว่างนำเข้ารอบใหม่`
                    : `รายการถัดไป: ${nextRequiredSource ? importProfiles[nextRequiredSource].title : "—"}`}
              </small>
            </span>
          </div>
          {(sequenceComplete || snapshotPublishedAt) && (
            <div className="import-publish-actions">
              {sequenceComplete && (
                <button type="button" className="btn import-publish-button" onClick={publishSnapshot}>
                  {snapshotPublishedAt ? "Publish New Data Snapshot" : "Publish Data Snapshot"}
                  <small>{snapshotPublishedAt ? "เผยแพร่ Snapshot เวอร์ชันใหม่" : "ยืนยันชุดข้อมูลและนำไปใช้งาน"}</small>
                </button>
              )}
              {snapshotPublishedAt && (
                <>
                  <button type="button" className="btn primary" onClick={onOpenPlanner}>
                    ไปที่ Planner Workspace →
                  </button>
                  {sequenceComplete && (
                    <button type="button" className="btn ghost" onClick={restartSequence}>
                      เริ่มรอบ Import ใหม่
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </footer>
      </section>

      {snapshotPublishedAt && publishedSnapshot && (
        <section className="panel published-snapshot-panel" aria-label="Published Data Snapshot">
          <div className="panel-title">
            <div>
              <span>DATA SNAPSHOT · PUBLISHED</span>
              <h3>ชุดข้อมูลที่ Planner ใช้งานอยู่</h3>
              <p>
                ระบบเก็บรายการแหล่งข้อมูลและเวอร์ชันที่ประกอบเป็น Snapshot นี้ไว้สำหรับสอบกลับ
              </p>
            </div>
            <Badge>v{publishedSnapshot.version}</Badge>
          </div>
          <div className="published-snapshot-meta">
            <span><b>Snapshot ID</b>{publishedSnapshot.id}</span>
            <span><b>Published by</b>{publishedSnapshot.publishedBy}</span>
            <span><b>Published at</b>{formatDateTime(publishedSnapshot.publishedAt)}</span>
          </div>
          <div className="published-snapshot-sources">
            {publishedSnapshot.batches.map((batch) => (
              <article key={batch.sourceKey}>
                <i>{importProfiles[batch.sourceKey].icon}</i>
                <span>
                  <b>{importProfiles[batch.sourceKey].title}</b>
                  <small>{batch.fileName} · v{batch.version}</small>
                </span>
                <strong>{formatNumber(batch.acceptedCount)} rows</strong>
              </article>
            ))}
          </div>
        </section>
      )}

      {reviewOpen && file && sheet && validation && (
        <div
          className="import-review-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) resetFile();
          }}
        >
          <section
            className="import-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-review-title"
          >
            <header>
              <div>
                <span>STEP {importSequence.indexOf(sourceKey) + 1} · DATA REVIEW</span>
                <h3 id="import-review-title">
                  {sourceKey === "history" ? "ตรวจสอบประวัติทั้ง 2 ชีทก่อนยืนยัน" : "ตรวจสอบข้อมูลก่อนยืนยัน"}
                </h3>
                <p>
                  {sourceKey === "history"
                    ? "ระบบแยกผลจ่ายได้ตามแผนและไม่รับของ แต่ยืนยันเป็น Historical Import รอบเดียว"
                    : "ระบบจะยังไม่รับข้อมูลและไม่เปิดขั้นตอนถัดไปจนกด Confirm"}
                </p>
              </div>
              <button type="button" onClick={resetFile} aria-label="ปิดหน้าตรวจสอบ">
                ×
              </button>
            </header>

            <div className="import-review-file">
              <i>{profile.icon}</i>
              <div>
                <strong>{file.name}</strong>
                <small>
                  {(file.size / 1024 / 1024).toFixed(2)} MB · {sourceKey === "history" ? `${historicalSheets.length} ชีท` : `Sheet: ${sheet.sheetName}`} ·{" "}
                  {formatNumber(validation.totalRows)} แถว
                </small>
              </div>
              <Badge>{profile.title}</Badge>
            </div>

            <div className="import-review-summary">
              <article>
                <span>ทั้งหมด</span>
                <strong>{formatNumber(validation.totalRows)}</strong>
                <small>Rows detected</small>
              </article>
              <article className="accepted">
                <span>พร้อมนำเข้า</span>
                <strong>{formatNumber(validation.validRows)}</strong>
                <small>Accepted rows</small>
              </article>
              <article className={validation.invalidRows ? "warning" : "accepted"}>
                <span>ต้องตรวจสอบ</span>
                <strong>{formatNumber(validation.invalidRows)}</strong>
                <small>เก็บแยก ไม่ทิ้งข้อมูล</small>
              </article>
              <article className={validation.missing.length ? "failed" : "accepted"}>
                <span>คอลัมน์จำเป็น</span>
                <strong>{validation.matches.length - validation.missing.length}/{validation.matches.length}</strong>
                <small>{validation.missing.length ? "ข้อมูลยังไม่พร้อม" : "ตรวจพบครบ"}</small>
              </article>
            </div>

            {sourceKey === "history" && historicalSheets.length === 2 && (
              <div className="import-history-outcome-tabs" aria-label="เลือกตรวจสอบชีท Historical">
                {validation.sheetStats.map((item) => {
                  const accepted = normalizeImportHeader(item.sheet.sheetName).includes(
                    normalizeImportHeader("จ่ายได้ตามแผน"),
                  );
                  return (
                    <button
                      type="button"
                      key={item.sheet.sheetName}
                      className={`${accepted ? "accepted" : "rejected"} ${sheet.sheetName === item.sheet.sheetName ? "active" : ""}`}
                      onClick={() => setSheet(item.sheet)}
                    >
                      <i>{accepted ? "✓" : "×"}</i>
                      <span>
                        <b>{accepted ? "จ่ายได้ตามแผน" : "ไม่รับของ"}</b>
                        <small>{item.sheet.sheetName}</small>
                      </span>
                      <strong>{formatNumber(item.sheet.totalRows)} รายการ</strong>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="import-review-body">
              <div className="import-review-table">
                <div>
                  <strong>Data Preview</strong>
                  <small>5 แถวแรก · {sheet.sheetName}</small>
                </div>
                <div className="live-table-wrap">
                  <table className="live-table">
                    <thead>
                      <tr>
                        {sheet.headers.slice(0, 8).map((header, index) => (
                          <th key={`${header}-${index}`}>{header || `Column ${index + 1}`}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.rows.slice(0, 5).map((row, rowIndex) => (
                        <tr key={`review-${rowIndex}`}>
                          {sheet.headers.slice(0, 8).map((_, columnIndex) => (
                            <td key={`review-cell-${rowIndex}-${columnIndex}`}>
                              {text(row[columnIndex])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <aside className="import-review-checks">
                <strong>Column Mapping · {sheet.sheetName}</strong>
                {validation.matches.map((match) => (
                  <div key={match.label} className={match.index < 0 ? "failed" : ""}>
                    <i>{match.index < 0 ? "!" : "✓"}</i>
                    <span>
                      <b>{match.label}</b>
                      <select
                        aria-label={`เลือกคอลัมน์สำหรับ ${match.label}`}
                        value={match.index >= 0 ? match.index : ""}
                        onChange={(event) =>
                          setManualMapping((current) => ({
                            ...current,
                            [match.label]: event.target.value === "" ? -1 : Number(event.target.value),
                          }))
                        }
                      >
                        <option value="">— เลือกคอลัมน์ —</option>
                        {sheet.headers.map((header, columnIndex) => (
                          <option key={`${match.label}-${columnIndex}`} value={columnIndex}>
                            {header || `Column ${columnIndex + 1}`}
                          </option>
                        ))}
                      </select>
                      <small>
                        {match.index < 0
                          ? "ระบบยังจับคู่ไม่ได้ กรุณาเลือกเอง"
                          : match.manuallySelected
                            ? "Admin เลือกคอลัมน์นี้"
                            : "ระบบจับคู่อัตโนมัติ"}
                      </small>
                    </span>
                  </div>
                ))}
                <section>
                  <strong>Business Rules</strong>
                  {profile.rules.map((rule) => (
                    <p key={rule}>• {rule}</p>
                  ))}
                </section>
              </aside>
            </div>

            {validation.missing.length > 0 && (
              <div className="form-error import-review-error" role="alert">
                ไม่พบคอลัมน์ที่จำเป็น: {validation.missing.map((item) => item.label).join(", ")}
                กรุณาเลือกคอลัมน์ที่ตรงกันใน Column Mapping หรือ Cancel เพื่อเลือกไฟล์ใหม่
              </div>
            )}

            <footer>
              <p>
                <strong>Local Preview:</strong> การยืนยันจะสร้าง Import Batch จำลอง
                และเก็บประวัติเดิมไว้ ไม่ส่งข้อมูลเข้า Production
              </p>
              <div>
                <button type="button" className="btn ghost" onClick={resetFile}>
                  Cancel · เลือกไฟล์ใหม่
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={confirmImport}
                  disabled={validation.missing.length > 0 || busy}
                >
                  Confirm & Continue →
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}

      <section className="panel import-history-panel">
        <div className="panel-title">
          <div>
            <span>IMPORT HISTORY · APPEND-ONLY</span>
            <h3>ประวัติการนำเข้าและเวอร์ชันข้อมูล</h3>
          </div>
          <small>{history.length} Import Batches</small>
        </div>
        <aside className="import-history-notice">
          <i>✓</i>
          <div>
            <strong>ข้อมูลใหม่ไม่ลบข้อมูลเดิม</strong>
            <p>
              แต่ละการอัปโหลดจะสร้าง Batch และ Version ใหม่ เพื่อให้ตรวจสอบย้อนหลัง
              เปรียบเทียบ และสอบกลับว่าใครนำเข้าข้อมูลเมื่อใดได้
            </p>
          </div>
        </aside>
        <div className="live-table-wrap import-history-table">
          <table className="live-table">
            <thead>
              <tr>
                <th>Batch ID</th>
                <th>ประเภทข้อมูล</th>
                <th>ไฟล์</th>
                <th>Version</th>
                <th>ผลการตรวจ</th>
                <th>ผู้ Import</th>
                <th>วันและเวลา</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {history.map((record) => (
                <tr key={record.id}>
                  <td>
                    <strong>{record.id}</strong>
                  </td>
                  <td>{importProfiles[record.sourceKey].title}</td>
                  <td>
                    <span className="import-file-cell">
                      <i>{importProfiles[record.sourceKey].icon}</i>
                      <span>{record.fileName}</span>
                    </span>
                  </td>
                  <td>v{record.version}</td>
                  <td>
                    <strong>{formatNumber(record.acceptedCount)}</strong> ผ่าน ·{" "}
                    <span className={record.rejectedCount ? "has-rejected" : ""}>
                      {formatNumber(record.rejectedCount)} ต้องตรวจ
                    </span>
                  </td>
                  <td>{record.importedBy}</td>
                  <td>{formatDateTime(record.importedAt)}</td>
                  <td>
                    <Badge>
                      {record.status === "published"
                        ? "Published"
                        : record.status === "needs_review"
                          ? "Needs review"
                          : "Failed"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="import-history-footer">
          <span>
            ฐานข้อมูลรองรับ <strong>raw.import_batches</strong> และเก็บ Source Snapshot
            แยกตาม Batch เพื่อรักษาประวัติเดิม
          </span>
          <span>Local Preview แสดงข้อมูลตัวอย่างสำหรับตรวจ UX</span>
        </footer>
      </section>
    </div>
  );
}

function DataView({ data }: { data: DashboardData }) {
  return (
    <div className="stack">
      <section className="user-status">
        <article>
          <span>สัญญา</span>
          <strong>{formatNumber(data.contracts.length)}</strong>
          <small>หน้าข้อมูลปัจจุบัน</small>
        </article>
        <article>
          <span>คุณภาพข้อมูล</span>
          <strong>{formatNumber(data.quality.length)}</strong>
          <small>สรุปตามกฎ</small>
        </article>
        <article>
          <span>ข้อมูลที่บันทึก</span>
          <strong>{formatNumber(data.inputSubmissions.length)}</strong>
          <small>รายการที่บันทึกล่าสุด</small>
        </article>
        <article>
          <span>รายการวัสดุ</span>
          <strong>{formatNumber(data.materials.length)}</strong>
          <small>ตามสิทธิ์ของคุณ</small>
        </article>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>สถานะสัญญา</span>
            <h3>สัญญาจากแหล่งข้อมูลจริง</h3>
          </div>
        </div>
        <LiveTable
          rows={data.contracts}
          empty="ไม่มีข้อมูลสัญญาในสิทธิ์นี้"
          columns={[
            ["PO", (row) => row.purchase_order],
            ["สัญญา", (row) => row.contract_number],
            ["ผู้ขาย", (row) => row.vendor_name],
            ["จำนวนรายการ", (row) => row.item_count],
            ["สถานะ", (row) => <Badge>{text(row.contract_status)}</Badge>],
            ["อัปเดต", (row) => formatDateTime(row.updated_at)],
          ]}
        />
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>คุณภาพข้อมูล</span>
            <h3>หลักฐานการตรวจสอบที่ใช้งาน</h3>
          </div>
        </div>
        <LiveTable
          rows={data.quality}
          empty="ไม่มีปัญหาคุณภาพข้อมูล"
          columns={[
            ["กฎ", (row) => row.rule_code],
            ["ระดับ", (row) => <Badge>{text(row.severity)}</Badge>],
            ["ค้าง", (row) => row.open_issue_count],
            ["พบล่าสุด", (row) => formatDateTime(row.last_detected_at)],
          ]}
        />
      </section>
    </div>
  );
}

function GovernedInputView({
  actionBusy,
  data,
  onLoadContext,
  onPublish,
}: {
  actionBusy: boolean;
  data: DashboardData;
  onLoadContext: (
    materialId: string,
    districtId: string,
  ) => Promise<VmiContext | null>;
  onPublish: (payload: VmiInputPayload) => Promise<boolean>;
}) {
  const [materialId, setMaterialId] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [snapshot, setSnapshot] = useState(() => toLocalDateTimeInput());
  const [stock, setStock] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [history, setHistory] = useState("");
  const [runPlan, setRunPlan] = useState(false);
  const [context, setContext] = useState<VmiContext | null>(null);
  const [formError, setFormError] = useState("");
  const loadContext = async () => {
    if (!materialId || !districtId) return;
    setContext(await onLoadContext(materialId, districtId));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    try {
      const currentStock = Number(stock);
      if (!Number.isFinite(currentStock) || currentStock < 0) {
        throw new Error("Stock ต้องเป็นจำนวนที่ไม่ติดลบ");
      }
      const payload: VmiInputPayload = {
        material_id: materialId,
        district_id: districtId,
        snapshot_at: snapshotIso(snapshot),
        current_stock: currentStock,
        source_note: sourceNote.trim(),
        history: parseVmiHistory(history),
        run_replenishment: runPlan,
      };
      await onPublish(payload);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "ข้อมูลไม่ถูกต้อง");
    }
  };
  return (
    <div className="stack">
      <form className="pipeline-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            วัสดุ
            <select
              value={materialId}
              onChange={(event) => setMaterialId(event.target.value)}
              required
            >
              <option value="">เลือกวัสดุ</option>
              {data.materials.map((row) => (
                <option key={text(row.material_id)} value={text(row.material_id)}>
                  {text(row.material_id)} · {text(row.material_name)}
                </option>
              ))}
            </select>
          </label>
          <label>
            เขต
            <select
              value={districtId}
              onChange={(event) => setDistrictId(event.target.value)}
              required
            >
              <option value="">เลือกเขต</option>
              {data.districts.map((row) => (
                <option key={text(row.district_id)} value={text(row.district_id)}>
                  {text(row.district_id)} · {text(row.district_name_th)}
                </option>
              ))}
            </select>
          </label>
          <label>
            เวลาบันทึก
            <input
              type="datetime-local"
              value={snapshot}
              onChange={(event) => setSnapshot(event.target.value)}
              required
            />
          </label>
          <label>
            สต็อกพร้อมใช้
            <input
              type="number"
              min="0"
              step="any"
              value={stock}
              onChange={(event) => setStock(event.target.value)}
              required
            />
          </label>
          <label className="wide">
            หมายเหตุแหล่งที่มา
            <input
              value={sourceNote}
              onChange={(event) => setSourceNote(event.target.value)}
              minLength={3}
              maxLength={500}
              required
            />
          </label>
          <label className="wide">
            ประวัติรายเดือน
            <textarea
              value={history}
              onChange={(event) => setHistory(event.target.value)}
              placeholder={"2026-04,100,0,7\n2026-05,110,0,7\n2026-06,105,0,7"}
              required
            />
            <small>ปีเดือน (YYYY-MM), ความต้องการ, วันของขาด, วันนำส่ง</small>
          </label>
        </div>
        <label className="pipeline-check">
          <input
            type="checkbox"
            checked={runPlan}
            onChange={(event) => setRunPlan(event.target.checked)}
          />
          สร้างแผนการจ่ายหลังบันทึก
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <div className="pipeline-actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => void loadContext()}
            disabled={!materialId || !districtId || actionBusy}
          >
            โหลดข้อมูล
          </button>
          <button className="btn primary" disabled={actionBusy}>
            บันทึกข้อมูล
          </button>
        </div>
      </form>
      {context && (
        <article className="pipeline-detail">
          <div>
            <span>ข้อมูลต้นทางล่าสุด</span>
            <button className="btn ghost" onClick={() => setContext(null)}>
              ปิด
            </button>
          </div>
          <pre>{JSON.stringify(context, null, 2)}</pre>
        </article>
      )}
    </div>
  );
}

function OperationsView({ data }: { data: DashboardData }) {
  const health = data.operations ?? {};
  const readiness = data.readiness ?? {};
  const sourceStatus = record(data.legacyStatus);
  const sourceTotals = record(sourceStatus.totals);
  const sourceRows = rows(sourceStatus.sources);
  const sourceWarnings = Array.isArray(sourceStatus.warnings)
    ? sourceStatus.warnings.map((warning) => text(warning))
    : [];
  return (
    <div className="stack">
      <section className="operations-hero">
        <div>
          <span>คู่มือปฏิบัติงาน</span>
          <h3>ศูนย์ควบคุมประจำวัน</h3>
          <p>
            สำรองข้อมูลก่อนปรับปรุงระบบ บันทึกหลักฐานแบบเพิ่มอย่างเดียว
            และปิดกั้นเมื่อพบข้อผิดพลาด
          </p>
        </div>
      </section>
      <section className="user-status">
        {Object.entries(health)
          .slice(0, 4)
          .map(([key, value]) => (
            <article key={key}>
              <span>{key.replaceAll("_", " ")}</span>
              <strong>{text(value)}</strong>
              <small>สุขภาพฐานข้อมูล</small>
            </article>
          ))}
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>การเปิดใช้งานจริง</span>
            <h3>ด่านตรวจความพร้อมก่อนเปิดใช้งาน</h3>
          </div>
          <Badge>{text(readiness.readiness_status)}</Badge>
        </div>
        <section className="user-status">
          {[
            ["ข้อมูลจริง", readiness.data_contract_ready],
            ["สิทธิ์ผู้ใช้", readiness.identity_ready],
            ["สำรอง + กู้คืน", readiness.recovery_ready],
            ["การบันทึกข้อมูล", readiness.operational_writes_enabled],
          ].map(([label, value]) => (
            <article key={text(label)}>
              <span>{text(label)}</span>
              <strong>{bool(value) ? "ผ่าน" : "ไม่ผ่าน"}</strong>
              <small>ด่านตรวจก่อนใช้งานจริง</small>
            </article>
          ))}
        </section>
      </section>
      <section className="user-status">
        {[
          ["รายการวัสดุ", sourceTotals.materials],
          ["ข้อมูลสต็อกคลัง", sourceTotals.warehouse_stock_snapshots],
          ["ข้อมูลสต็อกเขต", sourceTotals.district_stock_snapshots],
          ["อัตราการใช้", sourceTotals.usage_rates],
        ].map(([label, value]) => (
          <article key={text(label)}>
            <span>{text(label)}</span>
            <strong>{formatNumber(value)}</strong>
            <small>ข้อมูลจริงจากแหล่งที่มา</small>
          </article>
        ))}
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>ความพร้อมข้อมูลต้นทาง</span>
            <h3>สถานะการโหลดข้อมูลต้นทาง</h3>
          </div>
        </div>
        <LiveTable
          rows={sourceRows}
          empty="ยังไม่มีหลักฐานการนำเข้าข้อมูล"
          columns={[
            ["แหล่งที่มา", (row) => row.source_key],
            ["สถานะ", (row) => <Badge>{text(row.status)}</Badge>],
            ["คาดว่า", (row) => formatNumber(row.expected_rows)],
            ["โหลดแล้ว", (row) => formatNumber(row.loaded_rows)],
            ["พบเมื่อ", (row) => formatDateTime(row.source_observed_at)],
            ["อัปเดต", (row) => formatDateTime(row.updated_at)],
          ]}
        />
        {sourceWarnings.map((warning) => (
          <aside className="plain-notice warning" key={warning}>
            <i>!</i>
            <div>
              <strong>คำเตือนความพร้อมข้อมูลต้นทาง</strong>
              <p>{warning}</p>
            </div>
          </aside>
        ))}
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>การแจ้งเตือนระบบ</span>
            <h3>ข้อยกเว้นการทำงาน</h3>
          </div>
        </div>
        <LiveTable
          rows={data.alerts}
          empty="ไม่มีการแจ้งเตือน"
          columns={[
            ["สร้างเมื่อ", (row) => formatDateTime(row.created_at)],
            ["ประเภท", (row) => row.alert_type],
            ["ระดับ", (row) => <Badge>{text(row.severity)}</Badge>],
            ["สถานะ", (row) => row.status],
            ["ข้อความ", (row) => row.message],
          ]}
        />
      </section>
      <section className="runbook-grid">
        {[
          [
            "สำรองข้อมูลรายวัน",
            "สำรองข้อมูลพร้อมรหัสตรวจสอบ (SHA-256) และบันทึกหลักฐาน",
          ],
          [
            "ซ้อมกู้คืนข้อมูล",
            "กู้คืนข้อมูลลงฐานข้อมูลแยกทุกไตรมาส และตรวจสอบครบทุกส่วน",
          ],
          [
            "ปล่อยเวอร์ชันอย่างปลอดภัย",
            "ทดสอบ → สำรอง → ปรับปรุงระบบ → ตรวจรับ → ทดสอบใช้งาน → บันทึกการปล่อย",
          ],
          [
            "เหตุขัดข้อง",
            "เปลี่ยนรหัสผ่าน เก็บหลักฐานการตรวจสอบ แล้วแก้ไขไปข้างหน้า",
          ],
        ].map(([title, body]) => (
          <details key={title}>
            <summary>
              {title}
              <span>＋</span>
            </summary>
            <p>{body}</p>
          </details>
        ))}
      </section>
    </div>
  );
}

function ReleaseView() {
  return (
    <div className="stack">
      <section className="release-hero">
        <div>
          <span>ระบบงานเวอร์ชัน 1</span>
          <h3>เวอร์ชันที่ตรงตามข้อกำหนดการใช้งาน</h3>
          <p>เกณฑ์การจ่ายเวอร์ชัน 1</p>
        </div>
        <Badge>ผ่านการทดสอบ</Badge>
      </section>
      <section className="acceptance-grid">
        {[
          ["ลำดับการอัปเดตฐานข้อมูลครบถ้วน", "โครงสร้าง"],
          ["เชื่อมต่อ API ภายในโดเมนเดียว 50 เส้นทาง", "API"],
          ["เขต → ผู้วางแผน → วิชาการ → ล็อก", "การอนุมัติ"],
          ["หน่วยที่เปิด → วันรับ → PO → รายการ", "FIFO"],
          ["การจ่ายจริงรายสัปดาห์ + กรณีพิเศษ", "การจ่าย"],
          ["สอบกลับไป-กลับ ถึงสัญญาและผู้ขาย", "สอบกลับ"],
        ].map(([result, name]) => (
          <article key={name}>
            <span>✓</span>
            <div>
              <strong>{result}</strong>
              <p>{name}</p>
            </div>
          </article>
        ))}
      </section>
      <aside className="scope-exclusion">
        <i>—</i>
        <div>
          <strong>ยังไม่รวมการพยากรณ์ งานจัดเส้นทางแบบเดิม และ RAG</strong>
          <p>
            ระบบขนส่งและพรีวิวเส้นทางแบบจำกัดมีเอกสารกำกับ
            ส่วนงานจัดเส้นทางแบบเดิมถูกปิดไว้ (HTTP 410{" "}
            <code>scope_excluded</code>)
          </p>
        </div>
      </aside>
      <section className="plain-notice warning">
        <i>!</i>
        <div>
          <strong>การติดตั้งใช้งานเป็นงานของระบบ</strong>
          <p>
            ความพร้อมของโค้ดไม่ได้แทนการตั้งค่าลับสำหรับใช้งานจริง นโยบายสำรองข้อมูล
            การทดสอบใช้งานหลังเข้าสู่ระบบ และการอนุมัติปล่อยเวอร์ชันตามสิทธิ์
          </p>
        </div>
      </section>
    </div>
  );
}

function PageContent({
  view,
  role,
  backend,
  navigate,
  plannerDraft,
  setPlannerDraft,
  summaryAvailable,
  openTransport,
}: {
  view: ViewKey;
  role: Role;
  backend: ReturnType<typeof useSynapseBackend>;
  navigate: (view: ViewKey) => void;
  plannerDraft: PlannerDraft;
  setPlannerDraft: Dispatch<SetStateAction<PlannerDraft>>;
  summaryAvailable: boolean;
  openTransport: () => void;
}) {
  if (view === "dashboard") {
    return <DashboardView data={backend.data} role={role} navigate={navigate} />;
  }
  if (view === "weekly" || view === "summary") {
    const splitFlow = role === "admin" || role === "planner";
    const mode = !splitFlow ? "full" : view === "summary" ? "summary" : "calculate";
    return (
      <WeeklyPlanView
        key={mode}
        actionBusy={backend.actionBusy}
        dataLoading={backend.loading}
        data={backend.data}
        role={role}
        mode={mode}
        draft={plannerDraft}
        setDraft={setPlannerDraft}
        summaryAvailable={summaryAvailable}
        onOpenCalculate={() => navigate("weekly")}
        onOpenSummary={() => navigate("summary")}
        onApprove={backend.approveReplenishmentPlan}
        onCancel={backend.cancelReplenishmentPlan}
        onCreate={backend.createReplenishmentRun}
        onIssue={backend.issueReplenishmentPlan}
        onReview={backend.reviewChangeRequest}
        onRespond={backend.respondReplenishment}
        onVersion={backend.versionReplenishmentPlan}
        onConfirmPending={backend.confirmPendingDistrictItems}
        onOpenTransport={openTransport}
        onSubmitSelection={backend.submitPlannerSelection}
        onRecalculate={backend.recalculateReplenishmentPlan}
        actionError={backend.error}
      />
    );
  }
  if (view === "recommendations") {
    return <RecommendationView data={backend.data} />;
  }
  if (view === "advisory") {
    return <IntelligenceAdvisoryView data={backend.data} />;
  }
  if (view === "changes") {
    return (
      <ChangeReviewView
        actionBusy={backend.actionBusy}
        data={backend.data}
        role={role}
        onReview={backend.reviewChangeRequest}
      />
    );
  }
  if (view === "approvals") {
    return <ApprovalView data={backend.data} />;
  }
  if (view === "fifo") {
    return (
      <FifoView
        actionBusy={backend.actionBusy}
        data={backend.data}
        role={role}
        onReconcile={backend.reconcileHandlingUnit}
      />
    );
  }
  if (view === "receiving") {
    return (
      <ReceivingView
        actionBusy={backend.actionBusy}
        data={backend.data}
        onReceive={backend.receiveHandlingUnit}
      />
    );
  }
  if (view === "adhoc") {
    return (
      <AdHocView
        actionBusy={backend.actionBusy}
        data={backend.data}
        role={role}
        token={backend.session?.access_token ?? null}
        onApprove={backend.approveAdHocIssue}
        onCreate={backend.createAdHocIssue}
        onIssue={backend.issueAdHocIssue}
      />
    );
  }
  if (view === "trace") {
    return (
      <TraceView
        actionBusy={backend.actionBusy}
        data={backend.data}
        role={role}
        onReturn={backend.recordInventoryReturn}
      />
    );
  }
  if (view === "stock") return <StockView data={backend.data} />;
  if (view === "import") return (
    <div className="stack">
      <SourceImportCenter
        token={backend.session?.access_token ?? null}
        role={role}
      />
      <ImportPromotionPanel
        token={backend.session?.access_token ?? null}
        role={role}
        demoMode={DEMO_MODE}
      />
      <details className="sap-legacy-preview">
        <summary>เครื่องมือทดลองนำเข้าชุดเดิม (เก็บเฉพาะในเบราว์เซอร์ ไม่บันทึกฐานข้อมูล)</summary>
        <DataImportView onOpenPlanner={() => navigate("weekly")} />
      </details>
    </div>
  );
  if (view === "fifo_setup") {
    return (
      <FifoPackagingSetupView
        contractRows={backend.data.receiptOptions}
        materialRows={backend.data.materials}
        onPublishOpening={backend.publishFifoOpening}
      />
    );
  }
  if (view === "usage") {
    return (
      <DistrictUsageView
        token={backend.session?.access_token ?? null}
        role={role}
        ownDistrict={null}
        demoMode={DEMO_MODE}
      />
    );
  }
  if (view === "lots") {
    return (
      <ContractLotsView
        token={backend.session?.access_token ?? null}
        role={role}
        demoMode={DEMO_MODE}
      />
    );
  }
  if (view === "packing") {
    return (
      <PackingEntryView
        token={backend.session?.access_token ?? null}
        role={role}
        demoMode={DEMO_MODE}
        demoRows={backend.data.receiptOptions}
      />
    );
  }
  if (view === "delivery") {
    return (
      <DeliveryCalendarView
        token={backend.session?.access_token ?? null}
        role={role}
        demoMode={DEMO_MODE}
      />
    );
  }
  if (view === "alerts") {
    return (
      <RequestAlertsView
        token={backend.session?.access_token ?? null}
        role={role}
        demoMode={DEMO_MODE}
      />
    );
  }
  if (view === "users") {
    return (
      <UserManagementView
        token={backend.session?.access_token ?? null}
        demoMode={DEMO_MODE}
        demoPayload={DEMO_MODE ? demoUsersPayload() : undefined}
      />
    );
  }
  if (view === "history") {
    return (
      <OperationHistoryView
        token={backend.session?.access_token ?? null}
        role={role}
        demoMode={DEMO_MODE}
        demoPayload={DEMO_MODE ? demoHistoryPayload() : undefined}
      />
    );
  }
  if (view === "legacy_history") {
    return (
      <LegacyHistoryImportView
        token={backend.session?.access_token ?? null}
        demoMode={DEMO_MODE}
      />
    );
  }
  if (view === "data") return <DataView data={backend.data} />;
  if (view === "input") {
    return (
      <GovernedInputView
        actionBusy={backend.actionBusy}
        data={backend.data}
        onLoadContext={backend.loadVmiContext}
        onPublish={backend.publishVmiInput}
      />
    );
  }
  if (view === "operations") return <OperationsView data={backend.data} />;
  return <ReleaseView />;
}

export default function Home() {
  const backend = useSynapseBackend();
  const [view, setView] = useState<ViewKey>("dashboard");
  const [plannerDraft, setPlannerDraft] =
    useState<PlannerDraft>(emptyPlannerDraft);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moduleKey, setModule] = useState<"warehouse" | "transport">(
    "warehouse",
  );
  const [transportView, setTransportView] = useState<TransportView>("dashboard");
  // Pages visited before, for the back button and the browser back button
  const [backStack, setBackStack] = useState<PageState[]>([]);
  const current: PageState = { moduleKey, view, transportView };
  const sameState = (left: PageState, right: PageState) =>
    left.moduleKey === right.moduleKey &&
    (left.moduleKey === "transport" ? left.transportView === right.transportView : left.view === right.view);
  const goTo = (next: Partial<PageState>) => {
    const target = { ...current, ...next };
    if (sameState(target, current)) return;
    setBackStack((stack) => [...stack.slice(-29), current]);
    try {
      window.history.pushState({ synapse: true }, "");
    } catch {
      // history is not available (e.g. sandboxed preview): the button still works
    }
    if (next.moduleKey) setModule(next.moduleKey);
    if (next.view) setView(next.view);
    if (next.transportView) setTransportView(next.transportView);
    window.scrollTo({ top: 0 });
  };
  const navigateView = (next: ViewKey) => goTo({ moduleKey: "warehouse", view: next });
  const goBack = useCallback(() => {
    setBackStack((stack) => {
      const previous = stack.at(-1);
      if (!previous) return stack;
      setModule(previous.moduleKey);
      setView(previous.view);
      setTransportView(previous.transportView);
      window.scrollTo({ top: 0 });
      return stack.slice(0, -1);
    });
  }, []);
  useEffect(() => {
    const onPop = () => goBack();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [goBack]);
  const resetNavigation = () => setBackStack([]);

  if (!backend.session || !backend.identity) {
    return (
      <Login
        busy={backend.authBusy}
        error={backend.error}
        onLogin={backend.signIn}
      />
    );
  }

  const role = backend.identity.role;
  const allowedViews = new Set(
    navByRole[role].flatMap((group) => group.items.map(([key]) => key)),
  );
  // สรุปการจ่าย appears only after a calculation exists: either the planner
  // has selected calculated lines in this session, or a calculated plan is
  // already moving through district review / approval on the server.
  const summaryAvailable =
    hasPlannerSelection(plannerDraft) ||
    backend.data.replenishment.some((row) =>
      SUMMARY_PLAN_STATUSES.has(text(row.plan_status, "")),
    );
  const hiddenViews = new Set<ViewKey>(summaryAvailable ? [] : ["summary"]);
  const requestedView =
    view === "summary" && !summaryAvailable ? "weekly" : view;
  const activeView = allowedViews.has(requestedView)
    ? requestedView
    : "dashboard";
  const allowedTransportViews = new Set(
    transportNavForRole(role).map(([transportKey]) => transportKey),
  );
  const activeTransportView = allowedTransportViews.has(transportView)
    ? transportView
    : "dashboard";
  const [eyebrow, title, description] =
    activeView === "weekly" && (role === "admin" || role === "planner")
      ? [
          "คำนวณการจ่าย",
          "คำนวณการจ่ายรายสัปดาห์",
          "เลือกพัสดุ · กรอก Planner Qty · ตรวจ AI + FIFO แล้วไปหน้าสรุปการจ่าย",
        ]
      : titles[activeView];
  const snapshot = latestSnapshot(backend.data);

  return (
    <div className="app">
      <a className="skip" href="#content">
        ข้ามไปเนื้อหาหลัก
      </a>
      <Sidebar
        active={activeView}
        hiddenViews={hiddenViews}
        role={role}
        open={menuOpen}
        navigate={navigateView}
        close={() => setMenuOpen(false)}
        snapshot={snapshot}
        moduleKey={moduleKey}
        setModule={(next) => goTo({ moduleKey: next })}
        transportView={activeTransportView}
        setTransportView={(next) => goTo({ moduleKey: "transport", transportView: next })}
      />
      <div className="shell">
        {backend.demoMode && (
          <aside className="demo-mode-bar" aria-label="Local demo role switcher">
            <div>
              <strong>LOCAL DEMO</strong>
              <span>ข้อมูลตัวอย่าง · ไม่แตะ Supabase / Production</span>
            </div>
            <label>
              ทดลองบทบาท
              <select
                value={role}
                onChange={(event) => {
                  backend.setDemoRole(event.target.value as Role);
                  setPlannerDraft(emptyPlannerDraft);
                  setView("dashboard");
                  setModule("warehouse");
                  resetNavigation();
                }}
              >
                <option value="planner">ผู้วางแผนคลังคลองเตย</option>
                <option value="district">ผู้ใช้งานเขต 5501</option>
                <option value="academic">นักวิชาการ</option>
                <option value="picker">เจ้าหน้าที่คลัง</option>
                <option value="viewer">ผู้บริหาร / ผู้ดูข้อมูล</option>
                <option value="admin">ผู้จัดการระบบ</option>
              </select>
            </label>
          </aside>
        )}
        <Header
          title={moduleKey === "transport" ? "ระบบขนส่ง" : title}
          loading={backend.loading}
          openMenu={() => setMenuOpen(true)}
          logout={() => {
            setPlannerDraft(emptyPlannerDraft);
            setView("dashboard");
            resetNavigation();
            void backend.signOut();
          }}
          navigate={navigateView}
          refresh={() => void backend.refresh()}
          snapshot={snapshot}
        />
        <main id="content" className="content">
          {backStack.length > 0 && (
            <button type="button" className="page-back" onClick={() => {
              try {
                window.history.back();
              } catch {
                goBack();
              }
            }}>
              <span aria-hidden="true">←</span> ย้อนกลับ
              <small>
                {pageLabel(backStack[backStack.length - 1], role)}
              </small>
            </button>
          )}
          {moduleKey === "transport" && activeTransportView === "dispatch" ? (
            <>
              <PageHero
                icon="⛟"
                eyebrow={transportTitleFor("dispatch")[0]}
                title={transportTitleFor("dispatch")[1]}
                description={transportTitleFor("dispatch")[2]}
              />
              <DispatchBoardView
                token={backend.session?.access_token ?? null}
                role={role}
                demoMode={DEMO_MODE}
              />
            </>
          ) : moduleKey === "transport" ? (
            <TransportModule
              view={activeTransportView}
              token={backend.session?.access_token ?? null}
              role={role}
              actorId={backend.identity.user_id}
            />
          ) : (
            <>
              {activeView !== "dashboard" && (
                <PageHero
                  icon={
                    navByRole[role]
                      .flatMap((group) => group.items)
                      .find(([key]) => key === activeView)?.[2] ?? "◆"
                  }
                  eyebrow={eyebrow}
                  title={title}
                  description={description}
                  meta={[["ข้อมูลล่าสุด", snapshot]]}
                />
              )}
              {backend.error && (
                <aside className="runtime-message error" role="alert">
                  <i>!</i>
                  <div>
                    <strong>ไม่สามารถซิงก์ข้อมูลบางส่วน</strong>
                    <p>{backend.error}</p>
                  </div>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => void backend.refresh()}
                  >
                    ลองอีกครั้ง
                  </button>
                </aside>
              )}
              {backend.data.readiness &&
                !bool(backend.data.readiness.operational_writes_enabled) && (
                  <aside className="runtime-message warning" role="status">
                    <i>!</i>
                    <div>
                      <strong>ยังไม่เปิดให้บันทึกข้อมูลจริง</strong>
                      <p>
                        เปิดให้อ่านและตรวจข้อมูลได้ แต่คำสั่ง Replenishment,
                        Inventory และ Ad-hoc จะถูกปฏิเสธจนกว่า Actual data, Auth,
                        backup และ restore drill จะผ่านครบ
                      </p>
                    </div>
                  </aside>
                )}
              <ViewTabs view={activeView} role={role} hiddenViews={hiddenViews} navigate={navigateView} />
              <PageContent
                view={activeView}
                role={role}
                backend={backend}
                navigate={navigateView}
                plannerDraft={plannerDraft}
                setPlannerDraft={setPlannerDraft}
                summaryAvailable={summaryAvailable}
                openTransport={() => goTo({ moduleKey: "transport", transportView: "planner" })}
              />
            </>
          )}
        </main>
      </div>
      {backend.notice && (
        <div className="toast" role="status" aria-live="polite">
          <span>✓</span>
          {backend.notice}
        </div>
      )}
    </div>
  );
}
