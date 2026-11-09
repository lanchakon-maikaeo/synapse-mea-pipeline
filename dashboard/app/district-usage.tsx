"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";
import { RULE_LABELS, UsageBars, monthLabel } from "./usage-bars";
import { downloadXlsx, type Cell } from "./xlsx-writer";

// การใช้งานรายเขต (M31): monthly usage, dispatch history (ไฟล์คลังคลองเตย +
// SYNAPSE) and the recommendation from real usage, per district and material.

type Suggestion = {
  rule: string;
  qty: number | null;
  reason: string;
  months_used?: number;
  typical?: number | null;
  cmp_adjusted?: number | null;
  usage_12m?: number[];
  usage_labels?: string[];
};

type UsageRow = {
  district_id: string;
  district_name: string | null;
  material_id: string;
  material_name: string | null;
  unit: string | null;
  is_vmi: boolean;
  district_stock_qty: number | null;
  cmp_monthly: number | null;
  months_available: number | null;
  kt_stock_qty: number;
  issued_lines: number;
  issued_qty: number;
  last_issued: string | null;
  refused_lines: number;
  last_refusal: string | null;
  district_requests: number;
  suggestion: Suggestion;
};

type HistoryRow = {
  source: string;
  district_id: string;
  district_name: string | null;
  material_id: string;
  material_name: string | null;
  plan_date: string | null;
  actual_date: string | null;
  plan_qty: number | null;
  actual_qty: number | null;
  unit: string | null;
  lot_size: string | null;
  status: string;
  fill_type: string | null;
  note: string | null;
  rejected_by: string | null;
  reference: string | null;
};

type DistrictSummary = {
  district_id: string;
  district_name: string;
  issued_lines: number;
  refused_lines: number;
  district_requests: number;
  materials: number;
  first_date: string | null;
  last_date: string | null;
};

type Filter = "all" | "issued" | "refused" | "requests" | "regular" | "occasional" | "rare";

const FILTERS: Array<[Filter, string]> = [
  ["all", "ทั้งหมด"],
  ["issued", "มีประวัติจ่าย"],
  ["refused", "เคยไม่รับของ"],
  ["requests", "เขตแจ้งใช้"],
  ["regular", "ใช้สม่ำเสมอ"],
  ["occasional", "ใช้เป็นครั้งคราว"],
  ["rare", "ใช้ครั้งเดียว / ไม่ใช้"],
];

const thai = (value: string | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });
};

const num = (value: unknown) => (value === null || value === undefined || value === "" ? null : Number(value));

