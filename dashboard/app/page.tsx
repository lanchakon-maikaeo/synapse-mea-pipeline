"use client";

import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { formatDateTime, formatNumber, type Role } from "./lib";
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

type ViewKey =
  | "dashboard"
  | "weekly"
  | "recommendations"
  | "changes"
  | "approvals"
  | "fifo"
  | "receiving"
  | "adhoc"
  | "trace"
  | "stock"
  | "data"
  | "input"
  | "operations"
  | "release";

type NavGroup = {
  label: string;
  items: Array<[ViewKey, string, string]>;
};

const navByRole: Record<Role, NavGroup[]> = {
  admin: [
    {
      label: "Operations",
      items: [
        ["dashboard", "Dashboard", "⌂"],
        ["weekly", "Weekly Plan", "▤"],
        ["changes", "Abnormal Review", "!"],
        ["approvals", "Approval Timeline", "✓"],
      ],
    },
    {
      label: "Warehouse",
      items: [
        ["fifo", "FIFO & Pallets", "▦"],
        ["receiving", "Receive Stock", "＋"],
        ["adhoc", "Ad-hoc Issue", "↗"],
        ["trace", "Issue Traceback", "⌕"],
      ],
    },
    {
      label: "Data & Control",
      items: [
        ["recommendations", "Quantity Evidence", "✦"],
        ["stock", "Stock Health", "◫"],
        ["input", "Governed Input", "↻"],
        ["data", "Source & Quality", "▥"],
        ["operations", "Operations Center", "⚙"],
        ["release", "Release Control", "◉"],
      ],
    },
  ],
  planner: [
    {
      label: "Planning",
      items: [
        ["dashboard", "Dashboard", "⌂"],
        ["weekly", "Weekly Plan", "▤"],
        ["changes", "Abnormal Review", "!"],
        ["approvals", "Approval Timeline", "✓"],
        ["recommendations", "Quantity Evidence", "✦"],
      ],
    },
    {
      label: "Operations",
      items: [
        ["fifo", "FIFO & Pallets", "▦"],
        ["adhoc", "Ad-hoc Issue", "↗"],
        ["trace", "Issue Traceback", "⌕"],
        ["stock", "Stock Health", "◫"],
        ["input", "Governed Input", "↻"],
      ],
    },
  ],
  academic: [
    {
      label: "Academic Review",
      items: [
        ["dashboard", "Dashboard", "⌂"],
        ["weekly", "Academic Approval", "✓"],
        ["changes", "Abnormal Evidence", "!"],
        ["recommendations", "Quantity Evidence", "✦"],
        ["approvals", "Approval Timeline", "◷"],
        ["trace", "Issue Traceback", "⌕"],
      ],
    },
    {
      label: "Stock Evidence",
      items: [
        ["fifo", "FIFO & Pallets", "▦"],
        ["stock", "Stock Health", "◫"],
      ],
    },
  ],
  picker: [
    {
      label: "Warehouse Execution",
      items: [
        ["dashboard", "Dashboard", "⌂"],
        ["weekly", "Locked Plans", "▤"],
        ["fifo", "FIFO & Pallets", "▦"],
        ["receiving", "Receive Stock", "＋"],
        ["adhoc", "Ad-hoc Issue", "↗"],
        ["trace", "Issue Traceback", "⌕"],
      ],
    },
  ],
  district: [
    {
      label: "District",
      items: [
        ["dashboard", "Dashboard", "⌂"],
        ["weekly", "Confirm Materials", "✓"],
        ["changes", "My Change Requests", "!"],
        ["adhoc", "Ad-hoc Request", "↗"],
        ["stock", "District Stock", "◫"],
        ["trace", "Issue Traceback", "⌕"],
      ],
    },
  ],
  viewer: [
    {
      label: "Read-only",
      items: [
        ["dashboard", "Dashboard", "⌂"],
        ["weekly", "Weekly Plans", "▤"],
        ["recommendations", "Quantity Evidence", "✦"],
        ["fifo", "FIFO & Pallets", "▦"],
        ["stock", "Stock Health", "◫"],
        ["trace", "Issue Traceback", "⌕"],
      ],
    },
  ],
};

