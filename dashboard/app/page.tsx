"use client";

import {
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
import FifoPackagingSetupView from "./fifo-packaging-setup";
import {
  TransportModule,
  transportNavForRole,
  type TransportView,
} from "./transport";

type ViewKey =
  | "dashboard"
  | "weekly"
  | "district_confirmations"
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
  | "input"
  | "operations"
  | "release";

type NavGroup = {
  label: string;
  items: Array<[ViewKey, string, string]>;
};

const roleNameTh: Record<Role, string> = {
  admin: "ผู้ดูแลระบบ",
  planner: "ผู้วางแผน",
  academic: "เจ้าหน้าที่วิชาการ",
  picker: "เจ้าหน้าที่คลัง",
  district: "เจ้าหน้าที่เขต",
  viewer: "ผู้บริหาร / ผู้ดูข้อมูล",
};

const roleNameEn: Record<Role, string> = {
  admin: "Admin",
  planner: "Planner",
  academic: "Academic Approver",
  picker: "Warehouse Staff",
  district: "District User",
  viewer: "Viewer",
};

const navByRole: Record<Role, NavGroup[]> = {
  admin: [
    {
      label: "เมนูหลัก",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "คำนวณการจ่าย", "▤"],
        ["district_confirmations", "ยืนยันรายการเขต", "◎"],
        ["approvals", "ประวัติแผนการจ่าย", "✓"],
        ["changes", "ตรวจคำขอผิดปกติ", "!"],
      ],
    },
    {
      label: "IMPORT CENTER",
      items: [
        ["import", "Import Data", "⇧"],
        ["fifo_setup", "FIFO / Packaging Setup", "▣"],
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
        ["district_confirmations", "ยืนยันรายการเขต", "◎"],
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
        ["district_confirmations", "ผลยืนยันจากเขต", "◎"],
        ["changes", "หลักฐานคำขอผิดปกติ", "!"],
        ["recommendations", "หลักฐานปริมาณ", "✦"],
        ["approvals", "ประวัติการอนุมัติ", "◷"],
        ["trace", "สอบกลับการจ่าย", "⌕"],
      ],
    },
  ],
  picker: [
    {
      label: "งานคลัง",
      items: [
        ["dashboard", "แดชบอร์ด", "⌂"],
        ["weekly", "แผนที่ล็อกแล้ว", "▤"],
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
  district_confirmations: [
    "DISTRICT REVIEW",
    "ยืนยันรายการเขตก่อนจัดรถ",
    "ตรวจผลตอบรายเขต คำขอเปลี่ยน และรายการค้าง ก่อนยืนยันแผนเข้าสู่ขั้นอนุมัติและจัดรถ",
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
    <div className="live-table-wrap" tabIndex={0} aria-label="ตารางข้อมูล เลื่อนแนวนอนได้เมื่อข้อมูลกว้างกว่าหน้าจอ">
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

type AccessRequestForm = {
  fullName: string;
  employeeId: string;
  workEmail: string;
  organizationUnit: string;
  requestedRole: Exclude<Role, "admin">;
  reason: string;
};

const emptyAccessRequest: AccessRequestForm = {
  fullName: "",
  employeeId: "",
  workEmail: "",
  organizationUnit: "",
  requestedRole: "district",
  reason: "",
};

function RequestAccessDialog({ close }: { close: () => void }) {
  const [form, setForm] = useState<AccessRequestForm>(emptyAccessRequest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");

  const update = <K extends keyof AccessRequestForm>(
    field: K,
    value: AccessRequestForm[K],
  ) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        request_number?: string;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          payload.error?.message ?? "ไม่สามารถส่งคำขอได้ กรุณาลองอีกครั้ง",
        );
      }
      setReference(payload.request_number ?? "ส่งคำขอแล้ว");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "ไม่สามารถส่งคำขอได้ กรุณาลองอีกครั้ง",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="access-request-backdrop" role="presentation">
      <section
        className="access-request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-request-title"
      >
        <header>
          <div>
            <span>REQUEST ACCESS</span>
            <h2 id="access-request-title">ขอสิทธิ์เข้าใช้งาน</h2>
            <p>Admin จะตรวจสอบข้อมูลและกำหนดบทบาทก่อนสร้างบัญชี</p>
          </div>
          <button type="button" onClick={close} aria-label="ปิดแบบฟอร์ม">
            ×
          </button>
        </header>
        {reference ? (
          <div className="access-request-success" role="status">
            <i>✓</i>
            <h3>ส่งคำขอเรียบร้อยแล้ว</h3>
            <p>
              เลขอ้างอิง <strong>{reference}</strong>
            </p>
            <small>
              บัญชียังไม่ถูกสร้างจนกว่า Admin จะตรวจสอบและอนุมัติ
            </small>
            <button type="button" className="btn primary" onClick={close}>
              กลับหน้า Login
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="access-request-form">
            <div className="access-request-grid">
              <label>
                ชื่อ–นามสกุล
                <input
                  value={form.fullName}
                  onChange={(event) => update("fullName", event.target.value)}
                  autoComplete="name"
                  required
                  maxLength={120}
                />
              </label>
              <label>
                รหัสพนักงาน
                <input
                  value={form.employeeId}
                  onChange={(event) => update("employeeId", event.target.value)}
                  required
                  maxLength={30}
                />
              </label>
              <label>
                อีเมลองค์กร
                <input
                  type="email"
                  value={form.workEmail}
                  onChange={(event) => update("workEmail", event.target.value)}
                  autoComplete="email"
                  required
                  maxLength={160}
                />
              </label>
              <label>
                หน่วยงาน / การไฟฟ้าเขต
                <input
                  value={form.organizationUnit}
                  onChange={(event) =>
                    update("organizationUnit", event.target.value)
                  }
                  required
                  maxLength={160}
                  placeholder="เช่น 5501 : เขตนวลจันทร์"
                />
              </label>
              <label className="access-request-wide">
                บทบาทที่ขอ
                <select
                  value={form.requestedRole}
                  onChange={(event) =>
                    update(
                      "requestedRole",
                      event.target.value as AccessRequestForm["requestedRole"],
                    )
                  }
                >
                  <option value="district">District User · ผู้ใช้งานเขต</option>
                  <option value="planner">Planner · ผู้วางแผน</option>
                  <option value="academic">
                    Academic Approver · นักวิชาการ
                  </option>
                  <option value="picker">
                    Warehouse Staff · เจ้าหน้าที่คลัง
                  </option>
                  <option value="viewer">Viewer · ผู้บริหาร/ผู้ดูข้อมูล</option>
                </select>
              </label>
              <label className="access-request-wide">
                เหตุผลที่ขอใช้งาน
                <textarea
                  value={form.reason}
                  onChange={(event) => update("reason", event.target.value)}
                  required
                  minLength={10}
                  maxLength={800}
                  rows={3}
                />
              </label>
            </div>
            <div className="access-request-note">
              <i>i</i>
              <p>
                บทบาทที่เลือกเป็นเพียงคำขอเท่านั้น สิทธิ์จริงและพื้นที่รับผิดชอบจะถูกกำหนดโดย Admin
              </p>
            </div>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <footer>
              <button type="button" className="btn ghost" onClick={close}>
                ยกเลิก
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? "กำลังส่งคำขอ…" : "ส่งคำขอให้ Admin"}
              </button>
            </footer>
          </form>
        )}
      </section>
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
  const [showAccessRequest, setShowAccessRequest] = useState(false);
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
          <button
            className="login-request-access"
            type="button"
            onClick={() => setShowAccessRequest(true)}
          >
            <span>ยังไม่มีบัญชี?</span>
            <strong>Request Access · ขอสิทธิ์เข้าใช้งาน</strong>
          </button>
          <div className="login-assurance">
            <span>กำหนดสิทธิ์ตามบทบาท</span>
            <i />
            <span>ข้อมูลตามพื้นที่รับผิดชอบ</span>
          </div>
        </form>
      </section>
      {showAccessRequest && (
        <RequestAccessDialog close={() => setShowAccessRequest(false)} />
      )}
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
          <i>{roleNameTh[role].charAt(0)}</i>
          <div>
            <small>บทบาทของคุณ</small>
            <strong>{roleNameTh[role]}</strong>
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
                      className={`${active === key ? "active" : ""} ${
                        key === "import" ? "import-nav-button" : ""
                      }`}
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
  role,
  districtId,
  loading,
  openMenu,
  logout,
  navigate,
  refresh,
  snapshot,
}: {
  title: string;
  role: Role;
  districtId: string | null;
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
        <div className="identity-chip" title="สิทธิ์กำหนดจากบัญชีผู้ใช้งาน">
          <i>{roleNameTh[role].charAt(0)}</i>
          <span>
            <small>Signed in as</small>
            <strong>
              {roleNameEn[role]} · {roleNameTh[role]}
              {districtId ? ` ${districtId}` : ""}
            </strong>
          </span>
        </div>
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
      <section className="workflow">
        {[
          ["1", "เขต", "ยืนยัน / ปฏิเสธ / ขอแก้"],
          ["2", "ผู้วางแผน", "ตรวจและอนุมัติ"],
          ["3", "วิชาการ", "เกิน 9 เดือน ต้องมีหลักฐาน + ล็อก"],
          ["4", "เจ้าหน้าที่คลัง", "จ่ายแบบ FIFO + บันทึกเคลื่อนไหว"],
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
  currentUserName,
  data,
  role,
  onApprove,
  onCancel,
  onCreate,
  onIssue,
  onReview,
  onRespond,
  onReturn,
  onVersion,
}: {
  actionBusy: boolean;
  currentUserName: string;
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
  onReturn: (planId: string, note: string) => Promise<boolean>;
  onVersion: (planId: string, reason: string) => Promise<boolean>;
}) {
  const plannerTopScrollRef = useRef<HTMLDivElement>(null);
  const plannerTableScrollRef = useRef<HTMLDivElement>(null);
  const districtBatchDetailRef = useRef<HTMLDivElement>(null);
  const [plannerTableWidth, setPlannerTableWidth] = useState(1450);
  const [workflowStep, setWorkflowStep] = useState(() =>
    role === "district" ? 3 : role === "academic" ? 5 : 0,
  );
  const [searchMode, setSearchMode] = useState<"district" | "material">(
    "district",
  );
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<
    "priority" | "district" | "material" | "months"
  >("priority");
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
  const [savedDistrictIds, setSavedDistrictIds] = useState<
    Record<string, boolean>
  >({});
  const [draftSaveMessage, setDraftSaveMessage] = useState("");
  const [responseRow, setResponseRow] = useState<RecordRow | null>(null);
  const [decision, setDecision] = useState<
    ReplenishmentResponsePayload["decision"] | "defer"
  >("confirm");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [requester, setRequester] = useState("");
  const [deferredUntil, setDeferredUntil] = useState("");
  const [responseError, setResponseError] = useState("");
  const [districtBatchId, setDistrictBatchId] = useState("");
  const [districtReviewMode, setDistrictReviewMode] = useState<
    "pending" | "history"
  >("pending");
  const [planAction, setPlanAction] = useState<{
    type: "approve" | "return" | "cancel" | "version";
    row: RecordRow;
  } | null>(null);
  const [planNote, setPlanNote] = useState("");
  const [pickingDocument, setPickingDocument] = useState<{
    plan: RecordRow;
    generatedAt: string;
  } | null>(null);

  const itemId = (row: RecordRow) =>
    text(
      row.replenishment_item_id,
      `${text(row.district_id, "")}|${text(row.material_id, "")}`,
    );
  const planningCandidateKey = (row: RecordRow) =>
    `${text(row.district_id, "")}|${text(row.material_id, "")}`;
  const planningCandidateRank = (row: RecordRow) => {
    const timestamp = Date.parse(
      text(
        row.updated_at,
        text(
          row.calculated_at,
          text(row.created_at, text(row.snapshot_date, "1970-01-01")),
        ),
      ),
    );
    const version = Number(row.version_no ?? row.plan_version ?? 0);
    return (Number.isFinite(timestamp) ? timestamp : 0) * 1_000 + version;
  };
  const canonicalReplenishmentRows = (() => {
    const candidates = new Map<string, RecordRow>();
    data.replenishment.forEach((row) => {
      const key = planningCandidateKey(row);
      const current = candidates.get(key);
      if (!current || planningCandidateRank(row) > planningCandidateRank(current)) {
        candidates.set(key, row);
      }
    });
    return [...candidates.values()];
  })();
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
          canonicalReplenishmentRows.find(
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
      ? canonicalReplenishmentRows.filter((row) => {
          const value = query.trim().toLowerCase();
          return !value || text(row.district_id).toLowerCase().includes(value);
        })
      : materialRows
  ).sort((left, right) => {
    if (sortMode === "district") {
      return (
        text(left.district_id).localeCompare(text(right.district_id)) ||
        text(left.material_id).localeCompare(text(right.material_id))
      );
    }
    if (sortMode === "material") {
      return (
        text(left.material_id).localeCompare(text(right.material_id)) ||
        text(left.district_id).localeCompare(text(right.district_id))
      );
    }
    if (sortMode === "months") {
      return (
        Number(left.months_available ?? Number.POSITIVE_INFINITY) -
          Number(right.months_available ?? Number.POSITIVE_INFINITY) ||
        text(left.district_id).localeCompare(text(right.district_id))
      );
    }
    return (
      Number(Boolean(right.needs_fill ?? Number(right.suggested_qty ?? 0) > 0)) -
        Number(Boolean(left.needs_fill ?? Number(left.suggested_qty ?? 0) > 0)) ||
      Number(right.priority_score ?? 0) - Number(left.priority_score ?? 0) ||
      text(left.district_id).localeCompare(text(right.district_id))
    );
  });

  useEffect(() => {
    const topScroller = plannerTopScrollRef.current;
    const tableScroller = plannerTableScrollRef.current;
    if (!topScroller || !tableScroller) return;

    let syncingScroll = false;
    const syncTopToTable = () => {
      if (syncingScroll) return;
      syncingScroll = true;
      tableScroller.scrollLeft = topScroller.scrollLeft;
      syncingScroll = false;
    };
    const syncTableToTop = () => {
      if (syncingScroll) return;
      syncingScroll = true;
      topScroller.scrollLeft = tableScroller.scrollLeft;
      syncingScroll = false;
    };
    const updateScrollableWidth = () =>
      setPlannerTableWidth(tableScroller.scrollWidth);

    topScroller.addEventListener("scroll", syncTopToTable, { passive: true });
    tableScroller.addEventListener("scroll", syncTableToTop, { passive: true });
    const observer = new ResizeObserver(updateScrollableWidth);
    observer.observe(tableScroller);
    if (tableScroller.firstElementChild) {
      observer.observe(tableScroller.firstElementChild);
    }
    updateScrollableWidth();

    return () => {
      topScroller.removeEventListener("scroll", syncTopToTable);
      tableScroller.removeEventListener("scroll", syncTableToTop);
      observer.disconnect();
    };
  }, [rows.length, searchMode, query, sortMode]);

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
  const visibleRowIds = new Set(rows.map((row) => itemId(row)));
  const selectedRowsInView = selectedRows.filter((row) =>
    visibleRowIds.has(itemId(row)),
  );
  const workflowStatusRows = ["academic", "picker", "viewer"].includes(role)
    ? data.replenishment
    : selectedRows;
  const workflowStatusDistricts = new Set(
    workflowStatusRows.map((row) => text(row.district_id)),
  ).size;
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
  const fifoRowsForMaterial = (planningRow: RecordRow): RecordRow[] => {
    const materialCode = text(
      planningRow.material_code,
      text(planningRow.material_id),
    );
    const locationMatchesCentralWarehouse = (row: RecordRow) => {
      const location = text(
        row.location_id,
        text(row.location_code, text(row.storage_location_code, "")),
      );
      if (!location) return true;
      const normalized = location.toUpperCase().replaceAll(" ", "");
      return ["WH-KT", "2401/0001", "2401-0001", "24010001"].includes(
        normalized,
      );
    };
    return data.fifo
      .filter(
        (row) =>
          text(row.material_code, text(row.material_id)) === materialCode &&
          locationMatchesCentralWarehouse(row),
      )
      .sort((left, right) => {
        const leftSequence = Number(left.fifo_sequence ?? 0);
        const rightSequence = Number(right.fifo_sequence ?? 0);
        if (leftSequence && rightSequence && leftSequence !== rightSequence) {
          return leftSequence - rightSequence;
        }
        return (
          text(left.fifo_date, text(left.acceptance_date, "9999-12-31")).localeCompare(
            text(right.fifo_date, text(right.acceptance_date, "9999-12-31")),
          ) ||
          text(left.handling_unit_code).localeCompare(
            text(right.handling_unit_code),
          )
        );
      })
      .map((row, index): RecordRow => ({
        ...row,
        material_id: materialCode,
        allocatable_qty: Number(row.allocatable_qty ?? row.available_qty ?? 0),
        acceptance_date: row.acceptance_date ?? row.fifo_date,
        purchase_order: row.purchase_order ?? row.purchase_order_no,
        contract_number: row.contract_number ?? row.contract_no,
        vendor_name: row.vendor_name ?? row.vendor_alias,
        fifo_sequence: Number(row.fifo_sequence ?? index + 1),
      }));
  };
  const fifoPlanFor = (
    planningRow: RecordRow,
    requestedQuantity = plannerQuantity(planningRow),
  ) => {
    let remaining = requestedQuantity;
    const picks = fifoRowsForMaterial(planningRow)
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
    ? fifoRowsForMaterial(focusedRow)
    : [];
  const fifoPreviewResult = focusedFifo.reduce<{
    remaining: number;
    preview: RecordRow[];
  }>((result, row) => {
      const allocatable = Math.max(0, Number(row.allocatable_qty ?? 0));
      const allocated = Math.min(allocatable, result.remaining);
      return {
        remaining: result.remaining - allocated,
        preview: [...result.preview, { ...row, preview_allocated_qty: allocated }],
      };
    }, {
      remaining: focusedRow ? plannerQuantity(focusedRow) : 0,
      preview: [],
    });
  const fifoPreview = fifoPreviewResult.preview;
  const fifoPreviewShortage = fifoPreviewResult.remaining;
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

  const pickingPlanRows = pickingDocument
    ? data.replenishment.filter(
        (row) =>
          text(row.replenishment_plan_id) ===
          text(pickingDocument.plan.replenishment_plan_id),
      )
    : [];
  const finalPickingQuantity = (row: RecordRow) => {
    const value = Number(
      row.final_qty ??
        row.confirmed_qty ??
        row.planner_qty ??
        plannerQuantity(row),
    );
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const pickingDocumentNumber = pickingDocument
    ? `PK-${text(
        pickingDocument.plan.plan_number,
        text(pickingDocument.plan.plan_code, "PLAN"),
      )}-V${text(
        pickingDocument.plan.version_no,
        text(pickingDocument.plan.plan_version, "1"),
      )}`
    : "";
  const exportPickingCsv = () => {
    if (!pickingDocument) return;
    const csvRows: Array<Array<string | number>> = [
      [
        "Document No.",
        "District",
        "Material",
        "Material Name",
        "Final Qty",
        "FIFO Sequence",
        "Contract",
        "PO",
        "Vendor",
        "Delivery Lot",
        "Installment",
        "Handling Unit",
        "Packing",
        "Pick Qty",
        "Remain After Pick",
        "Status",
      ],
    ];
    pickingPlanRows.forEach((row) => {
      const finalQty = finalPickingQuantity(row);
      const fifo = fifoPlanFor(row, finalQty);
      fifo.picks.forEach(({ row: source, quantity }, index) => {
        csvRows.push([
          pickingDocumentNumber,
          `${text(row.district_id)} : ${text(row.district_name_th)}`,
          text(row.material_id),
          text(row.material_name),
          finalQty,
          index + 1,
          text(source.contract_number),
          text(source.purchase_order),
          text(source.vendor_name),
          text(source.lot_code),
          text(source.installment_no),
          text(source.handling_unit_code),
          packingText(source, quantity),
          quantity,
          Math.max(0, Number(source.allocatable_qty ?? 0) - quantity),
          fifo.shortage > 0 ? `SHORT ${fifo.shortage}` : "READY",
        ]);
      });
      if (!fifo.picks.length || fifo.shortage > 0) {
        csvRows.push([
          pickingDocumentNumber,
          `${text(row.district_id)} : ${text(row.district_name_th)}`,
          text(row.material_id),
          text(row.material_name),
          finalQty,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          0,
          0,
          `SHORT ${formatNumber(fifo.shortage || finalQty, 0)}`,
        ]);
      }
    });
    const escapeCell = (value: string | number) =>
      `"${String(value).replaceAll('"', '""')}"`;
    const csv = `\uFEFF${csvRows
      .map((row) => row.map(escapeCell).join(","))
      .join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${pickingDocumentNumber}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const canCreate = role === "admin" || role === "planner";
  const canRespond = ["admin", "planner", "district"].includes(role);
  const dateInputValue = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const nextWeekDate = () => {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return dateInputValue(date);
  };
  const openResponse = (row: RecordRow) => {
    setResponseRow(row);
    setDecision("confirm");
    setQuantity(text(row.suggested_qty, "0"));
    setReason("ยืนยันตามแผน");
    setRequester(currentUserName);
    setDeferredUntil(nextWeekDate());
    setResponseError("");
  };
  const submitResponse = async (event: FormEvent) => {
    event.preventDefault();
    if (!responseRow) return;
    const enteredQty = Number(quantity);
    if (!Number.isFinite(enteredQty) || enteredQty < 0) {
      setResponseError("กรุณาระบุจำนวนเป็นตัวเลขตั้งแต่ 0 ขึ้นไป");
      return;
    }
    if (decision === "defer" && enteredQty <= 0) {
      setResponseError("กรุณาระบุจำนวนที่ยังต้องการรับภายหลังมากกว่า 0");
      return;
    }
    if (decision === "defer" && !deferredUntil) {
      setResponseError("กรุณาระบุวันที่พร้อมรับโดยประมาณ");
      return;
    }
    if (requester.trim().length < 2) {
      setResponseError("ไม่พบชื่อผู้ใช้งาน กรุณาออกจากระบบแล้วเข้าสู่ระบบอีกครั้ง");
      return;
    }
    if (decision !== "confirm" && reason.trim().length < 3) {
      setResponseError("กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษรสำหรับ Change หรือ Reject");
      return;
    }
    setResponseError("");
    const isDeferred = decision === "defer";
    const recordedReason = isDeferred
      ? `[DEFER_UNTIL:${deferredUntil}][DEFER_QTY:${enteredQty}] ${reason.trim()}`
      : reason.trim() || "ยืนยันตามแผน";
    const ok = await onRespond(text(responseRow.replenishment_item_id), {
      decision: isDeferred ? "change" : decision,
      confirmed_qty: decision === "reject" || isDeferred ? 0 : enteredQty,
      reason: recordedReason,
      requester_name: requester.trim(),
    });
    if (ok) {
      setResponseRow(null);
      setResponseError("");
    } else {
      setResponseError("ยังบันทึกการตอบกลับไม่ได้ กรุณาลองอีกครั้ง");
    }
  };
  const submitPlanAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!planAction) return;
    const planId = text(planAction.row.replenishment_plan_id);
    const ok =
      planAction.type === "approve"
        ? await onApprove(planId, planNote)
        : planAction.type === "return"
          ? await onReturn(planId, planNote)
        : planAction.type === "cancel"
          ? await onCancel(planId, planNote)
          : await onVersion(planId, planNote);
    if (ok) {
      setPlanAction(null);
      setPlanNote("");
    }
  };
  const pendingDistrictStatuses = new Set(["draft", "pending"]);
  const districtApprovalByItem = (() => {
    const approvals = new Map<string, RecordRow>();
    [...data.approvals]
      .sort(
        (left, right) =>
          Date.parse(text(right.acted_at, "1970-01-01")) -
          Date.parse(text(left.acted_at, "1970-01-01")),
      )
      .forEach((approval) => {
        const id = text(approval.replenishment_item_id, "");
        if (
          id &&
          text(approval.approval_stage) === "district_response" &&
          !approvals.has(id)
        ) {
          approvals.set(id, approval);
        }
      });
    return approvals;
  })();
  const districtBatches = (() => {
    const batches = new Map<
      string,
      {
        id: string;
        planNumber: string;
        version: string;
        weekStart: string;
        receivedAt: string;
        dueAt: string;
        rows: RecordRow[];
        pendingRows: RecordRow[];
        historyRows: RecordRow[];
      }
    >();
    selectedRows.forEach((row) => {
      const id = text(
        row.replenishment_plan_id,
        `unplanned-${text(row.replenishment_item_id)}`,
      );
      const current = batches.get(id) ?? {
        id,
        planNumber: text(row.plan_number, `แผน ${id.slice(0, 8)}`),
        version: text(row.version_no, "1"),
        weekStart: text(row.week_start_date, ""),
        receivedAt: text(row.created_at, ""),
        dueAt: text(row.response_due_at, ""),
        rows: [],
        pendingRows: [],
        historyRows: [],
      };
      current.rows.push(row);
      if (pendingDistrictStatuses.has(text(row.item_status))) {
        current.pendingRows.push(row);
      } else {
        current.historyRows.push(row);
      }
      batches.set(id, current);
    });
    return [...batches.values()].sort(
      (left, right) =>
        Date.parse(right.receivedAt || "1970-01-01") -
          Date.parse(left.receivedAt || "1970-01-01") ||
        right.version.localeCompare(left.version),
    );
  })();
  const activeDistrictBatch =
    districtBatches.find((batch) => batch.id === districtBatchId) ??
    districtBatches[0] ??
    null;
  const openDistrictBatch = (
    batch: (typeof districtBatches)[number],
  ) => {
    setDistrictBatchId(batch.id);
    setDistrictReviewMode(batch.pendingRows.length ? "pending" : "history");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        districtBatchDetailRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        districtBatchDetailRef.current?.focus({ preventScroll: true });
      });
    });
  };
  const districtPendingTotal = districtBatches.reduce(
    (sum, batch) => sum + batch.pendingRows.length,
    0,
  );
  const districtHistoryTotal = districtBatches.reduce(
    (sum, batch) => sum + batch.historyRows.length,
    0,
  );
  const deferredResponseDetails = (row: RecordRow) => {
    const note = text(row.district_note, text(row.response_reason, ""));
    const match = note.match(
      /^\[DEFER_UNTIL:(\d{4}-\d{2}-\d{2})\]\[DEFER_QTY:([^\]]+)\]\s*(.*)$/,
    );
    if (!match) return null;
    const date = new Date(`${match[1]}T00:00:00`);
    const formattedDate = Number.isNaN(date.getTime())
      ? match[1]
      : new Intl.DateTimeFormat("th-TH", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }).format(date);
    return {
      date: formattedDate,
      quantity: Number(match[2]),
      reason: match[3] || "ขอเลื่อนรับ ฝากไว้ก่อน",
    };
  };
  const districtStatusLabel = (row: RecordRow) => {
    if (deferredResponseDetails(row)) return "เลื่อนรับ / ฝากไว้ก่อน";
    const labels: Record<string, string> = {
      draft: "รอยืนยัน",
      pending: "รอยืนยัน",
      change_requested: "ขอเปลี่ยนแล้ว",
      confirmed: "ยืนยันแล้ว",
      district_confirmed: "ยืนยันแล้ว",
      rejected: "ไม่รับรายการ",
      district_rejected: "ไม่รับรายการ",
      approved: "อนุมัติแล้ว",
      locked: "ล็อกแผนแล้ว",
      issued: "จ่ายแล้ว",
      cancelled: "ยกเลิก",
    };
    return labels[text(row.item_status)] ?? text(row.item_status);
  };
  const districtResponseQuantity = (row: RecordRow) => {
    const deferred = deferredResponseDetails(row);
    if (deferred && Number.isFinite(deferred.quantity)) {
      return `${formatNumber(deferred.quantity, 0)} (รับภายหลัง)`;
    }
    return formatNumber(row.requested_qty ?? row.confirmed_qty, 0);
  };
  const districtResponseReason = (row: RecordRow) => {
    const deferred = deferredResponseDetails(row);
    return deferred
      ? `พร้อมรับประมาณ ${deferred.date} · ${deferred.reason}`
      : text(row.district_note, text(row.response_reason));
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
  const savedDistrictSummary = districtSummary.filter(
    (district) => savedDistrictIds[district.district],
  );
  const savedItemCount = selectedRows.filter((row) =>
    savedDistrictIds[text(row.district_id)],
  ).length;
  const savePlanningScope = () => {
    const scopeRows =
      searchMode === "district" && query ? selectedRowsInView : selectedRows;
    const districtIds = [
      ...new Set(scopeRows.map((row) => text(row.district_id)).filter(Boolean)),
    ];
    if (!districtIds.length) return;

    const nextSavedDistrictIds = { ...savedDistrictIds };
    districtIds.forEach((districtId) => {
      nextSavedDistrictIds[districtId] = true;
    });
    setSavedDistrictIds(nextSavedDistrictIds);

    if (searchMode === "district" && query) {
      const currentDistrict = districtOptions.find(
        (district) => district.id === query,
      );
      const candidateDistrictIds = new Set(
        canonicalReplenishmentRows.map((row) => text(row.district_id)),
      );
      const currentIndex = Math.max(
        0,
        districtOptions.findIndex((district) => district.id === query),
      );
      const nextDistrict = [
        ...districtOptions.slice(currentIndex + 1),
        ...districtOptions.slice(0, currentIndex),
      ].find(
        (district) =>
          candidateDistrictIds.has(district.id) &&
          !nextSavedDistrictIds[district.id],
      );

      setDraftSaveMessage(
        `บันทึก ${query} : ${currentDistrict?.name ?? "การไฟฟ้าเขต"} แล้ว ${formatNumber(scopeRows.length)} รายการ`,
      );
      if (nextDistrict) {
        setQuery(nextDistrict.id);
      } else {
        setDraftSaveMessage(
          `บันทึกเขต ${query} แล้ว และตรวจครบทุกเขตที่มีรายการในรอบนี้`,
        );
      }
      return;
    }

    setDraftSaveMessage(
      `บันทึกรายการที่เลือกแล้ว ${formatNumber(scopeRows.length)} รายการ จาก ${formatNumber(districtIds.length)} เขต`,
    );
  };
  const academicPlan =
    plans.find((plan) =>
      ["pending_academic_approval", "locked"].includes(text(plan.plan_status)),
    ) ?? plans[0] ?? null;
  const academicPlanRows = academicPlan
    ? data.replenishment.filter(
        (row) =>
          text(row.replenishment_plan_id) ===
          text(academicPlan.replenishment_plan_id),
      )
    : [];
  const academicChangeRequests = academicPlan
    ? data.changeRequests.filter((request) => {
        const requestPlanId = text(request.replenishment_plan_id, "");
        return requestPlanId
          ? requestPlanId === text(academicPlan.replenishment_plan_id)
          : academicPlanRows.some(
              (row) =>
                text(row.replenishment_item_id) ===
                text(request.replenishment_item_id),
            );
      })
    : [];
  const academicTotalQty = academicPlanRows.reduce(
    (sum, row) => sum + finalPickingQuantity(row),
    0,
  );
  const academicStatus = text(academicPlan?.plan_status, "no_plan");
  const canAcademicDecide =
    academicStatus === "pending_academic_approval" &&
    ["admin", "academic"].includes(role);

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
          [role === "academic" ? "รายการในแผน" : "รายการที่เลือก", workflowStatusRows.length],
          ["เขตในแผน", role === "academic" ? workflowStatusDistricts : districtSummary.length],
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
              <section className="planner-table-toolbar" aria-label="ค้นหาและจัดเรียงรายการแผน">
                <div className="search-switch" role="group" aria-label="ค้นหาตาม">
                  <button
                    type="button"
                    className={searchMode === "district" ? "active" : ""}
                    onClick={() => {
                      setSearchMode("district");
                      setQuery("");
                    }}
                  >
                    รายเขต
                  </button>
                  <button
                    type="button"
                    className={searchMode === "material" ? "active" : ""}
                    onClick={() => {
                      setSearchMode("material");
                      setQuery(materialOptions[0] ?? "");
                    }}
                  >
                    รายพัสดุ
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
                        {savedDistrictIds[district.id] ? "✓ " : ""}
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
                <select
                  value={sortMode}
                  onChange={(event) =>
                    setSortMode(
                      event.target.value as
                        | "priority"
                        | "district"
                        | "material"
                        | "months",
                    )
                  }
                  aria-label="เรียงรายการ"
                >
                  <option value="priority">เรียง: ต้องเติมก่อน</option>
                  <option value="district">เรียง: รหัสเขต</option>
                  <option value="material">เรียง: รหัสพัสดุ</option>
                  <option value="months">เรียง: เดือนคงเหลือน้อย</option>
                </select>
                {canCreate && data.replenishment.length === 0 ? (
                  <button
                    className="btn primary"
                    disabled={actionBusy}
                    onClick={() => void onCreate()}
                  >
                    เริ่มรอบแผน
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn primary planner-district-confirm"
                    disabled={
                      searchMode === "district" && query
                        ? !selectedRowsInView.length
                        : !selectedRows.length
                    }
                    onClick={savePlanningScope}
                  >
                    {searchMode === "district" && query
                      ? `${savedDistrictIds[query] ? "อัปเดต" : "บันทึก"}เขต ${query} (${formatNumber(selectedRowsInView.length)}) → เขตถัดไป`
                      : `บันทึกรายการที่เลือก (${formatNumber(selectedRows.length)})`}
                  </button>
                )}
              </section>
              <section className="planner-draft-progress" aria-label="สถานะ Draft Plan">
                <div className="planner-draft-copy">
                  <span>DRAFT PLAN · บันทึกทีละเขต</span>
                  <strong>
                    {savedDistrictSummary.length >= 18
                      ? `ครบ 18 เขตเรียบร้อยแล้ว · ${formatNumber(savedItemCount)} รายการ`
                      : `${formatNumber(savedDistrictSummary.length)} / 18 เขต · ${formatNumber(savedItemCount)} รายการบันทึกแล้ว`}
                  </strong>
                  <small>
                    {draftSaveMessage ||
                      "เลือกรายการและ Qty ของเขตนี้ แล้วกดบันทึกเพื่อไปทำเขตถัดไป"}
                  </small>
                </div>
                <div className="planner-saved-districts">
                  {districtSummary.length ? (
                    districtSummary.map((district) => (
                      <button
                        type="button"
                        key={district.district}
                        className={savedDistrictIds[district.district] ? "saved" : "pending"}
                        onClick={() => {
                          setSearchMode("district");
                          setQuery(district.district);
                        }}
                      >
                        {savedDistrictIds[district.district] ? "✓" : "•"}{" "}
                        {district.district} · {formatNumber(district.items)} รายการ
                      </button>
                    ))
                  ) : (
                    <span>ยังไม่มีเขตใน Draft Plan</span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn ghost planner-review-all"
                  disabled={!selectedRows.length}
                  onClick={() => setWorkflowStep(2)}
                >
                  ดูสรุปแผนทั้งหมด ({formatNumber(selectedRows.length)})
                </button>
              </section>
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
                      setSavedDistrictIds((current) => ({
                        ...current,
                        ...Object.fromEntries(
                          rows.map((row) => [text(row.district_id), false]),
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
                    onClick={() => {
                      setSelectedPlanningIds((current) => ({
                        ...current,
                        ...Object.fromEntries(rows.map((row) => [itemId(row), false])),
                      }));
                      setSavedDistrictIds((current) => ({
                        ...current,
                        ...Object.fromEntries(
                          rows.map((row) => [text(row.district_id), false]),
                        ),
                      }));
                    }}
                  >
                    ล้างที่เลือกในหน้านี้
                  </button>
                </div>
              </div>
              {rows.length ? (
                <>
                  <div
                    ref={plannerTopScrollRef}
                    className="planner-table-top-scroll"
                    aria-label="เลื่อนดูคอลัมน์ตาราง"
                  >
                    <div style={{ width: `${plannerTableWidth}px` }} />
                  </div>
                  <div
                    ref={plannerTableScrollRef}
                    className="live-table-wrap planner-table-scroll-body"
                  >
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
                                    setSavedDistrictIds((current) => ({
                                      ...current,
                                      [text(row.district_id)]: false,
                                    }));
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
                                  setSavedDistrictIds((current) => ({
                                    ...current,
                                    [text(row.district_id)]: false,
                                  }));
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
                </>
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
                      Stock.xlsx เป็นยอดรวม จึงยังระบุไม่ได้ว่าต้องหยิบจากสัญญา
                      งวด หรือพาเลทใด
                    </p>
                    <ul className="fifo-missing-list">
                      <li>
                        ไฟล์รวมสัญญา: Material, PO/สัญญา, งวดส่งมอบ และวันผ่านตรวจรับ
                      </li>
                      <li>
                        ข้อมูลรับเข้าคลัง/HU: Receipt Lot, Pallet/Box ID, ประเภทบรรจุ,
                        จำนวนต่อหน่วย และยอดพร้อมหยิบ
                      </li>
                      <li>
                        เมื่อผูกสองส่วนนี้แล้ว ระบบจึงเรียงวันผ่านตรวจรับเก่า → ใหม่
                        และคำนวณ Remain ได้
                      </li>
                    </ul>
                  </div>
                    )}
                    {fifoPreviewShortage > 0 && (
                      <div className="fifo-shortage">
                        หลักฐาน FIFO ขาด {formatNumber(fifoPreviewShortage, 0)} หน่วย
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
              ดูสรุปแผนทั้งหมด ({formatNumber(selectedRows.length)}) →
            </button>
          </div>
        </>
      )}

      {workflowStep === 2 && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>DRAFT PLAN CONFIRMATION</span>
              <h3>สรุป Draft Plan แยกตามเขต — ตรวจทานทั้งหมดก่อนส่งให้เขต</h3>
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

      {workflowStep === 3 && role === "district" && (
        <section className="district-inbox" aria-labelledby="district-inbox-title">
          <header className="district-inbox-hero">
            <div className="district-inbox-icon" aria-hidden="true">!</div>
            <div>
              <span>DISTRICT INBOX · งานเข้าจากคลังกลาง</span>
              <h2 id="district-inbox-title">
                {districtPendingTotal > 0
                  ? `มี ${formatNumber(districtPendingTotal)} รายการใหม่รอการยืนยัน`
                  : "ยืนยันรายการใหม่ครบแล้ว"}
              </h2>
              <p>
                ข้อมูลถูกส่งมาเป็นชุดตามแผนรายสัปดาห์ เลือกชุดด้านล่างเพื่อดูรายการและวันที่รับเข้า
              </p>
            </div>
            <div className="district-inbox-totals">
              <span><b>{formatNumber(districtBatches.length)}</b> ชุดทั้งหมด</span>
              <span><b>{formatNumber(districtHistoryTotal)}</b> รายการในประวัติ</span>
            </div>
          </header>

          {districtBatches.length > 0 ? (
            <>
              <div className="district-batch-strip" aria-label="ชุดแผนที่ได้รับ">
                {districtBatches.map((batch, index) => (
                  <button
                    type="button"
                    key={batch.id}
                    className={`district-batch-card ${
                      activeDistrictBatch?.id === batch.id ? "active" : ""
                    }`}
                    aria-controls="district-batch-detail"
                    onClick={() => openDistrictBatch(batch)}
                  >
                    <span>
                      {index === 0 && batch.pendingRows.length > 0
                        ? "ชุดล่าสุด"
                        : "แผนรายสัปดาห์"}
                    </span>
                    <strong>{batch.planNumber} · V{batch.version}</strong>
                    <small>
                      ประจำวันที่ {batch.weekStart || "—"} · รับเมื่อ {formatDateTime(batch.receivedAt)}
                    </small>
                    <div>
                      <b>{formatNumber(batch.pendingRows.length)} รอยืนยัน</b>
                      <em>{formatNumber(batch.historyRows.length)} ตอบแล้ว</em>
                    </div>
                  </button>
                ))}
              </div>

              {activeDistrictBatch && (
                <div
                  ref={districtBatchDetailRef}
                  id="district-batch-detail"
                  className="district-batch-detail"
                  tabIndex={-1}
                >
                  <div className="district-batch-heading">
                    <div>
                      <span>ชุดที่กำลังเปิดดู</span>
                      <h3>{activeDistrictBatch.planNumber} · Version {activeDistrictBatch.version}</h3>
                      <p>
                        ประจำวันที่ <b>{activeDistrictBatch.weekStart || "—"}</b>
                        {" · "}ส่งถึงเขตเมื่อ <b>{formatDateTime(activeDistrictBatch.receivedAt)}</b>
                        {" · "}กำหนดตอบ <b>{formatDateTime(activeDistrictBatch.dueAt)}</b>
                      </p>
                    </div>
                    <div className="district-review-tabs" role="tablist" aria-label="สถานะรายการ">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={districtReviewMode === "pending"}
                        className={districtReviewMode === "pending" ? "active" : ""}
                        onClick={() => setDistrictReviewMode("pending")}
                      >
                        รอยืนยัน ({formatNumber(activeDistrictBatch.pendingRows.length)})
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={districtReviewMode === "history"}
                        className={districtReviewMode === "history" ? "active" : ""}
                        onClick={() => setDistrictReviewMode("history")}
                      >
                        ประวัติที่ตอบแล้ว ({formatNumber(activeDistrictBatch.historyRows.length)})
                      </button>
                    </div>
                  </div>

                  {districtReviewMode === "pending" ? (
                    <LiveTable
                      rows={activeDistrictBatch.pendingRows}
                      empty="ชุดนี้ไม่มีรายการค้างยืนยัน"
                      columns={[
                        ["พัสดุ", (row) => <span><strong>{text(row.material_id)}</strong><small>{text(row.material_name)}</small></span>],
                        ["Planner Qty", (row) => formatNumber(plannerQuantity(row), 0)],
                        ["หลังจ่าย", (row) => `${formatNumber(row.projected_months_after, 1)}M`],
                        ["สถานะ", (row) => <Badge>{districtStatusLabel(row)}</Badge>],
                        ["ดำเนินการ", (row) => (
                          <button
                            type="button"
                            className="table-action district-response-button"
                            disabled={!canRespond || actionBusy}
                            onClick={() => openResponse(row)}
                          >
                            Confirm / Change / Defer / Reject
                          </button>
                        )],
                      ]}
                    />
                  ) : (
                    <LiveTable
                      rows={activeDistrictBatch.historyRows}
                      empty="ชุดนี้ยังไม่มีประวัติการตอบ"
                      columns={[
                        ["วันที่ตอบ", (row) => formatDateTime(
                          districtApprovalByItem.get(text(row.replenishment_item_id))?.acted_at ??
                            row.district_confirmed_at ?? row.updated_at,
                        )],
                        ["พัสดุ", (row) => <span><strong>{text(row.material_id)}</strong><small>{text(row.material_name)}</small></span>],
                        ["Planner Qty", (row) => formatNumber(plannerQuantity(row), 0)],
                        ["เขตตอบ", (row) => districtResponseQuantity(row)],
                        ["ผลตอบ", (row) => <Badge>{districtStatusLabel(row)}</Badge>],
                        ["ผู้ยืนยัน / เหตุผล", (row) => <span><strong>{text(row.requester_name)}</strong><small>{districtResponseReason(row)}</small></span>],
                      ]}
                    />
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">ยังไม่มีชุดแผนจากคลังกลางส่งมาให้เขต</div>
          )}
        </section>
      )}

      {workflowStep === 3 && role !== "district" && (
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
          <section className="academic-review" aria-labelledby="academic-review-title">
            <header className="academic-review-hero">
              <div>
                <span>ACADEMIC REVIEW · FINAL CONTROL</span>
                <h2 id="academic-review-title">ตรวจหลักฐานก่อนอนุมัติและล็อกแผน</h2>
                <p>
                  ตรวจจำนวนที่เขตยืนยัน คำขอเปลี่ยน หลักฐาน AI และลำดับ FIFO
                  ก่อนส่งแผนที่ล็อกแล้วให้คลังจัดทำ Picking Document
                </p>
              </div>
              <div className="academic-review-state">
                <small>สถานะแผนปัจจุบัน</small>
                <Badge>{academicStatus}</Badge>
                <strong>{text(academicPlan?.plan_number, text(academicPlan?.plan_code))}</strong>
              </div>
            </header>

            {academicPlan ? (
              <>
                <section className="academic-summary" aria-label="สรุปแผน">
                  {[
                    ["Version", `V${text(academicPlan.version_no, text(academicPlan.plan_version, "1"))}`],
                    ["รายการ", formatNumber(academicPlanRows.length)],
                    ["เขต", formatNumber(new Set(academicPlanRows.map((row) => text(row.district_id))).size)],
                    ["จำนวนรวม", `${formatNumber(academicTotalQty, 0)} EA`],
                    ["คำขอเปลี่ยน", formatNumber(academicChangeRequests.length)],
                  ].map(([label, value]) => (
                    <article key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </article>
                  ))}
                </section>

                <div className="academic-review-grid">
                  <section className="academic-review-main">
                    <div className="academic-section-title">
                      <div>
                        <span>PLAN ITEM DETAILS</span>
                        <h3>รายการ จำนวน และหลักฐานประกอบ</h3>
                      </div>
                      <b>{academicPlanRows.length} รายการ</b>
                    </div>
                    <div className="live-table-wrap academic-table-wrap">
                      <table className="live-table academic-table">
                        <thead>
                          <tr>
                            <th>เขต / พัสดุ</th>
                            <th>จำนวน</th>
                            <th>AI / Rule evidence</th>
                            <th>FIFO evidence</th>
                            <th>ผลตอบเขต</th>
                          </tr>
                        </thead>
                        <tbody>
                          {academicPlanRows.map((row) => {
                            const recommendation = data.recommendations.find(
                              (item) => itemId(item) === itemId(row),
                            );
                            const fifo = fifoPlanFor(row, finalPickingQuantity(row));
                            return (
                              <tr key={itemId(row)}>
                                <td>
                                  <strong>{text(row.district_id)} · {text(row.district_name_th)}</strong>
                                  <small>{text(row.material_id)} · {text(row.material_name)}</small>
                                </td>
                                <td>
                                  <strong>{formatNumber(finalPickingQuantity(row), 0)} EA</strong>
                                  <small>AI {formatNumber(recommendation?.ai_suggested_qty ?? row.suggested_qty, 0)} · Min {formatNumber(row.min_fill_qty, 0)} · Max {formatNumber(row.max_fill_qty, 0)}</small>
                                </td>
                                <td>
                                  <strong>Confidence {formatNumber(Number(recommendation?.confidence_score ?? 0) * 100, 0)}%</strong>
                                  <small>CMP {formatNumber(row.cmp_monthly, 1)} / เดือน · คงเหลือ {formatNumber(row.months_available, 1)} เดือน</small>
                                </td>
                                <td className={fifo.shortage > 0 ? "evidence-short" : "evidence-ready"}>
                                  <strong>{fifo.shortage > 0 ? `ขาด ${formatNumber(fifo.shortage, 0)} EA` : `${fifo.picks.length} HU พร้อมหยิบ`}</strong>
                                  <small>{fifo.detail}</small>
                                </td>
                                <td><Badge>{text(row.item_status)}</Badge></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <aside className="academic-change-panel">
                    <div className="academic-section-title">
                      <div>
                        <span>CHANGE REQUESTS</span>
                        <h3>คำขอเปลี่ยนและความเสี่ยง</h3>
                      </div>
                    </div>
                    {academicChangeRequests.length ? (
                      academicChangeRequests.map((request) => (
                        <article key={text(request.change_request_id)}>
                          <div>
                            <strong>{text(request.material_id)}</strong>
                            <Badge>{text(request.status)}</Badge>
                          </div>
                          <p>{text(request.reason)}</p>
                          <dl>
                            <div><dt>เดิม</dt><dd>{formatNumber(request.original_qty, 0)}</dd></div>
                            <div><dt>ขอ</dt><dd>{formatNumber(request.requested_qty, 0)}</dd></div>
                            <div><dt>Risk</dt><dd>{text(request.risk_level)}</dd></div>
                          </dl>
                        </article>
                      ))
                    ) : (
                      <p className="academic-empty">ไม่มีคำขอเปลี่ยนในแผนนี้</p>
                    )}
                  </aside>
                </div>

                <footer className="academic-review-actions">
                  <div>
                    <strong>
                      {academicStatus === "locked"
                        ? "แผนล็อกแล้ว — Picking Document พร้อมใช้งาน"
                        : canAcademicDecide
                          ? "พร้อมให้วิชาการตัดสินใจ"
                          : "รอขั้นตอนก่อนหน้าให้เสร็จสมบูรณ์"}
                    </strong>
                    <small>การ Lock จะตรึงจำนวนและเปิดเอกสารหยิบตาม FIFO</small>
                  </div>
                  {canAcademicDecide && (
                    <>
                      <button type="button" className="btn ghost academic-return" onClick={() => setPlanAction({ type: "return", row: academicPlan })}>
                        Return to Planner
                      </button>
                      <button type="button" className="btn primary academic-lock" onClick={() => setPlanAction({ type: "approve", row: academicPlan })}>
                        Approve &amp; Lock Plan
                      </button>
                    </>
                  )}
                  {academicStatus === "locked" && (
                    <button type="button" className="btn primary" onClick={() => setPickingDocument({ plan: academicPlan, generatedAt: new Date().toISOString() })}>
                      Preview / Export Picking Document
                    </button>
                  )}
                </footer>
              </>
            ) : (
              <div className="academic-empty">ยังไม่มีแผนส่งเข้าตรวจวิชาการ</div>
            )}
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <span>PLAN QUEUE</span>
                <h3>สถานะแผนและการดำเนินการตามบทบาท</h3>
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
                        {status === "locked" &&
                          ["admin", "planner", "academic", "picker"].includes(role) && (
                            <button
                              className="table-action"
                              onClick={() =>
                                setPickingDocument({
                                  plan: row,
                                  generatedAt: new Date().toISOString(),
                                })
                              }
                            >
                              Preview / Export Picking
                            </button>
                          )}
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

      {pickingDocument && (
        <div
          className="picking-document-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="picking-document-title"
        >
          <section className="picking-document-sheet">
            <div className="picking-document-actions no-print">
              <div>
                <strong>Picking Document Preview</strong>
                <small>
                  ตรวจสอบ FIFO และจำนวนก่อนพิมพ์ส่งให้หน้างาน
                </small>
              </div>
              <span>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setPickingDocument(null)}
                >
                  ปิด
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={exportPickingCsv}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => window.print()}
                >
                  พิมพ์ / บันทึก PDF
                </button>
              </span>
            </div>

            <header className="picking-document-head">
              <div className="picking-document-brand">
                <b>MEA</b>
                <span>
                  <strong>MEA Synapse</strong>
                  <small>Warehouse Operations · Khlong Toei</small>
                </span>
              </div>
              <div>
                <span>PICKING DOCUMENT</span>
                <h2 id="picking-document-title">
                  ใบจัดเตรียมและหยิบพัสดุ
                </h2>
                <strong>{pickingDocumentNumber}</strong>
              </div>
            </header>

            <section className="picking-document-meta">
              <div>
                <span>Weekly Plan</span>
                <strong>
                  {text(
                    pickingDocument.plan.plan_number,
                    text(pickingDocument.plan.plan_code),
                  )}
                </strong>
              </div>
              <div>
                <span>Version / Status</span>
                <strong>
                  V
                  {text(
                    pickingDocument.plan.version_no,
                    text(pickingDocument.plan.plan_version, "1"),
                  )} · {text(pickingDocument.plan.plan_status)}
                </strong>
              </div>
              <div>
                <span>Warehouse</span>
                <strong>คลังคลองเตย · Plant 2401 / SLoc 0001</strong>
              </div>
              <div>
                <span>Generated</span>
                <strong>{formatDateTime(pickingDocument.generatedAt)}</strong>
              </div>
            </section>

            {text(pickingDocument.plan.plan_status) !== "locked" && (
              <aside className="picking-document-draft">
                DRAFT PREVIEW · ยังไม่ใช่คำสั่งหยิบ จนกว่าแผนจะอนุมัติครบและ Lock
              </aside>
            )}

            <section className="picking-document-summary">
              <article>
                <span>Districts</span>
                <strong>
                  {
                    new Set(
                      pickingPlanRows.map((row) => text(row.district_id)),
                    ).size
                  }
                </strong>
              </article>
              <article>
                <span>Materials</span>
                <strong>
                  {
                    new Set(
                      pickingPlanRows.map((row) => text(row.material_id)),
                    ).size
                  }
                </strong>
              </article>
              <article>
                <span>Plan Lines</span>
                <strong>{pickingPlanRows.length}</strong>
              </article>
              <article>
                <span>Total Qty</span>
                <strong>
                  {formatNumber(
                    pickingPlanRows.reduce(
                      (sum, row) => sum + finalPickingQuantity(row),
                      0,
                    ),
                    0,
                  )}
                </strong>
              </article>
            </section>

            <div className="picking-document-table-wrap">
              <table className="picking-document-table">
                <thead>
                  <tr>
                    <th>เขต / พัสดุ</th>
                    <th>Final Qty</th>
                    <th>ลำดับ FIFO / Contract</th>
                    <th>PO · Vendor · Lot</th>
                    <th>Pallet / Box / HU</th>
                    <th>Pick Qty</th>
                    <th>Remain</th>
                    <th>ตรวจหยิบ</th>
                  </tr>
                </thead>
                <tbody>
                  {pickingPlanRows.flatMap((planRow, planIndex) => {
                    const finalQty = finalPickingQuantity(planRow);
                    const fifo = fifoPlanFor(planRow, finalQty);
                    const pickRows = fifo.picks.map(
                      ({ row: source, quantity }, pickIndex) => (
                        <tr
                          key={`${text(planRow.replenishment_item_id)}:${text(
                            source.handling_unit_code,
                          )}:${pickIndex}`}
                        >
                          <td>
                            <strong>
                              {text(planRow.district_id)} :{" "}
                              {text(planRow.district_name_th)}
                            </strong>
                            <small>
                              {text(planRow.material_id)} ·{" "}
                              {text(planRow.material_name)}
                            </small>
                          </td>
                          <td>{formatNumber(finalQty, 0)}</td>
                          <td>
                            <strong>#{pickIndex + 1}</strong>
                            <small>{text(source.contract_number)}</small>
                          </td>
                          <td>
                            <strong>{text(source.purchase_order)}</strong>
                            <small>
                              {text(source.vendor_name)} · {text(source.lot_code)}
                              {text(source.installment_no, "")
                                ? ` · งวด ${text(source.installment_no)}`
                                : ""}
                            </small>
                          </td>
                          <td>
                            <strong>{text(source.handling_unit_code)}</strong>
                            <small>{packingText(source, quantity)}</small>
                          </td>
                          <td className="picking-quantity">
                            {formatNumber(quantity, 0)}
                          </td>
                          <td>
                            {formatNumber(
                              Math.max(
                                0,
                                Number(source.allocatable_qty ?? 0) - quantity,
                              ),
                              0,
                            )}
                          </td>
                          <td><span className="picking-check-box" /></td>
                        </tr>
                      ),
                    );
                    if (fifo.shortage > 0 || !pickRows.length) {
                      pickRows.push(
                        <tr
                          className="picking-shortage-row"
                          key={`shortage:${text(
                            planRow.replenishment_item_id,
                          )}:${planIndex}`}
                        >
                          <td>
                            <strong>
                              {text(planRow.district_id)} · {text(planRow.material_id)}
                            </strong>
                            <small>{text(planRow.material_name)}</small>
                          </td>
                          <td>{formatNumber(finalQty, 0)}</td>
                          <td colSpan={4}>FIFO พร้อมหยิบไม่เพียงพอ</td>
                          <td>
                            ขาด {formatNumber(fifo.shortage || finalQty, 0)}
                          </td>
                          <td><span className="picking-check-box" /></td>
                        </tr>,
                      );
                    }
                    return pickRows;
                  })}
                  {!pickingPlanRows.length && (
                    <tr>
                      <td colSpan={8}>ไม่พบรายการของแผนนี้</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <footer className="picking-document-footer">
              <div><span>ผู้จัดทำ Picking List</span><i /></div>
              <div><span>ผู้หยิบพัสดุ</span><i /></div>
              <div><span>ผู้ตรวจสอบ</span><i /></div>
              <div><span>วันเวลาเสร็จสิ้น</span><i /></div>
            </footer>
            <p className="picking-document-note">
              ใช้ Pallet/Box/HU เก่าให้หมดก่อนตาม FIFO และบันทึก Remain ของหน่วยที่เปิด
              หากจำนวนหรือสภาพพัสดุไม่ตรง ให้หยุดงานและแจ้ง Planner ก่อนดำเนินการต่อ
            </p>
          </section>
        </div>
      )}

      {responseRow && (
        <div
          className="district-response-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !actionBusy) {
              setResponseRow(null);
            }
          }}
        >
        <form
          className="pipeline-form district-response-dialog"
          onSubmit={submitResponse}
          role="dialog"
          aria-modal="true"
          aria-labelledby="district-response-title"
        >
          <div className="panel-title">
            <div>
              <span>การตอบกลับของเขต</span>
              <h3 id="district-response-title">
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
                onChange={(event) => {
                  const nextDecision =
                    event.target.value as ReplenishmentResponsePayload["decision"] | "defer";
                  setDecision(nextDecision);
                  setReason(
                    nextDecision === "confirm"
                      ? "ยืนยันตามแผน"
                      : nextDecision === "defer"
                        ? "ขอเลื่อนรับ ฝากไว้ก่อน"
                        : "",
                  );
                  setResponseError("");
                }}
              >
                <option value="confirm">Confirm</option>
                <option value="change">Change quantity</option>
                <option value="defer">Defer · เลื่อนรับ / ฝากไว้ก่อน</option>
                <option value="reject">Reject</option>
              </select>
            </label>
            <label>
              {decision === "defer" ? "จำนวนที่ต้องการรับภายหลัง" : "จำนวน"}
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
                readOnly
                aria-readonly="true"
                title="ดึงอัตโนมัติจากบัญชีที่เข้าสู่ระบบ"
                maxLength={200}
                required
              />
            </label>
            {decision === "defer" && (
              <label>
                วันที่พร้อมรับโดยประมาณ
                <input
                  type="date"
                  min={dateInputValue(new Date())}
                  value={deferredUntil}
                  onChange={(event) => setDeferredUntil(event.target.value)}
                  required
                />
              </label>
            )}
            <label className="wide">
              เหตุผล / หลักฐาน
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={900}
                required={decision !== "confirm"}
                placeholder={
                  decision === "confirm"
                    ? "ยืนยันตามแผน"
                    : decision === "defer"
                      ? "เช่น พื้นที่จัดเก็บยังไม่พร้อม ขอรับในรอบถัดไป"
                      : "ระบุเหตุผลและหลักฐานประกอบ"
                }
              />
            </label>
          </div>
          {responseError && (
            <div className="form-error" role="alert">
              {responseError}
            </div>
          )}
          <div className="pipeline-actions">
            <button
              className="btn ghost"
              type="button"
              disabled={actionBusy}
              onClick={() => setResponseRow(null)}
            >
              ยกเลิก
            </button>
            <button className="btn primary" disabled={actionBusy}>
              {actionBusy ? "กำลังบันทึก..." : "บันทึกการตอบกลับของเขต"}
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
                {planAction.type === "approve"
                  ? "APPROVE & LOCK"
                  : planAction.type === "return"
                    ? "RETURN TO PLANNER"
                    : planAction.type.toUpperCase()} ·{" "}
                {text(planAction.row.plan_number, text(planAction.row.plan_code))}
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
                planAction.type === "return" ||
                planAction.type !== "approve" ||
                text(planAction.row.plan_status) ===
                  "pending_academic_approval" ||
                bool(planAction.row.special_approval_required)
              }
              placeholder={
                planAction.type === "approve"
                  ? "สรุปผลการตรวจ AI, FIFO และคำขอเปลี่ยนก่อน Lock"
                  : planAction.type === "return"
                    ? "ระบุสิ่งที่ Planner ต้องแก้ไข (จำเป็น)"
                  : "จำเป็นสำหรับการยกเลิก/ออกเวอร์ชันใหม่"
              }
            />
          </label>
          <div className="pipeline-actions">
            <button className="btn primary" disabled={actionBusy}>
              {planAction.type === "approve"
                ? "ยืนยัน Approve & Lock Plan"
                : planAction.type === "return"
                  ? "ยืนยัน Return to Planner"
                  : `ยืนยัน ${planAction.type}`}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

type DistrictResponseKind =
  | "pending"
  | "confirmed"
  | "changed"
  | "deferred"
  | "rejected";

function districtResponseKind(row: RecordRow): DistrictResponseKind {
  const note = text(row.district_note, text(row.response_reason, ""));
  if (note.startsWith("[DEFER_UNTIL:")) return "deferred";
  const status = text(row.item_status, "");
  const decision = text(row.district_decision, "");
  if (["draft", "pending"].includes(status)) return "pending";
  if (status === "change_requested" || decision === "change") return "changed";
  if (status.includes("reject") || decision === "reject") return "rejected";
  return "confirmed";
}

function DistrictConfirmationView({
  actionBusy,
  currentUserName,
  data,
  role,
  onApprove,
  onConfirmPending,
  onOpenTransport,
}: {
  actionBusy: boolean;
  currentUserName: string;
  data: DashboardData;
  role: Role;
  onApprove: (planId: string, note?: string) => Promise<boolean>;
  onConfirmPending: (planId: string, requesterName: string) => Promise<boolean>;
  onOpenTransport: () => void;
}) {
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [selectedDistrictId, setSelectedDistrictId] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [localError, setLocalError] = useState("");
  const detailRef = useRef<HTMLElement>(null);

  const planGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        id: string;
        planNumber: string;
        version: string;
        status: string;
        weekStart: string;
        dueAt: string;
        createdAt: string;
        rows: RecordRow[];
      }
    >();
    data.replenishment.forEach((row) => {
      const id = text(row.replenishment_plan_id, "");
      if (!id) return;
      const current = groups.get(id) ?? {
        id,
        planNumber: text(row.plan_number, text(row.plan_code, `แผน ${id.slice(0, 8)}`)),
        version: text(row.version_no, text(row.plan_version, "1")),
        status: text(row.plan_status, "district_review"),
        weekStart: text(row.week_start_date, ""),
        dueAt: text(row.response_due_at, ""),
        createdAt: text(row.created_at, text(row.updated_at, "")),
        rows: [],
      };
      current.rows.push(row);
      groups.set(id, current);
    });
    return [...groups.values()].sort(
      (left, right) =>
        Date.parse(right.createdAt || right.weekStart || "1970-01-01") -
          Date.parse(left.createdAt || left.weekStart || "1970-01-01") ||
        right.version.localeCompare(left.version),
    );
  }, [data.replenishment]);

  const activePlan =
    planGroups.find((plan) => plan.id === selectedPlanId) ?? planGroups[0] ?? null;
  const pendingChangeItemIds = useMemo(
    () =>
      new Set(
        data.changeRequests
          .filter((request) => text(request.status) === "pending_review")
          .map((request) => text(request.replenishment_item_id, ""))
          .filter(Boolean),
      ),
    [data.changeRequests],
  );
  const responseLabel = (row: RecordRow) => {
    const labels: Record<string, string> = {
      pending: "รอเขตยืนยัน",
      confirmed: "ยืนยันตามแผน",
      changed: pendingChangeItemIds.has(text(row.replenishment_item_id, ""))
        ? "เปลี่ยนจำนวน · รอ Planner"
        : "เปลี่ยนจำนวนแล้ว",
      deferred: "เลื่อนรับ / ฝากไว้ก่อน",
      rejected: "ไม่รับรายการ",
    };
    return labels[districtResponseKind(row)];
  };
  const responseQuantity = (row: RecordRow) => {
    const note = text(row.district_note, text(row.response_reason, ""));
    const deferredQty = note.match(/\[DEFER_QTY:([^\]]+)\]/)?.[1];
    return districtResponseKind(row) === "deferred" && deferredQty
      ? `${formatNumber(Number(deferredQty), 0)} (ภายหลัง)`
      : formatNumber(row.requested_qty ?? row.confirmed_qty ?? row.suggested_qty, 0);
  };

  const districtSummaries = useMemo(() => {
    if (!activePlan) return [];
    const districtNames = new Map(
      data.districts.map((district) => [
        text(district.district_id, ""),
        text(district.district_name_th, ""),
      ]),
    );
    const groups = new Map<
      string,
      {
        districtId: string;
        districtName: string;
        rows: RecordRow[];
        total: number;
        confirmed: number;
        changed: number;
        deferred: number;
        rejected: number;
        pending: number;
        pendingChanges: number;
      }
    >();
    activePlan.rows.forEach((row) => {
      const districtId = text(row.district_id, "ไม่ระบุเขต");
      const current = groups.get(districtId) ?? {
        districtId,
        districtName: text(
          row.district_name_th,
          districtNames.get(districtId) || `การไฟฟ้าเขต ${districtId}`,
        ),
        rows: [],
        total: 0,
        confirmed: 0,
        changed: 0,
        deferred: 0,
        rejected: 0,
        pending: 0,
        pendingChanges: 0,
      };
      const kind = districtResponseKind(row);
      current.rows.push(row);
      current.total += 1;
      current[kind] += 1;
      if (pendingChangeItemIds.has(text(row.replenishment_item_id, ""))) {
        current.pendingChanges += 1;
      }
      groups.set(districtId, current);
    });
    return [...groups.values()].sort((left, right) =>
      left.districtId.localeCompare(right.districtId),
    );
  }, [activePlan, data.districts, pendingChangeItemIds]);

  const activeDistrict =
    districtSummaries.find((district) => district.districtId === selectedDistrictId) ??
    districtSummaries[0] ??
    null;
  const totals = districtSummaries.reduce(
    (summary, district) => ({
      total: summary.total + district.total,
      confirmed: summary.confirmed + district.confirmed,
      changed: summary.changed + district.changed,
      deferred: summary.deferred + district.deferred,
      rejected: summary.rejected + district.rejected,
      pending: summary.pending + district.pending,
      pendingChanges: summary.pendingChanges + district.pendingChanges,
    }),
    {
      total: 0,
      confirmed: 0,
      changed: 0,
      deferred: 0,
      rejected: 0,
      pending: 0,
      pendingChanges: 0,
    },
  );
  const responded = totals.total - totals.pending;
  const allDistrictsReady = totals.total > 0 && totals.pending === 0;
  const allChangesReviewed = totals.pendingChanges === 0;
  const planStatus = activePlan?.status ?? "";
  const canPlannerApprove =
    ["admin", "planner"].includes(role) && planStatus === "pending_planner_approval";
  const canAcademicLock =
    ["admin", "academic"].includes(role) && planStatus === "pending_academic_approval";
  const fifoReadiness = useMemo(() => {
    if (!activePlan) return { shortages: [], shortageQty: 0, requiredQty: 0 };

    const requiredByMaterial = new Map<
      string,
      { materialId: string; materialName: string; required: number; districts: Set<string> }
    >();
    activePlan.rows.forEach((row) => {
      const materialId = text(row.material_id, text(row.material_code, ""));
      if (!materialId) return;
      const quantity = Math.max(
        0,
        Number(
          row.final_qty ??
            row.confirmed_qty ??
            row.requested_qty ??
            row.suggested_qty ??
            0,
        ),
      );
      if (!Number.isFinite(quantity) || quantity <= 0) return;
      const current = requiredByMaterial.get(materialId) ?? {
        materialId,
        materialName: text(row.material_name, text(row.description, materialId)),
        required: 0,
        districts: new Set<string>(),
      };
      current.required += quantity;
      current.districts.add(text(row.district_id, "ไม่ระบุเขต"));
      requiredByMaterial.set(materialId, current);
    });

    const availableByMaterial = new Map<string, number>();
    data.fifo.forEach((row) => {
      const materialId = text(row.material_id, text(row.material_code, ""));
      if (!materialId) return;
      const location = text(
        row.location_id,
        text(row.location_code, text(row.storage_location_code, "")),
      )
        .toUpperCase()
        .replaceAll(" ", "");
      if (
        location &&
        !["WH-KT", "2401/0001", "2401-0001", "24010001"].includes(location)
      ) {
        return;
      }
      const allocatable = Math.max(
        0,
        Number(row.allocatable_qty ?? row.available_qty ?? 0),
      );
      availableByMaterial.set(
        materialId,
        (availableByMaterial.get(materialId) ?? 0) +
          (Number.isFinite(allocatable) ? allocatable : 0),
      );
    });

    const shortages = [...requiredByMaterial.values()]
      .map((item) => {
        const available = availableByMaterial.get(item.materialId) ?? 0;
        return {
          ...item,
          available,
          shortage: Math.max(0, item.required - available),
        };
      })
      .filter((item) => item.shortage > 0)
      .sort((left, right) => right.shortage - left.shortage);

    return {
      shortages,
      shortageQty: shortages.reduce((sum, item) => sum + item.shortage, 0),
      requiredQty: [...requiredByMaterial.values()].reduce(
        (sum, item) => sum + item.required,
        0,
      ),
    };
  }, [activePlan, data.fifo]);
  const allFifoReady =
    fifoReadiness.requiredQty > 0 && fifoReadiness.shortages.length === 0;
  const canSubmitApproval =
    (canPlannerApprove || canAcademicLock) &&
    allDistrictsReady &&
    allChangesReviewed &&
    (!canAcademicLock || allFifoReady);
  const planStatusLabel: Record<string, string> = {
    draft: "กำลังจัดทำแผน",
    pending_district_confirmation: "รอเขตยืนยัน",
    district_review: "รอเขตยืนยัน",
    pending_planner_approval: "พร้อมให้ Planner ยืนยัน",
    pending_academic_approval: "รอวิชาการอนุมัติและ Lock",
    locked: "Lock แล้ว · พร้อมจัดรถ",
    completed: "จ่ายตามแผนแล้ว",
    cancelled: "ยกเลิกแล้ว",
  };

  const submitApproval = async (event: FormEvent) => {
    event.preventDefault();
    if (!activePlan || !canSubmitApproval) return;
    if (canAcademicLock && approvalNote.trim().length < 3) {
      setLocalError("กรุณาระบุหมายเหตุการตรวจสอบก่อนอนุมัติและ Lock แผน");
      return;
    }
    setLocalError("");
    const ok = await onApprove(
      activePlan.id,
      approvalNote.trim() || "ตรวจผลตอบจากทุกเขตและคำขอเปลี่ยนครบแล้ว",
    );
    if (ok) setApprovalNote("");
    else setLocalError("ยังยืนยันแผนไม่ได้ กรุณาตรวจสถานะรายการแล้วลองอีกครั้ง");
  };

  const openDistrictDetails = (districtId: string) => {
    setSelectedDistrictId(districtId);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        detailRef.current?.focus({ preventScroll: true });
      });
    });
  };

  const confirmAllPending = async () => {
    if (!activePlan || role !== "admin" || totals.pending < 1) return;
    const accepted = window.confirm(
      `ยืนยันรายการค้าง ${totals.pending} รายการของ ${activePlan.planNumber} · Version ${activePlan.version} ตามจำนวนที่ Planner วางแผนไว้ ใช่หรือไม่?`,
    );
    if (!accepted) return;
    setLocalError("");
    const ok = await onConfirmPending(activePlan.id, currentUserName);
    if (!ok) {
      setLocalError("มีบางรายการยังยืนยันไม่สำเร็จ ระบบโหลดข้อมูลล่าสุดให้แล้ว กรุณาตรวจยอดค้างและลองอีกครั้ง");
    }
  };

  if (!activePlan) {
    return (
      <section className="panel district-confirmation-empty">
        <span>◎</span>
        <h3>ยังไม่มีแผนที่ส่งให้เขตยืนยัน</h3>
        <p>สร้างและส่งแผนจากเมนู “คำนวณการจ่าย” ก่อนตรวจผลตอบรายเขต</p>
      </section>
    );
  }

  return (
    <div className="stack district-confirmation-view">
      <section className="panel district-confirmation-toolbar">
        <div>
          <span>DISTRICT CONFIRMATION CONTROL</span>
          <h3>ตรวจผลตอบทุกเขตจากแผนที่ Planner ส่ง</h3>
          <p>แยกตามเลขแผนและเวอร์ชัน เพื่อไม่ปะปนข้อมูลคนละรอบ</p>
        </div>
        <label>
          เลือกแผนที่ต้องการตรวจ
          <select
            value={activePlan.id}
            onChange={(event) => {
              setSelectedPlanId(event.target.value);
              setSelectedDistrictId("");
              setApprovalNote("");
              setLocalError("");
            }}
          >
            {planGroups.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.planNumber} · V{plan.version} · {planStatusLabel[plan.status] ?? plan.status}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="district-confirmation-kpis">
        {[
          ["เขตในแผน", districtSummaries.length, "เขต"],
          ["รายการตามแผน", totals.total, "รายการ"],
          ["เขตตอบแล้ว", responded, `จาก ${formatNumber(totals.total)}`],
          ["เปลี่ยน / เลื่อน / ไม่รับ", totals.changed + totals.deferred + totals.rejected, "รายการ"],
          ["ยังรอเขต", totals.pending, "รายการ"],
        ].map(([label, value, unit]) => (
          <article key={String(label)}>
            <span>{label}</span>
            <strong>{formatNumber(value, 0)}</strong>
            <small>{unit}</small>
          </article>
        ))}
      </section>

      <section className="panel district-confirmation-progress">
        <div className="panel-title">
          <div>
            <span>{activePlan.planNumber} · VERSION {activePlan.version}</span>
            <h3>สถานะการตอบกลับรายเขต</h3>
            <p>
              ประจำสัปดาห์ {activePlan.weekStart || "—"} · กำหนดตอบ {formatDateTime(activePlan.dueAt)}
            </p>
          </div>
          <Badge>{planStatusLabel[planStatus] ?? planStatus}</Badge>
          {role === "admin" && totals.pending > 0 && (
            <button
              type="button"
              className="btn primary"
              disabled={actionBusy}
              onClick={() => void confirmAllPending()}
            >
              {actionBusy
                ? "กำลังยืนยันรายการ..."
                : `ยืนยันรายการค้างทุกเขต (${formatNumber(totals.pending)})`}
            </button>
          )}
        </div>
        <div className="district-confirmation-cards">
          {districtSummaries.map((district) => {
            const completed = district.total - district.pending;
            const ready = district.pending === 0 && district.pendingChanges === 0;
            return (
              <button
                type="button"
                key={district.districtId}
                className={`${activeDistrict?.districtId === district.districtId ? "active" : ""} ${ready ? "ready" : "waiting"}`}
                onClick={() => openDistrictDetails(district.districtId)}
              >
                <header>
                  <span>เขต {district.districtId}</span>
                  <b>{ready ? "✓ ตรวจครบ" : `รอ ${district.pending + district.pendingChanges}`}</b>
                </header>
                <strong>{district.districtName}</strong>
                <div className="district-card-progress">
                  <i style={{ width: `${district.total ? (completed / district.total) * 100 : 0}%` }} />
                </div>
                <p>
                  ตอบแล้ว {formatNumber(completed)}/{formatNumber(district.total)} · เปลี่ยน {formatNumber(district.changed)}
                </p>
                <small>
                  เลื่อน {formatNumber(district.deferred)} · ไม่รับ {formatNumber(district.rejected)}
                  {district.pendingChanges ? ` · รอ Planner ${district.pendingChanges}` : ""}
                </small>
              </button>
            );
          })}
        </div>
      </section>

      {activeDistrict && (
        <section
          ref={detailRef}
          className="panel district-confirmation-detail"
          tabIndex={-1}
        >
          <div className="panel-title">
            <div>
              <span>รายละเอียดเขต {activeDistrict.districtId}</span>
              <h3>{activeDistrict.districtName}</h3>
            </div>
            <b>{formatNumber(activeDistrict.total)} รายการ</b>
          </div>
          <LiveTable
            rows={activeDistrict.rows}
            empty="ไม่มีรายการในเขตนี้"
            columns={[
              ["พัสดุ", (row) => <span><strong>{text(row.material_id)}</strong><small>{text(row.material_name)}</small></span>],
              ["Planner Qty", (row) => formatNumber(row.suggested_qty, 0)],
              ["เขตตอบ", (row) => responseQuantity(row)],
              ["ผลตอบ", (row) => <Badge>{responseLabel(row)}</Badge>],
              ["ผู้ยืนยัน", (row) => <span><strong>{text(row.requester_name)}</strong><small>{formatDateTime(row.district_confirmed_at ?? row.updated_at)}</small></span>],
              ["เหตุผล", (row) => text(row.district_note, text(row.response_reason))],
            ]}
          />
        </section>
      )}

      <form className="panel district-plan-gate" onSubmit={submitApproval}>
        <div>
          <span>PLAN CONFIRMATION GATE</span>
          <h3>
            {planStatus === "locked"
              ? "แผน Lock แล้ว พร้อมนำไปจัดรถ"
              : canAcademicLock
                ? "วิชาการตรวจและ Lock แผน"
                : "Planner ยืนยันผลตอบจากทุกเขต"}
          </h3>
          <ul>
            <li className={allDistrictsReady ? "passed" : "blocked"}>
              {allDistrictsReady ? "✓" : "!"} เขตตอบครบ: {formatNumber(responded)}/{formatNumber(totals.total)} รายการ
            </li>
            <li className={allChangesReviewed ? "passed" : "blocked"}>
              {allChangesReviewed ? "✓" : "!"} คำขอเปลี่ยนที่ยังรอ Planner: {formatNumber(totals.pendingChanges)} รายการ
            </li>
            {(canAcademicLock || planStatus === "locked") && (
              <li className={allFifoReady || planStatus === "locked" ? "passed" : "blocked"}>
                {allFifoReady || planStatus === "locked" ? "✓" : "!"}{" "}
                FIFO พร้อมจอง:{" "}
                {allFifoReady || planStatus === "locked"
                  ? "ครบตามแผน"
                  : `ขาด ${formatNumber(fifoReadiness.shortageQty, 0)} EA ใน ${formatNumber(fifoReadiness.shortages.length)} พัสดุ`}
              </li>
            )}
          </ul>
          {canAcademicLock && !allFifoReady && (
            <details className="fifo-lock-blocker" open>
              <summary>
                ยัง Lock ไม่ได้ — เปิดดูพัสดุที่ FIFO พร้อมหยิบไม่เพียงพอ
              </summary>
              <p>
                ต้องให้ Planner ลดจำนวนหรือเติม Opening HU/Stock ให้เพียงพอก่อน
                ระบบจึงจะจอง FIFO และส่งแผนไปจัดรถได้
              </p>
              <div>
                {fifoReadiness.shortages.slice(0, 8).map((item) => (
                  <span key={item.materialId}>
                    <strong>{item.materialId}</strong>{" "}
                    ขาด {formatNumber(item.shortage, 0)} EA
                    <small>
                      ต้องใช้ {formatNumber(item.required, 0)} · พร้อมหยิบ{" "}
                      {formatNumber(item.available, 0)} · เขต{" "}
                      {[...item.districts].join(", ")}
                    </small>
                  </span>
                ))}
              </div>
              {fifoReadiness.shortages.length > 8 && (
                <small>
                  และอีก {formatNumber(fifoReadiness.shortages.length - 8)} พัสดุ
                  — ดูทั้งหมดที่เมนู “FIFO &amp; พาเลท”
                </small>
              )}
            </details>
          )}
        </div>
        {planStatus === "locked" ? (
          <button type="button" className="btn primary" onClick={onOpenTransport}>
            ไปหน้าจัดรถ →
          </button>
        ) : (
          <div className="district-plan-approval">
            <label>
              หมายเหตุการตรวจสอบ
              <textarea
                value={approvalNote}
                onChange={(event) => setApprovalNote(event.target.value)}
                placeholder="สรุปผลการตรวจรายการยืนยันและคำขอเปลี่ยน"
                maxLength={1000}
                required={canAcademicLock}
              />
            </label>
            {localError && <p className="form-error" role="alert">{localError}</p>}
            <button className="btn primary" disabled={!canSubmitApproval || actionBusy}>
              {actionBusy
                ? "กำลังบันทึก..."
                : canAcademicLock
                  ? "อนุมัติและ Lock → พร้อมจัดรถ"
                  : canPlannerApprove
                    ? "ยืนยันแผน → ส่งให้วิชาการ"
                    : canAcademicLock && !allFifoReady
                      ? `FIFO ขาด ${formatNumber(fifoReadiness.shortageQty, 0)} EA`
                    : totals.pending > 0
                      ? `รอเขตอีก ${formatNumber(totals.pending)} รายการ`
                      : totals.pendingChanges > 0
                        ? `รอตรวจคำขอเปลี่ยน ${formatNumber(totals.pendingChanges)} รายการ`
                        : "ยังไม่ถึงขั้นยืนยันแผน"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function RecommendationView({ data }: { data: DashboardData }) {
  const [query, setQuery] = useState("");
  const [districtFilter, setDistrictFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState<"all" | AdvisoryLevel>("all");
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const districtNames = useMemo(
    () =>
      new Map(
        [...data.districts, ...data.stock, ...data.replenishment].map((row) => [
          text(row.district_id, ""),
          text(row.district_name_th, ""),
        ]),
      ),
    [data.districts, data.replenishment, data.stock],
  );
  const materialNames = useMemo(
    () =>
      new Map(
        [...data.materials, ...data.stock, ...data.replenishment].map((row) => [
          text(row.material_id, ""),
          text(row.material_name, ""),
        ]),
      ),
    [data.materials, data.replenishment, data.stock],
  );
  const enrichedRows = useMemo(
    () =>
      data.recommendations.map((row) => ({
        ...row,
        __district_name: text(
          row.district_name_th,
          districtNames.get(text(row.district_id, "")) || "",
        ),
        __material_name: text(
          row.material_name,
          materialNames.get(text(row.material_id, "")) || "",
        ),
        __risk: advisoryFor(row).level,
      }) as RecordRow),
    [data.recommendations, districtNames, materialNames],
  );
  const districts = useMemo(
    () =>
      [...new Set(enrichedRows.map((row) => text(row.district_id, "")))]
        .filter(Boolean)
        .sort(),
    [enrichedRows],
  );
  const filteredRows = useMemo(() => {
    const value = query.trim().toLowerCase();
    return enrichedRows.filter((row) => {
      const matchesQuery =
        !value ||
        [
          row.plan_number,
          row.plan_code,
          row.material_id,
          row.__material_name,
          row.district_id,
          row.__district_name,
        ]
          .map((item) => text(item, "").toLowerCase())
          .some((item) => item.includes(value));
      const matchesDistrict =
        districtFilter === "all" || text(row.district_id, "") === districtFilter;
      const matchesRisk = riskFilter === "all" || row.__risk === riskFilter;
      return matchesQuery && matchesDistrict && matchesRisk;
    });
  }, [districtFilter, enrichedRows, query, riskFilter]);
  const resetFilters = () => {
    setQuery("");
    setDistrictFilter("all");
    setRiskFilter("all");
  };
  const distinctMaterials = new Set(enrichedRows.map((row) => text(row.material_id, ""))).size;
  const criticalCount = enrichedRows.filter((row) => row.__risk === "critical").length;

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
      <section className="explorer-kpis" aria-label="สรุปหลักฐานปริมาณ">
        <article><span>หลักฐานทั้งหมด</span><strong>{formatNumber(enrichedRows.length)}</strong><small>รายการคำนวณ</small></article>
        <article><span>พัสดุ</span><strong>{formatNumber(distinctMaterials)}</strong><small>รหัสพัสดุ</small></article>
        <article><span>เขต</span><strong>{formatNumber(districts.length)}</strong><small>เขตที่มีแผน</small></article>
        <article className={criticalCount ? "danger" : ""}><span>ต้องตรวจเร่งด่วน</span><strong>{formatNumber(criticalCount)}</strong><small>หลักฐาน Critical</small></article>
      </section>
      <section className="panel">
        <header className="explorer-heading">
          <div>
            <span>QUANTITY EVIDENCE EXPLORER</span>
            <h3>ค้นหาหลักฐานตามเขตหรือพัสดุ</h3>
            <p>แสดงที่มาของจำนวนแนะนำจากสต็อก, CMP และกรอบขั้นต่ำ–สูงสุด</p>
          </div>
          <b aria-live="polite">พบ {formatNumber(filteredRows.length)} จาก {formatNumber(enrichedRows.length)} รายการ</b>
        </header>
        <div className="explorer-toolbar">
          <label className="explorer-search">
            <span>ค้นหา</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="รหัส/ชื่อพัสดุ, เขต หรือเลขแผน" />
          </label>
          <label>
            <span>เขต</span>
            <select value={districtFilter} onChange={(event) => setDistrictFilter(event.target.value)}>
              <option value="all">ทุกเขต</option>
              {districts.map((districtId) => <option key={districtId} value={districtId}>{districtId} · {districtNames.get(districtId) || "ไม่ระบุชื่อ"}</option>)}
            </select>
          </label>
          <label>
            <span>ระดับความเสี่ยง</span>
            <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as "all" | AdvisoryLevel)}>
              <option value="all">ทุกระดับ</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="watch">Watch</option>
              <option value="none">ปกติ</option>
            </select>
          </label>
          <button type="button" className="btn ghost" onClick={resetFilters}>ล้างตัวกรอง</button>
        </div>
        <LiveTable
          rows={filteredRows}
          empty="ไม่พบหลักฐานที่ตรงกับตัวกรอง"
          columns={[
            ["แผน", (row) => <span><strong>{text(row.plan_number, text(row.plan_code))}</strong><small>{text(row.generated_at, "") ? formatDateTime(row.generated_at) : "หลักฐานล่าสุด"}</small></span>],
            ["พัสดุ", (row) => <span><strong>{text(row.material_id)}</strong><small>{text(row.__material_name)}</small></span>],
            ["เขต", (row) => <span><strong>{text(row.district_id)}</strong><small>{text(row.__district_name)}</small></span>],
            ["สต็อก / CMP", (row) => <span><strong>{formatNumber(row.current_stock_qty, 2)} EA</strong><small>CMP {formatNumber(row.cmp_monthly, 2)} / เดือน</small></span>],
            ["เดือนคงเหลือ", (row) => <span><strong>{formatNumber(row.months_available, 1)} เดือน</strong><small><RiskBadge level={row.__risk as AdvisoryLevel} /></small></span>],
            ["จำนวนแนะนำ", (row) => <span><strong>{formatNumber(row.recommended_qty ?? row.rule_suggested_qty ?? row.suggested_qty, 2)} EA</strong><small>Min {formatNumber(row.min_fill_qty, 2)} · Max {formatNumber(row.max_fill_qty, 2)}</small></span>],
            ["รายละเอียด", (row) => <button type="button" className="table-action" onClick={() => setSelected(row)}>ดูที่มาจำนวน</button>],
          ]}
        />
      </section>
      {selected && (
        <div className="explorer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <section className="explorer-dialog" role="dialog" aria-modal="true" aria-labelledby="quantity-evidence-title">
            <header>
              <div><span>หลักฐานเชิงปริมาณ</span><h3 id="quantity-evidence-title">{text(selected.material_id)} · เขต {text(selected.district_id)}</h3><p>{text(selected.__material_name)} · {text(selected.__district_name)}</p></div>
              <button type="button" onClick={() => setSelected(null)} aria-label="ปิดรายละเอียด">×</button>
            </header>
            <div className="explorer-dialog-body">
              <aside className="evidence-equation"><span>เหตุผลของจำนวนแนะนำ</span><strong>{formatNumber(selected.recommended_qty ?? selected.rule_suggested_qty ?? selected.suggested_qty, 2)} EA</strong><p>คำนวณจากสต็อกปัจจุบัน {formatNumber(selected.current_stock_qty, 2)} และ CMP {formatNumber(selected.cmp_monthly, 2)} ต่อเดือน เพื่อเติมให้อยู่ในกรอบ 4–6 เดือน (Min {formatNumber(selected.min_fill_qty, 2)} ถึง Max {formatNumber(selected.max_fill_qty, 2)})</p></aside>
              <dl className="explorer-detail-grid">
                <div><dt>แผน</dt><dd>{text(selected.plan_number, text(selected.plan_code))}</dd></div>
                <div><dt>CMP ต่อเดือน</dt><dd>{formatNumber(selected.cmp_monthly, 2)}</dd></div>
                <div><dt>เดือนคงเหลือ</dt><dd>{formatNumber(selected.months_available, 1)}</dd></div>
                <div><dt>ระดับความเสี่ยง</dt><dd><RiskBadge level={selected.__risk as AdvisoryLevel} /></dd></div>
                <div><dt>กฎแนะนำ</dt><dd>{formatNumber(selected.rule_suggested_qty ?? selected.recommended_qty ?? selected.suggested_qty, 2)} EA</dd></div>
                <div><dt>AI แนะนำ</dt><dd>{formatNumber(selected.ai_suggested_qty ?? selected.recommended_qty ?? selected.suggested_qty, 2)} EA</dd></div>
                <div><dt>ความมั่นใจ</dt><dd>{formatNumber(Number(selected.confidence_score ?? 0) * 100, 0)}%</dd></div>
                <div><dt>ความสดข้อมูล</dt><dd><Badge>{text(selected.source_freshness_status, text(selected.evidence_status, "unknown"))}</Badge></dd></div>
              </dl>
            </div>
            <footer><button type="button" className="btn primary" onClick={() => setSelected(null)}>ปิดรายละเอียด</button></footer>
          </section>
        </div>
      )}
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
  type ReviewFilter = "abnormal" | "pending" | "normal";
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>("abnormal");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [note, setNote] = useState("");
  const canReview = role === "admin" || role === "planner";
  const classify = (row: RecordRow): ReviewFilter => {
    const status = text(row.status).toLowerCase();
    const risk = text(row.risk_level).toLowerCase();
    const projectedMonths = Number(row.projected_months_after);
    if (status === "pending_review") return "pending";
    if (
      ["critical", "high", "urgent"].includes(risk) ||
      (Number.isFinite(projectedMonths) && projectedMonths > 6)
    ) {
      return "abnormal";
    }
    return "normal";
  };
  const grouped = data.changeRequests.reduce<Record<ReviewFilter, RecordRow[]>>(
    (result, row) => {
      result[classify(row)].push(row);
      return result;
    },
    { abnormal: [], pending: [], normal: [] },
  );
  const visibleRows = grouped[filter];
  const selectedStatus = text(selected?.status).toLowerCase();
  const selectedOriginalQty = Number(
    selected?.original_qty ?? selected?.baseline_qty ?? 0,
  );
  const selectedRequestedQty = Number(selected?.requested_qty ?? 0);
  const selectedDelta = selectedRequestedQty - selectedOriginalQty;
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
      <section className="panel change-review-panel">
        <div className="change-review-summary" aria-label="สรุปรายการตรวจ">
          {([
            ["abnormal", "ผิดปกติ", "เกินเกณฑ์หรือมีความเสี่ยง"],
            ["pending", "รอตรวจ", "รอ Planner ตัดสินใจ"],
            ["normal", "ปกติ", "ผ่านเกณฑ์และเก็บเป็นประวัติ"],
          ] as [ReviewFilter, string, string][]).map(([value, label, detail]) => (
            <button
              type="button"
              key={value}
              className={`${filter === value ? "active" : ""} ${value}`}
              onClick={() => {
                setFilter(value);
                setSelected(null);
              }}
            >
              <span>{label}</span>
              <strong>{formatNumber(grouped[value].length)}</strong>
              <small>{detail}</small>
            </button>
          ))}
        </div>
        <div className="change-review-heading">
          <div>
            <span>{filter === "abnormal" ? "ABNORMAL REQUESTS" : filter === "pending" ? "PENDING REVIEW" : "NORMAL RECORDS"}</span>
            <h3>
              {filter === "abnormal"
                ? "รายการที่ต้องตรวจความเสี่ยง"
                : filter === "pending"
                  ? "รายการที่ยังรอผลตรวจ"
                  : "รายการปกติและผลที่ตรวจแล้ว"}
            </h3>
          </div>
          <b>{formatNumber(visibleRows.length)} รายการ</b>
        </div>
        <LiveTable
          rows={visibleRows}
          empty={
            filter === "abnormal"
              ? "ไม่พบคำขอผิดปกติในข้อมูลรอบนี้"
              : filter === "pending"
                ? "ไม่มีรายการรอตรวจ"
                : "ไม่มีรายการปกติ"
          }
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
                  onClick={() => {
                    setSelected(row);
                    setNote("");
                  }}
                >
                  {canReview && text(row.status).toLowerCase() === "pending_review"
                    ? "ตรวจและตัดสินใจ"
                    : "ดูหลักฐาน"}
                </button>
              ),
            ],
          ]}
        />
        {filter === "abnormal" && visibleRows.length === 0 && grouped.normal.length > 0 && (
          <div className="change-review-empty-action">
            <strong>รอบนี้ไม่มีรายการผิดปกติ</strong>
            <p>รายการปกติถูกแยกออกเพื่อไม่ให้ปะปนกับงานที่ต้องตรวจ</p>
            <button type="button" className="btn ghost" onClick={() => setFilter("normal")}>
              เปิดดูรายการปกติ ({formatNumber(grouped.normal.length)})
            </button>
          </div>
        )}
      </section>
      {selected && (
        <div className="change-evidence-backdrop" role="presentation">
          <form
            className="change-evidence-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="change-evidence-title"
            onSubmit={submit}
          >
            <header>
              <div>
                <span>REQUEST EVIDENCE · {text(selected.plan_number)}</span>
                <h3 id="change-evidence-title">
                  {text(selected.material_id)} · เขต {text(selected.district_id)}
                </h3>
                <p>ตรวจค่าก่อน–หลัง เหตุผล ผู้ขอ และผลการพิจารณาในที่เดียว</p>
              </div>
              <button type="button" aria-label="ปิด" onClick={() => setSelected(null)}>×</button>
            </header>

            <div className="change-evidence-metrics">
              <article><span>จำนวนเดิม</span><strong>{formatNumber(selectedOriginalQty, 2)}</strong></article>
              <article><span>จำนวนที่ขอ</span><strong>{formatNumber(selectedRequestedQty, 2)}</strong></article>
              <article className={selectedDelta === 0 ? "normal" : "warning"}>
                <span>ผลต่าง</span><strong>{selectedDelta > 0 ? "+" : ""}{formatNumber(selectedDelta, 2)}</strong>
              </article>
              <article><span>คงคลังหลังจ่าย</span><strong>{formatNumber(selected.projected_months_after, 1)} เดือน</strong></article>
              <article><span>ความเสี่ยง</span><Badge>{text(selected.risk_level)}</Badge></article>
              <article><span>สถานะ</span><Badge>{text(selected.status)}</Badge></article>
            </div>

            <div className="change-evidence-body">
              <section>
                <span>เหตุผล / หลักฐานจากผู้ขอ</span>
                <p>{text(selected.reason, "ไม่มีการระบุเหตุผลเพิ่มเติม")}</p>
              </section>
              <section>
                <span>ผู้ขอและเวลาที่ส่ง</span>
                <p><strong>{text(selected.requester_name, "—")}</strong><br />{formatDateTime(selected.created_at)}</p>
              </section>
              {Boolean(selected.review_note) && (
                <section className="reviewed">
                  <span>ผลการตรวจที่ผ่านมา</span>
                  <p>{text(selected.review_note)}<br />{formatDateTime(selected.reviewed_at)}</p>
                </section>
              )}
            </div>

            {canReview && selectedStatus === "pending_review" ? (
              <div className="change-evidence-decision">
                <label>
                  การตัดสินใจ
                  <select
                    value={decision}
                    onChange={(event) =>
                      setDecision(event.target.value as "approved" | "rejected")
                    }
                  >
                    <option value="approved">อนุมัติจำนวนที่ขอ</option>
                    <option value="rejected">ไม่อนุมัติ และใช้จำนวนเดิม</option>
                  </select>
                </label>
                <label>
                  หมายเหตุการตรวจ
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="ระบุเหตุผลและหลักฐานประกอบการตัดสินใจ"
                    required
                  />
                </label>
              </div>
            ) : (
              <p className="change-evidence-readonly">
                {selectedStatus === "pending_review"
                  ? "ดูหลักฐานได้ในโหมดอ่านอย่างเดียว การตัดสินใจคำขอเป็นหน้าที่ Planner หรือ Admin"
                  : "รายการนี้มีผลการตรวจแล้ว เปิดดูได้เพื่อสอบกลับและใช้ประกอบการอนุมัติแผน"}
              </p>
            )}

            <footer>
              <button type="button" className="btn ghost" onClick={() => setSelected(null)}>ปิด</button>
              {canReview && selectedStatus === "pending_review" && (
                <button className="btn primary" disabled={actionBusy || note.trim().length < 3}>
                  {actionBusy ? "กำลังบันทึก..." : "บันทึกผลการตรวจ"}
                </button>
              )}
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}

function ApprovalView({ data }: { data: DashboardData }) {
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const normalizedRows = useMemo(
    () =>
      data.approvals
        .map((row) => ({
          ...row,
          __acted_at: row.acted_at ?? row.approved_at ?? row.created_at,
          __stage: text(row.approval_stage, text(row.stage, "ไม่ระบุขั้นตอน")),
          __decision: text(row.decision, text(row.status, "ไม่ระบุผล")),
          __actor: text(row.approver_name, text(row.actor_name, text(row.actor_id, "ไม่ระบุผู้ทำ"))),
          __role: text(row.actor_role, text(row.approver_role, "ไม่ระบุบทบาท")),
          __plan: text(row.plan_number, text(row.plan_code, text(row.replenishment_plan_id))),
          __version: Number(row.version_no ?? row.plan_version ?? row.version ?? 1),
        }) as RecordRow)
        .sort((a, b) => Date.parse(text(b.__acted_at, "")) - Date.parse(text(a.__acted_at, ""))),
    [data.approvals],
  );
  const stages = useMemo(
    () => [...new Set(normalizedRows.map((row) => text(row.__stage, "")))].filter(Boolean).sort(),
    [normalizedRows],
  );
  const decisions = useMemo(
    () => [...new Set(normalizedRows.map((row) => text(row.__decision, "")))].filter(Boolean).sort(),
    [normalizedRows],
  );
  const filteredRows = useMemo(() => {
    const value = query.trim().toLowerCase();
    return normalizedRows.filter((row) => {
      const matchesQuery = !value || [row.__plan, row.__actor, row.__role, row.district_id, row.note]
        .map((item) => text(item, "").toLowerCase())
        .some((item) => item.includes(value));
      return matchesQuery && (stageFilter === "all" || row.__stage === stageFilter) && (decisionFilter === "all" || row.__decision === decisionFilter);
    });
  }, [decisionFilter, normalizedRows, query, stageFilter]);
  const approvedCount = normalizedRows.filter((row) => /approve|confirm|lock/i.test(text(row.__decision, ""))).length;
  const returnedCount = normalizedRows.filter((row) => /reject|return|change|cancel/i.test(text(row.__decision, ""))).length;
  const planCount = new Set(normalizedRows.map((row) => text(row.__plan, ""))).size;
  const resetFilters = () => { setQuery(""); setStageFilter("all"); setDecisionFilter("all"); };

  return (
    <div className="stack">
      <section className="plain-notice info">
        <i>i</i>
        <div><strong>ประวัติการอนุมัติ คือ Audit Trail ของแต่ละแผนและแต่ละ Version</strong><p>เรียงจากเหตุการณ์ล่าสุด เปิดดูได้ว่าใครทำอะไร เมื่อใด ที่ขั้นตอนไหน และมีหมายเหตุอะไร โดยไม่รวมรายการที่ยังไม่เคยมีการตัดสินใจ</p></div>
      </section>
      <section className="explorer-kpis" aria-label="สรุปประวัติการอนุมัติ">
        <article><span>เหตุการณ์ทั้งหมด</span><strong>{formatNumber(normalizedRows.length)}</strong><small>บันทึกตรวจสอบ</small></article>
        <article><span>แผนที่มีประวัติ</span><strong>{formatNumber(planCount)}</strong><small>รวมทุก Version</small></article>
        <article><span>อนุมัติ / ยืนยัน</span><strong>{formatNumber(approvedCount)}</strong><small>เหตุการณ์สำเร็จ</small></article>
        <article className={returnedCount ? "danger" : ""}><span>ส่งกลับ / ปฏิเสธ / เปลี่ยน</span><strong>{formatNumber(returnedCount)}</strong><small>ต้องอ่านเหตุผล</small></article>
      </section>
      <section className="panel">
        <header className="explorer-heading">
          <div><span>APPROVAL AUDIT TRAIL</span><h3>ค้นประวัติว่าใครอนุมัติแผนใด</h3><p>เลือกขั้นตอนและผลการตัดสินใจ แล้วเปิดดูหลักฐานของเหตุการณ์นั้น</p></div>
          <b aria-live="polite">พบ {formatNumber(filteredRows.length)} จาก {formatNumber(normalizedRows.length)} เหตุการณ์</b>
        </header>
        <div className="explorer-toolbar">
          <label className="explorer-search"><span>ค้นหา</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="เลขแผน, ผู้ดำเนินการ, บทบาท หรือเขต" /></label>
          <label><span>ขั้นตอน</span><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}><option value="all">ทุกขั้นตอน</option>{stages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}</select></label>
          <label><span>ผลการตัดสินใจ</span><select value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value)}><option value="all">ทุกผล</option>{decisions.map((decision) => <option key={decision} value={decision}>{decision}</option>)}</select></label>
          <button type="button" className="btn ghost" onClick={resetFilters}>ล้างตัวกรอง</button>
        </div>
        <LiveTable
          rows={filteredRows}
          empty="ไม่พบประวัติที่ตรงกับตัวกรอง"
          columns={[
            ["วันเวลา", (row) => <span><strong>{formatDateTime(row.__acted_at)}</strong><small>บันทึกในระบบ</small></span>],
            ["แผน / Version", (row) => <span><strong>{text(row.__plan)}</strong><small>Version {formatNumber(row.__version, 0)}</small></span>],
            ["ขั้นตอน", (row) => <Badge>{text(row.__stage)}</Badge>],
            ["ผล", (row) => <Badge>{text(row.__decision)}</Badge>],
            ["ผู้ดำเนินการ", (row) => <span><strong>{text(row.__actor)}</strong><small>{text(row.__role)}</small></span>],
            ["เขต", (row) => text(row.district_id, "ทุกเขต / ส่วนกลาง")],
            ["รายละเอียด", (row) => <button type="button" className="table-action" onClick={() => setSelected(row)}>เปิด Audit Trail</button>],
          ]}
        />
      </section>
      {selected && (
        <div className="explorer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <section className="explorer-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-history-title">
            <header><div><span>เหตุการณ์อนุมัติ</span><h3 id="approval-history-title">{text(selected.__plan)} · Version {formatNumber(selected.__version, 0)}</h3><p>{formatDateTime(selected.__acted_at)}</p></div><button type="button" onClick={() => setSelected(null)} aria-label="ปิดรายละเอียด">×</button></header>
            <div className="explorer-dialog-body">
              <aside className="evidence-equation"><span>ผลการดำเนินการ</span><strong>{text(selected.__decision)}</strong><p>ขั้นตอน {text(selected.__stage)} · เขต {text(selected.district_id, "ทุกเขต / ส่วนกลาง")}</p></aside>
              <dl className="explorer-detail-grid">
                <div><dt>ผู้ดำเนินการ</dt><dd>{text(selected.__actor)}</dd></div>
                <div><dt>บทบาท</dt><dd>{text(selected.__role)}</dd></div>
                <div><dt>รหัสเหตุการณ์</dt><dd>{text(selected.approval_id, text(selected.audit_id))}</dd></div>
                <div><dt>รหัสแผนในระบบ</dt><dd>{text(selected.replenishment_plan_id)}</dd></div>
                <div className="wide"><dt>หมายเหตุ / เหตุผล</dt><dd>{text(selected.note, text(selected.reason, "ไม่มีหมายเหตุ"))}</dd></div>
              </dl>
            </div>
            <footer><button type="button" className="btn primary" onClick={() => setSelected(null)}>ปิดรายละเอียด</button></footer>
          </section>
        </div>
      )}
    </div>
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
  const [districtFilter, setDistrictFilter] = useState("all");
  const [materialFilter, setMaterialFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selected, setSelected] = useState<RecordRow | null>(null);
  const [returnRow, setReturnRow] = useState<RecordRow | null>(null);
  const [returnQty, setReturnQty] = useState("");
  const [damaged, setDamaged] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const canReturn = ["admin", "picker"].includes(role);
  const districts = useMemo(
    () => [...new Set(data.traceability.map((row) => text(row.district_id, "")))].filter(Boolean).sort(),
    [data.traceability],
  );
  const materials = useMemo(
    () => [...new Set(data.traceability.map((row) => text(row.material_id, "")))].filter(Boolean).sort(),
    [data.traceability],
  );
  const issueTypes = useMemo(
    () => [...new Set(data.traceability.map((row) => text(row.issue_type, "")))].filter(Boolean).sort(),
    [data.traceability],
  );
  const rows = useMemo(() => {
    const value = query.trim().toLowerCase();
    return data.traceability.filter((row) => {
      const matchesQuery = !value || Object.values(row).map((item) => text(item, "")).join(" ").toLowerCase().includes(value);
      return matchesQuery &&
        (districtFilter === "all" || text(row.district_id, "") === districtFilter) &&
        (materialFilter === "all" || text(row.material_id, "") === materialFilter) &&
        (typeFilter === "all" || text(row.issue_type, "") === typeFilter);
    });
  }, [data.traceability, districtFilter, materialFilter, query, typeFilter]);
  const totalIssued = rows.reduce((sum, row) => sum + Number(row.issued_qty ?? 0), 0);
  const huCount = new Set(rows.map((row) => text(row.handling_unit_code, ""))).size;
  const resetFilters = () => { setQuery(""); setDistrictFilter("all"); setMaterialFilter("all"); setTypeFilter("all"); };
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
      <section className="plain-notice info">
        <i>i</i>
        <div><strong>สอบกลับจากรายการจ่าย ไปยัง HU, Lot, PO, สัญญา และผู้ขาย</strong><p>เริ่มค้นจากเลขที่จ่าย เขต หรือรหัสพัสดุ แล้วเปิด “ดูเส้นทาง” เพื่อดูต้นทางของของที่จ่ายออกไป</p></div>
      </section>
      <section className="explorer-kpis" aria-label="สรุปการสอบกลับ">
        <article><span>รายการที่พบ</span><strong>{formatNumber(rows.length)}</strong><small>หลังใช้ตัวกรอง</small></article>
        <article><span>จำนวนจ่ายรวม</span><strong>{formatNumber(totalIssued, 2)}</strong><small>หน่วยนับพื้นฐาน</small></article>
        <article><span>เขตปลายทาง</span><strong>{formatNumber(new Set(rows.map((row) => text(row.district_id, ""))).size)}</strong><small>เขต</small></article>
        <article><span>HU ต้นทาง</span><strong>{formatNumber(huCount)}</strong><small>หน่วยจัดเก็บ</small></article>
      </section>
      <section className="panel">
        <header className="explorer-heading">
          <div><span>DISTRIBUTION TRACEABILITY</span><h3>ค้นหาเส้นทางการจ่าย</h3><p>ผลลัพธ์แต่ละแถวเชื่อมรายการจ่ายกับหลักฐาน FIFO และเอกสารจัดซื้อ</p></div>
          <b aria-live="polite">พบ {formatNumber(rows.length)} จาก {formatNumber(data.traceability.length)} รายการ</b>
        </header>
        <div className="explorer-toolbar trace-toolbar">
          <label className="explorer-search"><span>ค้นหา</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="เลขที่จ่าย, HU, Lot, PO, สัญญา หรือผู้ขาย" aria-label="ค้นหาการสอบกลับ" /></label>
          <label><span>เขต</span><select value={districtFilter} onChange={(event) => setDistrictFilter(event.target.value)}><option value="all">ทุกเขต</option>{districts.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>พัสดุ</span><select value={materialFilter} onChange={(event) => setMaterialFilter(event.target.value)}><option value="all">ทุกพัสดุ</option>{materials.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>ประเภทการจ่าย</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">ทุกประเภท</option>{issueTypes.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <button type="button" className="btn ghost" onClick={resetFilters}>ล้างตัวกรอง</button>
        </div>
        <LiveTable
          rows={rows}
          empty="ไม่พบรายการจ่ายที่ตรงกับตัวกรอง"
          columns={[
            ["วันเวลา / เลขที่จ่าย", (row) => <span><strong>{text(row.issue_reference)}</strong><small>{formatDateTime(row.occurred_at ?? row.issued_at)}</small></span>],
            ["ปลายทาง", (row) => <span><strong>เขต {text(row.district_id)}</strong><small><Badge>{text(row.issue_type)}</Badge></small></span>],
            ["พัสดุ / จำนวน", (row) => <span><strong>{text(row.material_id)}</strong><small>{formatNumber(row.issued_qty, 2)} EA</small></span>],
            ["หลักฐาน FIFO", (row) => <span><strong>{text(row.handling_unit_code)}</strong><small>Lot {text(row.lot_code)}</small></span>],
            ["เอกสารต้นทาง", (row) => <span><strong>PO {text(row.purchase_order)} / {text(row.line_item)}</strong><small>{text(row.contract_number)} · {text(row.vendor_name)}</small></span>],
            ["ดำเนินการ", (row) => <div className="table-actions"><button type="button" className="table-action" onClick={() => setSelected(row)}>ดูเส้นทาง</button>{canReturn && <button type="button" className="table-action secondary" onClick={() => { setReturnRow(row); setReturnQty(""); setDamaged(false); setReturnReason(""); }}>รับคืน</button>}</div>],
          ]}
        />
      </section>
      {selected && (
        <div className="explorer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <section className="explorer-dialog trace-dialog" role="dialog" aria-modal="true" aria-labelledby="trace-title">
            <header><div><span>เส้นทางการจ่าย</span><h3 id="trace-title">{text(selected.issue_reference)}</h3><p>จ่ายไปเขต {text(selected.district_id)} เมื่อ {formatDateTime(selected.occurred_at ?? selected.issued_at)}</p></div><button type="button" onClick={() => setSelected(null)} aria-label="ปิดรายละเอียด">×</button></header>
            <div className="explorer-dialog-body">
              <ol className="trace-flow">
                <li><i>1</i><span><small>เอกสารจัดซื้อ</small><strong>PO {text(selected.purchase_order)} / {text(selected.line_item)}</strong><p>{text(selected.contract_number)} · {text(selected.vendor_name)}</p></span></li>
                <li><i>2</i><span><small>รับเข้าคลัง</small><strong>{text(selected.handling_unit_code)} · Lot {text(selected.lot_code)}</strong><p>วันรับ {text(selected.acceptance_date)}</p></span></li>
                <li><i>3</i><span><small>จ่ายออกแบบ FIFO</small><strong>{formatNumber(selected.issued_qty, 2)} EA · พัสดุ {text(selected.material_id)}</strong><p>{text(selected.issue_reference)} · {text(selected.issue_type)}</p></span></li>
                <li><i>4</i><span><small>ปลายทาง</small><strong>เขต {text(selected.district_id)}</strong><p>เชื่อมหลักฐานจากรายการจ่ายถึงเอกสารต้นทางครบถ้วน</p></span></li>
              </ol>
            </div>
            <footer><button type="button" className="btn primary" onClick={() => setSelected(null)}>ปิดรายละเอียด</button></footer>
          </section>
        </div>
      )}
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
          ["เชื่อมต่อ API ภายในโดเมนเดียว 49 เส้นทาง", "API"],
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
  onOpenTransport,
}: {
  view: ViewKey;
  role: Role;
  backend: ReturnType<typeof useSynapseBackend>;
  navigate: (view: ViewKey) => void;
  onOpenTransport: () => void;
}) {
  if (view === "dashboard") {
    return <DashboardView data={backend.data} role={role} navigate={navigate} />;
  }
  if (view === "weekly") {
    return (
      <WeeklyPlanView
        actionBusy={backend.actionBusy}
        currentUserName={text(
          backend.identity?.display_name,
          text(backend.session?.user?.email, backend.identity?.user_id),
        )}
        data={backend.data}
        role={role}
        onApprove={backend.approveReplenishmentPlan}
        onCancel={backend.cancelReplenishmentPlan}
        onCreate={backend.createReplenishmentRun}
        onIssue={backend.issueReplenishmentPlan}
        onReview={backend.reviewChangeRequest}
        onRespond={backend.respondReplenishment}
        onReturn={backend.returnAcademicPlan}
        onVersion={backend.versionReplenishmentPlan}
      />
    );
  }
  if (view === "district_confirmations") {
    return (
      <DistrictConfirmationView
        actionBusy={backend.actionBusy}
        currentUserName={text(
          backend.identity?.display_name,
          text(backend.session?.user?.email, backend.identity?.user_id),
        )}
        data={backend.data}
        role={role}
        onApprove={backend.approveReplenishmentPlan}
        onConfirmPending={backend.confirmPendingDistrictItems}
        onOpenTransport={onOpenTransport}
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
  if (view === "import") return <DataImportView onOpenPlanner={() => navigate("weekly")} />;
  if (view === "fifo_setup") {
    return (
      <FifoPackagingSetupView
        contractRows={backend.data.receiptOptions}
        materialRows={backend.data.materials}
        onPublishOpening={backend.publishFifoOpening}
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
          role={role}
          districtId={backend.identity.district_id}
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
              demoMode={backend.demoMode}
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
                onOpenTransport={() => {
                  setTransportView("planner");
                  setModule("transport");
                }}
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
