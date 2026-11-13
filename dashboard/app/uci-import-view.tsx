"use client";

import { useMemo, useState } from "react";
import { apiRequest, formatNumber } from "./lib";
import { readAllWorksheets } from "./sap-xlsx";
import { parseCsv, parseLotSize, passedAwaiting105, readUciMatrix, type ParsedLot, type UciRow } from "./uci-import";

type WorkLot = {
  material_id: string;
  purchase_order: string;
  contract_no: string;
  vendor_name: string;
  profile: Record<string, unknown> | null;
};
type ContractLot = {
  material_id: string;
  material_name: string | null;
  unit: string | null;
  purchase_order: string;
  contract_number: string | null;
  line_item: string;
  quantity: number | null;
  received_qty: number;
  status: string;
};

type PackPlan = {
  key: string;
  row: UciRow;
  lot: ParsedLot | null;
  lotText: string;
  manual: boolean;
  vendor: string;
  purchase_order: string;
  state: "new" | "update" | "same" | "measured" | "unparsed";
};
type ReleasePlan = { row: UciRow; lot: ContractLot | null; qty: number; why: string };

const UCI_TAG = "UCI";

function sourceText(plan: PackPlan) {
  const inner = plan.lot?.inner ? ` · ด้านใน ${plan.lot.inner}` : "";
  const fixed = plan.manual ? ` (แก้จาก: ${plan.row.lot_size})` : "";
  return `[${plan.lot!.label}] ตามเอกสารผู้ขาย · ${UCI_TAG}: ${plan.lotText}${inner}${fixed}`.slice(0, 480);
}

