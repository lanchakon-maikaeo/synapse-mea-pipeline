"use client";

import { useState } from "react";
import { formatNumber } from "./lib";

// ส่งแผนให้เขต: the last check before the planner's own selection replaces the
// system proposal on the server plan and goes out to the districts.

export type PlannerSelectionLine = {
  replenishment_item_id: string | null;
  district_id: string;
  district_name_th: string;
  material_id: string;
  material_name: string;
  quantity: number;
  system_quantity: number | null;
  source: "system" | "added";
  reason: string;
};

export type PlannerSelectionDrop = {
  replenishment_item_id: string;
  district_id: string;
  district_name_th: string;
  material_id: string;
  material_name: string;
  system_quantity: number;
  reason: string;
};

export type PlannerSelectionPayload = {
  lines: PlannerSelectionLine[];
  dropped: PlannerSelectionDrop[];
};

type Props = {
  planLabel: string;
  weekLabel: string;
  payload: PlannerSelectionPayload;
  unconfirmedDistricts: string[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: () => void;
};

export function PlanSubmitModal({
  planLabel,
  weekLabel,
  payload,
  unconfirmedDistricts,
  busy,
  error,
  onClose,
  onSubmit,
}: Props) {
  const [ack, setAck] = useState(false);
  const [open, setOpen] = useState("");
  const districts = [
    ...new Set([
      ...payload.lines.map((line) => line.district_id),
      ...payload.dropped.map((line) => line.district_id),
    ]),
  ].sort();
  const changed = payload.lines.filter(
    (line) =>
      line.source === "system" &&
      line.system_quantity !== null &&
      line.system_quantity !== line.quantity,
  );
  const added = payload.lines.filter((line) => line.source === "added");
  const total = payload.lines.reduce((sum, line) => sum + line.quantity, 0);
  const systemTotal =
    payload.lines.reduce((sum, line) => sum + (line.system_quantity ?? 0), 0) +
    payload.dropped.reduce((sum, line) => sum + line.system_quantity, 0);
  const sendDistricts = new Set(payload.lines.map((line) => line.district_id)).size;

  return (
    <div className="import-review-backdrop" role="dialog" aria-modal="true">
      <div className="import-review-modal district-review ps-modal">
        <header>
          <div>
            <span>ส่งแผนให้เขตยืนยัน</span>
            <h3>
              {planLabel} · {weekLabel}
            </h3>
            <p>
              รายการด้านล่างจะแทนที่ข้อเสนอของระบบในแผนนี้ แล้วส่งให้แต่ละเขตยืนยันทีละรายการ
            </p>
          </div>
          <button type="button" aria-label="ปิด" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="dr-body">
          <div className="dr-stats ps-stats">
            <div>
              <span>ส่งให้เขต</span>
              <strong>{formatNumber(sendDistricts)}</strong>
              <small>เขต · {formatNumber(payload.lines.length)} รายการ</small>
            </div>
            <div>
              <span>จำนวนจ่ายรวม</span>
              <strong>{formatNumber(total, 0)}</strong>
              <small>ระบบเสนอ {formatNumber(systemTotal, 0)} หน่วย</small>
            </div>
            <div>
              <span>ปรับจำนวนจากระบบ</span>
              <strong className={changed.length ? "dp-warn" : ""}>
                {formatNumber(changed.length)}
              </strong>
              <small>รายการ</small>
            </div>
            <div>
              <span>เพิ่มเอง</span>
              <strong className={added.length ? "dp-accent" : ""}>
                {formatNumber(added.length)}
              </strong>
              <small>รายการ</small>
            </div>
            <div>
              <span>ระบบเสนอแต่ไม่ส่ง</span>
              <strong className={payload.dropped.length ? "dp-bad" : ""}>
                {formatNumber(payload.dropped.length)}
              </strong>
              <small>รายการ · ยกเลิกในแผน</small>
            </div>
          </div>

          {unconfirmedDistricts.length > 0 && (
            <section className="dr-section warn">
              <h4>เขตที่ยังไม่ได้กดยืนยันในหน้าคำนวณ ({unconfirmedDistricts.length})</h4>
              <p className="dp-muted">
                {unconfirmedDistricts.join(" · ")} — จะส่งตามที่เลือกไว้ตอนนี้
              </p>
            </section>
          )}

          <div className="live-table-wrap">
            <table className="live-table ps-table">
              <thead>
                <tr>
                  <th>การไฟฟ้าเขต</th>
                  <th>ส่ง (รายการ)</th>
                  <th>จำนวนรวม</th>
                  <th>ปรับจำนวน</th>
                  <th>เพิ่มเอง</th>
                  <th>ไม่ส่ง</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {districts.map((id) => {
                  const lines = payload.lines.filter((line) => line.district_id === id);
                  const dropped = payload.dropped.filter((line) => line.district_id === id);
                  const name = lines[0]?.district_name_th ?? dropped[0]?.district_name_th ?? "";
                  const isOpen = open === id;
                  return [
                    <tr key={id} className={isOpen ? "open" : ""}>
                      <td>
                        <strong>{id}</strong>
                        <small>{name}</small>
                      </td>
                      <td>{formatNumber(lines.length)}</td>
                      <td>{formatNumber(lines.reduce((s, l) => s + l.quantity, 0), 0)}</td>
                      <td className={changed.some((l) => l.district_id === id) ? "dp-warn" : "dp-muted"}>
                        {formatNumber(changed.filter((l) => l.district_id === id).length)}
                      </td>
                      <td className={lines.some((l) => l.source === "added") ? "dp-accent" : "dp-muted"}>
                        {formatNumber(lines.filter((l) => l.source === "added").length)}
                      </td>
                      <td className={dropped.length ? "dp-bad" : "dp-muted"}>
                        {formatNumber(dropped.length)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="table-action"
                          onClick={() => setOpen(isOpen ? "" : id)}
                        >
                          {isOpen ? "ซ่อน ▴" : "ดูรายการ ▾"}
                        </button>
                      </td>
                    </tr>,
                    isOpen && (
                      <tr key={`${id}-detail`} className="dc-detail">
                        <td colSpan={7}>
                          <table className="dc-lines">
                            <thead>
                              <tr>
                                <th>พัสดุ</th>
                                <th>ระบบเสนอ</th>
                                <th>ส่งให้เขต</th>
                                <th>หมายเหตุ</th>
                              </tr>
                            </thead>
                            <tbody>
                              {lines.map((line) => (
                                <tr key={`${line.material_id}-s`}>
                                  <td>
                                    <strong>{line.material_id}</strong>
                                    <small>{line.material_name}</small>
                                  </td>
                                  <td>
                                    {line.system_quantity === null
                                      ? "—"
                                      : formatNumber(line.system_quantity, 0)}
                                  </td>
                                  <td>
                                    <strong>{formatNumber(line.quantity, 0)}</strong>
                                  </td>
                                  <td>
                                    {line.source === "added" ? (
                                      <span className="dc-line changed">
                                        เพิ่มเอง · {line.reason || "ไม่ระบุเหตุผล"}
                                      </span>
                                    ) : line.system_quantity !== line.quantity ? (
                                      <span className="dc-line changed">ปรับจำนวน</span>
                                    ) : (
                                      <span className="dc-line confirmed">ตามระบบ</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                              {dropped.map((line) => (
                                <tr key={`${line.material_id}-d`} className="ps-dropped">
                                  <td>
                                    <strong>{line.material_id}</strong>
                                    <small>{line.material_name}</small>
                                  </td>
                                  <td>{formatNumber(line.system_quantity, 0)}</td>
                                  <td>—</td>
                                  <td>
                                    <span className="dc-line rejected">
                                      ไม่ส่ง · {line.reason}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>

          <label className="dr-ack">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />
            <span>
              ตรวจแล้ว ส่ง {formatNumber(payload.lines.length)} รายการให้{" "}
              {formatNumber(sendDistricts)} เขตยืนยัน และยกเลิก{" "}
              {formatNumber(payload.dropped.length)} รายการที่ระบบเสนอแต่ไม่ได้เลือก
            </span>
          </label>
          {error && <p className="dp-bad">{error}</p>}
        </div>

        <footer className="dr-footer">
          <span className="dp-muted">
            หลังส่งแล้ว แก้ไขรายการได้โดยออกแผนเวอร์ชันใหม่ หรือให้เขตขอเปลี่ยนจำนวน
          </span>
          <div>
            <button type="button" className="btn ghost" onClick={onClose}>
              ← กลับไปแก้
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !ack || payload.lines.length === 0}
              onClick={onSubmit}
            >
              ส่งแผนให้ {formatNumber(sendDistricts)} เขตยืนยัน →
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