const titles: Record<ViewKey, [string, string, string]> = {
  dashboard: [
    "PRODUCTION OPERATIONS",
    "Warehouse Operations Dashboard",
    "Live, role-scoped status from the governed Supabase backend.",
  ],
  weekly: [
    "WEEKLY CONTROL",
    "Weekly Replenishment Plan",
    "District → Planner → Academic → Lock → FIFO Issue.",
  ],
  recommendations: [
    "DECISION SUPPORT",
    "Quantity Recommendation Evidence",
    "Business Rules v1 evidence only; no fabricated or auto-approved result.",
  ],
  changes: [
    "REQUEST CONTROL",
    "Abnormal Request Review",
    "Review quantity changes, projected months and the >6M / >9M controls.",
  ],
  approvals: [
    "GOVERNANCE",
    "Approval Timeline",
    "Append-only District, Planner, Academic, Lock, Cancel and Version evidence.",
  ],
  fifo: [
    "WAREHOUSE EXECUTION",
    "FIFO, Pallets & Remaining Quantity",
    "Opened handling units first, then accepted date, PO, item and source row.",
  ],
  receiving: [
    "RECEIVING",
    "Receive Traceable Handling Unit",
    "Link every lot and handling unit to contract, acceptance evidence and source.",
  ],
  adhoc: [
    "EXCEPTION ISSUE",
    "Ad-hoc Issue",
    "Separate approval and actual movement; never mutates the Weekly Plan.",
  ],
  trace: [
    "TRACEABILITY",
    "Issue Traceback",
    "Search forward or reverse from district issue to pallet, lot, contract and vendor.",
  ],
  stock: [
    "STOCK POLICY",
    "Stock Health",
    "Unrestricted stock only; missing material/plant is shown as assumed zero with evidence.",
  ],
  data: [
    "DATA FOUNDATION",
    "Source, Contract & Data Quality",
    "Raw → Staging → Core lineage and source-quality evidence.",
  ],
  input: [
    "GOVERNED INPUT",
    "Publish Stock & Usage",
    "Daily stock and monthly usage/CMP observations with immutable source lineage.",
  ],
  operations: [
    "M12 CONTROL",
    "Operations Center",
    "Health, alerts, backup and deployment evidence for the operational release.",
  ],
  release: [
    "RELEASE CONTROL",
    "Production Scope",
    "Business Rules v1 and migration 015; forecasting, routing and RAG are excluded.",
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
  return timestamps.length ? formatDateTime(Math.max(...timestamps)) : "รอข้อมูลจริง";
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
            <small>WAREHOUSE OPERATIONS</small>
          </span>
        </div>
        <div className="login-copy">
          <span>PRODUCTION OPERATIONS · BUSINESS RULES V1</span>
          <h1>
            Traceable stock.
            <br />
            Governed decisions.
          </h1>
          <p>
            Weekly planning, district confirmation, sequential approval, FIFO
            allocation, ad-hoc issue and complete traceback in one workspace.
          </p>
        </div>
        <div className="login-metrics">
          <span>
            <strong>2401</strong> Khlong Toei Plant
          </span>
          <span>
            <strong>0001</strong> Storage Location
          </span>
          <span>
            <strong>18</strong> Districts
          </span>
        </div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={submit}>
          <span className="demo-tag">
            <i /> SUPABASE AUTH · RBAC
          </span>
          <div className="login-heading">
            <h2>Sign in to MEA Synapse</h2>
            <p>Application role and district scope are enforced by the API.</p>
          </div>
          <label>
            Username or email
            <input
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Password
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
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? "Hide" : "Show"}
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
            {busy ? "Checking access…" : "Sign in"} <span>→</span>
          </button>
          <div className="login-assurance">
            <span>Role-based access</span>
            <i />
            <span>District-scoped data</span>
          </div>
        </form>
      </section>
    </main>
  );
}

