"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, formatNumber } from "./lib";
import { readAllWorksheets } from "./sap-xlsx";
import {
  FLAG_LABELS,
  parseLegacyWorkbook,
  type LegacyFlag,
  type LegacyHistoryRow,
  type LegacyParseResult,
} from "./legacy-history";

// ยกประวัติการจ่ายจากระบบเดิม: read the old Google Sheet export, show what will
// be imported and what needs a look, then send it in chunks.

type Summary = {
  total: number;
  issued: number;
  adjusted: number;
  refused: number;
  first_plan_date: string | null;
  last_plan_date: string | null;
  districts: number;
  materials: number;
  last_imported_at: string | null;
};

const OUTCOME_LABEL = { issued: "จ่ายได้ตามแผน", adjusted: "ปรับจำนวน", refused: "ไม่รับของ" } as const;
const FILL_LABEL = {
  vmi: "จ่ายตาม VMI",
  passed_test: "ของผ่านทดสอบ",
  district_request: "เขตแจ้งใช้",
  unknown: "ไม่ระบุ",
} as const;

export function LegacyHistoryImportView({ token, demoMode }: { token: string | null; demoMode: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<LegacyParseResult | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [flagFilter, setFlagFilter] = useState<LegacyFlag | "all">("all");
  const [ack, setAck] = useState(false);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ inserted: number; updated: number; skipped: number } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  const loadSummary = useCallback(async () => {
    if (demoMode || !token) return;
    try {
      setSummary(await apiRequest<Summary>("/v1/admin/legacy-issue-history", token));
    } catch {
      setSummary(null);
    }
  }, [demoMode, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSummary(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSummary]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setError("");
    setParsed(null);
    setResult(null);
    setAck(false);
    try {
      const sheets = readAllWorksheets(new Uint8Array(await file.arrayBuffer()));
      const outcome = parseLegacyWorkbook(sheets);
      if (!outcome.rows.length) {
        setError(outcome.warnings.join(" · ") || "ไม่พบรายการประวัติในไฟล์นี้");
      }
      setParsed(outcome);
      setFileName(file.name);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "อ่านไฟล์ไม่สำเร็จ");
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const rows = parsed?.rows ?? [];
  const count = <T extends string>(pick: (row: LegacyHistoryRow) => T) =>
    rows.reduce<Record<string, number>>((totals, row) => {
      const key = pick(row);
      totals[key] = (totals[key] ?? 0) + 1;
      return totals;
    }, {});
  const outcomes = count((row) => row.outcome);
  const fills = count((row) => row.fill_type);
  const bySource = count((row) => (row.source_sheet.startsWith("History") ? row.source_sheet : "ชีทเขต (ยังไม่ย้ายเข้า History)"));
  const flagCounts = rows.reduce<Record<string, number>>((totals, row) => {
    row.review_flags.forEach((flag) => { totals[flag] = (totals[flag] ?? 0) + 1; });
    return totals;
  }, {});
  const flagged = rows.filter((row) => row.review_flags.length > 0
    && (flagFilter === "all" || row.review_flags.includes(flagFilter)));
  const dates = rows.map((row) => row.plan_date).filter(Boolean).sort() as string[];
  const refusalsByDistrict = Object.entries(count((row) => (row.outcome === "refused" ? row.district_name : "")))
    .filter(([name]) => name)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);

  const send = async () => {
    if (!parsed || !rows.length) return;
    setSending(true);
    setError("");
    setProgress(0);
    const totals = { inserted: 0, updated: 0, skipped: 0 };
    try {
      for (let start = 0; start < rows.length; start += 500) {
        const chunk = rows.slice(start, start + 500);
        if (!demoMode && token) {
          const response = await apiRequest<{ inserted: number; updated: number; skipped: number }>(
            "/v1/admin/legacy-issue-history",
            token,
            { method: "POST", body: JSON.stringify({ rows: chunk, source_file: fileName }) },
          );
          totals.inserted += Number(response.inserted ?? 0);
          totals.updated += Number(response.updated ?? 0);
          totals.skipped += Number(response.skipped ?? 0);
        } else {
          totals.inserted += chunk.length;
        }
        setProgress(Math.min(rows.length, start + chunk.length));
      }
      setResult(totals);
      void loadSummary();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "นำเข้าไม่สำเร็จ");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="stack lh-page">
      <section className="panel lh-intro">
        <div>
          <span>ยกข้อมูลครั้งแรก</span>
          <h3>ประวัติการจ่ายและการไม่รับของจากไฟล์คำนวณการจ่ายเดิม</h3>
          <p>
            อ่านชีท History จ่ายได้ตามแผน, History ไม่รับของ และชีท 18 เขต
            (เฉพาะรายการที่มีสถานะแล้ว) · นำเข้าซ้ำได้ ระบบจะอัปเดตรายการเดิม ไม่สร้างซ้ำ
          </p>
        </div>
        <div className="lh-intro-actions">
          {summary && summary.total > 0 && (
            <div className="hero-chip lh-current">
              <span>อยู่ในระบบแล้ว</span>
              <strong>{formatNumber(summary.total)} รายการ</strong>
              <small>
                {summary.first_plan_date ?? "—"} ถึง {summary.last_plan_date ?? "—"} · ไม่รับ {formatNumber(summary.refused)}
              </small>
            </div>
          )}
          <input
            ref={inputRef}
            className="import-hidden-input"
            type="file"
            accept=".xlsx"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          <button type="button" className="btn primary" disabled={reading} onClick={() => inputRef.current?.click()}>
            {reading ? "กำลังอ่านไฟล์…" : "เลือกไฟล์ .xlsx"}
          </button>
        </div>
      </section>

      {error && <p className="pk-error">{error}</p>}

      {parsed && rows.length > 0 && (
        <>
          <section className="lh-stats">
            <article>
              <span>รายการที่จะนำเข้า</span>
              <strong>{formatNumber(rows.length)}</strong>
              <small>{dates[0] ?? "—"} ถึง {dates.at(-1) ?? "—"}</small>
            </article>
            <article>
              <span>จ่ายได้ตามแผน</span>
              <strong>{formatNumber(outcomes.issued ?? 0)}</strong>
              <small>ปรับจำนวน {formatNumber(outcomes.adjusted ?? 0)}</small>
            </article>
            <article className={outcomes.refused ? "attn" : ""}>
              <span>ไม่รับของ</span>
              <strong>{formatNumber(outcomes.refused ?? 0)}</strong>
              <small>{formatNumber(((outcomes.refused ?? 0) / rows.length) * 100, 1)}% ของรายการ</small>
            </article>
            <article>
              <span>ยังไม่ปิดงาน (ไม่นำเข้า)</span>
              <strong>{formatNumber(parsed.pending)}</strong>
              <small>ในชีทเขตที่ยังไม่มีสถานะ</small>
            </article>
          </section>

          <section className="lh-grid">
            <article className="panel lh-box">
              <h4>ที่มาและประเภทการเติม</h4>
              <ul>
                {Object.entries(bySource).map(([name, value]) => (
                  <li key={name}><span>{name}</span><b>{formatNumber(value)}</b></li>
                ))}
              </ul>
              <ul>
                {(Object.keys(FILL_LABEL) as Array<keyof typeof FILL_LABEL>).map((key) => (
                  <li key={key}><span>{FILL_LABEL[key]}</span><b>{formatNumber(fills[key] ?? 0)}</b></li>
                ))}
              </ul>
            </article>
            <article className="panel lh-box">
              <h4>เขตที่ไม่รับของบ่อย</h4>
              <ul>
                {refusalsByDistrict.length ? refusalsByDistrict.map(([name, value]) => (
                  <li key={name}><span>{name}</span><b className="dp-accent">{formatNumber(value)}</b></li>
                )) : <li><span>ไม่มี</span></li>}
              </ul>
            </article>
            <article className="panel lh-box">
              <h4>ต้องตรวจ ({formatNumber(Object.values(flagCounts).reduce((sum, value) => sum + value, 0))})</h4>
              <ul>
                {(Object.keys(FLAG_LABELS) as LegacyFlag[]).filter((flag) => flagCounts[flag]).map((flag) => (
                  <li key={flag}>
                    <button type="button" className={flagFilter === flag ? "active" : ""} onClick={() => setFlagFilter(flagFilter === flag ? "all" : flag)}>
                      {FLAG_LABELS[flag]}
                    </button>
                    <b className="dp-accent">{formatNumber(flagCounts[flag])}</b>
                  </li>
                ))}
              </ul>
              <small className="dp-muted">รายการเหล่านี้นำเข้าได้ และติดป้ายไว้ให้ตรวจภายหลัง</small>
            </article>
          </section>

          {flagged.length > 0 && (
            <section className="panel">
              <div className="panel-title">
                <div><span>รายการที่ต้องตรวจ</span><h3>{flagFilter === "all" ? "ทุกประเภท" : FLAG_LABELS[flagFilter]}</h3></div>
                <b>{formatNumber(flagged.length)} รายการ</b>
              </div>
              <div className="live-table-wrap">
                <table className="live-table">
                  <thead>
                    <tr>
                      <th>ชีท · แถว</th><th>เขต</th><th>พัสดุ</th><th>วันแผน</th><th>วันจ่ายจริง</th>
                      <th>แผน</th><th>จ่ายจริง</th><th>สถานะ</th><th>ประเด็น</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flagged.slice(0, 60).map((row) => (
                      <tr key={`${row.source_sheet}-${row.source_row}`}>
                        <td>{row.source_sheet}<small>แถว {row.source_row}</small></td>
                        <td>{row.district_name}</td>
                        <td><strong>{row.material_id}</strong><small>{row.material_name}</small></td>
                        <td>{row.plan_date ?? "—"}</td>
                        <td>{row.actual_date ?? "—"}</td>
                        <td>{row.planned_qty === null ? "—" : formatNumber(row.planned_qty)}</td>
                        <td>{row.issued_qty === null ? "—" : formatNumber(row.issued_qty)}</td>
                        <td>{OUTCOME_LABEL[row.outcome]}</td>
                        <td>{row.review_flags.map((flag) => <span key={flag} className="pk-status estimate">{FLAG_LABELS[flag]}</span>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {flagged.length > 60 && <p className="pk-empty">แสดง 60 รายการแรก</p>}
            </section>
          )}

          <section className="panel lh-confirm">
            <label className="dr-ack">
              <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
              <span>
                ตรวจแล้ว นำเข้า {formatNumber(rows.length)} รายการจากไฟล์ {fileName}
                (รายการที่ติดป้ายจะถูกเก็บพร้อมป้ายเพื่อให้ตรวจภายหลัง)
              </span>
            </label>
            <div>
              {sending && <span className="dp-muted">กำลังส่ง {formatNumber(progress)} / {formatNumber(rows.length)}</span>}
              {result && (
                <span className="dp-good">
                  ✓ เพิ่มใหม่ {formatNumber(result.inserted)} · อัปเดต {formatNumber(result.updated)}
                  {result.skipped ? ` · ข้าม ${formatNumber(result.skipped)}` : ""}
                  {demoMode ? " (โหมดตัวอย่าง ไม่บันทึกฐานข้อมูล)" : ""}
                </span>
              )}
              <button type="button" className="btn primary" disabled={!ack || sending || !rows.length} onClick={() => void send()}>
                นำเข้าประวัติ {formatNumber(rows.length)} รายการ
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
