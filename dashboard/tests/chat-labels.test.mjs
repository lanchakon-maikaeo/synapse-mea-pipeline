import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { columnLabel, valueLabel } from '../app/api/chat/labels.mjs';
import { renderToolResult } from '../app/api/chat/tools.mjs';
import { fixtureDatabase } from '../evals/fixture.mjs';

// The 739 columns ops.chat_sources listed on 2026-11-26; refresh this file when the catalog grows.
const CATALOG = readFileSync(new URL('./chat-catalog-columns.txt', import.meta.url), 'utf8').split(/\s+/).filter(Boolean);
// Codes and units a Thai reader knows by their English names.
const KEPT = new Set(['SKU', 'PO', 'CMP', 'HU', 'Lot', 'SAP', 'VMI', 'FIFO', 'MOQ', 'SHA', 'SHA-256', 'OSM', 'WAPE', 'MAE', 'GeoJSON',
  'Git', 'URL', 'SQLSTATE', 'X', 'Y', 'Plant']);
const english = label => (label.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []).filter(word => !KEPT.has(word));

test('every column the chat can read has a Thai name', async () => {
  const { rpc } = fixtureDatabase({ role: 'admin' });
  const discovered = await rpc('vmi_chat_database', { p_tool: 'discover_database', p_args: { query: '' } });
  const fixture = (discovered.data ?? []).flatMap(source => Object.keys(source.columns ?? {}));
  // A name is Thai words, or a code a Thai reader knows (material_id is SKU).
  const unnamed = [...new Set([...CATALOG, ...fixture])].filter(column => columnLabel(column) === column || english(columnLabel(column)).length);
  assert.deepEqual(unnamed, []);
  assert.ok(CATALOG.length > 700 && fixture.length > 20);
});

test('a row reads as a short Thai summary: its name or number, its status, then what was asked', () => {
  assert.equal(renderToolResult({ status: 'ok', tool: 'query_database', source_id: 'analytics.v_replenishment_queue', data: [{
    plan_number: 'KT01-W47-000214', plan_status: 'pending_district_confirmation', requester_name: null, special_approval_required: false,
    abnormal_signals: ['stockout'], reviewed_by: 'u-1', sum_final_qty: 4600 }] }),
  // Empty fields are left out, an aggregate comes before other fields, and a row shows at most four.
  '• KT01-W47-000214 · รอเขตยืนยัน · ผลรวมจำนวนสุดท้าย: 4600 · ต้องขออนุมัติพิเศษ: ไม่ใช่');
  // A code is translated only in a column that stores codes: a material named "critical" stays as written.
  assert.equal(valueLabel('material_name', 'critical'), 'critical');
  assert.equal(valueLabel('health_band', 'critical'), 'วิกฤต');
});

test('near matches name what was searched and show each row by its number, status and latest event', () => {
  const plan = (number, status, times) => ({ status: status, created_at: times[0], updated_at: times[1], approved_at: null, plan_number: number,
    cancelled_at: times[2] ?? null, planner_approved_at: null, technical_approved_at: null, id: 'c57fa2a9-80d7-4cc3-9b4c-64d2a4c7d65e' });
  assert.equal(renderToolResult({ status: 'no_data', tool: 'query_database', source_id: 'core.replenishment_plans', data: [],
    query: { search: null, filters: [{ column: 'plan_number', operator: 'eq', value: 'KT03-W46-091169-V1' }] },
    near_matches: [plan('KT03-W46-091169', 'pending_district_confirmation', ['2026-11-11T05:45:53.953168+00:00', '2026-11-11T05:45:53.953168+00:00']),
      { ...plan('KT02-W46-091169', 'cancelled', ['2026-11-09T04:09:15.763608+00:00', '2026-11-11T04:23:11.966718+00:00', '2026-11-11T04:23:11.966718+00:00']), match_score: 0.8 }] }),
  ['ไม่พบรายการที่ตรงกับ “KT03-W46-091169-V1” รายการที่ใกล้เคียงมีดังนี้',
    '• KT03-W46-091169 · รอเขตยืนยัน · สร้างเมื่อ 11 พ.ย. 2569 12:45',
    '• KT02-W46-091169 · ยกเลิก · ยกเลิกเมื่อ 11 พ.ย. 2569 11:23'].join('\n'));
});

test('a stored timestamp reads as a Thai date in Bangkok time', () => {
  assert.equal(renderToolResult({ status: 'ok', tool: 'query_database', source_id: 'core.replenishment_plans', data: [{
    plan_number: 'KT03-W46-091169', created_at: '2026-11-11T05:45:53.953168+00:00', delivery_date: '2026-11-11', approved_at: null }] }),
  '• KT03-W46-091169 · วันที่ส่งมอบ: 11 พ.ย. 2569 · สร้างเมื่อ 11 พ.ย. 2569 12:45');
  // A time with no zone could be any zone, so it stays as stored.
  assert.equal(valueLabel('created_at', '2026-11-11T05:45:53'), '2026-11-11T05:45:53');
});
