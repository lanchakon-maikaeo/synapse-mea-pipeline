export type VmiDemandPoint = {
  period: string;
  demand_quantity: number;
  stockout_days: number;
  lead_time_days?: number;
};

export type VmiInputPayload = {
  material_id: string;
  district_id: string;
  snapshot_at: string;
  current_stock: number;
  source_note: string;
  history: VmiDemandPoint[];
  run_replenishment: boolean;
};

export type ForecastRunPayload = {
  training_end: string;
  training_start?: string;
  horizon_months: number;
};

export type RouteJobPayload = {
  replenishment_plan_id: string;
  forecast_run_id?: string;
  matrix_source: "valhalla";
};

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const datePattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isIsoDate(value: string) {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function toLocalDateInput(value: Date = new Date()) {
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function toLocalDateTimeInput(value: Date = new Date()) {
  if (!Number.isFinite(value.getTime())) return "";
  const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function parseVmiHistory(
  input: string,
  currentPeriod = toLocalDateInput().slice(0, 7),
): VmiDemandPoint[] {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3 || lines.length > 36) {
    throw new Error("Demand history ต้องมี 3–36 เดือน");
  }

  const history = lines.map((line, index) => {
    const values = line.split(",").map((value) => value.trim());
    if (values.length < 2 || values.length > 4) {
      throw new Error(
        `บรรทัด ${index + 1}: ใช้รูปแบบ YYYY-MM,จำนวน[,stockout_days,lead_time_days]`,
      );
    }
    const [period, quantity, stockout = "0", leadTime = ""] = values;
    const demandQuantity = Number(quantity);
    if (
      !monthPattern.test(period) ||
      quantity === "" ||
      !Number.isFinite(demandQuantity) ||
      demandQuantity < 0
    ) {
      throw new Error(
        `บรรทัด ${index + 1}: ใช้รูปแบบ YYYY-MM,จำนวน[,stockout_days,lead_time_days]`,
      );
    }
    if (period > currentPeriod) {
      throw new Error(`บรรทัด ${index + 1}: เดือนของ Demand ต้องไม่อยู่ในอนาคต`);
    }

    const stockoutDays = stockout === "" ? 0 : Number(stockout);
    if (
      !Number.isInteger(stockoutDays) ||
      stockoutDays < 0 ||
      stockoutDays > 31
    ) {
      throw new Error(`บรรทัด ${index + 1}: stockout_days ต้องเป็น 0–31`);
    }

    const point: VmiDemandPoint = {
      period,
      demand_quantity: demandQuantity,
      stockout_days: stockoutDays,
    };
    if (leadTime !== "") {
      const leadTimeDays = Number(leadTime);
      if (!Number.isFinite(leadTimeDays) || leadTimeDays < 0) {
        throw new Error(`บรรทัด ${index + 1}: lead_time_days ต้องไม่ติดลบ`);
      }
      point.lead_time_days = leadTimeDays;
    }
    return point;
  });

  if (new Set(history.map((row) => row.period)).size !== history.length) {
    throw new Error("Demand history มีเดือนซ้ำ");
  }
  return history;
}

export function snapshotIso(value: string, now: Date = new Date()) {
  if (!value) throw new Error("กรุณาระบุ Snapshot time");
  const snapshot = new Date(value);
  if (!Number.isFinite(snapshot.getTime())) {
    throw new Error("Snapshot time ไม่ถูกต้อง");
  }
  if (snapshot.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("Snapshot time ต้องไม่อยู่ในอนาคต");
  }
  return snapshot.toISOString();
}

export function createForecastRunPayload(
  trainingStart: string,
  trainingEnd: string,
  horizon: string,
  today = toLocalDateInput(),
): ForecastRunPayload {
  if (!isIsoDate(trainingEnd)) {
    throw new Error("Training end ไม่ถูกต้อง");
  }
  if (trainingEnd > today) {
    throw new Error("Training end ต้องไม่อยู่ในอนาคต");
  }
  if (
    trainingStart &&
    !isIsoDate(trainingStart)
  ) {
    throw new Error("Training start ไม่ถูกต้อง");
  }
  if (trainingStart && trainingStart > trainingEnd) {
    throw new Error("Training start ต้องไม่เกิน Training end");
  }
  const horizonMonths = Number(horizon);
  if (
    !Number.isInteger(horizonMonths) ||
    horizonMonths < 1 ||
    horizonMonths > 24
  ) {
    throw new Error("Horizon ต้องเป็นจำนวนเต็ม 1–24 เดือน");
  }
  return {
    training_end: trainingEnd,
    ...(trainingStart ? { training_start: trainingStart } : {}),
    horizon_months: horizonMonths,
  };
}
