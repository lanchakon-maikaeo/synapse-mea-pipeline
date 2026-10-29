"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";
import type { RecordRow } from "./use-synapse-backend";

// ข้อมูล Packing: one simple form per received lot (material + PO), filled by
// warehouse staff. Box and pallet dimensions feed truck loading later.

type PackingStatus = "missing" | "estimate" | "verified";

type Lot = {
  material_id: string;
  material_name: string;
  unit: string;
  purchase_order: string;
  contract_no: string;
  vendor_name: string;
  received_qty: number | null;
  receipt_lines: number | null;
  last_receipt: string | null;
  acceptance_date: string | null;
  needed_soon: boolean;
  packing_status: PackingStatus;
  profile: RecordRow | null;
};

type Form = {
  kind: string;
  units: string;
  boxL: string;
  boxW: string;
  boxH: string;
  boxKg: string;
  onPallet: boolean;
  perLayer: string;
  layers: string;
  palletL: string;
  palletW: string;
  loadH: string;
  palletKg: string;
  source: "measured" | "document" | "estimate";
  note: string;
};

const KINDS: Array<{ key: string; label: string; type: string }> = [
  { key: "box", label: "กล่อง", type: "BOX" },
  { key: "crate", label: "ลัง", type: "CRATE" },
  { key: "sack", label: "กระสอบ", type: "BUNDLE" },
  { key: "bundle", label: "มัด / ขด / ม้วน", type: "BUNDLE" },
  { key: "long", label: "ชิ้นยาว (ท่อ/เสา)", type: "LONG_MATERIAL" },
  { key: "loose", label: "ชิ้นเปล่า ไม่มีบรรจุภัณฑ์", type: "LOOSE" },
  { key: "pallet", label: "มาทั้งพาเลท", type: "FULL_PALLET" },
];

const SOURCES: Array<{ key: Form["source"]; label: string; note: string }> = [
  { key: "measured", label: "วัดจริง", note: "วัด/ชั่งจากของที่รับเข้า" },
  { key: "document", label: "ตามเอกสารผู้ขาย", note: "สเปกในสัญญา/ใบส่งของ" },
  { key: "estimate", label: "ประมาณการ", note: "ยังไม่ได้วัด ใช้ชั่วคราว" },
];

const STATUS_LABEL: Record<PackingStatus, string> = {
  missing: "ยังไม่มี Packing",
  estimate: "ประมาณการ",
  verified: "ยืนยันแล้ว",
};

const emptyForm: Form = {
  kind: "box", units: "", boxL: "", boxW: "", boxH: "", boxKg: "",
  onPallet: true, perLayer: "", layers: "", palletL: "", palletW: "", loadH: "",
  palletKg: "", source: "measured", note: "",
};

const num = (value: string) => {
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const fmtDate = (value: string | null) => (value ? value.slice(0, 10) : "—");

function formFromProfile(profile: RecordRow | null): Form {
  if (!profile) return { ...emptyForm };
  const type = text(profile.package_type);
  const reference = text(profile.source_reference);
  const kind = KINDS.find((item) => reference.includes(`[${item.label}]`))?.key
    ?? KINDS.find((item) => item.type === type)?.key ?? "box";
  return {
    kind,
    units: text(profile.units_per_package),
    boxL: text(profile.box_length_cm),
    boxW: text(profile.box_width_cm),
    boxH: text(profile.box_height_cm),
    boxKg: text(profile.box_gross_weight_kg),
    onPallet: Boolean(profile.boxes_per_layer || profile.boxes_per_pallet || profile.pallet_length_m),
    perLayer: text(profile.boxes_per_layer),
    layers: text(profile.stack_layers),
    palletL: text(profile.pallet_length_m),
    palletW: text(profile.pallet_width_m),
    loadH: text(profile.load_height_m),
    palletKg: text(profile.pallet_tare_kg),
    source: profile.assumption_status === "VERIFIED"
      ? reference.includes("ตามเอกสาร") ? "document" : "measured"
      : "estimate",
    note: reference.replace(/^\[[^\]]*\]\s*/, "").replace(/^(วัดจริง|ตามเอกสารผู้ขาย|ประมาณการ)\s*·?\s*/, ""),
  };
}

