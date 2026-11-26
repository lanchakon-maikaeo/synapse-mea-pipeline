import test from 'node:test';
import assert from 'node:assert/strict';
import { createMasker } from '../app/api/chat/masking.mjs';

// The provider sees what maskBody sends; these helpers read and write one user turn.
const send = (masker, text) => masker.maskBody({ contents: [{ role: 'user', parts: [{ text }] }] }).contents[0].parts[0].text;

test('labels the model copies with a different format still restore', () => {
  const masker = createMasker();
  assert.equal(send(masker, 'โทร 0812345678'), 'โทร [เบอร์โทร-1]');
  for (const variant of ['[เบอร์โทร-1]', '[เบอร์โทร - 1]', '［เบอร์โทร-1］', '[ เบอร์โทร–1 ]']) {
    assert.equal(masker.restore(`ติดต่อ ${variant}`), 'ติดต่อ 0812345678');
  }
});

test('a label the model wrote without its brackets restores when this run issued it, and stays as written otherwise', () => {
  const masker = createMasker();
  send(masker, 'โทร 0812345678');
  // Seen in a live eval: the writer answered "เบอร์โทร-1" for [เบอร์โทร-1], and the user read the label.
  assert.equal(masker.restore('ผู้ขอคือเบอร์โทร-1'), 'ผู้ขอคือ0812345678');
  assert.equal(masker.restore('ติดต่อ เบอร์โทร-2 หรือ ชื่อ-1'), 'ติดต่อ เบอร์โทร-2 หรือ ชื่อ-1');
});

test('a label this run never issued makes the output unusable', () => {
  const masker = createMasker();
  send(masker, 'โทร 0812345678');
  assert.throws(() => masker.restore({ answer: 'ติดต่อ [เบอร์โทร-2]' }), /unknown_label/);
  assert.throws(() => masker.restore('ส่งให้ [ชื่อ-1]'), /unknown_label/);
});

test('label-like text people typed keeps its number and comes back unchanged', () => {
  const masker = createMasker();
  assert.equal(send(masker, 'ป้าย [เบอร์โทร-1] ในเอกสาร และเบอร์ 081-234-5678'), 'ป้าย [เบอร์โทร-1] ในเอกสาร และเบอร์ [เบอร์โทร-2]');
  assert.equal(masker.restore('[เบอร์โทร-1] กับ [เบอร์โทร-2]'), '[เบอร์โทร-1] กับ 081-234-5678');
});

test('one value keeps one label however it is written', () => {
  const masker = createMasker();
  assert.equal(send(masker, '081-234-5678 หรือ 0812345678 หรือ +66 81 234 5678 หรือ ๐๘๑๒๓๔๕๖๗๘'),
    '[เบอร์โทร-1] หรือ [เบอร์โทร-1] หรือ [เบอร์โทร-1] หรือ [เบอร์โทร-1]');
});

test('each kind of personal data and secret in free text becomes a label', () => {
  for (const [text, expected] of [
    ['อีเมล somchai.j@mea.or.th ครับ', 'อีเมล [อีเมล-1] ครับ'],
    ['ดูที่ https://drive.example.com/file?id=9 และ www.example.org.', 'ดูที่ [ลิงก์-1] และ [ลิงก์-2].'],
    ['line id: somchai_99 หรือไลน์ @mea123', 'line id: [ไลน์-1] หรือไลน์ [ไลน์-2]'],
    ['เลขบัตร 1-1017-00230-70-8 กับ 1101700230705', 'เลขบัตร [เลขบัตร-1] กับ 1101700230705'],
    ['โทร 02-123-4567 ต่อ 12', 'โทร [เบอร์โทร-1]'],
    ['รถทะเบียน 1กข 1234 กับทะเบียน 70-1234 และ กข-5678', 'รถทะเบียน [ทะเบียนรถ-1] กับทะเบียน [ทะเบียนรถ-2] และ [ทะเบียนรถ-3]'],
    ['key sk-or-v1-0123456789abcdef0123 แล้ว Bearer abc.def-ghi_123', 'key [รหัสลับ-1] แล้ว [รหัสลับ-2]'],
    ['password: Hunter2!x และ token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', 'password: [รหัสลับ-1] และ token=[รหัสลับ-2]'],
  ]) assert.equal(send(createMasker(), text), expected, text);
});

test('work data the agent computes with stays readable', () => {
  for (const text of [
    'SKU 015800100148 เหลือ 1,250 ม้วน ณ วันที่ 2026-11-22 10:30',
    'PO 1300000002 สัญญา MP4-8975-JGE แผน KT01-W45-021169 เขต 5501-5518',
    'lot OBR-471050004000-825A83BE47C7 ราคา 12,345.50 บาท',
    'รถ 10 คัน รถ 6 ล้อ ลดลง 20% ภายใน 3.5 เดือน',
    'หูสายทองแดงแบบไม่มีฉนวนหุ้ม #14-6 และ SURGE ARRESTER 24KV 10KA',
    'คุณภาพของพัสดุ นายช่างตรวจแล้ว ขอบคุณค่ะ',
  ]) assert.equal(send(createMasker(), text), text);
});

test('a name after a title becomes a label and the title stays', () => {
  for (const [text, expected] of [
    ['นายสมชาย ใจดี โทรมาแจ้ง', 'นาย[ชื่อ-1] โทรมาแจ้ง'],
    ['คุณสมศรีแจ้งว่าของไม่ครบ', 'คุณ[ชื่อ-1]แจ้งว่าของไม่ครบ'],
    ['น.ส.วันดี ศรีสุข ขอเบิก', 'น.ส.[ชื่อ-1] ขอเบิก'],
    ['Mr. John Smith asked', 'Mr. [ชื่อ-1] asked'],
  ]) assert.equal(send(createMasker(), text), expected, text);
});

