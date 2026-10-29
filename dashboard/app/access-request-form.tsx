"use client";

import { useState, type FormEvent } from "react";

// Public "ขอสิทธิ์ใช้งาน" form on the login page → POST /api/access-requests.
const ROLES: Array<[string, string, string]> = [
  ["district", "เจ้าหน้าที่เขต", "ยืนยัน / ปรับ / ไม่รับรายการพัสดุของเขต"],
  ["planner", "ผู้วางแผน", "คำนวณและส่งแผนการจ่าย"],
  ["academic", "เจ้าหน้าที่วิชาการ", "ตรวจหลักฐานและอนุมัติวิชาการ"],
  ["picker", "เจ้าหน้าที่คลัง", "รับของ กรอก Packing จ่ายตาม FIFO"],
  ["viewer", "ผู้อ่านข้อมูล", "ดูภาพรวมอย่างเดียว"],
];

export function AccessRequestForm({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({
    fullName: "", employeeId: "", workEmail: "", organizationUnit: "", requestedRole: "district", reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

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
      if (!response.ok || !payload.request_number) {
        throw new Error(payload.error?.message ?? "ส่งคำขอไม่สำเร็จ");
      }
      setDone(payload.request_number);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "ส่งคำขอไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="import-review-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="import-review-modal um-modal ar-modal" role="dialog" aria-modal="true" aria-labelledby="ar-title">
        <header>
          <div>
            <span>ผู้ใช้ใหม่</span>
            <h3 id="ar-title">ขอสิทธิ์ใช้งาน MEA Synapse</h3>
            <p>ผู้ดูแลระบบจะตรวจสอบและกำหนดสิทธิ์ให้ตามหน้าที่ของคุณ</p>
          </div>
        </header>
        {done ? (
          <div className="ar-done">
            <strong>ส่งคำขอแล้ว</strong>
            <p>เลขที่คำขอ <b>{done}</b></p>
            <p>เมื่อผู้ดูแลระบบอนุมัติ คุณจะได้รับบัญชีเข้าระบบด้วยอีเมล <b>{form.workEmail}</b></p>
            <button type="button" className="btn primary" onClick={onClose}>กลับไปหน้าเข้าสู่ระบบ</button>
          </div>
        ) : (
          <form className="um-form" onSubmit={submit}>
            <label>
              ชื่อ–นามสกุล
              <input value={form.fullName} onChange={(event) => set("fullName")(event.target.value)} required minLength={2} maxLength={120} />
            </label>
            <label>
              รหัสพนักงาน
              <input value={form.employeeId} onChange={(event) => set("employeeId")(event.target.value)} required pattern="[A-Za-z0-9._/\-]{2,30}" />
            </label>
            <label>
              อีเมลที่ทำงาน
              <input type="email" value={form.workEmail} onChange={(event) => set("workEmail")(event.target.value)} required maxLength={160} />
            </label>
            <label>
              หน่วยงาน
              <input value={form.organizationUnit} onChange={(event) => set("organizationUnit")(event.target.value)} required minLength={2} maxLength={160}
                placeholder={form.requestedRole === "district" ? "เช่น การไฟฟ้าเขตสามเสน" : "เช่น กองคลังพัสดุ"} />
            </label>
            <fieldset className="ar-roles">
              <legend>บทบาทที่ต้องการ</legend>
              {ROLES.map(([key, label, note]) => (
                <label key={key} className={form.requestedRole === key ? "active" : ""}>
                  <input type="radio" name="role" value={key} checked={form.requestedRole === key} onChange={() => set("requestedRole")(key)} />
                  <span><b>{label}</b><small>{note}</small></span>
                </label>
              ))}
            </fieldset>
            <label className="um-wide">
              เหตุผล / งานที่ต้องใช้ระบบ
              <textarea value={form.reason} onChange={(event) => set("reason")(event.target.value)} required minLength={10} maxLength={800} rows={3} />
            </label>
            {error && <p className="pk-error um-wide">{error}</p>}
            <footer className="um-wide ar-footer">
              <button type="button" className="btn ghost" onClick={onClose}>ยกเลิก</button>
              <button type="submit" className="btn primary" disabled={busy}>{busy ? "กำลังส่ง…" : "ส่งคำขอ"}</button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