function calculate(form: Form) {
  const units = num(form.units);
  const boxVolume = (num(form.boxL) * num(form.boxW) * num(form.boxH)) / 1_000_000;
  const boxKg = num(form.boxKg);
  const perPallet = form.onPallet ? Math.floor(num(form.perLayer) * num(form.layers)) : 0;
  const unitsPerPallet = perPallet * units;
  const palletGross = perPallet && boxKg ? num(form.palletKg) + perPallet * boxKg : 0;
  const palletVolume = num(form.palletL) * num(form.palletW) * num(form.loadH);
  return { units, boxVolume, boxKg, perPallet, unitsPerPallet, palletGross, palletVolume };
}

function missingFields(form: Form) {
  const missing: string[] = [];
  if (!num(form.units)) missing.push("จำนวนชิ้นต่อหน่วยบรรจุ");
  if (form.kind !== "loose" && form.kind !== "long") {
    if (!num(form.boxL) || !num(form.boxW) || !num(form.boxH)) missing.push("ขนาด กว้าง×ยาว×สูง");
  }
  if (!num(form.boxKg)) missing.push("น้ำหนักต่อหน่วยบรรจุ");
  if (form.onPallet) {
    if (!num(form.perLayer) || !num(form.layers)) missing.push("จำนวนต่อชั้น / จำนวนชั้น");
    if (!num(form.palletL) || !num(form.palletW)) missing.push("ขนาดพาเลท");
    if (!num(form.loadH)) missing.push("ความสูงรวมบนพาเลท");
  }
  return missing;
}

