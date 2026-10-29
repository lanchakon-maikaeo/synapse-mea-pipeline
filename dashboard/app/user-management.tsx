"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";
import { HISTORY_DISTRICTS } from "./operation-history";

// จัดการผู้ใช้: approve access requests, change role / district / status, and
// see who changed what. Admin only (GET/POST /v1/admin/users…).

export type ManagedUser = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  district_id: string | null;
  district_name: string | null;
  is_active: boolean;
  last_sign_in_at: string | null;
  created_at: string | null;
};

export type AccessRequestRow = {
  request_id: string;
  request_number: string;
  full_name: string;
  employee_id: string;
  work_email: string;
  organization_unit: string;
  requested_role: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_note: string | null;
  approved_role: string | null;
  approved_district_id: string | null;
  applied_at: string | null;
  account_user_id: string | null;
  account_role: string | null;
  account_active: boolean | null;
};

type HistoryRow = {
  audit_id: number;
  occurred_at: string;
  operation: string;
  actor: string | null;
  target_user_id: string;
  target: string | null;
  changes: Record<string, [unknown, unknown]>;
};

export type UsersPayload = {
  me: string;
  users: ManagedUser[];
  requests: AccessRequestRow[];
  history: HistoryRow[];
};

export const ROLE_LABEL: Record<string, string> = {
  admin: "เจ้าหน้าที่ส่วนกลาง (Admin)",
  planner: "ผู้วางแผน",
  academic: "เจ้าหน้าที่วิชาการ",
  picker: "เจ้าหน้าที่คลัง",
  district: "เจ้าหน้าที่เขต",
  viewer: "ผู้อ่านข้อมูล",
};

const ASSIGNABLE = ["planner", "academic", "picker", "district", "viewer"];

const dateTime = (value: string | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("th-TH", {
    day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Bangkok",
  });
};

const districtLabel = (id: string | null | undefined) => {
  if (!id) return "—";
  const name = HISTORY_DISTRICTS.find(([code]) => code === id)?.[1];
  return name ? `${id} · เขต${name}` : id;
};

function RoleBadge({ role }: { role: string }) {
  return <span className={`um-role ${role}`}>{ROLE_LABEL[role] ?? role}</span>;
}

function DistrictSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="เขต">
      <option value="">— เลือกเขต —</option>
      {HISTORY_DISTRICTS.map(([code, name]) => (
        <option key={code} value={code}>{code} · เขต{name}</option>
      ))}
    </select>
  );
}

