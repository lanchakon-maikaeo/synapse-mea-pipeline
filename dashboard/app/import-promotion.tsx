"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, formatNumber } from "./lib";

// ส่งไฟล์ Stock + อัตราการใช้งาน ที่บันทึกใน Import Center เข้าระบบคำนวณ (M24)

type FileInfo = { import_run_id: string; file_name: string; committed_at: string; sha256: string } | null;
type Readiness = {
  stock_file: FileInfo;
  usage_file: FileInfo;
  stock_date: string | null;
  usage_as_of: string | null;
  stock_rows: number;
  stock_district_rows: number;
  stock_districts: number;
  stock_warehouse_rows: number;
  usage_rows: number;
  usage_district_rows: number;
  usage_districts: number;
  materials_not_in_master: number;
  current_import: { finished_at: string; attested_by: string; source: string } | null;
  already_promoted: boolean;
  blocking: string[];
  warnings: string[];
};
type PromoteResult = {
  promoted: boolean;
  message?: string;
  counts?: Record<string, number>;
};

const thaiDate = (value: string | null | undefined, withTime = false) => {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return date.toLocaleString("th-TH", withTime
    ? { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", year: "2-digit" });
};

export function ImportPromotionPanel({ token, role, demoMode }: { token: string | null; role: string; demoMode: boolean }) {
  const canPromote = role === "admin" || role === "planner";
  const [ready, setReady] = useState<Readiness | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setError("");
    if (demoMode) {
      setReady({
        stock_file: { import_run_id: "d1", file_name: "Stock update 20.10.69.XLSX", committed_at: new Date().toISOString(), sha256: "" },
        usage_file: { import_run_id: "d2", file_name: "อัตราการใช้งาน.xlsx", committed_at: new Date().toISOString(), sha256: "" },
        stock_date: "2026-10-20", usage_as_of: "2026-09-30", stock_rows: 250, stock_district_rows: 0, stock_districts: 0,
        stock_warehouse_rows: 250, usage_rows: 6164, usage_district_rows: 5926, usage_districts: 18, materials_not_in_master: 0,
        current_import: { finished_at: "2026-07-24T10:00:00+07:00", attested_by: "pipeline", source: "workbook_pipeline" },
        already_promoted: false,
        blocking: ["ไฟล์ Stock ไม่มี Stock ของเขต (มีเฉพาะคลัง) ถ้าส่งเข้าไป ระบบจะคิดว่าทุกเขตมีของ 0 และสั่งจ่ายเต็ม 6 เดือน ต้องใช้ไฟล์ Stock ทุกโรงงาน"],
        warnings: [],
      });
      return;
    }
    if (!token || !canPromote) return;
    try {
      setReady(await apiRequest<Readiness>("/v1/source-imports/promotion", token));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดสถานะไม่สำเร็จ");
    }
  }, [canPromote, demoMode, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const promote = async () => {
    if (!token || demoMode) return;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<PromoteResult>("/v1/source-imports/promotion", token, {
        method: "POST",
        body: JSON.stringify({ note: "ส่งไฟล์จาก Import Center เข้าระบบคำนวณ" }),
      });
      setConfirming(false);
      if (!result.promoted) {
        setNotice(result.message ?? "ไฟล์ชุดนี้ส่งเข้าระบบคำนวณแล้ว");
      } else {
        const c = result.counts ?? {};
        setNotice(`ส่งเข้าระบบคำนวณแล้ว: Stock เขต ${formatNumber(c.district_snapshots ?? 0)} รายการ · Stock คลัง ${formatNumber(c.warehouse_snapshots ?? 0)} รายการ · CMP ${formatNumber(c.usage_rates ?? 0)} รายการ${c.plans_cancelled ? ` · ยกเลิกแผนเก่าที่ยังไม่ล็อก ${c.plans_cancelled} แผน` : ""}`);
      }
      await load();
    } catch (promoteError) {
      setError(promoteError instanceof Error ? promoteError.message : "ส่งเข้าระบบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  if (!canPromote) return null;
  if (!ready) return error ? <p className="form-error">{error}</p> : null;
  const blocked = ready.blocking.length > 0;

  return (
    <section className="panel ip-panel" aria-label="ส่งข้อมูลเข้าระบบคำนวณ">
      <header>
        <div>
          <span>ขั้นสุดท้าย</span>
          <h3>3. ส่งข้อมูลเข้าระบบคำนวณ</h3>
          <p>การคำนวณแผนการจ่ายใช้ Stock และ CMP ชุดที่ส่งเข้ามาล่าสุดเท่านั้น ชุดก่อนหน้าจะเลิกใช้ทันที (ไม่ลบ เก็บไว้เป็นประวัติ)</p>
        </div>
        <span className={`ip-state ${ready.already_promoted ? "done" : blocked ? "blocked" : "ready"}`}>
          {ready.already_promoted ? "ใช้ชุดนี้อยู่แล้ว" : blocked ? "ยังส่งไม่ได้" : "พร้อมส่ง"}
        </span>
      </header>

      <div className="ip-grid">
        <article>
          <small>ไฟล์ Stock ล่าสุด</small>
          <b>{ready.stock_file?.file_name ?? "—"}</b>
          <p>ยอด ณ {thaiDate(ready.stock_date)} · คลัง {formatNumber(ready.stock_warehouse_rows)} รายการ</p>
          <p className={ready.stock_districts === 18 ? "ok" : "bad"}>
            Stock เขต {formatNumber(ready.stock_district_rows)} รายการ · {ready.stock_districts}/18 เขต
          </p>
        </article>
        <article>
          <small>ไฟล์อัตราการใช้งาน (CMP) ล่าสุด</small>
          <b>{ready.usage_file?.file_name ?? "—"}</b>
          <p>คำนวณถึง {thaiDate(ready.usage_as_of)}</p>
          <p className={ready.usage_districts === 18 ? "ok" : "bad"}>
            {formatNumber(ready.usage_district_rows)} รายการ · {ready.usage_districts}/18 เขต
          </p>
        </article>
        <article>
          <small>ระบบคำนวณใช้ข้อมูลชุด</small>
          <b>{ready.current_import ? thaiDate(ready.current_import.finished_at, true) : "ยังไม่มี"}</b>
          <p>{ready.current_import ? (ready.current_import.source === "import_center" ? `ส่งจาก Import Center โดย ${ready.current_import.attested_by}` : "ชุดนำเข้าเดิม (ก่อนมี Import Center)") : ""}</p>
        </article>
      </div>

      {ready.blocking.map((message) => <p key={message} className="form-error" role="alert">{message}</p>)}
      {ready.warnings.map((message) => <p key={message} className="sap-import-help warning">{message}</p>)}
      {ready.materials_not_in_master > 0 && (
        <p className="sap-import-help warning">มี {formatNumber(ready.materials_not_in_master)} รหัสพัสดุที่ยังไม่อยู่ใน Material Master จะถูกข้ามไป</p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="sap-import-success" role="status">{notice}</p>}

      {!ready.already_promoted && !blocked && (
        confirming ? (
          <div className="ip-confirm">
            <p>ยืนยันส่ง Stock ยอด ณ {thaiDate(ready.stock_date)} และ CMP ถึง {thaiDate(ready.usage_as_of)} เข้าระบบคำนวณ? แผนที่ยังไม่ล็อกซึ่งคำนวณจากข้อมูลชุดเก่าจะถูกยกเลิก</p>
            <div className="um-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>ยกเลิก</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void promote()}>ยืนยันส่ง</button>
            </div>
          </div>
        ) : (
          <div className="um-actions">
            <button type="button" className="btn primary" disabled={busy || demoMode} onClick={() => setConfirming(true)}>ส่งเข้าระบบคำนวณ</button>
          </div>
        )
      )}
    </section>
  );
}