export function PackingEntryView({
  token,
  role,
  demoMode,
  demoRows,
}: {
  token: string | null;
  role: string;
  demoMode: boolean;
  demoRows: RecordRow[];
}) {
  const canEdit = role === "admin" || role === "picker";
  const [lots, setLots] = useState<Lot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"todo" | "needed" | PackingStatus | "all">("todo");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Lot | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedKey, setSavedKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (demoMode || !token) {
        const seen = new Map<string, Lot>();
        demoRows.forEach((row, index) => {
          const key = `${text(row.material_id)}|${text(row.purchase_order)}`;
          if (!text(row.material_id) || seen.has(key)) return;
          seen.set(key, {
            material_id: text(row.material_id),
            material_name: text(row.item_description ?? row.material_name),
            unit: text(row.unit) || "EA",
            purchase_order: text(row.purchase_order),
            contract_no: text(row.contract_number),
            vendor_name: text(row.vendor_name) || "SUP-UNKNOWN",
            received_qty: Number(row.quantity ?? 0) || null,
            receipt_lines: 1,
            last_receipt: text(row.acceptance_date) || null,
            acceptance_date: text(row.acceptance_date) || null,
            needed_soon: index % 2 === 0,
            packing_status: "missing",
            profile: null,
          });
        });
        setLots((current) => (current.length ? current : [...seen.values()]));
      } else {
        const rows = await apiRequest<Lot[]>("/v1/packing/worklist", token);
        setLots(Array.isArray(rows) ? rows : []);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "โหลดรายการไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [demoMode, demoRows, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const counts = useMemo(() => ({
    needed: lots.filter((lot) => lot.needed_soon && lot.packing_status !== "verified").length,
    missing: lots.filter((lot) => lot.packing_status === "missing").length,
    estimate: lots.filter((lot) => lot.packing_status === "estimate").length,
    verified: lots.filter((lot) => lot.packing_status === "verified").length,
  }), [lots]);

  const visible = lots.filter((lot) => {
    if (filter === "todo" && lot.packing_status === "verified") return false;
    if (filter === "needed" && !(lot.needed_soon && lot.packing_status !== "verified")) return false;
    if (["missing", "estimate", "verified"].includes(filter) && lot.packing_status !== filter) return false;
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return [lot.material_id, lot.material_name, lot.vendor_name, lot.contract_no, lot.purchase_order]
      .join(" ").toLowerCase().includes(term);
  });

  const siblings = editing
    ? lots.filter((lot) => lot.material_id === editing.material_id
        && lot.purchase_order !== editing.purchase_order && lot.profile)
    : [];

  const open = (lot: Lot) => {
    setEditing(lot);
    setForm(formFromProfile(lot.profile));
    setSaveError("");
  };
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const result = calculate(form);
  const missing = missingFields(form);
  const kind = KINDS.find((item) => item.key === form.kind) ?? KINDS[0];
  const containerWord = form.kind === "pallet" ? "พาเลท" : kind.label.split(" ")[0];

  const save = async () => {
    if (!editing) return;
    if (!num(form.units)) {
      setSaveError("กรอกจำนวนชิ้นต่อหน่วยบรรจุก่อน");
      return;
    }
    const sourceLabel = SOURCES.find((item) => item.key === form.source)?.label ?? "";
    const profile = {
      material_id: editing.material_id,
      vendor_name: editing.vendor_name,
      contract_no: editing.contract_no,
      purchase_order: editing.purchase_order,
      package_type: kind.type,
      units_per_package: num(form.units),
      box_length_cm: num(form.boxL) || null,
      box_width_cm: num(form.boxW) || null,
      box_height_cm: num(form.boxH) || null,
      box_gross_weight_kg: num(form.boxKg) || null,
      boxes_per_layer: form.onPallet ? num(form.perLayer) || null : null,
      stack_layers: form.onPallet ? num(form.layers) || null : null,
      boxes_per_pallet: result.perPallet || null,
      units_per_pallet: result.unitsPerPallet || null,
      pallet_length_m: form.onPallet ? num(form.palletL) || null : null,
      pallet_width_m: form.onPallet ? num(form.palletW) || null : null,
      load_height_m: form.onPallet ? num(form.loadH) || null : null,
      pallet_tare_kg: form.onPallet && form.palletKg !== "" ? Number(form.palletKg) || 0 : null,
      calculated_pallet_gross_kg: result.palletGross || null,
      assumption_status: form.source === "estimate" ? "TEMPORARY_ESTIMATE" : "VERIFIED",
      source_reference: `[${kind.label}] ${sourceLabel}${form.note.trim() ? ` · ${form.note.trim()}` : ""}`,
    };
    setSaving(true);
    setSaveError("");
    try {
      if (!demoMode && token) {
        await apiRequest("/v1/packing/profiles", token, {
          method: "POST",
          body: JSON.stringify({ profile }),
        });
      }
      const status: PackingStatus = form.source === "estimate" ? "estimate" : "verified";
      setLots((current) => current.map((lot) =>
        lot.material_id === editing.material_id && lot.purchase_order === editing.purchase_order
          ? { ...lot, packing_status: status, profile: { ...profile, package_type: kind.type } }
          : lot));
      setSavedKey(`${editing.material_id}|${editing.purchase_order}`);
      setEditing(null);
      if (!demoMode && token) void load();
    } catch (saveFailure) {
      setSaveError(saveFailure instanceof Error ? saveFailure.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof Form, label: string, unit: string, step = "any") => (
    <label className="pk-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={String(form[key])}
          onChange={(event) => set(key, event.target.value as never)}
        />
        <em>{unit}</em>
      </div>
    </label>
  );

  return (
    <div className="stack pk-page">
      <section className="pk-summary">
        {([
          ["needed", "ต้องใช้เร็ว", "อยู่ในแผนจ่ายที่เปิดอยู่ แต่ยังไม่ยืนยัน Packing", counts.needed],
          ["missing", "ยังไม่มี Packing", "รับเข้าแล้ว (105) ยังไม่กรอก", counts.missing],
          ["estimate", "ประมาณการ", "กรอกแล้วแต่ยังไม่ได้วัด/ตรวจเอกสาร", counts.estimate],
          ["verified", "ยืนยันแล้ว", "วัดจริงหรือตามเอกสารผู้ขาย", counts.verified],
        ] as Array<[typeof filter, string, string, number]>).map(([key, label, note, value]) => (
          <button
            key={key}
            type="button"
            className={`pk-stat ${key} ${filter === key ? "active" : ""}`}
            onClick={() => setFilter(filter === key ? "todo" : key)}
          >
            <span>{label}</span>
            <strong>{formatNumber(value)}</strong>
            <small>{note}</small>
          </button>
        ))}
      </section>

      <section className="panel pk-list">
        <div className="pk-toolbar">
          <div className="district-filters pk-filters">
            {([
              ["todo", "ต้องกรอก"],
              ["needed", "ต้องใช้เร็ว"],
              ["all", "ทั้งหมด"],
            ] as Array<[typeof filter, string]>).map(([key, label]) => (
              <button key={key} type="button" className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
          <input
            className="pk-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ค้นหารหัสพัสดุ ชื่อ ผู้ขาย สัญญา หรือ PO"
            aria-label="ค้นหา"
          />
        </div>
        {!canEdit && (
          <p className="pk-readonly">สิทธิ์ของคุณดูได้อย่างเดียว · ผู้กรอก Packing คือเจ้าหน้าที่คลังหรือผู้ดูแลระบบ</p>
        )}
        {error && <p className="pk-error">{error}</p>}
        {loading ? (
          <p className="pk-empty">กำลังโหลดรายการรับเข้า…</p>
        ) : visible.length === 0 ? (
          <p className="pk-empty">
            {lots.length
              ? "ไม่มีรายการในกลุ่มนี้"
              : "ยังไม่มีรายการรับเข้า (105) · Import ไฟล์รวมสัญญาและ 105 ที่หน้า Import Data ก่อน"}
          </p>
        ) : (
          <div className="live-table-wrap">
            <table className="live-table pk-table">
              <thead>
                <tr>
                  <th>พัสดุ</th>
                  <th>ผู้ขาย · สัญญา · PO</th>
                  <th>รับเข้า (105)</th>
                  <th>Packing</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 300).map((lot) => {
                  const key = `${lot.material_id}|${lot.purchase_order}`;
                  const profile = lot.profile;
                  return (
                    <tr key={key} className={savedKey === key ? "pk-just-saved" : ""}>
                      <td>
                        <strong>{lot.material_id}</strong>
                        <small>{lot.material_name}</small>
                        {lot.needed_soon && lot.packing_status !== "verified" && (
                          <span className="pk-needed">ต้องใช้เร็ว</span>
                        )}
                      </td>
                      <td>
                        <strong>{lot.vendor_name}</strong>
                        <small>{[lot.contract_no, lot.purchase_order && `PO ${lot.purchase_order}`].filter(Boolean).join(" · ") || "—"}</small>
                      </td>
                      <td>
                        {lot.received_qty !== null && lot.received_qty !== undefined
                          ? `${formatNumber(lot.received_qty)} ${lot.unit}`
                          : "ผ่านตรวจรับ"}
                        <small>
                          {lot.receipt_lines ? `${formatNumber(lot.receipt_lines)} ครั้ง · ` : ""}
                          ล่าสุด {fmtDate(lot.last_receipt ?? lot.acceptance_date)}
                        </small>
                      </td>
                      <td>
                        <span className={`pk-status ${lot.packing_status}`}>{STATUS_LABEL[lot.packing_status]}</span>
                        {profile && (
                          <small>
                            {formatNumber(Number(profile.units_per_package ?? 0))} {lot.unit}/หน่วย
                            {profile.units_per_pallet ? ` · ${formatNumber(Number(profile.units_per_pallet))} ${lot.unit}/พาเลท` : ""}
                          </small>
                        )}
                      </td>
                      <td>
                        {canEdit && (
                          <button type="button" className={lot.packing_status === "verified" ? "btn ghost" : "btn primary"} onClick={() => open(lot)}>
                            {lot.packing_status === "missing" ? "กรอก Packing" : "แก้ไข"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length > 300 && <p className="pk-empty">แสดง 300 รายการแรก · ใช้ช่องค้นหาเพื่อหารายการอื่น</p>}
          </div>
        )}
      </section>

      {editing && (
        <div className="import-review-backdrop" role="dialog" aria-modal="true">
          <div className="import-review-modal pk-modal">
            <header>
              <div>
                <span>กรอก Packing</span>
                <h3>{editing.material_id} · {editing.material_name}</h3>
                <p>
                  {editing.vendor_name} · {editing.contract_no || "ไม่ระบุสัญญา"} · PO {editing.purchase_order || "—"}
                </p>
              </div>
              <button type="button" aria-label="ปิด" onClick={() => setEditing(null)}>×</button>
            </header>

            <div className="pk-body">
              <div className="pk-form">
                {siblings.length > 0 && (
                  <label className="pk-copy">
                    <span>ใช้ค่าจาก PO อื่นของพัสดุนี้ (ผู้ขายเดียวกันมักใช้ Packing เดิม)</span>
                    <select
                      defaultValue=""
                      onChange={(event) => {
                        const source = siblings.find((lot) => lot.purchase_order === event.target.value);
                        if (source) setForm({ ...formFromProfile(source.profile), source: "estimate", note: `คัดลอกจาก PO ${source.purchase_order}` });
                      }}
                    >
                      <option value="">— เลือก PO —</option>
                      {siblings.map((lot) => (
                        <option key={lot.purchase_order} value={lot.purchase_order}>
                          {lot.vendor_name} · PO {lot.purchase_order} · {STATUS_LABEL[lot.packing_status]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <section className="pk-step">
                  <h4><i>1</i> ของมาในรูปแบบไหน</h4>
                  <div className="pk-kinds">
                    {KINDS.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={form.kind === item.key ? "active" : ""}
                        onClick={() => set("kind", item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div className="pk-grid one">
                    {field("units", `จำนวนต่อ 1 ${containerWord}`, editing.unit || "ชิ้น")}
                  </div>
                </section>

                <section className="pk-step">
                  <h4><i>2</i> ขนาดและน้ำหนักของ 1 {containerWord}</h4>
                  <div className="pk-grid">
                    {field("boxL", "ยาว", "ซม.")}
                    {field("boxW", "กว้าง", "ซม.")}
                    {field("boxH", "สูง", "ซม.")}
                    {field("boxKg", "น้ำหนักรวม", "กก.")}
                  </div>
                </section>

                <section className="pk-step">
                  <h4>
                    <i>3</i> การวางบนพาเลท
                    <label className="pk-toggle">
                      <input type="checkbox" checked={form.onPallet} onChange={(event) => set("onPallet", event.target.checked)} />
                      วางบนพาเลท
                    </label>
                  </h4>
                  {form.onPallet ? (
                    <>
                      <div className="pk-grid">
                        {field("perLayer", `${containerWord}ต่อชั้น`, containerWord, "1")}
                        {field("layers", "จำนวนชั้น", "ชั้น", "1")}
                        {field("loadH", "ความสูงรวม (รวมพาเลท)", "ม.")}
                        {field("palletKg", "น้ำหนักพาเลทเปล่า", "กก.")}
                      </div>
                      <div className="pk-pallet-size">
                        <span>ขนาดพาเลท</span>
                        {[["1.2", "1.0"], ["1.1", "1.1"], ["1.2", "0.8"]].map(([l, w]) => (
                          <button
                            key={`${l}x${w}`}
                            type="button"
                            className={form.palletL === l && form.palletW === w ? "active" : ""}
                            onClick={() => setForm((current) => ({ ...current, palletL: l, palletW: w }))}
                          >
                            {l} × {w} ม.
                          </button>
                        ))}
                        <div className="pk-grid two">
                          {field("palletL", "ยาว", "ม.")}
                          {field("palletW", "กว้าง", "ม.")}
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="pk-hint">ไม่วางบนพาเลท: ระบบจะคำนวณพื้นที่บนรถจากขนาดของแต่ละ{containerWord}</p>
                  )}
                </section>

                <section className="pk-step">
                  <h4><i>4</i> ข้อมูลนี้มาจากไหน</h4>
                  <div className="pk-sources">
                    {SOURCES.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={`${form.source === item.key ? "active" : ""} ${item.key}`}
                        onClick={() => set("source", item.key)}
                      >
                        <b>{item.label}</b>
                        <small>{item.note}</small>
                      </button>
                    ))}
                  </div>
                  <label className="pk-note">
                    <span>หมายเหตุ (ไม่บังคับ)</span>
                    <input value={form.note} maxLength={300} onChange={(event) => set("note", event.target.value)} placeholder="เช่น วัดจากล็อต 12 ต.ค. / ผู้วัด" />
                  </label>
                </section>
              </div>

              <aside className="pk-preview">
                <span>สรุปที่ระบบคำนวณให้</span>
                <div className="pk-preview-box">
                  <strong>1 {containerWord}</strong>
                  <p>{result.units ? `${formatNumber(result.units)} ${editing.unit}` : "—"}</p>
                  <p>{result.boxKg ? `${formatNumber(result.boxKg, 1)} กก.` : "— กก."} · {result.boxVolume ? `${formatNumber(result.boxVolume, 3)} ม³` : "— ม³"}</p>
                </div>
                {form.onPallet && (
                  <div className="pk-preview-box pallet">
                    <strong>1 พาเลท</strong>
                    <p>{result.perPallet ? `${formatNumber(result.perPallet)} ${containerWord}` : "—"} · {result.unitsPerPallet ? `${formatNumber(result.unitsPerPallet)} ${editing.unit}` : "—"}</p>
                    <p>{result.palletGross ? `หนักรวม ${formatNumber(result.palletGross, 0)} กก.` : "น้ำหนักรวม —"}</p>
                    <p>{result.palletVolume ? `${formatNumber(result.palletVolume, 2)} ม³ บนรถ` : "ปริมาตร —"}</p>
                  </div>
                )}
                {editing.received_qty ? (
                  <div className="pk-preview-box">
                    <strong>ล็อตนี้รับเข้า {formatNumber(editing.received_qty)} {editing.unit}</strong>
                    <p>
                      {result.units ? `≈ ${formatNumber(Math.ceil(editing.received_qty / result.units))} ${containerWord}` : ""}
                      {result.unitsPerPallet ? ` · ${formatNumber(Math.ceil(editing.received_qty / result.unitsPerPallet))} พาเลท` : ""}
                    </p>
                  </div>
                ) : null}
                {missing.length > 0 ? (
                  <div className="pk-missing">
                    <b>ยังขาด (บันทึกได้ แต่จัดรถจะยังคำนวณไม่ครบ)</b>
                    <ul>{missing.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                ) : (
                  <div className="pk-complete">✓ ข้อมูลครบ ใช้คำนวณจัดรถได้</div>
                )}
              </aside>
            </div>

            <footer className="dr-footer">
              <span className={saveError ? "dp-bad" : "dp-muted"}>
                {saveError || (demoMode ? "โหมดตัวอย่าง: ไม่บันทึกฐานข้อมูล" : "บันทึกแล้วใช้กับทุกล็อตของ PO นี้")}
              </span>
              <div>
                <button type="button" className="btn ghost" onClick={() => setEditing(null)}>ยกเลิก</button>
                <button type="button" className="btn primary" disabled={saving || !num(form.units)} onClick={() => void save()}>
                  {saving ? "กำลังบันทึก…" : "บันทึก Packing"}
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
