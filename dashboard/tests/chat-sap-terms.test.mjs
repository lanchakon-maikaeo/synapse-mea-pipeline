import test from 'node:test';
import assert from 'node:assert/strict';
import { sapTerms } from '../app/api/chat/sap-terms.mjs';

// Production 27 Nov: "หม้อแปลงไฟฟ้า 3 เฟส 250kVA" found nothing, while the register names it
// "TRANS 3P4W 12/24KV D416Y240V 250KVA(SL)". 6,193 of 7,596 material names have no Thai at all.
test('Thai material words become the SAP words the register spells them with, units joined to their numbers', () => {
  for (const [text, terms] of [
    ['หม้อแปลงไฟฟ้า 3 เฟส 250kVA', 'trans 3p 250kva'],
    ['หม้อแปลงไฟฟ้า 3 เฟส 22 kV 250 เควีเอ', 'trans 3p 22kv 250kva'],
    ['กับดักฟ้าผ่า 21 kV 10 kA', 'arrest 21kv 10ka'],
    ['ล่อฟ้า 9kV', 'arrest 9kv'],
    ['เบรกเกอร์ 3 เฟส 630A', 'breaker|mccb|mcb|vcb|gcb|acb 3p 630a'],
    ['คีมปอกสายไฟ 185 ตร.มม.', 'cable|wire|conductor 185sqmm'],
    ['ลูกถ้วยแขวน', 'insulator'],
    ['มิเตอร์ไฟฟ้า 1 เฟส', 'meter|kwh 1p|single'],
    ['ฟิวส์ RMU 24kV', 'fuse rmu 24kv'],
  ]) assert.equal(sapTerms(text), terms, text);
});

// Production names by how many hold each word (27 Nov): sqmm 611, cable 293, fuse 230, bolt 208, ring 173, switch 133,
// clamp 118, relay 108, terminal 81, CT 75, crossarm 40, ...
test('the common SAP item words have their Thai, and a longer Thai word wins over the word it starts with', () => {
  for (const [text, terms] of [
    ['หม้อแปลงกระแส 400/5A', 'ct|current 400 5a'],
    ['หม้อแปลงแรงดัน 24kV', 'pt|vt|voltage 24kv'],
    ['แหวนรองสปริง', 'washer spring'],
    ['แหวนกันน้ำ', 'ring'],
    ['เคเบิลไทร์ 8 นิ้ว', 'tie'],
    ['สวิตช์ตัดตอน 24kV', 'disconnecting|disc 24kv'],
    ['หางปลาทองแดง 185 ตร.มม.', 'lug|terminal|term|thimble copper|cu 185sqmm'],
    ['คอนเหล็ก 2.4 เมตร', 'crossarm'],
    ['คาปาซิเตอร์ 50 kvar', 'capacitor 50kvar'],
    ['สายอะลูมิเนียม 4/0 AWG', 'cable|wire|conductor alumin 0awg'],
    ['ตู้ RMU', 'cabinet|box|rmu|swgr rmu'],
  ]) assert.equal(sapTerms(text), terms, text);
});

test('a search with no Thai material word is left to the text search as it is', () => {
  for (const text of ['TRANS 3P 250KVA', 'ใครเป็นผู้ขอเติมของเขตบางนา', '', '   ', undefined]) assert.equal(sapTerms(text), null, String(text));
});

test('terms are only lowercase letters, digits and | between alternatives, at most 12 of them', () => {
  const terms = sapTerms('หม้อแปลง ฟิวส์ เบรกเกอร์ ลูกถ้วย มิเตอร์ ล่อฟ้า เสา สายไฟ แคลมป์ สลักเกลียว เทป ทองแดง อะลูมิเนียม ปะเก็น 250kVA 22kV');
  assert.match(terms, /^[a-z0-9|]+( [a-z0-9|]+){0,11}$/);
  assert.equal(terms.split(' ').length, 12);
  assert.equal(sapTerms('หม้อแปลง TRANS-3P (ใหม่); DROP TABLE x'), 'trans 3p drop table');
});