export function DistrictUsageView({
  token,
  role,
  ownDistrict,
  demoMode,
}: {
  token: string | null;
  role: string;
  ownDistrict: string | null;
  demoMode: boolean;
}) {
  const [summary, setSummary] = useState<DistrictSummary[]>([]);
  const [district, setDistrict] = useState(ownDistrict ?? "5501");
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<UsageRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [exporting, setExporting] = useState("");

  const loadSummary = useCallback(async () => {
    if (demoMode || !token) return;
    try {
      setSummary(await apiRequest<DistrictSummary[]>("/v1/district-usage/summary", token));
    } catch {
      setSummary([]);
    }
  }, [demoMode, token]);

  const load = useCallback(async () => {
    if (demoMode || !token) return;
    setLoading(true);
    setError("");
    try {
      setRows(await apiRequest<UsageRow[]>(`/v1/district-usage?district_id=${encodeURIComponent(district)}`, token));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [demoMode, district, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSummary(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSummary]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFocus(null);
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const openRow = async (row: UsageRow) => {
    setFocus(row);
    setHistory([]);
    if (!token) return;
    setHistoryLoading(true);
    try {
      setHistory(await apiRequest<HistoryRow[]>(
        `/v1/district-usage/history?district_id=${encodeURIComponent(row.district_id)}&material_id=${encodeURIComponent(row.material_id)}`,
        token,
      ));
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const visible = useMemo(() => {
    const needle = deferred.trim().toLowerCase();
    return rows.filter((row) => {
      const rule = row.suggestion?.rule;
      if (filter === "issued" && !row.issued_lines) return false;
      if (filter === "refused" && !row.refused_lines) return false;
      if (filter === "requests" && !row.district_requests) return false;
      if (filter === "regular" && rule !== "regular") return false;
      if (filter === "occasional" && rule !== "occasional") return false;
      if (filter === "rare" && rule !== "once" && rule !== "none") return false;
      if (!needle) return true;
      return [row.material_id, row.material_name].some((value) => String(value ?? "").toLowerCase().includes(needle));
    });
  }, [deferred, filter, rows]);

  const totals = useMemo(() => ({
    materials: rows.length,
    issuedLines: rows.reduce((sum, row) => sum + row.issued_lines, 0),
    refusedLines: rows.reduce((sum, row) => sum + row.refused_lines, 0),
    requests: rows.reduce((sum, row) => sum + row.district_requests, 0),
    regular: rows.filter((row) => row.suggestion?.rule === "regular").length,
    occasional: rows.filter((row) => row.suggestion?.rule === "occasional").length,
  }), [rows]);

  const noLegacy = summary.length > 0 && summary.every((item) => !item.issued_lines && !item.refused_lines);
  const districtName = summary.find((item) => item.district_id === district)?.district_name
    ?? rows[0]?.district_name ?? district;

  const usageRows = (list: UsageRow[]): Cell[][] => {
    const labels = list.find((row) => row.suggestion?.usage_labels?.length)?.suggestion.usage_labels ?? [];
    return [
      ["เขต", "ชื่อเขต", "รหัสพัสดุ", "รายการพัสดุ", "หน่วย", "VMI", ...labels.map(monthLabel),
        "รูปแบบการใช้", "CMP (ไฟล์)", "CMP ปรับ", "Stock เขต", "ใช้ได้ (เดือน)", "Stock คลองเตย",
        "จ่ายแล้ว (ครั้ง)", "จ่ายแล้ว (จำนวน)", "จ่ายล่าสุด", "ไม่รับของ (ครั้ง)", "เหตุผลไม่รับล่าสุด",
        "เขตแจ้งใช้ (ครั้ง)", "แนะนำ", "เหตุผล"],
      ...list.map((row) => [
        row.district_id, row.district_name, row.material_id, row.material_name, row.unit, row.is_vmi ? "ใช่" : "",
        ...labels.map((_, index) => num(row.suggestion?.usage_12m?.[index])),
        RULE_LABELS[row.suggestion?.rule] ?? row.suggestion?.rule, num(row.cmp_monthly), num(row.suggestion?.cmp_adjusted),
        num(row.district_stock_qty), num(row.months_available), num(row.kt_stock_qty),
        row.issued_lines, num(row.issued_qty), row.last_issued, row.refused_lines, row.last_refusal,
        row.district_requests, num(row.suggestion?.qty), row.suggestion?.reason,
      ]),
    ];
  };

  const historyRows = (list: HistoryRow[]): Cell[][] => [
    ["แหล่งข้อมูล", "เขต", "ชื่อเขต", "รหัสพัสดุ", "รายการพัสดุ", "แผนวันที่จ่าย", "วันที่จ่ายจริง",
      "จำนวนตามแผน", "จำนวนที่จ่ายจริง", "หน่วย", "Lot Size", "สถานะ", "ประเภทการเติม", "หมายเหตุ",
      "ผู้ยืนยันไม่รับ", "อ้างอิง"],
    ...list.map((row) => [
      row.source, row.district_id, row.district_name, row.material_id, row.material_name, row.plan_date,
      row.actual_date, num(row.plan_qty), num(row.actual_qty), row.unit, row.lot_size, row.status,
      row.fill_type, row.note, row.rejected_by, row.reference,
    ]),
  ];

  const exportExcel = async (scope: "district" | "all") => {
    if (!token) return;
    setExporting(scope);
    setError("");
    try {
      const target = scope === "all" ? "all" : district;
      const [usage, hist] = await Promise.all([
        scope === "all"
          ? apiRequest<UsageRow[]>("/v1/district-usage?district_id=all", token)
          : Promise.resolve(rows),
        apiRequest<HistoryRow[]>(`/v1/district-usage/history?district_id=${encodeURIComponent(target)}`, token),
      ]);
      const stamp = new Date().toISOString().slice(0, 10);
      const sheets = [
        { name: "สรุปรายการ", rows: usageRows(usage), widths: [7, 14, 15, 40, 8, 6] },
        { name: "ประวัติการจ่าย", rows: historyRows(hist), widths: [16, 7, 14, 15, 40, 12, 12, 12, 12, 8, 14, 14, 14, 30, 20, 20] },
      ];
      if (scope === "all") {
        sheets.unshift({
          name: "สรุปรายเขต",
          rows: [
            ["เขต", "ชื่อเขต", "จ่ายแล้ว (รายการ)", "ไม่รับของ (รายการ)", "เขตแจ้งใช้ (รายการ)", "จำนวนรหัส", "ตั้งแต่", "ถึง"],
            ...summary.map((item) => [item.district_id, item.district_name, item.issued_lines, item.refused_lines,
              item.district_requests, item.materials, item.first_date, item.last_date]),
          ],
          widths: [7, 16, 16, 16, 16, 12, 12, 12],
        });
      }
      downloadXlsx(scope === "all" ? `การใช้งานรายเขต_ทั้ง18เขต_${stamp}` : `การใช้งาน_เขต${districtName}_${stamp}`, sheets);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "ส่งออก Excel ไม่สำเร็จ");
    } finally {
      setExporting("");
    }
  };

  return (
    <section className="du-page">
      <header className="du-head">
        <div>
          <span className="eyebrow">การใช้งานรายเขต</span>
          <h2>ยอดใช้จริง · ประวัติการจ่าย · ยอดแนะนำ</h2>
          <p>
            ยอดใช้รายเดือนจากไฟล์อัตราการใช้ล่าสุด และประวัติการจ่ายจากไฟล์คลังคลองเตยรวมกับที่จ่ายผ่าน SYNAPSE ·
            ยอดแนะนำคิดจากการใช้จริงของเขต ถ้า Stock คลองเตยไม่พอจะแสดงว่าขาดเท่าไหร่
          </p>
        </div>
        <div className="du-actions">
          <button type="button" className="btn ghost" disabled={!token || Boolean(exporting) || !rows.length}
            onClick={() => void exportExcel("district")}>
            {exporting === "district" ? "กำลังสร้างไฟล์…" : `Excel เขต${districtName}`}
          </button>
          {role !== "district" && (
            <button type="button" className="btn primary" disabled={!token || Boolean(exporting)}
              onClick={() => void exportExcel("all")}>
              {exporting === "all" ? "กำลังสร้างไฟล์ (ทั้ง 18 เขต)…" : "Excel ทั้ง 18 เขต"}
            </button>
          )}
        </div>
      </header>

      {noLegacy && (
        <div className="du-notice">
          ตัวเลข “จ่าย 0 · ไม่รับ 0” เพราะยังไม่ได้นำเข้าประวัติการจ่ายจากระบบเดิม · นำเข้าไฟล์คลังคลองเตย
          (ชีท History และชีท 18 เขต) ได้ที่เมนู <b>นำเข้าข้อมูล → ประวัติจากระบบเดิม</b> แล้วตัวเลขจะขึ้นทันที
        </div>
      )}
      {error && <div className="du-error" role="alert">{error}</div>}

      {role !== "district" && summary.length > 0 && (
        <div className="du-districts">
          {summary.map((item) => (
            <button
              type="button"
              key={item.district_id}
              className={item.district_id === district ? "active" : ""}
              onClick={() => setDistrict(item.district_id)}
            >
              <small>{item.district_id}</small>
              <b>{item.district_name}</b>
              <span>
                จ่าย {formatNumber(item.issued_lines)} · ไม่รับ {formatNumber(item.refused_lines)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="du-tiles">
        {[
          ["รหัสพัสดุ", totals.materials],
          ["ใช้สม่ำเสมอ", totals.regular],
          ["ใช้เป็นครั้งคราว", totals.occasional],
          ["จ่ายแล้ว (รายการ)", totals.issuedLines],
          ["ไม่รับของ (รายการ)", totals.refusedLines],
          ["เขตแจ้งใช้ (รายการ)", totals.requests],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <span>{label}</span>
            <strong>{formatNumber(Number(value))}</strong>
          </div>
        ))}
      </div>

      <div className="du-filters">
        {FILTERS.map(([key, label]) => (
          <button type="button" key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
        <input type="search" placeholder="ค้นหารหัส / ชื่อพัสดุ" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div className="du-body">
        <div className="du-table-wrap">
          {loading ? (
            <p className="du-empty">กำลังโหลด…</p>
          ) : visible.length ? (
            <table className="du-table">
              <thead>
                <tr>
                  <th>พัสดุ</th>
                  <th>ยอดใช้ 12 เดือน</th>
                  <th>รูปแบบ</th>
                  <th>CMP</th>
                  <th>Stock เขต</th>
                  <th>Stock คลองเตย</th>
                  <th>จ่ายแล้ว</th>
                  <th>ไม่รับ</th>
                  <th>✦ แนะนำ</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={`${row.district_id}-${row.material_id}`}
                    className={focus?.material_id === row.material_id ? "focused" : ""}
                    onClick={() => void openRow(row)}
                  >
                    <td>
                      <strong>{row.material_id}</strong>
                      <small>{row.material_name ?? "—"}</small>
                    </td>
                    <td>
                      <UsageBars compact values={row.suggestion?.usage_12m ?? []} labels={row.suggestion?.usage_labels ?? []} />
                    </td>
                    <td><span className={`du-rule ${row.suggestion?.rule ?? ""}`}>{RULE_LABELS[row.suggestion?.rule] ?? "—"}</span></td>
                    <td>{formatNumber(row.cmp_monthly ?? 0)}</td>
                    <td>{formatNumber(row.district_stock_qty ?? 0)}</td>
                    <td>{formatNumber(row.kt_stock_qty)}</td>
                    <td>
                      {row.issued_lines ? `${formatNumber(row.issued_lines)} ครั้ง · ${formatNumber(row.issued_qty)}` : "—"}
                      {row.last_issued && <small>ล่าสุด {thai(row.last_issued)}</small>}
                    </td>
                    <td>
                      {row.refused_lines ? <b className="du-bad">{formatNumber(row.refused_lines)} ครั้ง</b> : "—"}
                      {row.last_refusal && <small>{row.last_refusal}</small>}
                    </td>
                    <td className="du-suggest">
                      <strong>{row.suggestion?.qty === null || row.suggestion?.qty === undefined ? "—" : formatNumber(row.suggestion.qty)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="du-empty">ไม่มีรายการตามตัวกรองนี้</p>
          )}
        </div>

        <aside className="du-detail">
          {focus ? (
            <>
              <span className="eyebrow">{focus.district_id} · {focus.district_name}</span>
              <h3>{focus.material_id}</h3>
              <p className="du-name">{focus.material_name}</p>
              <UsageBars values={focus.suggestion?.usage_12m ?? []} labels={focus.suggestion?.usage_labels ?? []} />
              <div className="du-reco">
                <span>✦ แนะนำ</span>
                <strong>
                  {focus.suggestion?.qty === null || focus.suggestion?.qty === undefined ? "—" : formatNumber(focus.suggestion.qty)}{" "}
                  {focus.unit ?? ""}
                </strong>
                <p>{focus.suggestion?.reason}</p>
              </div>
              <dl className="du-metrics">
                <div><dt>CMP (ไฟล์)</dt><dd>{formatNumber(focus.cmp_monthly ?? 0)}</dd></div>
                <div><dt>CMP ปรับ</dt><dd>{focus.suggestion?.cmp_adjusted == null ? "—" : formatNumber(focus.suggestion.cmp_adjusted)}</dd></div>
                <div><dt>Stock เขต</dt><dd>{formatNumber(focus.district_stock_qty ?? 0)}</dd></div>
                <div><dt>Stock คลองเตย</dt><dd>{formatNumber(focus.kt_stock_qty)}</dd></div>
              </dl>
              <h4>ประวัติการจ่าย</h4>
              {historyLoading ? (
                <p className="du-empty">กำลังโหลด…</p>
              ) : history.length ? (
                <ul className="du-history">
                  {history.map((item, index) => (
                    <li key={`${item.plan_date}-${index}`} className={item.status === "ไม่รับของ" ? "refused" : ""}>
                      <b>{thai(item.plan_date)}</b>
                      <span>
                        {item.status} · {formatNumber(item.actual_qty ?? item.plan_qty ?? 0)} {item.unit ?? ""}
                        {item.fill_type ? ` · ${item.fill_type}` : ""}
                      </span>
                      {item.note && <small>{item.note}</small>}
                      <small className="du-source">{item.source}{item.reference ? ` · ${item.reference}` : ""}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="du-empty">ยังไม่มีประวัติการจ่ายรายการนี้ให้เขตนี้</p>
              )}
            </>
          ) : (
            <p className="du-empty">กดที่รายการเพื่อดูยอดใช้รายเดือนและประวัติการจ่าย</p>
          )}
        </aside>
      </div>
    </section>
  );
}
