// Material-centric summary of the four imported files.
//
// Everything is keyed on the 12-digit material code:
//   Stock (Khlong Toei 2401/0001)  → quantity on hand
//   อัตราการใช้งาน                  → CMP per district
//   รวมสัญญา                       → contract installments (PO + รายการที่ = งวด)
//   รับเข้า 105                     → receipts, linked to an installment by
//                                     PO + material + รายการ (= งวด)
//
// Quantities are only added within one material, and an installment is only
// compared with its receipts when both use the same unit; a unit difference is
// reported instead of being converted.

type Payload = Record<string, unknown>;

export type SummaryInput = {
  stock: Payload[];
  contracts: Payload[];
  receipts: Payload[];
  usage: Payload[];
};

export type InstallmentStatus = "complete" | "accepted" | "partial" | "pending" | "overdue" | "unit_mismatch";

export type InstallmentSummary = {
  purchaseOrder: string;
  installment: string;
  contractNumber: string;
  quantity: number;
  unit: string;
  deliveryDate: string;
  acceptanceDate: string;
  receivedQty: number;
  receiptCount: number;
  lastReceiptDate: string;
  status: InstallmentStatus;
};

export const DISTRICT_NAMES: Record<string, string> = {
  "5501": "เขตนวลจันทร์", "5502": "เขตสามเสน", "5503": "เขตนนทบุรี", "5504": "เขตธนบุรี",
  "5505": "เขตบางใหญ่", "5506": "เขตลาดกระบัง", "5507": "เขตบางนา", "5508": "เขตวัดเลียบ",
  "5509": "เขตคลองเตย", "5510": "เขตราษฎร์บูรณะ", "5511": "เขตยานนาวา", "5512": "เขตบางขุนเทียน",
  "5513": "เขตบางบัวทอง", "5514": "เขตบางกะปิ", "5515": "เขตสมุทรปราการ", "5516": "เขตบางพลี",
  "5517": "เขตมีนบุรี", "5518": "เขตบางเขน",
};

export type DistrictUsage = {
  districtId: string;
  districtName: string;
  plant: string;
  cmp: number;
  ly: number;
  avg12: number;
  avg6: number;
  avg4: number;
};

export type MaterialSummary = {
  material: string;
  name: string;
  unit: string;
  inStock: boolean;
  stockQty: number;
  districtCount: number;
  cmpTotal: number;
  districts: DistrictUsage[];
  monthsOfCover: number | null;
  purchaseOrders: number;
  installments: InstallmentSummary[];
  contractQty: number;
  receiptCount: number;
  receivedQty: number;
  unmatchedReceipts: number;
  lastReceiptDate: string;
  flags: string[];
};

export type SummaryTotals = {
  materials: number;
  materialsInStock: number;
  materialsWithUsage: number;
  materialsWithContracts: number;
  materialsWithReceipts: number;
  installments: number;
  complete: number;
  accepted: number;
  partial: number;
  pending: number;
  overdue: number;
  unitMismatch: number;
  receipts: number;
  matchedReceipts: number;
  unmatchedReceipts: number;
};

