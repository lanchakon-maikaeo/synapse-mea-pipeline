import type { RecordRow } from "./use-synapse-backend";

// Which contracts a plan line is issued from: the plan's FIFO guidance (M29),
// oldest lot first, cut to the quantity actually issued.

export type ContractPart = {
  contract: string; // contract number, "ใบสั่ง <PO>", or "ยอดยกมา" / "ไม่ระบุ"
  purchase_order: string;
  line_item: string;
  quantity: number;
  kind: string; // contract / released / unknown / rest
};

type GuidanceLot = {
  lot_kind?: string;
  contract_number?: string | null;
  purchase_order?: string | null;
  line_item?: string | null;
  quantity?: number | string | null;
};

export function contractLabel(lot: GuidanceLot) {
  if (lot.lot_kind === "unknown") return "ยอดยกมา (ไม่ทราบสัญญา)";
  if (lot.contract_number) return String(lot.contract_number);
  if (lot.purchase_order) return `ใบสั่ง ${lot.purchase_order}`;
  return "ไม่ระบุสัญญา";
}

export function contractSplit(row: RecordRow, quantity: number): ContractPart[] {
  const lots = (Array.isArray(row.fifo_guidance) ? row.fifo_guidance : []) as GuidanceLot[];
  const parts: ContractPart[] = [];
  let left = Math.max(0, quantity);
  lots
    .filter((lot) => lot.lot_kind !== "short")
    .forEach((lot) => {
      if (left <= 0) return;
      const take = Math.min(left, Number(lot.quantity ?? 0));
      if (!(take > 0)) return;
      const label = contractLabel(lot);
      const same = parts.find((part) => part.contract === label && part.purchase_order === String(lot.purchase_order ?? ""));
      if (same) same.quantity += take;
      else
        parts.push({
          contract: label,
          purchase_order: String(lot.purchase_order ?? ""),
          line_item: String(lot.line_item ?? ""),
          quantity: take,
          kind: String(lot.lot_kind ?? "contract"),
        });
      left -= take;
    });
  if (left > 0) {
    parts.push({
      contract: lots.length ? "เกินที่ FIFO จองไว้" : "ยังไม่มี FIFO",
      purchase_order: "",
      line_item: "",
      quantity: left,
      kind: "rest",
    });
  }
  return parts;
}
