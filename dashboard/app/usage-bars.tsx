"use client";

import { formatNumber } from "./lib";

// Monthly usage bars (12 months). Months above 3x the median are marked:
// the recommendation counts them as 3x the median only.
const MONTHS_TH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

export function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return key;
  return `${MONTHS_TH[month - 1]} ${String((year + 543) % 100).padStart(2, "0")}`;
}

export function UsageBars({
  values,
  labels,
  compact = false,
}: {
  values: number[];
  labels: string[];
  compact?: boolean;
}) {
  if (!values.length) return <span className="usage-bars-empty">—</span>;
  const sorted = [...values].sort((a, b) => a - b);
  const median = (sorted[5] + sorted[6]) / 2 || 0;
  const max = Math.max(...values, 1);
  const width = compact ? 120 : 360;
  const height = compact ? 28 : 120;
  const gap = compact ? 2 : 6;
  const bar = (width - gap * (values.length - 1)) / values.length;
  const top = compact ? 2 : 16;
  const bottom = compact ? 0 : 18;
  const plot = height - top - bottom;
  return (
    <svg
      className={compact ? "usage-bars compact" : "usage-bars"}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={values.map((value, index) => `${monthLabel(labels[index] ?? "")} ${formatNumber(value)}`).join(", ")}
    >
      {values.map((value, index) => {
        const h = value > 0 ? Math.max(2, (value / max) * plot) : 1;
        const x = index * (bar + gap);
        const spike = median > 0 && value > 3 * median;
        return (
          <g key={labels[index] ?? index}>
            <title>{`${monthLabel(labels[index] ?? "")}: ${formatNumber(value)}${spike ? " (สูงผิดปกติ)" : ""}`}</title>
            <rect
              x={x}
              y={top + plot - h}
              width={bar}
              height={h}
              rx={compact ? 1 : 3}
              className={value <= 0 ? "zero" : spike ? "spike" : "used"}
            />
            {!compact && value > 0 && (
              <text x={x + bar / 2} y={top + plot - h - 4} textAnchor="middle">
                {formatNumber(value)}
              </text>
            )}
            {!compact && (
              <text x={x + bar / 2} y={height - 4} textAnchor="middle" className="axis">
                {monthLabel(labels[index] ?? "").split(" ")[0]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export const RULE_LABELS: Record<string, string> = {
  regular: "ใช้สม่ำเสมอ",
  occasional: "ใช้เป็นครั้งคราว",
  once: "ใช้ครั้งเดียว",
  none: "ไม่มีการใช้",
  no_usage: "ไม่มีข้อมูลการใช้",
};

// Recommendation from the district's real usage (M31); the old MAX fill when
// the usage file has nothing for this line
export function recommendedQty(row: Record<string, unknown>): number {
  const ai = row.ai_qty;
  return ai !== null && ai !== undefined && ai !== "" ? Number(ai) : Number(row.suggested_qty ?? 0);
}