export function UciImportView({ token, demoMode }: { token: string | null; demoMode: boolean }) {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<UciRow[]>([]);
  const [work, setWork] = useState<WorkLot[]>([]);
  const [lots, setLots] = useState<ContractLot[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [releasePick, setReleasePick] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"packing" | "release">("packing");
  // Lot Size typed here for rows UCI wrote in a way the reader does not know
  const [fixes, setFixes] = useState<Record<string, string>>({});

  const load = async (file: File) => {
    setError("");
    setDone([]);
    setFailed([]);
    setFileName(file.name);
    setBusy("กำลังอ่านไฟล์…");
    try {
      let matrix: string[][];
      if (/\.csv$/i.test(file.name)) {
        matrix = parseCsv(await file.text());
      } else {
        const sheets = readAllWorksheets(new Uint8Array(await file.arrayBuffer()));
        const sheet = sheets.find((item) => item.name.trim().toUpperCase() === "DATA")
          ?? sheets.find((item) => item.matrix.some((line) => line.some((cell) => /^Lot Size/.test(String(cell ?? "").trim()))));
        if (!sheet) throw new Error("ไม่พบชีต DATA หรือคอลัมน์ Lot Size ในไฟล์นี้");
        matrix = sheet.matrix;
      }
      const parsed = readUciMatrix(matrix);
      if (!parsed.rows.length) throw new Error(`อ่านไม่ได้: ไม่พบคอลัมน์ ${parsed.missing.join(", ")}`);
      setRows(parsed.rows);
      if (token && !demoMode) {
        setBusy("กำลังดึงข้อมูล Packing และสัญญาในระบบ…");
        const [workList, contract] = await Promise.all([
          apiRequest<WorkLot[]>("/v1/packing/worklist", token).catch(() => [] as WorkLot[]),
          apiRequest<{ rows: ContractLot[] }>("/v1/contract-lots?scope=all", token).catch(() => ({ rows: [] as ContractLot[] })),
        ]);
        setWork(workList ?? []);
        setLots(contract.rows ?? []);
      }
    } catch (reason) {
      setRows([]);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const packPlans = useMemo<PackPlan[]>(() => {
    // the latest row per material + contract
    const latest = new Map<string, UciRow>();
    rows.forEach((row) => {
      if (!row.lot_size || !row.contract_no) return;
      latest.set(`${row.material_id}|${row.contract_no}`, row);
    });
    // one profile per receiving lot (PO) the packing page shows for this
    // material + contract, so every lot gets its packing
    return [...latest.entries()].flatMap(([key, row]) => {
      const manual = key in fixes;
      const lotText = manual ? fixes[key] : row.lot_size;
      const lot = parseLotSize(lotText);
      const matches = work.filter((item) => item.material_id === row.material_id && item.contract_no === row.contract_no);
      const targets = matches.length
        ? matches
        : [{ material_id: row.material_id, purchase_order: row.purchase_order, contract_no: row.contract_no, vendor_name: row.vendor, profile: null }];
      return targets.map((target) => {
        const plan: PackPlan = {
          key: `${key}|${target.purchase_order}`,
          row,
          lot,
          lotText,
          manual,
          vendor: target.vendor_name || row.vendor,
          purchase_order: target.purchase_order,
          state: "new",
        };
        const profile = target.profile;
        if (!lot) plan.state = "unparsed";
        else if (profile) {
          const source = String(profile.source_reference ?? "");
          // Lot Size only fills a lot with no packing yet, or one filled from UCI before
          if (!source.includes(UCI_TAG)) plan.state = "measured";
          else if (source === sourceText(plan)) plan.state = "same";
          else plan.state = "update";
        }
        return plan;
      });
    });
  }, [rows, work, fixes]);

  const releasePlans = useMemo<ReleasePlan[]>(() => {
    return rows.filter(passedAwaiting105).map((row) => {
      const candidates = lots.filter((lot) =>
        lot.status === "awaiting_105" && lot.material_id === row.material_id && (lot.contract_number ?? "") === row.contract_no);
      const exact = candidates.length > 1
        ? candidates.filter((lot) => String(Number(lot.line_item)) === String(Number(row.installment)))
        : candidates;
      const lot = exact.length === 1 ? exact[0] : null;
      const open = lot ? Math.max(0, Number(lot.quantity ?? 0) - Number(lot.received_qty ?? 0)) : 0;
      const qty = lot ? Math.min(row.delivered_qty ?? 0, open || (row.delivered_qty ?? 0)) : 0;
      const why = lot ? "" : candidates.length > 1 ? "มีหลายงวดในระบบ จับคู่งวดไม่ได้" : "ไม่พบงวดที่รอ 105 ในระบบ (อาจคีย์ 105 แล้ว)";
      return { row, lot, qty, why };
    });
  }, [rows, lots]);

  const toSave = packPlans.filter((plan) => plan.state === "new" || plan.state === "update");
  const count = (state: PackPlan["state"]) => packPlans.filter((plan) => plan.state === state).length;
  const releasable = releasePlans.filter((plan) => plan.lot && plan.qty > 0);
  const releaseKey = (plan: ReleasePlan) => `${plan.row.material_id}|${plan.lot?.purchase_order}|${plan.lot?.line_item}`;
  const picked = releasable.filter((plan) => releasePick[releaseKey(plan)] !== false);

  const savePacking = async () => {
    if (!token || demoMode) return;
    const ok: string[] = [];
    const bad: string[] = [];
    let index = 0;
    const worker = async () => {
      while (index < toSave.length) {
        const plan = toSave[index++];
        const lot = plan.lot!;
        const boxesPerPallet = lot.units_per_pallet && lot.units_per_package
          ? Math.round(lot.units_per_pallet / lot.units_per_package) || null : null;
        try {
          await apiRequest("/v1/packing/profiles", token, {
            method: "POST",
            body: JSON.stringify({
              profile: {
                material_id: plan.row.material_id,
                vendor_name: plan.vendor,
                contract_no: plan.row.contract_no,
                purchase_order: plan.purchase_order,
                package_type: lot.package_type,
                units_per_package: lot.units_per_package,
                units_per_pallet: lot.units_per_pallet,
                boxes_per_layer: lot.boxes_per_layer,
                stack_layers: lot.stack_layers,
                boxes_per_pallet: lot.boxes_per_layer && lot.stack_layers ? lot.boxes_per_layer * lot.stack_layers : boxesPerPallet,
                assumption_status: "TEMPORARY_ESTIMATE",
                source_reference: sourceText(plan),
              },
            }),
          });
          ok.push(plan.key);
        } catch (reason) {
          bad.push(`${plan.row.material_id} ${plan.row.contract_no}: ${reason instanceof Error ? reason.message : String(reason)}`);
        }
        setBusy(`กำลังบันทึก Packing ${ok.length + bad.length}/${toSave.length}…`);
      }
    };
    setBusy(`กำลังบันทึก Packing 0/${toSave.length}…`);
    await Promise.all([worker(), worker(), worker(), worker()]);
    setDone([`บันทึก Packing ${formatNumber(ok.length)} รายการ`]);
    setFailed(bad);
    setBusy("");
    const workList = await apiRequest<WorkLot[]>("/v1/packing/worklist", token).catch(() => null);
    if (workList) setWork(workList);
  };

  const confirmReleases = async () => {
    if (!token || demoMode) return;
    const ok: string[] = [];
    const bad: string[] = [];
    for (const plan of picked) {
      setBusy(`กำลังยืนยันจ่ายได้ ${ok.length + bad.length + 1}/${picked.length}…`);
      try {
        await apiRequest("/v1/contract-lots/confirm", token, {
          method: "POST",
          body: JSON.stringify({
            material_id: plan.lot!.material_id,
            purchase_order: plan.lot!.purchase_order,
            line_item: plan.lot!.line_item,
            quantity: plan.qty,
            note: `ตาม UCI: ผลทดสอบ ${plan.row.test_result} · ตรวจรับ ${plan.row.accepted_on}`,
          }),
        });
        ok.push(releaseKey(plan));
      } catch (reason) {
        bad.push(`${plan.row.material_id} ${plan.row.contract_no}: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    }
    setDone([`ยืนยันจ่ายได้ ${formatNumber(ok.length)} รายการ · บวกเข้า Stock คลองเตยแล้ว`]);
    setFailed(bad);
    setBusy("");
    const contract = await apiRequest<{ rows: ContractLot[] }>("/v1/contract-lots?scope=all", token).catch(() => null);
    if (contract) setLots(contract.rows ?? []);
  };

  return (
    <div className="stack uci-page">
      <section className="panel lh-intro uci-intro">
        <div>
          <span>อัปโหลดชีต DATA</span>
          <h3>Lot Size → ข้อมูล Packing · ผลทดสอบผ่าน → ยืนยันจ่ายได้</h3>
          <ol className="uci-steps">
            <li><b>1</b>Google Sheets เปิดชีต <strong>DATA</strong> → ไฟล์ → ดาวน์โหลด → <strong>CSV</strong></li>
            <li><b>2</b>เลือกไฟล์ที่ดาวน์โหลดมา</li>
            <li><b>3</b>ตรวจตัวอย่าง แล้วกดบันทึก (ยังไม่บันทึกจนกว่าจะกดปุ่ม)</li>
          </ol>
        </div>
        <div className="lh-intro-actions">
          {fileName && (
            <div className="hero-chip lh-current">
              <span>ไฟล์ที่อ่าน</span>
              <strong>{fileName}</strong>
              <small>{formatNumber(rows.length)} แถว</small>
            </div>
          )}
          <label className="btn primary uci-file">
            {fileName ? "เลือกไฟล์ใหม่" : "เลือกไฟล์ DATA (.csv / .xlsx)"}
            <input
              type="file"
              accept=".csv,.xlsx"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void load(file);
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </section>

      <section className={`panel uci-import${rows.length || busy || error || done.length ? "" : " empty"}`}>
      {busy && <p className="uci-note">{busy}</p>}
      {error && <p className="uci-note bad">{error}</p>}
      {done.map((line) => (
        <p key={line} className="uci-note ok">✓ {line}</p>
      ))}
      {failed.length > 0 && (
        <details className="uci-note bad" open>
          <summary>ไม่สำเร็จ {failed.length} รายการ</summary>
          <ul>{failed.slice(0, 50).map((line) => <li key={line}>{line}</li>)}</ul>
        </details>
      )}

      {rows.length > 0 && (
        <>
          <p className="uci-file-line">
            Lot Size {formatNumber(new Set(packPlans.map((plan) => `${plan.row.material_id}|${plan.row.contract_no}`)).size)} รายการ (รหัส + สัญญา)
          </p>
          <div className="uci-tabs" role="tablist">
            <button type="button" className={tab === "packing" ? "active" : ""} onClick={() => setTab("packing")}>
              Lot Size → Packing ({formatNumber(toSave.length)} จะบันทึก)
            </button>
            <button type="button" className={tab === "release" ? "active" : ""} onClick={() => setTab("release")}>
              ผลทดสอบผ่าน รอ 105 ({formatNumber(releasable.length)} จับคู่ได้)
            </button>
          </div>

          {tab === "packing" ? (
            <>
              <div className="uci-tiles">
                <div><b>{formatNumber(count("new"))}</b><span>ใหม่</span></div>
                <div><b>{formatNumber(count("update"))}</b><span>Lot Size ใน UCI เปลี่ยน · อัปเดต</span></div>
                <div><b>{formatNumber(count("same"))}</b><span>เหมือนเดิม ข้าม</span></div>
                <div><b>{formatNumber(count("measured"))}</b><span>มี Packing ในระบบแล้ว · ไม่ทับ</span></div>
                <div className={count("unparsed") ? "warn" : ""}><b>{formatNumber(count("unparsed"))}</b><span>อ่านไม่ออก</span></div>
              </div>
              <div className="uci-table">
                <table>
                  <thead>
                    <tr><th>รหัส</th><th>สัญญา · งวด</th><th>Lot Size ใน UCI</th><th>ระบบอ่านได้</th><th>สถานะ</th></tr>
                  </thead>
                  <tbody>
                    {[...packPlans]
                      .sort((a, b) => {
                        const rank = (plan: PackPlan) =>
                          plan.manual ? 0 : ["unparsed", "new", "update", "measured", "same"].indexOf(plan.state);
                        return rank(a) - rank(b);
                      })
                      .slice(0, 300)
                      .map((plan) => (
                        <tr key={plan.key} className={plan.state}>
                          <td><strong>{plan.row.material_id}</strong><small>{plan.row.material_name}</small></td>
                          <td>{plan.row.contract_no}<small>งวด {plan.row.installment || "—"}{plan.purchase_order ? ` · PO ${plan.purchase_order}` : ""}</small></td>
                          <td>{plan.row.lot_size}</td>
                          <td>
                            {(plan.manual || plan.state === "unparsed") && (
                              <input
                                className="uci-fix"
                                type="text"
                                value={fixes[`${plan.row.material_id}|${plan.row.contract_no}`] ?? ""}
                                placeholder="พิมพ์ เช่น กล่องละ 50 EA (พาเลทละ 1,000 EA)"
                                onChange={(event) => {
                                  const key = `${plan.row.material_id}|${plan.row.contract_no}`;
                                  const value = event.target.value;
                                  setFixes((current) => {
                                    const next = { ...current };
                                    if (value.trim()) next[key] = value;
                                    else delete next[key];
                                    return next;
                                  });
                                }}
                              />
                            )}
                            {plan.lot ? (
                              <>
                                {plan.lot.word}ละ {formatNumber(plan.lot.units_per_package)}
                                {plan.lot.units_per_pallet ? ` · พาเลทละ ${formatNumber(plan.lot.units_per_pallet)}` : ""}
                                {plan.lot.boxes_per_layer ? ` · ${plan.lot.boxes_per_layer}×${plan.lot.stack_layers} ชั้น` : ""}
                                {plan.lot.inner && <small>ด้านใน {plan.lot.inner}</small>}
                              </>
                            ) : "—"}
                          </td>
                          <td>
                            {{ new: "ใหม่", update: "อัปเดต", same: "เหมือนเดิม", measured: "มี Packing ในระบบแล้ว · ไม่ทับ", unparsed: plan.manual ? "ยังอ่านไม่ออก · ลองเขียนแบบ กล่องละ 50 EA" : "อ่านไม่ออก · พิมพ์ Lot Size ในช่องซ้าย หรือข้ามไปก่อน" }[plan.state]}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {packPlans.length > 300 && <p className="uci-file-line">แสดง 300 แถวแรก (รายการที่อ่านไม่ออกและรายการใหม่ขึ้นก่อน)</p>}
              </div>
              <footer className="uci-actions">
                <small>บันทึกเฉพาะ Lot Size (จำนวนต่อหน่วยบรรจุ · ต่อพาเลท) เป็น “ตามเอกสารผู้ขาย (UCI) · ยังไม่ได้วัดจริง” · ขนาดและน้ำหนักเว้นว่างให้วัดเพิ่ม · รายการที่มี Packing ในระบบแล้วไม่ถูกทับ</small>
                <button type="button" className="btn primary" disabled={!toSave.length || Boolean(busy) || !token || demoMode} onClick={savePacking}>
                  บันทึก Packing {formatNumber(toSave.length)} รายการ
                </button>
              </footer>
            </>
          ) : (
            <>
              <p className="uci-file-line">
                แถวที่ผลทดสอบ “ผ่าน” หรือ “ไม่ทดสอบ” + มีวันตรวจรับ + ยังไม่คีย์ 105 ใน UCI · จับคู่กับงวดในหน้าของเข้าคลังตามสัญญาที่ยังรอ 105
              </p>
              <div className="uci-table">
                <table>
                  <thead>
                    <tr><th></th><th>รหัส</th><th>สัญญา · งวด</th><th>ส่งจริง</th><th>ตรวจรับ · ผลทดสอบ</th><th>ยืนยันจ่ายได้</th></tr>
                  </thead>
                  <tbody>
                    {releasable.map((plan) => {
                      const key = releaseKey(plan);
                      const usable = Boolean(plan.lot && plan.qty > 0);
                      return (
                        <tr key={`${plan.row.row}`} className={usable ? "" : "unparsed"}>
                          <td>
                            <input
                              type="checkbox"
                              disabled={!usable}
                              checked={usable && releasePick[key] !== false}
                              onChange={(event) => setReleasePick((current) => ({ ...current, [key]: event.target.checked }))}
                            />
                          </td>
                          <td><strong>{plan.row.material_id}</strong><small>{plan.row.material_name}</small></td>
                          <td>{plan.row.contract_no}<small>งวด {plan.row.installment || "—"}{plan.lot ? ` · PO ${plan.lot.purchase_order}` : ""}</small></td>
                          <td>{formatNumber(plan.row.delivered_qty ?? 0)} {plan.row.unit}<small>{plan.row.delivered_on}</small></td>
                          <td>{plan.row.accepted_on}<small>{plan.row.test_result}</small></td>
                          <td>{usable ? `${formatNumber(plan.qty)} ${plan.lot?.unit ?? ""}` : <small>{plan.why}</small>}</td>
                        </tr>
                      );
                    })}
                    {!releasable.length && (
                      <tr><td colSpan={6}><small>ไม่มีงวดที่ผ่านทดสอบแล้วและยังรอ 105 ในระบบ</small></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {releasePlans.length > releasable.length && (
                <p className="uci-file-line">
                  อีก {formatNumber(releasePlans.length - releasable.length)} แถวใน UCI ผ่านทดสอบแต่ช่องคีย์ 105 ว่าง
                  และไม่พบงวดที่รอ 105 ในระบบ (ส่วนใหญ่คีย์ 105 ใน SAP แล้ว) — ไม่ต้องทำอะไร
                </p>
              )}
              <footer className="uci-actions">
                <small>ยืนยันแล้วจำนวนจะบวกเข้า Stock คลองเตยทันที (เหมือนกดยืนยันในหน้าของเข้าคลังตามสัญญา) · ยกเลิกได้ที่หน้านั้น</small>
                <button type="button" className="btn primary" disabled={!picked.length || Boolean(busy) || !token || demoMode} onClick={confirmReleases}>
                  ยืนยันจ่ายได้ {formatNumber(picked.length)} รายการ
                </button>
              </footer>
            </>
          )}
        </>
      )}
      </section>
    </div>
  );
}