test('a name the system knows becomes a label, even a first name standing alone', () => {
  const terms = { names: ['สมพงษ์ รักงาน', 'Somchai Jaidee', 'นายทอง มั่งมี'], words: [] };
  for (const [text, expected] of [
    ['ส่งให้สมพงษ์ รักงาน แล้ว', 'ส่งให้[ชื่อ-1] แล้ว'],
    ['สมพงษ์รักงานยืนยันแล้ว', '[ชื่อ-1]ยืนยันแล้ว'],
    ['ถามสมพงษ์ดู', 'ถาม[ชื่อ-1]ดู'],
    ['somchai said yes, SOMCHAI JAIDEE too', '[ชื่อ-1] said yes, [ชื่อ-2] too'],
    ['ทอง มั่งมี มารับของ', '[ชื่อ-1] มารับของ'],
  ]) assert.equal(send(createMasker(terms), text), expected, text);
});

test('a known first name inside a longer word, or a word that is not a name, stays', () => {
  const terms = { names: ['นายทอง มั่งมี', 'มานะ ใจดี', 'Max Power'], words: [] };
  for (const text of ['หูสายทองแดงแบบไม่มีฉนวน', 'ราคาทองวันนี้', 'ต้องมีมานะในการทำงาน', 'metrics max quantity'])
    assert.equal(send(createMasker(terms), text), text);
});

test('an always-mask word becomes a label wherever it appears', () => {
  assert.equal(send(createMasker({ names: [], words: ['โครงการลับ X'] }), 'คุยเรื่องโครงการลับ x ต่อ'), 'คุยเรื่อง[ข้อมูลปิด-1] ต่อ');
});

test('rows sent as JSON stay JSON: people columns become labels, user ids are dropped', () => {
  const masker = createMasker();
  const row = { district_note: 'โทรหาวิภาแล้ว รหัส E12345 แจ้งว่าครบ', plan_number: 'KT01-W45-021169', requester_name: 'วิภา ทองดี',
    approved_by: '0b6f7a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', actor_id: 'a1', user_id: 'u1', driver_name: null, plate: '1กข 1234',
    work_email: 'v@mea.or.th', employee_reference: 'E12345', employee_id: 10042, quantity: 12 };
  const sent = JSON.parse(send(masker, JSON.stringify({ question: 'วิภา ทองดี ขออะไร', evidence: [{ id: 1, data: { data: [row] } }],
    catalog: [{ source_id: 'core.replenishment_items', columns: { requester_name: 'text', district_confirmed_by: 'uuid' } }],
    query: { columns: ['requester_name'], group_by: [], filters: [{ column: 'requester_name', operator: 'eq', value: 'วิภา ทองดี' }] } })));
  assert.deepEqual(sent.evidence[0].data.data[0], { district_note: 'โทรหา[ชื่อ-2]แล้ว รหัส [รหัสพนักงาน-1] แจ้งว่าครบ',
    plan_number: 'KT01-W45-021169', requester_name: '[ชื่อ-1]', driver_name: null, plate: '[ทะเบียนรถ-1]', work_email: '[อีเมล-1]',
    employee_reference: '[รหัสพนักงาน-1]', employee_id: '[รหัสพนักงาน-2]', quantity: 12 });
  assert.equal(sent.question, '[ชื่อ-1] ขออะไร');
  assert.deepEqual(sent.catalog[0].columns, { requester_name: 'text' });
  assert.deepEqual(sent.query, { columns: ['requester_name'], group_by: [], filters: [{ column: 'requester_name', operator: 'eq', value: '[ชื่อ-1]' }] });
  assert.equal(masker.restore(sent.evidence[0].data.data[0].district_note), 'โทรหาวิภาแล้ว รหัส E12345 แจ้งว่าครบ');
});

test('the outbound check hides contact details and secrets that came from neither the evidence nor the asker', () => {
  const answer = 'ติดต่อ 081-234-5678 หรือ 02-999-8888 อีเมล a@mea.or.th หรือ x@evil.example เลขบัตร 1101700230708 key sk-or-v1-0123456789abcdef0123';
  assert.equal(createMasker().guard(answer, ['เบอร์ 0812345678', { rows: [{ work_email: 'A@mea.or.th' }] }]),
    'ติดต่อ 081-234-5678 หรือ [ปิดไว้] อีเมล a@mea.or.th หรือ [ปิดไว้] เลขบัตร [ปิดไว้] key [ปิดไว้]');
});

test('counts say how many values of each kind a run hid, never which', () => {
  const masker = createMasker({ names: ['สมพงษ์ รักงาน'] });
  send(masker, 'สมพงษ์ รักงาน โทร 0812345678 หรือ 081-234-5678 อีเมล a@b.co');
  send(masker, 'สมพงษ์ รักงาน อีกครั้ง');
  assert.deepEqual(masker.counts(), { name: 1, phone: 1, email: 1 });
});

test('a value hidden once stays hidden when it comes back without the title that found it', () => {
  const masker = createMasker();
  assert.equal(send(masker, 'คุณสมศรี ใจดี ขอเบิก'), 'คุณ[ชื่อ-1] ขอเบิก');
  assert.equal(send(masker, 'ค้นคำขอของ สมศรี ใจดี และสมศรีคนเดิม'), 'ค้นคำขอของ [ชื่อ-1] และ[ชื่อ-2]คนเดิม');
});