function Sidebar({
  active,
  role,
  open,
  navigate,
  close,
  snapshot,
}: {
  active: ViewKey;
  role: Role;
  open: boolean;
  navigate: (view: ViewKey) => void;
  close: () => void;
  snapshot: string;
}) {
  const roleName: Record<Role, string> = {
    admin: "Administrator",
    planner: "Planner",
    academic: "Academic Officer",
    picker: "Picker / Outsource",
    district: "District User",
    viewer: "Viewer",
  };
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
            <small>WAREHOUSE OPERATIONS</small>
          </div>
        </div>
        <div className="user-scope">
          <i>{roleName[role].charAt(0)}</i>
          <div>
            <small>Signed in as</small>
            <strong>{roleName[role]}</strong>
          </div>
        </div>
        <nav>
          {navByRole[role].map((group) => (
            <section key={group.label}>
              <p>{group.label}</p>
              {group.items.map(([key, label, icon]) => (
                <button
                  type="button"
                  key={key}
                  className={active === key ? "active" : ""}
                  aria-current={active === key ? "page" : undefined}
                  onClick={() => {
                    navigate(key);
                    close();
                  }}
                >
                  <i>{icon}</i>
                  <span>{label}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div className="release-badge">
          <small>Latest verified snapshot</small>
          <strong>{snapshot}</strong>
          <span>LIVE BACKEND · NO DEMO DATA</span>
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
            placeholder="ค้นหา workflow"
          />
          <kbd>Ctrl K</kbd>
        </form>
        <button
          type="button"
          className="last-sync live-sync"
          onClick={refresh}
          disabled={loading}
        >
          <i /> {loading ? "Syncing…" : snapshot}
        </button>
        <button type="button" className="btn ghost logout" onClick={logout}>
          Sign out
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
  const planIds = new Set(
    data.replenishment.map((row) => text(row.replenishment_plan_id)),
  );
  const pendingChanges = data.changeRequests.filter(
    (row) => row.status === "pending_review",
  ).length;
  const allocatable = data.fifo.reduce(
    (sum, row) => sum + Number(row.allocatable_qty ?? 0),
    0,
  );
  const pendingAdHoc = data.adHocIssues.filter(
    (row) => !["issued", "rejected", "cancelled"].includes(text(row.status)),
  ).length;
  const nextView: ViewKey =
    role === "picker"
      ? "fifo"
      : role === "district"
        ? "weekly"
        : role === "academic"
          ? "weekly"
          : "changes";
  return (
    <div className="stack">
      <section className="executive-hero">
        <div>
          <span>LIVE OPERATING MODEL</span>
          <h2>One governed chain from source evidence to actual issue</h2>
          <p>
            Weekly Plan · District response · Planner · Academic · FIFO ·
            Movement · Traceback
          </p>
        </div>
        <button className="btn light" onClick={() => navigate(nextView)}>
          เปิดงานที่ต้องดำเนินการ
        </button>
      </section>
      <section className="kpis">
        <article>
          <div>
            <span>Weekly Plans</span>
            <i className="dot purple" />
          </div>
          <strong>{formatNumber(planIds.size)}</strong>
          <small>ตามสิทธิ์ของผู้ใช้</small>
        </article>
        <article>
          <div>
            <span>Pending Changes</span>
            <i className="dot orange" />
          </div>
          <strong>{formatNumber(pendingChanges)}</strong>
          <small>ต้องมี Planner review</small>
        </article>
        <article>
          <div>
            <span>FIFO Available</span>
            <i className="dot green" />
          </div>
          <strong>{formatNumber(allocatable, 2)}</strong>
          <small>Traceable base units</small>
        </article>
        <article>
          <div>
            <span>Ad-hoc Pending</span>
            <i className="dot blue" />
          </div>
          <strong>{formatNumber(pendingAdHoc)}</strong>
          <small>แยกจาก Weekly Plan</small>
        </article>
      </section>
      <section className="workflow">
        {[
          ["1", "District", "confirm / reject / change"],
          ["2", "Planner", "review + approve"],
          ["3", "Academic", ">9M evidence + lock"],
          ["4", "Picker", "FIFO issue + movement"],
        ].map(([step, name, note], index) => (
          <div className="workflow-step done" key={name}>
            <span>{step}</span>
            <div>
              <strong>{name}</strong>
              <small>{note}</small>
            </div>
            {index < 3 && <i />}
          </div>
        ))}
      </section>
      <section className="dashboard-main">
        <article className="panel">
          <div className="panel-title">
            <div>
              <span>ATTENTION QUEUE</span>
              <h3>คำขอที่มีความเสี่ยงสูง</h3>
            </div>
            <b className="count">{pendingChanges}</b>
          </div>
          <LiveTable
            rows={data.changeRequests.slice(0, 6)}
            empty="ไม่มีคำขอผิดปกติ"
            columns={[
              ["Material", (row) => row.material_id],
              ["District", (row) => row.district_id],
              ["Requested", (row) => formatNumber(row.requested_qty, 2)],
              ["Projected", (row) => `${formatNumber(row.projected_months_after, 1)}M`],
              ["Risk", (row) => <Badge>{text(row.risk_level)}</Badge>],
            ]}
          />
        </article>
        <article className="panel">
          <div className="panel-title">
            <div>
              <span>TRACEABILITY COVERAGE</span>
              <h3>การจ่ายที่สอบกลับได้</h3>
            </div>
            <b>{formatNumber(data.traceability.length)}</b>
          </div>
          <LiveTable
            rows={data.traceability.slice(0, 6)}
            empty="ยังไม่มีการจ่ายจริง"
            columns={[
              ["Issue", (row) => row.issue_reference],
              ["Type", (row) => <Badge>{text(row.issue_type)}</Badge>],
              ["HU", (row) => row.handling_unit_code],
              ["Vendor Alias", (row) => row.vendor_name],
            ]}
          />
        </article>
      </section>
    </div>
  );
}

function WeeklyPlanView({
  actionBusy,
  data,
  role,
  onApprove,
  onCancel,
  onCreate,
  onIssue,
  onRespond,
  onVersion,
}: {
  actionBusy: boolean;
  data: DashboardData;
  role: Role;
  onApprove: (planId: string, note?: string) => Promise<boolean>;
  onCancel: (planId: string, reason: string) => Promise<boolean>;
  onCreate: () => Promise<boolean>;
  onIssue: (planId: string) => Promise<boolean>;
  onRespond: (
    itemId: string,
    payload: ReplenishmentResponsePayload,
  ) => Promise<boolean>;
  onVersion: (planId: string, reason: string) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
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

  const rows = data.replenishment.filter((row) => {
    const value = query.trim().toLowerCase();
    return (
      !value ||
      `${text(row.plan_number)} ${text(row.material_id)} ${text(
        row.material_name,
      )} ${text(row.district_id)}`
        .toLowerCase()
        .includes(value)
    );
  });

  const plans = useMemo(() => {
    const unique = new Map<string, RecordRow>();
    data.replenishment.forEach((row) => {
      unique.set(text(row.replenishment_plan_id), row);
    });
    return [...unique.values()];
  }, [data.replenishment]);

  const canCreate = role === "admin" || role === "planner";
  const canRespond = ["admin", "planner", "district"].includes(role);
  const openResponse = (row: RecordRow) => {
    setResponseRow(row);
    setDecision("confirm");
    setQuantity(text(row.suggested_qty, "0"));
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

  return (
    <div className="stack">
      <section className="workflow">
        {[
          ["1", "District Response", "due next day"],
          ["2", "Planner Approval", "all changes resolved"],
          ["3", "Academic Approval", ">9M requires note"],
          ["4", "Lock + FIFO", "immutable plan version"],
        ].map(([step, name, note], index) => (
          <div className="workflow-step done" key={name}>
            <span>{step}</span>
            <div>
              <strong>{name}</strong>
              <small>{note}</small>
            </div>
            {index < 3 && <i />}
          </div>
        ))}
      </section>

      <section className="filter-bar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ค้นหา Plan / Material / District"
          aria-label="ค้นหาแผน"
        />
        {canCreate && (
          <button
            className="btn primary"
            disabled={actionBusy}
            onClick={() => void onCreate()}
          >
            ＋ สร้าง Weekly Plan
          </button>
        )}
      </section>

      <section className="user-status">
        {[
          ["Plans", plans.length],
          [
            "Awaiting District",
            plans.filter(
              (row) => row.plan_status === "pending_district_confirmation",
            ).length,
          ],
          [
            "Awaiting Approval",
            plans.filter((row) =>
              ["pending_planner_approval", "pending_academic_approval"].includes(
                text(row.plan_status),
              ),
            ).length,
          ],
          [
            "Locked",
            plans.filter((row) => row.plan_status === "locked").length,
          ],
        ].map(([label, value]) => (
          <article key={String(label)}>
            <span>{label}</span>
            <strong>{formatNumber(value)}</strong>
            <small>Live backend</small>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <span>PLAN LINES</span>
            <h3>Weekly allocation candidates</h3>
          </div>
          <b>{formatNumber(rows.length)} rows</b>
        </div>
        <LiveTable
          rows={rows}
          empty="ยังไม่มีรายการใน Weekly Plan"
          columns={[
            [
              "Plan",
              (row) => (
                <span>
                  <strong>{text(row.plan_number)}</strong>
                  <small>V{formatNumber(row.version_no)}</small>
                </span>
              ),
            ],
            ["Status", (row) => <Badge>{text(row.plan_status)}</Badge>],
            [
              "Material",
              (row) => (
                <span>
                  <strong>{text(row.material_id)}</strong>
                  <small>{text(row.material_name)}</small>
                </span>
              ),
            ],
            ["District", (row) => row.district_id],
            ["Stock", (row) => formatNumber(row.current_stock_qty, 2)],
            ["CMP", (row) => formatNumber(row.cmp_monthly, 2)],
            ["Months", (row) => formatNumber(row.months_available, 1)],
            ["Suggested", (row) => formatNumber(row.suggested_qty, 2)],
            ["Final", (row) => formatNumber(row.final_qty, 2)],
            ["Line", (row) => <Badge>{text(row.item_status)}</Badge>],
            [
              "Respond",
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
                  ตอบรายการ
                </button>
              ),
            ],
          ]}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <span>PLAN ACTIONS</span>
            <h3>Sequential approval and controlled mutation</h3>
          </div>
        </div>
        <LiveTable
          rows={plans}
          empty="ยังไม่มีแผน"
          columns={[
            ["Plan", (row) => `${text(row.plan_number)} · V${text(row.version_no)}`],
            ["Week", (row) => row.week_start_date],
            ["Status", (row) => <Badge>{text(row.plan_status)}</Badge>],
            ["Due", (row) => formatDateTime(row.response_due_at)],
            ["Locked", (row) => formatDateTime(row.locked_at)],
            [
              "Action",
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
                          ? "Academic approve"
                          : "Planner approve"}
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
                        Issue
                      </button>
                    )}
                    {["admin", "planner"].includes(role) &&
                      !["completed", "cancelled"].includes(status) && (
                        <button
                          className="table-action"
                          onClick={() => setPlanAction({ type: "cancel", row })}
                        >
                          Cancel
                        </button>
                      )}
                    {["admin", "planner"].includes(role) &&
                      status === "locked" && (
                        <button
                          className="table-action"
                          onClick={() => setPlanAction({ type: "version", row })}
                        >
                          New version
                        </button>
                      )}
                  </span>
                );
              },
            ],
          ]}
        />
      </section>

      {responseRow && (
        <form className="pipeline-form" onSubmit={submitResponse}>
          <div className="panel-title">
            <div>
              <span>DISTRICT RESPONSE</span>
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
              Decision
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
              Quantity
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
              Requester name
              <input
                value={requester}
                onChange={(event) => setRequester(event.target.value)}
                maxLength={200}
                required
              />
            </label>
            <label className="wide">
              Reason / evidence
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
              บันทึก District response
            </button>
          </div>
        </form>
      )}

      {planAction && (
        <form className="pipeline-form compact" onSubmit={submitPlanAction}>
          <div className="panel-title">
            <div>
              <span>GOVERNED PLAN ACTION</span>
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
            Note / reason
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
                  ? "Academic note is mandatory when any line exceeds 9 months"
                  : "Required for cancellation/version audit"
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
          <span>BUSINESS RULES V1</span>
          <h3>CMP + 3.5M trigger + 4M MIN + 6M MAX</h3>
          <p>
            CMP = ROUND(AVERAGE(LY, 12M, 6M, 4M), 0). Partial pallet issue is
            allowed; fixed rounding tiers are disabled.
          </p>
        </div>
        <div>
          <strong>{formatNumber(data.recommendations.length)}</strong>
          <small>evidence records</small>
        </div>
      </section>
      <section className="panel">
        <LiveTable
          rows={data.recommendations}
          empty="ยังไม่มี Quantity recommendation"
          columns={[
            ["Plan", (row) => row.plan_number],
            ["Material", (row) => row.material_id],
            ["District", (row) => row.district_id],
            ["Stock", (row) => formatNumber(row.current_stock_qty, 2)],
            ["CMP", (row) => formatNumber(row.cmp_monthly, 2)],
            ["Months", (row) => formatNumber(row.months_available, 1)],
            ["MIN", (row) => formatNumber(row.min_fill_qty, 2)],
            ["MAX", (row) => formatNumber(row.max_fill_qty, 2)],
            ["Recommended", (row) => formatNumber(row.recommended_qty, 2)],
            ["Source", (row) => <Badge>{text(row.source_freshness_status)}</Badge>],
          ]}
        />
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
          <strong>Quantity above 6 months requires review</strong>
          <p>
            Above 9 months is a special-approval flag and Academic approval
            must include an evidence note.
          </p>
        </div>
      </section>
      <section className="panel">
        <LiveTable
          rows={data.changeRequests}
          empty="ไม่มี District change request"
          columns={[
            ["Plan", (row) => row.plan_number],
            ["Material", (row) => row.material_id],
            ["District", (row) => row.district_id],
            ["Baseline", (row) => formatNumber(row.baseline_qty, 2)],
            ["Requested", (row) => formatNumber(row.requested_qty, 2)],
            ["Projected", (row) => `${formatNumber(row.projected_months_after, 1)}M`],
            ["Risk", (row) => <Badge>{text(row.risk_level)}</Badge>],
            ["Requester", (row) => row.requester_name],
            ["Status", (row) => <Badge>{text(row.status)}</Badge>],
            [
              "Review",
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
              Decision
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
              Review note
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
        empty="ยังไม่มี Approval audit"
        columns={[
          ["Time", (row) => formatDateTime(row.acted_at)],
          ["Plan", (row) => text(row.replenishment_plan_id).slice(0, 8)],
          ["Stage", (row) => <Badge>{text(row.approval_stage)}</Badge>],
          ["Decision", (row) => row.decision],
          ["Role", (row) => row.actor_role],
          ["Actor", (row) => text(row.actor_id).slice(0, 8)],
          ["District", (row) => row.district_id],
          ["Note", (row) => row.note],
        ]}
      />
    </section>
  );
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
  const canReconcile = role === "admin" || role === "picker";
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
          <span>Handling Units</span>
          <strong>{formatNumber(data.handlingUnits.length)}</strong>
          <small>all statuses</small>
        </article>
        <article>
          <span>Open</span>
          <strong>
            {formatNumber(
              data.handlingUnits.filter((row) => row.opening_status === "OPEN")
                .length,
            )}
          </strong>
          <small>allocated before sealed</small>
        </article>
        <article className="danger">
          <span>Opening Unknown</span>
          <strong>
            {formatNumber(
              data.handlingUnits.filter(
                (row) => row.opening_status === "OPENING_UNKNOWN",
              ).length,
            )}
          </strong>
          <small>blocked until reconciled</small>
        </article>
        <article>
          <span>Allocatable</span>
          <strong>
            {formatNumber(
              data.fifo.reduce(
                (sum, row) => sum + Number(row.allocatable_qty ?? 0),
                0,
              ),
              2,
            )}
          </strong>
          <small>base units</small>
        </article>
      </section>
      {data.warehouseStock.length > 0 && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>ACTUAL WAREHOUSE SNAPSHOTS</span>
              <h3>Opening stock awaiting Handling Unit registration</h3>
            </div>
            <b>{formatNumber(data.warehouseStock.length)}</b>
          </div>
          {!data.handlingUnits.length && (
            <aside className="plain-notice warning">
              <i>!</i>
              <div>
                <strong>Stock exists, but no Handling Unit is registered</strong>
                <p>
                  Source-backed warehouse balance is visible below. Register
                  actual receipts or verified opening units before FIFO issue;
                  the system does not fabricate pallet or contract lineage.
                </p>
              </div>
            </aside>
          )}
          <LiveTable
            rows={data.warehouseStock.slice(0, 100)}
            empty="ยังไม่มี Warehouse snapshot"
            columns={[
              ["Material", (row) => row.material_id],
              ["Description", (row) => row.material_name],
              ["Quantity", (row) => formatNumber(row.quantity_on_hand, 2)],
              ["Unit", (row) => row.unit],
              ["Location", (row) => row.location_name_th],
              ["Snapshot", (row) => formatDateTime(row.snapshot_at)],
            ]}
          />
        </section>
      )}
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>FIFO QUEUE</span>
            <h3>Opened unit first, then accepted date / PO / item / row</h3>
          </div>
        </div>
        <LiveTable
          rows={data.fifo}
          empty="ไม่มี Handling Unit ที่พร้อมจ่าย"
          columns={[
            ["Seq", (row) => row.fifo_sequence],
            ["HU", (row) => row.handling_unit_code],
            ["Status", (row) => <Badge>{text(row.opening_status)}</Badge>],
            ["Material", (row) => row.material_id],
            ["Available", (row) => formatNumber(row.available_qty, 2)],
            ["Reserved", (row) => formatNumber(row.reserved_qty, 2)],
            ["Remain", (row) => formatNumber(row.allocatable_qty, 2)],
            ["Accepted", (row) => row.acceptance_date],
            ["PO / Item", (row) => `${text(row.purchase_order)} / ${text(row.line_item)}`],
            ["Lot", (row) => row.lot_code],
          ]}
        />
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>ALL HANDLING UNITS</span>
            <h3>Blocked, depleted and quarantined inventory</h3>
          </div>
        </div>
        <LiveTable
          rows={data.handlingUnits}
          empty="ยังไม่มี Handling Unit"
          columns={[
            ["HU", (row) => row.handling_unit_code],
            ["Material", (row) => row.material_id],
            ["Status", (row) => <Badge>{text(row.opening_status)}</Badge>],
            ["Trace", (row) => <Badge>{text(row.traceability_status)}</Badge>],
            ["Available", (row) => formatNumber(row.available_qty, 2)],
            ["Accepted", (row) => row.acceptance_date],
            [
              "Reconcile",
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
              Resolved status
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
              Count / acceptance evidence
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
              บันทึก Reconciliation
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
          <strong>Khlong Toei = Plant 2401 / Storage Location 0001</strong>
          <p>
            OPENING_UNKNOWN is blocked from FIFO until a picker/admin records
            reconciliation evidence.
          </p>
        </div>
      </section>
      <form className="pipeline-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="wide">
            Contract item
            <select
              value={contractItemId}
              onChange={(event) => setContractItemId(event.target.value)}
              required
            >
              <option value="">เลือก PO / Item / Material</option>
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
            Acceptance date
            <input
              type="date"
              value={acceptanceDate}
              onChange={(event) => setAcceptanceDate(event.target.value)}
              required
            />
          </label>
          <label>
            Quantity
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
            Handling Unit code
            <input
              value={handlingUnitCode}
              onChange={(event) => setHandlingUnitCode(event.target.value)}
              required
            />
          </label>
          <label>
            Unit type
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
            Opening status
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
            Installment
            <input
              value={installment}
              onChange={(event) => setInstallment(event.target.value)}
            />
          </label>
          <label className="wide">
            Source reference / acceptance evidence
            <textarea
              value={source}
              onChange={(event) => setSource(event.target.value)}
              required
            />
          </label>
        </div>
        <div className="pipeline-actions">
          <button className="btn primary" disabled={actionBusy}>
            รับ Handling Unit
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
  onApprove,
  onCreate,
  onIssue,
}: {
  actionBusy: boolean;
  data: DashboardData;
  role: Role;
  onApprove: (issueId: string, note: string) => Promise<boolean>;
  onCreate: (payload: AdHocIssuePayload) => Promise<boolean>;
  onIssue: (issueId: string) => Promise<boolean>;
}) {
  const [materialId, setMaterialId] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [requester, setRequester] = useState("");
  const [reason, setReason] = useState("");
  const [approveRow, setApproveRow] = useState<RecordRow | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const canCreate = ["admin", "planner", "district"].includes(role);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload: AdHocIssuePayload = {
      material_id: materialId,
      district_id: districtId,
      requested_qty: Number(quantity),
      requester_name: requester.trim(),
      reason: reason.trim(),
      idempotency_key: crypto.randomUUID(),
    };
    if (
      !payload.material_id ||
      !payload.district_id ||
      !Number.isFinite(payload.requested_qty) ||
      payload.requested_qty <= 0
    ) {
      return;
    }
    const ok = await onCreate(payload);
    if (ok) {
      setQuantity("");
      setReason("");
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
              Material
              <select
                value={materialId}
                onChange={(event) => setMaterialId(event.target.value)}
                required
              >
                <option value="">เลือก Material</option>
                {data.materials.map((row) => (
                  <option key={text(row.material_id)} value={text(row.material_id)}>
                    {text(row.material_id)} · {text(row.material_name)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              District
              <select
                value={districtId}
                onChange={(event) => setDistrictId(event.target.value)}
                required
              >
                <option value="">เลือก District</option>
                {data.districts.map((row) => (
                  <option key={text(row.district_id)} value={text(row.district_id)}>
                    {text(row.district_id)} · {text(row.district_name_th)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quantity
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
              Requester name
              <input
                value={requester}
                onChange={(event) => setRequester(event.target.value)}
                required
              />
            </label>
            <label className="wide">
              Emergency reason / evidence
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </label>
          </div>
          <div className="pipeline-actions">
            <button className="btn primary" disabled={actionBusy}>
              สร้าง Ad-hoc Issue
            </button>
          </div>
        </form>
      )}
      <section className="panel">
        <LiveTable
          rows={data.adHocIssues}
          empty="ยังไม่มี Ad-hoc Issue"
          columns={[
            ["Issue", (row) => row.issue_number],
            ["Material", (row) => row.material_id],
            ["District", (row) => row.district_id],
            ["Quantity", (row) => formatNumber(row.requested_qty, 2)],
            ["Allocated", (row) => formatNumber(row.allocated_qty, 2)],
            ["Requester", (row) => row.requester_name],
            ["Status", (row) => <Badge>{text(row.status)}</Badge>],
            [
              "Action",
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
                        Approve
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
                        Issue
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
            Approval note
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
              Approve + FIFO reserve
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
          placeholder="Issue / Material / HU / Contract / PO / Vendor"
          aria-label="ค้นหาการสอบกลับ"
        />
      </section>
      <section className="panel">
        <LiveTable
          rows={rows}
          empty="ยังไม่มี Inventory ISSUE movement"
          columns={[
            ["Issued", (row) => formatDateTime(row.occurred_at)],
            ["Issue", (row) => row.issue_reference],
            ["Type", (row) => <Badge>{text(row.issue_type)}</Badge>],
            ["District", (row) => row.district_id],
            ["Material", (row) => row.material_id],
            ["Qty", (row) => formatNumber(row.issued_qty, 2)],
            ["HU", (row) => row.handling_unit_code],
            ["Lot", (row) => row.lot_code],
            ["Accepted", (row) => row.acceptance_date],
            ["PO / Item", (row) => `${text(row.purchase_order)} / ${text(row.line_item)}`],
            ["Contract", (row) => row.contract_number],
            ["Vendor Alias", (row) => row.vendor_name],
            ...(canReturn
              ? [
                  [
                    "Return",
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
              <span>APPEND-ONLY RETURN</span>
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
              Return quantity (max {formatNumber(returnRow.issued_qty, 2)})
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
              Damaged / test failed → Quarantine
            </label>
            <label className="wide">
              Return reason / physical evidence
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
            <strong>UAT data is active — TEST FIXTURE</strong>
            <p>
              District stock or CMP on this screen includes governed Dummy
              workbook values. It is not Actual SAP evidence and must not be
              used for production readiness or operational dispatch.
            </p>
          </div>
        </section>
      )}
      <section className="plain-notice info">
        <i>i</i>
        <div>
          <strong>Frozen stock interpretation</strong>
          <p>
            Unrestricted only; transfer excluded. Missing material + plant is
            displayed as 0 with “Source Missing / Assumed 0”.
          </p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>DISTRICT STOCK HEALTH</span>
            <h3>Latest stock and CMP</h3>
          </div>
          <b>{formatNumber(data.stock.length)}</b>
        </div>
        <LiveTable
          rows={data.stock}
          empty="ยังไม่มี District Stock"
          columns={[
            ["Material", (row) => row.material_id],
            ["District", (row) => row.district_id],
            ["Stock", (row) => formatNumber(row.current_stock_qty, 2)],
            ["CMP", (row) => formatNumber(row.cmp_monthly, 2)],
            ["Months", (row) => formatNumber(row.months_available, 1)],
            ["Health", (row) => <Badge>{text(row.health_band)}</Badge>],
            ["Source", (row) => row.stock_source_status],
            ["Snapshot", (row) => formatDateTime(row.snapshot_at)],
          ]}
        />
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>WAREHOUSE STOCK</span>
            <h3>Khlong Toei actual snapshots</h3>
          </div>
          <b>{formatNumber(data.warehouseStock.length)}</b>
        </div>
        <LiveTable
          rows={data.warehouseStock}
          empty="ยังไม่มี Warehouse snapshot"
          columns={[
            ["Material", (row) => row.material_id],
            ["Description", (row) => row.material_name],
            ["Quantity", (row) => formatNumber(row.quantity_on_hand, 2)],
            ["Unit", (row) => row.unit],
            ["Location", (row) => row.location_name_th],
            ["Snapshot", (row) => formatDateTime(row.snapshot_at)],
          ]}
        />
      </section>
    </div>
  );
}

function DataView({ data }: { data: DashboardData }) {
  return (
    <div className="stack">
      <section className="user-status">
        <article>
          <span>Contracts</span>
          <strong>{formatNumber(data.contracts.length)}</strong>
          <small>current API page</small>
        </article>
        <article>
          <span>Data Quality</span>
          <strong>{formatNumber(data.quality.length)}</strong>
          <small>rule summaries</small>
        </article>
        <article>
          <span>Governed Inputs</span>
          <strong>{formatNumber(data.inputSubmissions.length)}</strong>
          <small>recent submissions</small>
        </article>
        <article>
          <span>Materials</span>
          <strong>{formatNumber(data.materials.length)}</strong>
          <small>role-scoped master</small>
        </article>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>CONTRACT STATUS</span>
            <h3>Current source-backed contracts</h3>
          </div>
        </div>
        <LiveTable
          rows={data.contracts}
          empty="ไม่มี Contract rows ในสิทธิ์นี้"
          columns={[
            ["PO", (row) => row.purchase_order],
            ["Contract", (row) => row.contract_number],
            ["Vendor Alias", (row) => row.vendor_name],
            ["Items", (row) => row.item_count],
            ["Status", (row) => <Badge>{text(row.contract_status)}</Badge>],
            ["Updated", (row) => formatDateTime(row.updated_at)],
          ]}
        />
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>DATA QUALITY</span>
            <h3>Active validation evidence</h3>
          </div>
        </div>
        <LiveTable
          rows={data.quality}
          empty="ไม่มี Data Quality issue"
          columns={[
            ["Rule", (row) => row.rule_code],
            ["Severity", (row) => <Badge>{text(row.severity)}</Badge>],
            ["Open", (row) => row.open_issue_count],
            ["Last detected", (row) => formatDateTime(row.last_detected_at)],
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
            Material
            <select
              value={materialId}
              onChange={(event) => setMaterialId(event.target.value)}
              required
            >
              <option value="">เลือก Material</option>
              {data.materials.map((row) => (
                <option key={text(row.material_id)} value={text(row.material_id)}>
                  {text(row.material_id)} · {text(row.material_name)}
                </option>
              ))}
            </select>
          </label>
          <label>
            District
            <select
              value={districtId}
              onChange={(event) => setDistrictId(event.target.value)}
              required
            >
              <option value="">เลือก District</option>
              {data.districts.map((row) => (
                <option key={text(row.district_id)} value={text(row.district_id)}>
                  {text(row.district_id)} · {text(row.district_name_th)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Snapshot time
            <input
              type="datetime-local"
              value={snapshot}
              onChange={(event) => setSnapshot(event.target.value)}
              required
            />
          </label>
          <label>
            Unrestricted stock
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
            Source note
            <input
              value={sourceNote}
              onChange={(event) => setSourceNote(event.target.value)}
              minLength={3}
              maxLength={500}
              required
            />
          </label>
          <label className="wide">
            Monthly history
            <textarea
              value={history}
              onChange={(event) => setHistory(event.target.value)}
              placeholder={"2026-04,100,0,7\n2026-05,110,0,7\n2026-06,105,0,7"}
              required
            />
            <small>YYYY-MM, demand, stockout days, lead time days</small>
          </label>
        </div>
        <label className="pipeline-check">
          <input
            type="checkbox"
            checked={runPlan}
            onChange={(event) => setRunPlan(event.target.checked)}
          />
          Create Weekly Plan after publish
        </label>
        {formError && <div className="form-error">{formError}</div>}
        <div className="pipeline-actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => void loadContext()}
            disabled={!materialId || !districtId || actionBusy}
          >
            โหลด Context
          </button>
          <button className="btn primary" disabled={actionBusy}>
            Publish governed input
          </button>
        </div>
      </form>
      {context && (
        <article className="pipeline-detail">
          <div>
            <span>LIVE SOURCE CONTEXT</span>
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
          <span>PRODUCTION RUNBOOK</span>
          <h3>Daily Control Center</h3>
          <p>
            Backup before migration, append-only evidence and fail-closed
            operational paths.
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
              <small>live database health</small>
            </article>
          ))}
      </section>
      <section className="user-status">
        {[
          ["Materials", sourceTotals.materials],
          ["Warehouse snapshots", sourceTotals.warehouse_stock_snapshots],
          ["District snapshots", sourceTotals.district_stock_snapshots],
          ["Usage rates", sourceTotals.usage_rates],
        ].map(([label, value]) => (
          <article key={text(label)}>
            <span>{text(label)}</span>
            <strong>{formatNumber(value)}</strong>
            <small>source-backed production rows</small>
          </article>
        ))}
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>DATA SOURCE READINESS</span>
            <h3>Actual source load status</h3>
          </div>
        </div>
        <LiveTable
          rows={sourceRows}
          empty="ยังไม่มี source import evidence"
          columns={[
            ["Source", (row) => row.source_key],
            ["Status", (row) => <Badge>{text(row.status)}</Badge>],
            ["Expected", (row) => formatNumber(row.expected_rows)],
            ["Loaded", (row) => formatNumber(row.loaded_rows)],
            ["Observed", (row) => formatDateTime(row.source_observed_at)],
            ["Updated", (row) => formatDateTime(row.updated_at)],
          ]}
        />
        {sourceWarnings.map((warning) => (
          <aside className="plain-notice warning" key={warning}>
            <i>!</i>
            <div>
              <strong>Source readiness warning</strong>
              <p>{warning}</p>
            </div>
          </aside>
        ))}
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>SYSTEM ALERTS</span>
            <h3>Operational exceptions</h3>
          </div>
        </div>
        <LiveTable
          rows={data.alerts}
          empty="ไม่มี Operational alert"
          columns={[
            ["Created", (row) => formatDateTime(row.created_at)],
            ["Type", (row) => row.alert_type],
            ["Severity", (row) => <Badge>{text(row.severity)}</Badge>],
            ["Status", (row) => row.status],
            ["Message", (row) => row.message],
          ]}
        />
      </section>
      <section className="runbook-grid">
        {[
          [
            "Daily backup",
            "Logical dump + SHA-256 + ops.backup_runs evidence.",
          ],
          [
            "Restore drill",
            "Quarterly restore into an isolated database and verify all schemas.",
          ],
          [
            "Safe release",
            "Tests → backup → migration → acceptance → smoke → release record.",
          ],
          [
            "Incident",
            "Rotate credentials, preserve audit evidence, then apply a forward fix.",
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
          <span>PRODUCTION OPERATIONS V1</span>
          <h3>Requirement-aligned operational release</h3>
          <p>Business Rules v1 · Supabase migration 202607230015</p>
        </div>
        <Badge>TESTED</Badge>
      </section>
      <section className="acceptance-grid">
        {[
          ["17 ordered Supabase migrations", "Schema"],
          ["36 same-origin API paths", "API"],
          ["District → Planner → Academic → Lock", "Approval"],
          ["Opened HU → accepted date → PO → item → row", "FIFO"],
          ["Weekly + Ad-hoc actual movement", "Issue"],
          ["Forward / reverse trace to contract and vendor", "Traceback"],
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
          <strong>Forecasting, Routing and RAG are excluded</strong>
          <p>
            They are absent from navigation and OpenAPI, and database dispatcher
            calls fail closed with HTTP 410 <code>scope_excluded</code>.
          </p>
        </div>
      </aside>
      <section className="plain-notice warning">
        <i>!</i>
        <div>
          <strong>Deployment is an environment action</strong>
          <p>
            Code readiness does not replace production secrets, Supabase backup
            policy, authenticated smoke tests and authorized release approval.
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
}: {
  view: ViewKey;
  role: Role;
  backend: ReturnType<typeof useSynapseBackend>;
  navigate: (view: ViewKey) => void;
}) {
  if (view === "dashboard") {
    return <DashboardView data={backend.data} role={role} navigate={navigate} />;
  }
  if (view === "weekly") {
    return (
      <WeeklyPlanView
        actionBusy={backend.actionBusy}
        data={backend.data}
        role={role}
        onApprove={backend.approveReplenishmentPlan}
        onCancel={backend.cancelReplenishmentPlan}
        onCreate={backend.createReplenishmentRun}
        onIssue={backend.issueReplenishmentPlan}
        onRespond={backend.respondReplenishment}
        onVersion={backend.versionReplenishmentPlan}
      />
    );
  }
  if (view === "recommendations") {
    return <RecommendationView data={backend.data} />;
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
  const [menuOpen, setMenuOpen] = useState(false);

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
  const activeView = allowedViews.has(view) ? view : "dashboard";
  const [eyebrow, title, description] = titles[activeView];
  const snapshot = latestSnapshot(backend.data);

  return (
    <div className="app">
      <a className="skip" href="#content">
        ข้ามไปเนื้อหาหลัก
      </a>
      <Sidebar
        active={activeView}
        role={role}
        open={menuOpen}
        navigate={setView}
        close={() => setMenuOpen(false)}
        snapshot={snapshot}
      />
      <div className="shell">
        <Header
          title={title}
          loading={backend.loading}
          openMenu={() => setMenuOpen(true)}
          logout={() => void backend.signOut()}
          navigate={setView}
          refresh={() => void backend.refresh()}
          snapshot={snapshot}
        />
        <main id="content" className="content">
          <header className="page-head user-page-head">
            <div>
              <span>{eyebrow}</span>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
          </header>
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
          <PageContent
            view={activeView}
            role={role}
            backend={backend}
            navigate={setView}
          />
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
