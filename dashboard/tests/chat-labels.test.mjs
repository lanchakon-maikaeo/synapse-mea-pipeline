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

test('a row reads in Thai: names, stored codes, empty values and aggregates', () => {
  assert.equal(renderToolResult({ status: 'ok', tool: 'query_database', source_id: 'analytics.v_replenishment_queue', data: [{
    plan_number: 'KT01-W47-000214', plan_status: 'pending_district_confirmation', requester_name: null, special_approval_required: false,
    abnormal_signals: ['stockout'], reviewed_by: 'u-1', sum_final_qty: 4600 }] }),
  '• เลขแผน: KT01-W47-000214 · สถานะแผน: รอเขตยืนยัน · ผู้ขอเติม: ไม่ทราบ · ต้องขออนุมัติพิเศษ: ไม่ใช่ · สัญญาณผิดปกติ: stockout · ผู้ตรวจทาน: u-1 · ผลรวมจำนวนสุดท้าย: 4600');
  // A code is translated only in a column that stores codes: a material named "critical" stays as written.
  assert.equal(valueLabel('material_name', 'critical'), 'critical');
  assert.equal(valueLabel('health_band', 'critical'), 'วิกฤต');
});