function RequestCard({
  request,
  busy,
  onReview,
}: {
  request: AccessRequestRow;
  busy: boolean;
  onReview: (request: AccessRequestRow, body: Record<string, string>) => Promise<boolean>;
}) {
  const [role, setRole] = useState(request.requested_role);
  const [district, setDistrict] = useState("");
  const [name, setName] = useState(request.full_name);
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const hasAccount = Boolean(request.account_user_id);
  const accountIsAdmin = request.account_role === "admin";
  const canApprove = !accountIsAdmin && (role !== "district" || Boolean(district)) && name.trim().length >= 2;

  return (
    <article className="panel um-request">
      <header>
        <div>
          <strong>{request.full_name}</strong>
          <small>{request.request_number} · ส่งเมื่อ {dateTime(request.submitted_at)}</small>
        </div>
        <span className={`um-account ${hasAccount ? "has" : "none"}`}>
          {hasAccount ? "มีบัญชี Login แล้ว · มีผลทันที" : "ยังไม่มีบัญชี Login"}
        </span>
      </header>
      <dl className="um-request-facts">
        <div><dt>รหัสพนักงาน</dt><dd>{request.employee_id}</dd></div>
        <div><dt>อีเมล</dt><dd>{request.work_email}</dd></div>
        <div><dt>หน่วยงาน</dt><dd>{request.organization_unit}</dd></div>
        <div><dt>บทบาทที่ขอ</dt><dd><RoleBadge role={request.requested_role} /></dd></div>
      </dl>
      <p className="um-reason">“{request.reason}”</p>
      {accountIsAdmin && <p className="pk-error">อีเมลนี้เป็นบัญชีผู้ดูแลระบบอยู่แล้ว</p>}
      {!rejecting ? (
        <div className="um-review">
          <label>
            บทบาทที่ให้
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              {ASSIGNABLE.map((key) => <option key={key} value={key}>{ROLE_LABEL[key]}</option>)}
            </select>
          </label>
          {role === "district" && (
            <label>
              เขต
              <DistrictSelect value={district} onChange={setDistrict} />
            </label>
          )}
          <label>
            ชื่อที่แสดงในระบบ
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="um-wide">
            หมายเหตุ (ถ้ามี)
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="เช่น อนุมัติตามบันทึกข้อความเลขที่ …" />
          </label>
          <div className="um-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setRejecting(true)}>ไม่อนุมัติ</button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !canApprove}
              onClick={() => void onReview(request, {
                decision: "approve", role, district_id: role === "district" ? district : "", display_name: name.trim(), note,
              })}
            >
              อนุมัติเป็น{ROLE_LABEL[role]}
            </button>
          </div>
          {!hasAccount && (
            <p className="um-hint">
              อนุมัติแล้ว สร้างบัญชี Login ด้วยอีเมล <b>{request.work_email}</b> สิทธิ์นี้จะถูกใส่ให้อัตโนมัติ
            </p>
          )}
        </div>
      ) : (
        <div className="um-review">
          <label className="um-wide">
            เหตุผลที่ไม่อนุมัติ (จำเป็น)
            <input value={note} onChange={(event) => setNote(event.target.value)} autoFocus />
          </label>
          <div className="um-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setRejecting(false)}>← กลับ</button>
            <button
              type="button"
              className="btn danger"
              disabled={busy || !note.trim()}
              onClick={() => void onReview(request, { decision: "reject", note: note.trim() })}
            >
              ยืนยันไม่อนุมัติ
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function EditUserModal({
  user,
  isSelf,
  busy,
  onClose,
  onSave,
}: {
  user: ManagedUser;
  isSelf: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(user.display_name ?? "");
  const [role, setRole] = useState(user.role);
  const [district, setDistrict] = useState(user.district_id ?? "");
  const [active, setActive] = useState(user.is_active);
  const isAdmin = user.role === "admin";
  const lockRole = isAdmin || isSelf;
  const valid = name.trim().length >= 2 && (role !== "district" || Boolean(district));

  return (
    <div className="import-review-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="import-review-modal um-modal" role="dialog" aria-modal="true" aria-labelledby="um-edit-title">
        <header>
          <div>
            <span>แก้ไขผู้ใช้</span>
            <h3 id="um-edit-title">{user.display_name || user.email}</h3>
            <p>{user.email}</p>
          </div>
        </header>
        <div className="um-form">
          <label>
            ชื่อที่แสดงในระบบ
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            บทบาท
            {lockRole ? (
              <div className="um-locked">
                <RoleBadge role={user.role} />
                <small>{isAdmin ? "บทบาทผู้ดูแลระบบเปลี่ยนจากหน้านี้ไม่ได้" : "เปลี่ยนบทบาทของตัวเองไม่ได้"}</small>
              </div>
            ) : (
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                {ASSIGNABLE.map((key) => <option key={key} value={key}>{ROLE_LABEL[key]}</option>)}
              </select>
            )}
          </label>
          {role === "district" && (
            <label>
              เขตที่รับผิดชอบ
              <DistrictSelect value={district} onChange={setDistrict} />
            </label>
          )}
          <label className="um-toggle">
            <input
              type="checkbox"
              checked={active}
              disabled={lockRole}
              onChange={(event) => setActive(event.target.checked)}
            />
            <span>
              <b>{active ? "ใช้งานได้" : "ระงับการใช้งาน"}</b>
              <small>ระงับแล้วจะเข้าใช้งานระบบไม่ได้ · ประวัติงานเดิมยังอยู่ครบ เปิดใช้งานคืนได้ภายหลัง</small>
            </span>
          </label>
        </div>
        <footer>
          <span />
          <div>
            <button type="button" className="btn ghost" onClick={onClose}>ยกเลิก</button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !valid}
              onClick={async () => {
                const ok = await onSave({
                  display_name: name.trim(),
                  ...(lockRole ? {} : { role, is_active: active }),
                  ...(role === "district" ? { district_id: district } : {}),
                });
                if (ok) onClose();
              }}
            >
              บันทึก
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  role: "บทบาท",
  district_id: "เขต",
  is_active: "สถานะ",
  display_name: "ชื่อ",
};

function changeText(field: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "role") return ROLE_LABEL[String(value)] ?? String(value);
  if (field === "is_active") return value ? "ใช้งานได้" : "ระงับ";
  if (field === "district_id") return districtLabel(String(value));
  return String(value);
}

export function UserManagementView({
  token,
  demoMode,
  demoPayload,
}: {
  token: string | null;
  demoMode: boolean;
  demoPayload?: UsersPayload;
}) {
  const [data, setData] = useState<UsersPayload | null>(null);
  const [tab, setTab] = useState<"requests" | "users" | "history">("requests");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("");
  const [editing, setEditing] = useState<ManagedUser | null>(null);

  const load = useCallback(async () => {
    setError("");
    if (demoMode || !token) {
      setData(demoPayload ?? null);
      return;
    }
    setLoading(true);
    try {
      setData(await apiRequest<UsersPayload>("/v1/admin/users", token));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดข้อมูลผู้ใช้ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [demoMode, demoPayload, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const pending = useMemo(() => (data?.requests ?? []).filter((row) => row.status === "pending"), [data]);
  const reviewed = useMemo(() => (data?.requests ?? []).filter((row) => row.status !== "pending"), [data]);
  const users = data?.users ?? [];
  const activeUsers = users.filter((user) => user.is_active);
  const roleCounts = ASSIGNABLE.concat("admin").map((role) => [role, activeUsers.filter((user) => user.role === role).length] as const);

  const visibleUsers = users.filter((user) => {
    if (roleFilter && user.role !== roleFilter) return false;
    if (statusFilter === "active" && !user.is_active) return false;
    if (statusFilter === "inactive" && user.is_active) return false;
    const text = `${user.display_name ?? ""} ${user.email ?? ""} ${user.district_id ?? ""} ${user.district_name ?? ""}`.toLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  });

  const run = async (action: () => Promise<unknown>, success: string) => {
    if (demoMode || !token) {
      setNotice("โหมดสาธิต: ไม่บันทึกจริง");
      return true;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
      await load();
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "บันทึกไม่สำเร็จ");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const review = (request: AccessRequestRow, body: Record<string, string>) =>
    run(
      () => apiRequest(`/v1/admin/access-requests/${request.request_id}/review`, token ?? "", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      body.decision === "approve"
        ? request.account_user_id
          ? `อนุมัติ ${request.full_name} แล้ว · สิทธิ์มีผลทันที`
          : `อนุมัติ ${request.full_name} แล้ว · สร้างบัญชี Login ด้วย ${request.work_email} แล้วสิทธิ์จะมีผลอัตโนมัติ`
        : `ไม่อนุมัติคำขอของ ${request.full_name}`,
    );

  const save = (user: ManagedUser, patch: Record<string, unknown>) =>
    run(
      () => apiRequest(`/v1/admin/users/${user.user_id}`, token ?? "", {
        method: "POST",
        body: JSON.stringify(patch),
      }),
      `บันทึกข้อมูล ${user.display_name || user.email} แล้ว`,
    );

  return (
    <div className="stack um-page">
      <section className="oh-summary um-summary">
        <article>
          <span>ผู้ใช้ที่ใช้งานได้</span>
          <strong>{formatNumber(activeUsers.length)}</strong>
          <small>ระงับแล้ว {formatNumber(users.length - activeUsers.length)} บัญชี</small>
        </article>
        <article className={pending.length ? "attn" : ""}>
          <span>คำขอรอพิจารณา</span>
          <strong>{formatNumber(pending.length)}</strong>
          <small>{pending.length ? "ตรวจและอนุมัติที่แท็บคำขอสิทธิ์" : "ไม่มีคำขอค้าง"}</small>
        </article>
        <article className="um-roles">
          <span>แยกตามบทบาท</span>
          <div>
            {roleCounts.map(([role, count]) => (
              <button key={role} type="button" onClick={() => { setRoleFilter(role); setTab("users"); }}>
                {ROLE_LABEL[role].replace(" (Admin)", "")} <b>{formatNumber(count)}</b>
              </button>
            ))}
          </div>
        </article>
      </section>

      <details className="panel um-howto">
        <summary>เพิ่มผู้ใช้ใหม่ทำอย่างไร</summary>
        <ol>
          <li>ผู้ใช้กด <b>“ขอสิทธิ์ใช้งาน”</b> ที่หน้าเข้าสู่ระบบ แล้วกรอกชื่อ รหัสพนักงาน อีเมล หน่วยงาน และบทบาทที่ต้องการ</li>
          <li>คำขอจะขึ้นที่แท็บ <b>คำขอสิทธิ์</b> ด้านล่าง เลือกบทบาท (และเขต ถ้าเป็นเจ้าหน้าที่เขต) แล้วกด <b>อนุมัติ</b></li>
          <li>ถ้าผู้ใช้ยังไม่มีบัญชี Login ให้สร้างใน Supabase → Authentication → Add user ด้วย<b>อีเมลเดียวกับในคำขอ</b> ระบบจะใส่สิทธิ์ที่อนุมัติให้อัตโนมัติ</li>
          <li>ถ้ามีบัญชีอยู่แล้ว สิทธิ์มีผลทันที ผู้ใช้ออกจากระบบแล้วเข้าใหม่ 1 ครั้ง</li>
        </ol>
      </details>

      <div className="oh-tabs" role="tablist">
        {([
          ["requests", `คำขอสิทธิ์${pending.length ? ` (${pending.length})` : ""}`],
          ["users", `ผู้ใช้ทั้งหมด (${users.length})`],
          ["history", "ประวัติการเปลี่ยนสิทธิ์"],
        ] as Array<[typeof tab, string]>).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
        <span className="oh-tabs-spacer" />
        <button type="button" className="btn ghost" disabled={loading} onClick={() => void load()}>รีเฟรช</button>
      </div>

      {error && <p className="pk-error">{error}</p>}
      {notice && <p className="um-notice">{notice}</p>}

      {tab === "requests" && (
        <div className="stack">
          {loading && !data ? (
            <p className="pk-empty">กำลังโหลด…</p>
          ) : pending.length === 0 ? (
            <p className="panel pk-empty">ไม่มีคำขอสิทธิ์ที่รอพิจารณา</p>
          ) : (
            pending.map((request) => (
              <RequestCard key={request.request_id} request={request} busy={busy} onReview={review} />
            ))
          )}
          {reviewed.length > 0 && (
            <section className="panel um-past">
              <h4>คำขอที่พิจารณาแล้ว (180 วันล่าสุด)</h4>
              <div className="live-table-wrap">
                <table className="live-table">
                  <thead>
                    <tr><th>ผู้ขอ</th><th>ผล</th><th>บทบาทที่ให้</th><th>สถานะบัญชี</th><th>ผู้พิจารณา</th><th>หมายเหตุ</th></tr>
                  </thead>
                  <tbody>
                    {reviewed.map((request) => (
                      <tr key={request.request_id}>
                        <td><strong>{request.full_name}</strong><small>{request.work_email}</small></td>
                        <td><span className={`um-status ${request.status}`}>{request.status === "approved" ? "อนุมัติ" : request.status === "rejected" ? "ไม่อนุมัติ" : "ยกเลิก"}</span></td>
                        <td>
                          {request.approved_role ? <RoleBadge role={request.approved_role} /> : "—"}
                          {request.approved_district_id && <small>{districtLabel(request.approved_district_id)}</small>}
                        </td>
                        <td>
                          {request.status !== "approved" ? "—" : request.applied_at ? "มีผลแล้ว" : <span className="oh-attn">รอสร้างบัญชี Login</span>}
                        </td>
                        <td>{request.reviewed_by_name ?? "—"}<small>{dateTime(request.reviewed_at)}</small></td>
                        <td>{request.review_note ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {tab === "users" && (
        <section className="panel um-users">
          <div className="oh-filter-row">
            <input className="pk-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาชื่อ อีเมล หรือเขต" aria-label="ค้นหาผู้ใช้" />
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="บทบาท">
              <option value="">ทุกบทบาท</option>
              {Object.entries(ROLE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="สถานะ">
              <option value="">ทุกสถานะ</option>
              <option value="active">ใช้งานได้</option>
              <option value="inactive">ระงับแล้ว</option>
            </select>
          </div>
          {visibleUsers.length === 0 ? (
            <p className="pk-empty">ไม่พบผู้ใช้ตามเงื่อนไข</p>
          ) : (
            <div className="live-table-wrap">
              <table className="live-table um-table">
                <thead>
                  <tr><th>ผู้ใช้</th><th>บทบาท</th><th>เขต</th><th>สถานะ</th><th>เข้าระบบล่าสุด</th><th></th></tr>
                </thead>
                <tbody>
                  {visibleUsers.map((user) => (
                    <tr key={user.user_id} className={user.is_active ? "" : "um-inactive"}>
                      <td>
                        <strong>{user.display_name || "— ยังไม่ตั้งชื่อ —"}{user.user_id === data?.me && <em className="um-me">คุณ</em>}</strong>
                        <small>{user.email ?? user.user_id}</small>
                      </td>
                      <td><RoleBadge role={user.role} /></td>
                      <td>{user.role === "district" ? districtLabel(user.district_id) : "—"}</td>
                      <td><span className={`um-status ${user.is_active ? "approved" : "rejected"}`}>{user.is_active ? "ใช้งานได้" : "ระงับ"}</span></td>
                      <td>{user.last_sign_in_at ? dateTime(user.last_sign_in_at) : <span className="um-muted">ยังไม่เคยเข้า</span>}</td>
                      <td><button type="button" className="btn ghost" onClick={() => setEditing(user)}>แก้ไข</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="oh-hint">บัญชีใหม่ที่สร้างโดยไม่มีคำขอ จะได้บทบาท “ผู้อ่านข้อมูล” ก่อน · เปลี่ยนบทบาทได้จากปุ่มแก้ไข</p>
        </section>
      )}

      {tab === "history" && (
        <section className="panel um-history">
          {(data?.history ?? []).length === 0 ? (
            <p className="pk-empty">ยังไม่มีประวัติการเปลี่ยนสิทธิ์</p>
          ) : (
            <ul>
              {(data?.history ?? []).map((row) => {
                const fields = Object.entries(row.changes ?? {});
                return (
                  <li key={row.audit_id}>
                    <div className="um-when">{dateTime(row.occurred_at)}</div>
                    <div>
                      <strong>{row.target ?? row.target_user_id}</strong>
                      <span className="um-op">{row.operation === "INSERT" ? "สร้างบัญชี" : row.operation === "DELETE" ? "ลบบัญชี" : "แก้ไข"}</span>
                      <ul className="um-changes">
                        {fields.map(([field, [before, after]]) => (
                          <li key={field}>
                            {FIELD_LABEL[field] ?? field}:{" "}
                            {row.operation === "UPDATE" && <><s>{changeText(field, before)}</s> → </>}
                            <b>{changeText(field, after)}</b>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="um-actor">โดย {row.actor ?? "—"}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {editing && (
        <EditUserModal
          user={editing}
          isSelf={editing.user_id === data?.me}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(patch) => save(editing, patch)}
        />
      )}
    </div>
  );
}