const text = (value: unknown) => String(value ?? "").trim();
const num = (value: unknown) => {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const digits = (value: unknown) => text(value).replace(/^0+(?=\d)/, "");

export function materialCode(value: unknown): string {
  const cleaned = text(value);
  if (!/^\d+$/.test(cleaned)) return cleaned;
  const significant = cleaned.replace(/^0+(?=\d)/, "");
  return significant.length <= 12 ? significant.padStart(12, "0") : cleaned;
}

export function buildMaterialSummary(input: SummaryInput, today = new Date().toISOString().slice(0, 10)) {
  const materials = new Map<string, MaterialSummary>();
  const entry = (code: string): MaterialSummary => {
    let found = materials.get(code);
    if (!found) {
      found = {
        material: code, name: "", unit: "", inStock: false, stockQty: 0, districtCount: 0,
        cmpTotal: 0, districts: [], monthsOfCover: null, purchaseOrders: 0, installments: [], contractQty: 0,
        receiptCount: 0, receivedQty: 0, unmatchedReceipts: 0, lastReceiptDate: "", flags: [],
      };
      materials.set(code, found);
    }
    return found;
  };

  for (const row of input.stock) {
    const isWarehouse = text(row.warehouse_id) === "WH-KT" ||
      (text(row.sap_plant_code) === "2401" && text(row.storage_location_code) === "0001");
    if (!isWarehouse) continue;
    const item = entry(materialCode(row.material_id));
    item.inStock = true;
    item.stockQty += num(row.unrestricted_qty);
    item.name ||= text(row.material_name);
    item.unit ||= text(row.base_unit);
  }

  // Usage stays per district; the total is only a convenience next to it.
  for (const row of input.usage) {
    const districtId = text(row.district_id);
    if (!districtId) continue;
    const cmp = num(row.cmp_monthly);
    const summaries = [row.avg_ly, row.avg_12m, row.avg_6m, row.avg_4m];
    const raw = [row.avg_ly_raw, row.avg_12m_raw, row.avg_6m_raw, row.avg_4m_raw];
    const pick = (index: number) => num(summaries[index] ?? raw[index]);
    if (cmp <= 0 && [0, 1, 2, 3].every((index) => pick(index) <= 0)) continue;
    const item = entry(materialCode(row.material_id));
    item.districts.push({
      districtId,
      districtName: DISTRICT_NAMES[districtId] ?? "",
      plant: text(row.sap_plant_code),
      cmp,
      ly: pick(0),
      avg12: pick(1),
      avg6: pick(2),
      avg4: pick(3),
    });
    if (cmp > 0) {
      item.districtCount += 1;
      item.cmpTotal += cmp;
    }
  }

  const installmentIndex = new Map<string, InstallmentSummary>();
  const ordersByMaterial = new Map<string, Set<string>>();
  for (const row of input.contracts) {
    const code = materialCode(row.material_code);
    if (!code) continue;
    const item = entry(code);
    item.name ||= text(row.item_description);
    item.unit ||= text(row.unit);
    const installment: InstallmentSummary = {
      purchaseOrder: text(row.purchase_order),
      installment: digits(row.line_item),
      contractNumber: text(row.contract_number),
      quantity: num(row.quantity),
      unit: text(row.unit),
      deliveryDate: text(row.delivery_date).slice(0, 10),
      acceptanceDate: text(row.acceptance_date).slice(0, 10),
      receivedQty: 0,
      receiptCount: 0,
      lastReceiptDate: "",
      status: "pending",
    };
    item.installments.push(installment);
    item.contractQty += installment.quantity;
    installmentIndex.set(`${digits(row.purchase_order)}|${code}|${installment.installment}`, installment);
    const orders = ordersByMaterial.get(code) ?? new Set<string>();
    orders.add(digits(row.purchase_order));
    ordersByMaterial.set(code, orders);
  }

  let matchedReceipts = 0;
  let unmatchedReceipts = 0;
  for (const row of input.receipts) {
    const code = materialCode(row.material_code);
    if (!code) continue;
    const item = entry(code);
    item.name ||= text(row.item_description);
    item.unit ||= text(row.unit);
    const quantity = num(row.quantity);
    const posted = text(row.posting_date).slice(0, 10);
    item.receiptCount += 1;
    item.receivedQty += quantity;
    if (posted > item.lastReceiptDate) item.lastReceiptDate = posted;
    const installmentNo = text(row.po_item) || (text(row.source_layout) ? "" : text(row.item));
    const installment = installmentIndex.get(`${digits(row.purchase_order)}|${code}|${digits(installmentNo)}`);
    if (!installment) {
      item.unmatchedReceipts += 1;
      unmatchedReceipts += 1;
      continue;
    }
    matchedReceipts += 1;
    installment.receiptCount += 1;
    installment.receivedQty += quantity;
    if (posted > installment.lastReceiptDate) installment.lastReceiptDate = posted;
    if (text(row.unit) && installment.unit && text(row.unit) !== installment.unit) {
      installment.status = "unit_mismatch";
    }
  }

  const totals: SummaryTotals = {
    materials: 0, materialsInStock: 0, materialsWithUsage: 0, materialsWithContracts: 0,
    materialsWithReceipts: 0, installments: 0, complete: 0, accepted: 0, partial: 0, pending: 0, overdue: 0,
    unitMismatch: 0, receipts: input.receipts.length, matchedReceipts, unmatchedReceipts,
  };

  for (const item of materials.values()) {
    item.purchaseOrders = ordersByMaterial.get(item.material)?.size ?? 0;
    item.monthsOfCover = item.inStock && item.cmpTotal > 0 ? item.stockQty / item.cmpTotal : null;
    for (const installment of item.installments) {
      if (installment.status !== "unit_mismatch") {
        installment.status = installment.receivedQty >= installment.quantity && installment.quantity > 0
          ? "complete"
          : installment.receivedQty > 0
            ? "partial"
            // Accepted in the contract file but its 105 receipt lies outside
            // the 105 export's date range: finished, evidence elsewhere.
            : installment.acceptanceDate
              ? "accepted"
              : installment.deliveryDate && installment.deliveryDate < today ? "overdue" : "pending";
      }
      totals.installments += 1;
      if (installment.status === "complete") totals.complete += 1;
      else if (installment.status === "accepted") totals.accepted += 1;
      else if (installment.status === "partial") totals.partial += 1;
      else if (installment.status === "overdue") totals.overdue += 1;
      else if (installment.status === "unit_mismatch") totals.unitMismatch += 1;
      else totals.pending += 1;
    }
    item.districts.sort((left, right) => left.districtId.localeCompare(right.districtId));
    item.installments.sort((left, right) =>
      left.purchaseOrder.localeCompare(right.purchaseOrder) ||
      Number(left.installment) - Number(right.installment));
    if (item.installments.some((installment) => installment.status === "overdue")) item.flags.push("overdue");
    if (item.installments.some((installment) => installment.status === "unit_mismatch")) item.flags.push("unit_mismatch");
    if (item.unmatchedReceipts) item.flags.push("receipt_without_contract");
    if (item.inStock && item.cmpTotal === 0) item.flags.push("no_usage");
    totals.materials += 1;
    if (item.inStock) totals.materialsInStock += 1;
    if (item.cmpTotal > 0) totals.materialsWithUsage += 1;
    if (item.installments.length) totals.materialsWithContracts += 1;
    if (item.receiptCount) totals.materialsWithReceipts += 1;
  }

  const rows = [...materials.values()].sort((left, right) =>
    Number(right.inStock) - Number(left.inStock) ||
    right.installments.length - left.installments.length ||
    left.material.localeCompare(right.material));
  return { rows, totals };
}
