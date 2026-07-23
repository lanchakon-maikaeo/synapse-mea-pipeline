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

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

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
