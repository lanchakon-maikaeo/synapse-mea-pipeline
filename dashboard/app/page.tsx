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
import {
  TransportModule,
  transportNavForRole,
  type TransportView,
} from "./transport";

type ViewKey =
  | "dashboard"
  | "weekly"
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
      label: "เมนูหลัก",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "คำนวณการจ่าย", "▤"],
        ["approvals", "ประวัติแผนการจ่าย", "✓"],
        ["changes", "ตรวจคำขอผิดปกติ", "!"],
      ],
    },
    {
      label: "คลังสินค้า",
      items: [
        ["fifo", "FIFO & พาเลท", "▦"],
        ["receiving", "รับพัสดุเข้าคลัง", "＋"],
        ["adhoc", "จ่ายกรณีพิเศษ", "↗"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
      ],
    },
    {
      label: "ข้อมูล & ควบคุม",
      items: [
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["advisory", "Intelligence (advisory)", "◈"],
        ["stock", "ข้อมูล Stock", "◫"],
        ["input", "อัปเดต Stock", "↻"],
        ["data", "ข้อมูล SAP / คุณภาพ", "▥"],
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
        ["approvals", "ประวัติแผนการจ่าย", "✓"],
        ["changes", "ตรวจคำขอผิดปกติ", "!"],
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["advisory", "Intelligence (advisory)", "◈"],
      ],
    },
    {
      label: "คลังสินค้า",
      items: [
        ["fifo", "FIFO & พาเลท", "▦"],
        ["adhoc", "จ่ายกรณีพิเศษ", "↗"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
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
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["approvals", "ประวัติการอนุมัติ", "◷"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
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
        ["fifo", "FIFO & พาเลท", "▦"],
        ["receiving", "รับพัสดุเข้าคลัง", "＋"],
        ["adhoc", "จ่ายกรณีพิเศษ", "↗"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
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
        ["stock", "Stock เขต", "◫"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
      ],
    },
  ],
  viewer: [
    {
      label: "อ่านอย่างเดียว",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "แผนการจ่าย", "▤"],
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["fifo", "FIFO & พาเลท", "▦"],
        ["stock", "ข้อมูล Stock", "◫"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
      ],
    },
  ],
};

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
  moduleKey,
  setModule,
  transportView,
  setTransportView,
}: {
  active: ViewKey;
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
          moduleKey === key ? "#E3670A" : "rgba(255,255,255,.06)",
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
            ? navByRole[role].map((group) => (
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
              ))
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
  const materialsCount = data.materials.length;
  const districtsCount = data.districts.length;
  const warehouseCount = data.warehouseStock.length;
  const stockHealthCount = data.stock.length;
  const contractsCount = data.contracts.length;
  const hasReferenceData =
    materialsCount + warehouseCount + stockHealthCount + contractsCount > 0;
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
          <span>ภาพรวมการทำงาน</span>
          <h2>เชื่อมโยงข้อมูลตั้งแต่ต้นทางจนถึงการจ่ายจริง</h2>
          <p>
            แผนการจ่าย · เขตยืนยัน · ผู้วางแผน · วิชาการ · FIFO · เคลื่อนไหวสต็อก ·
            สอบกลับ
          </p>
        </div>
        <button className="btn light" onClick={() => navigate(nextView)}>
          เปิดงานที่ต้องดำเนินการ
        </button>
      </section>
      <section className="kpis">
        <article>
          <div>
            <span>แผนการจ่าย</span>
            <i className="dot purple" />
          </div>
          <strong>{formatNumber(planIds.size)}</strong>
          <small>ตามสิทธิ์ของคุณ</small>
        </article>
        <article>
          <div>
            <span>คำขอรอตรวจ</span>
            <i className="dot orange" />
          </div>
          <strong>{formatNumber(pendingChanges)}</strong>
          <small>รอผู้วางแผนตรวจ</small>
        </article>
        <article>
          <div>
            <span>พร้อมจ่าย (FIFO)</span>
            <i className="dot green" />
          </div>
          <strong>{formatNumber(allocatable, 2)}</strong>
          <small>หน่วยนับพื้นฐานที่สอบกลับได้</small>
        </article>
        <article>
          <div>
            <span>กรณีพิเศษรอดำเนินการ</span>
            <i className="dot blue" />
          </div>
          <strong>{formatNumber(pendingAdHoc)}</strong>
          <small>แยกจากแผนรายสัปดาห์</small>
        </article>
      </section>
      <section className="kpis">
        <article>
          <div>
            <span>รายการวัสดุ</span>
            <i className="dot purple" />
          </div>
          <strong>{formatNumber(materialsCount)}</strong>
          <small>ข้อมูลจริงจากระบบ</small>
        </article>
        <article>
          <div>
            <span>เขต</span>
            <i className="dot blue" />
          </div>
          <strong>{formatNumber(districtsCount)}</strong>
          <small>ทะเบียนเขตในระบบ</small>
        </article>
        <article>
          <div>
            <span>ข้อมูลสต็อกคลัง</span>
            <i className="dot green" />
          </div>
          <strong>{formatNumber(warehouseCount)}</strong>
          <small>สต็อกจริงคลังคลองเตย</small>
        </article>
        <article>
          <div>
            <span>ข้อมูลสุขภาพสต็อก</span>
            <i className="dot orange" />
          </div>
          <strong>{formatNumber(stockHealthCount)}</strong>
          <small>ความครอบคลุมการวิเคราะห์</small>
        </article>
      </section>
      {hasReferenceData && (
        <section className="dashboard-main">
          <article className="panel">
            <div className="panel-title">
              <div>
                <span>สต็อกคลัง · เรียลไทม์</span>
                <h3>ข้อมูลสต็อกจริงคลังคลองเตย</h3>
              </div>
              <b>{formatNumber(warehouseCount)}</b>
            </div>
            <LiveTable
              rows={data.warehouseStock.slice(0, 6)}
              empty="ยังไม่มีข้อมูลสต็อกคลัง"
              columns={[
                ["วัสดุ", (row) => row.material_id],
                ["รายละเอียด", (row) => row.material_name],
                ["จำนวน", (row) => formatNumber(row.quantity_on_hand, 2)],
                ["หน่วย", (row) => row.unit],
                ["เวลาข้อมูล", (row) => formatDateTime(row.snapshot_at)],
              ]}
            />
          </article>
          <article className="panel">
            <div className="panel-title">
              <div>
                <span>สุขภาพสต็อกเขต · เรียลไทม์</span>
                <h3>สต็อกและ CMP ล่าสุด</h3>
              </div>
              <b>{formatNumber(stockHealthCount)}</b>
            </div>
            <LiveTable
              rows={data.stock.slice(0, 6)}
              empty="ยังไม่มีข้อมูลสต็อกเขต"
              columns={[
                ["วัสดุ", (row) => row.material_id],
                ["เขต", (row) => row.district_id],
                ["สต็อก", (row) => formatNumber(row.current_stock_qty, 2)],
                ["CMP", (row) => formatNumber(row.cmp_monthly, 2)],
                ["สถานะ", (row) => <Badge>{text(row.health_band)}</Badge>],
              ]}
            />
          </article>
        </section>
      )}
      <section className="dashboard-main">
        <article className="panel">
          <div className="panel-title">
            <div>
              <span>รายการที่ต้องดู</span>
              <h3>คำขอที่มีความเสี่ยงสูง</h3>
            </div>
            <b className="count">{pendingChanges}</b>
          </div>
          <LiveTable
            rows={data.changeRequests.slice(0, 6)}
            empty="ไม่มีคำขอผิดปกติ"
            columns={[
              ["วัสดุ", (row) => row.material_id],
              ["เขต", (row) => row.district_id],
              ["ขอเบิก", (row) => formatNumber(row.requested_qty, 2)],
              ["คงคลังหลังจ่าย", (row) => `${formatNumber(row.projected_months_after, 1)} เดือน`],
              ["ความเสี่ยง", (row) => <Badge>{text(row.risk_level)}</Badge>],
            ]}
          />
        </article>
        <article className="panel">
          <div className="panel-title">
            <div>
              <span>ความครอบคลุมการสอบกลับ</span>
              <h3>การจ่ายที่สอบกลับได้</h3>
            </div>
            <b>{formatNumber(data.traceability.length)}</b>
          </div>
          <LiveTable
            rows={data.traceability.slice(0, 6)}
            empty="ยังไม่มีการจ่ายจริง"
            columns={[
              ["เลขที่จ่าย", (row) => row.issue_reference],
              ["ประเภท", (row) => <Badge>{text(row.issue_type)}</Badge>],
              ["หน่วยจัดเก็บ", (row) => row.handling_unit_code],
              ["ผู้ขาย", (row) => row.vendor_name],
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
  onReview,
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
}) {
  const [workflowStep, setWorkflowStep] = useState(() =>
    role === "district" ? 3 : role === "academic" ? 5 : 0,
  );
  const [searchMode, setSearchMode] = useState<"district" | "material">(
    "district",
  );
  const [query, setQuery] = useState("");
  const [focusedItemId, setFocusedItemId] = useState("");
  const [plannerQuantities, setPlannerQuantities] = useState<
    Record<string, string>
  >({});
  const [editedPlanningRows, setEditedPlanningRows] = useState<
    Record<string, RecordRow>
  >({});
  const [selectedPlanningIds, setSelectedPlanningIds] = useState<
    Record<string, boolean>
  >({});
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
  const materialRows: RecordRow[] = selectedMaterial
    ? districtReference.map((district) => {
        const stock =
          data.stock.find(
            (row) =>
              text(row.material_id) === selectedMaterial.id &&
              text(row.district_id) === district.district_id,
          ) ?? {};
        const queued =
          data.replenishment.find(
            (row) =>
              text(row.material_id) === selectedMaterial.id &&
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
          material_id: selectedMaterial.id,
          material_name: selectedMaterial.name,
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
      })
    : [];
  const rows = (
    searchMode === "district"
      ? data.replenishment.filter((row) => {
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
    row.replenishment_item_id ? Number(row.suggested_qty ?? 0) : 0;
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
  let fifoRemaining = focusedRow ? plannerQuantity(focusedRow) : 0;
  const fifoPreview = focusedFifo.map((row): RecordRow => {
      const allocatable = Math.max(0, Number(row.allocatable_qty ?? 0));
      const allocated = Math.min(allocatable, fifoRemaining);
      fifoRemaining -= allocated;
      return { ...row, preview_allocated_qty: allocated };
    });
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

      <section className="user-status">
        {[
          ["รายการที่เลือก", selectedRows.length],
          ["เขตในแผน", districtSummary.length],
          [
            "รอเขตตอบ",
            data.replenishment.filter((row) =>
              ["draft", "pending", "change_requested"].includes(
                text(row.item_status),
              ),
            ).length,
          ],
          ["คำขอเปลี่ยน", data.changeRequests.length],
        ].map(([label, value]) => (
          <article key={String(label)}>
            <span>{label}</span>
            <strong>{formatNumber(value)}</strong>
            <small>ข้อมูลจริงจากระบบ</small>
          </article>
        ))}
      </section>

      {(workflowStep === 0 || workflowStep === 1) && (
        <>
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
            {canCreate && data.replenishment.length === 0 ? (
              <button
                className="btn primary"
                disabled={actionBusy}
                onClick={() => void onCreate()}
              >
                เริ่มรอบแผนจากข้อมูลล่าสุด
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                disabled={!selectedRows.length}
                onClick={() => setWorkflowStep(2)}
              >
                ยืนยันรายการที่เลือก ({formatNumber(selectedRows.length)})
              </button>
            )}
          </section>

          <section className="planner-preview-note">
            <strong>Candidate Source</strong>
            <span>
              รายเขตแสดงเฉพาะพัสดุที่ต้องเติม · รายพัสดุแสดงครบทั้ง 18 เขต
              พร้อมสถานะต้องเติม/ไม่ต้องเติม · กรอก Planner Qty แล้วเลือก
              “เข้าแผน” เฉพาะรายการที่ต้องการยืนยัน
            </span>
          </section>

          <section className="planner-workspace-grid">
            <article className="panel planner-picker">
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
                        <th>AI Suggestion</th>
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
                              <span className="ai-suggestion">✦ AI {formatNumber(row.suggested_qty, 0)}</span>
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
                    <span>AI / Rule Suggestion</span>
                    <strong>{formatNumber(focusedRow.suggested_qty, 0)}</strong>
                    <small>
                      {text(
                        focusedRecommendation?.method,
                        "ยังไม่มีผล AI จากประวัติ — ใช้ Business Rule",
                      )}
                    </small>
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
                            key={text(row.handling_unit_id)}
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
              ยืนยันรายการที่เลือกเข้า Draft Plan ({formatNumber(selectedRows.length)}) →
            </button>
          </div>
        </>
      )}

      {workflowStep === 2 && (
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
                ["Stock คลังกลาง", (row) => formatNumber(warehouseQuantity(row), 0)],
                ["Stock เขต", (row) => formatNumber(row.current_stock_qty, 0)],
                ["MIN", (row) => formatNumber(row.min_fill_qty, 0)],
                ["MAX", (row) => formatNumber(row.max_fill_qty, 0)],
                ["✦ AI Suggestion", (row) => formatNumber(row.suggested_qty, 0)],
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
              ← กลับไปแก้รายการ
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!selectedRows.length}
              onClick={() => setWorkflowStep(3)}
            >
              ยืนยัน Draft Plan และส่งให้เขตตรวจทีละรายการ →
            </button>
          </div>
        </section>
      )}

      {workflowStep === 3 && (
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
                ["แผน", (row) => `${text(row.plan_number)} · V${text(row.version_no)}`],
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

      {responseRow && (
        <form className="pipeline-form" onSubmit={submitResponse}>
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

const ADVISORY_ORDER: Record<AdvisoryLevel, number> = {
  critical: 0,
  warning: 1,
  watch: 2,
  none: 3,
};

const ADVISORY_STYLE: Record<AdvisoryLevel, { bg: string; fg: string; label: string }> = {
  critical: { bg: "#fee4e2", fg: "#b42318", label: "Critical" },
  warning: { bg: "#fef0c7", fg: "#b54708", label: "Warning" },
  watch: { bg: "#d1e9ff", fg: "#175cd3", label: "Watch" },
  none: { bg: "#dcfae6", fg: "#067647", label: "OK" },
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
  const flagged = scored
    .filter(({ advisory }) => advisory.level !== "none")
    .sort((a, b) => ADVISORY_ORDER[a.advisory.level] - ADVISORY_ORDER[b.advisory.level])
    .map(({ row, advisory }) => ({ ...row, __level: advisory.level, __reason: advisory.reason }));
  return (
    <div className="stack">
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
          <strong>{formatNumber(flagged.length)}</strong>
          <small>ต้องเฝ้าระวัง / {formatNumber(scored.length)} records</small>
        </div>
      </section>
      <section
        className="panel"
        style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}
      >
        {(["critical", "warning", "watch", "none"] as AdvisoryLevel[]).map((level) => (
          <div key={level} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <RiskBadge level={level} />
            <strong>{formatNumber(counts[level])}</strong>
          </div>
        ))}
      </section>
      <section className="panel">
        <LiveTable
          rows={flagged}
          empty="ไม่มีรายการที่ต้องเฝ้าระวัง — หรือยังไม่มีหลักฐานปริมาณ"
          columns={[
            ["วัสดุ", (row) => row.material_id],
            ["เขต", (row) => row.district_id],
            ["สต็อก", (row) => formatNumber(row.current_stock_qty, 2)],
            ["CMP", (row) => formatNumber(row.cmp_monthly, 2)],
            ["เดือน", (row) => formatNumber(row.months_available, 1)],
            ["ความเสี่ยง", (row) => <RiskBadge level={row.__level as AdvisoryLevel} />],
            ["สัญญาณ", (row) => text(row.__reason)],
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
      {data.warehouseStock.length > 0 && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>ข้อมูลสต็อกคลังจริง</span>
              <h3>สต็อกที่รอลงทะเบียนหน่วยจัดเก็บ</h3>
            </div>
            <b>{formatNumber(data.warehouseStock.length)}</b>
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
            rows={data.warehouseStock.slice(0, 100)}
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
      )}
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>คิว FIFO</span>
            <h3>จ่ายหน่วยที่เปิดก่อน แล้วเรียงตามวันรับ / PO / รายการ</h3>
          </div>
        </div>
        <LiveTable
          rows={data.fifo}
          empty="ไม่มีหน่วยจัดเก็บที่พร้อมจ่าย"
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
        </div>
        <LiveTable
          rows={data.handlingUnits}
          empty="ยังไม่มีหน่วยจัดเก็บ"
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
            <label className="wide">
              เหตุผลกรณีพิเศษ / หลักฐาน
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </label>
          </div>
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
          ["เชื่อมต่อ API ภายในโดเมนเดียว 48 เส้นทาง", "API"],
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
        onReview={backend.reviewChangeRequest}
        onRespond={backend.respondReplenishment}
        onVersion={backend.versionReplenishmentPlan}
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
  const [moduleKey, setModule] = useState<"warehouse" | "transport">(
    "warehouse",
  );
  const [transportView, setTransportView] = useState<TransportView>("dashboard");

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
  const allowedTransportViews = new Set(
    transportNavForRole(role).map(([transportKey]) => transportKey),
  );
  const activeTransportView = allowedTransportViews.has(transportView)
    ? transportView
    : "dashboard";
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
        moduleKey={moduleKey}
        setModule={setModule}
        transportView={activeTransportView}
        setTransportView={setTransportView}
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
                  setView("dashboard");
                  setModule("warehouse");
                }}
              >
                <option value="planner">Planner คลังคลองเตย</option>
                <option value="district">District User 5501</option>
                <option value="academic">นักวิชาการ</option>
                <option value="picker">Warehouse Picker</option>
                <option value="viewer">Viewer / ผู้บริหาร</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </aside>
        )}
        <Header
          title={moduleKey === "transport" ? "ระบบขนส่ง" : title}
          loading={backend.loading}
          openMenu={() => setMenuOpen(true)}
          logout={() => void backend.signOut()}
          navigate={setView}
          refresh={() => void backend.refresh()}
          snapshot={snapshot}
        />
        <main id="content" className="content">
          {moduleKey === "transport" ? (
            <TransportModule
              view={activeTransportView}
              token={backend.session?.access_token ?? null}
              role={role}
              actorId={backend.identity.user_id}
            />
          ) : (
            <>
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
              <PageContent
                view={activeView}
                role={role}
                backend={backend}
                navigate={setView}
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
