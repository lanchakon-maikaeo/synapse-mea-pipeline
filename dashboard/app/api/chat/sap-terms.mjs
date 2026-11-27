// คำค้นภาษาไทย → คำที่ทะเบียนวัสดุ SAP ใช้ (ADR 0002): 6,193 of 7,596 material names have no Thai at all, so
// "หม้อแปลงไฟฟ้า 3 เฟส 250kVA" never meets "TRANS 3P4W 12/24KV D416Y240V 250KVA(SL)" by text or by meaning.
// The database counts how many of these terms a name holds (near_text). Each term is one word or alternatives
// joined by |; a word matches the start of a word in the name, so "insulat" finds INSULATED and INSULATOR.
const WORDS = [
  [/หม้อแปลง(?:ไฟฟ้า)?(?:จำหน่าย)?/g, 'trans'],
  [/กับดักฟ้า(?:ผ่า)?|ล่อฟ้า/g, 'arrest'],
  [/เบร[กค]เกอร์/g, 'breaker|mccb|mcb'],
  [/ฟิวส์/g, 'fuse'],
  [/สวิ[ตท]ช์/g, 'switch'],
  [/รีเลย์/g, 'relay'],
  [/มิเตอร์(?:ไฟฟ้า)?|มาตรวัด(?:ไฟฟ้า)?/g, 'meter'],
  [/ลูกถ้วย/g, 'insulator'],
  [/สายดิน/g, 'ground|earth'],
  [/(?:สาย)?เคเบิล|สายไฟ(?:ฟ้า)?|สาย/g, 'cable|wire|conductor'],
  [/คอนเน[คก]เตอร์|ข้อต่อ/g, 'conn'],
  [/แคลมป์|ก้ามปู/g, 'clamp'],
  [/สลักเกลียว|โบลท์|น็อต/g, 'bolt|nut|screw'],
  [/แหวนรอง/g, 'washer'],
  [/เทป/g, 'tape'],
  [/โคมไฟ|หลอดไฟ/g, 'lamp|luminaire'],
  [/คาปาซิเตอร์|ตัวเก็บประจุ/g, 'capacitor'],
  [/ทองแดง/g, 'copper|cu'],
  [/อะ?ลูมิเนียม/g, 'alumin'],
  [/ฉนวน/g, 'insulat'],
  [/บุชชิ่ง/g, 'bushing'],
  [/ปะเก็น/g, 'gasket'],
  [/สปริง/g, 'spring'],
  [/เสา/g, 'pole'],
  [/คอนเวนชัน(?:นัล)?/g, 'conv'],
  [/เต้ารับ/g, 'socket|outlet'],
  [/ปลั๊ก/g, 'plug'],
  [/ท่อร้อยสาย|ท่อ/g, 'conduit|pipe'],
  [/แบตเตอรี่/g, 'batt'],
];
// A number and its unit as one term, the way the database joins them in names ("250 KVA" reads as 250kva).
// Only the decimals of 0.48 are kept: the name side keeps the point, which ends a word.
const NUMBER = '(\\d+(?:\\.\\d+)?)\\s*';
const UNITS = [
  ['kva', 'kva|เควีเอ'], ['kv', 'kv|เควี|กิโลโวลต์'], ['ka', 'ka|กิโลแอมป์'], ['kw', 'kw|กิโลวัตต์'],
  ['sqmm', 'ตร\\.?\\s*มม\\.?|sq\\.?\\s*mm\\.?|sqmm'], ['mm', 'มม\\.?|mm'], ['a', 'a|แอมป์|แอมแปร์'], ['v', 'v|โวลต์'],
].map(([unit, spelled]) => [new RegExp(`${NUMBER}(?:${spelled})(?![a-z])`, 'g'), unit]);
const PHASE = /(\d)\s*(?:เฟส|phase|ph(?![a-z]))/g;
const digits = number => number.includes('.') ? number.split('.')[1] : number;

export function sapTerms(text) {
  if (typeof text !== 'string' || !/[ก-๙]/.test(text)) return null;
  let rest = text.toLowerCase();
  const found = []; // [position, term]
  let thai = false;
  const take = (pattern, term) => {
    rest = rest.replace(pattern, (match, ...groups) => {
      const at = groups.at(-2);
      const word = typeof term === 'function' ? term(...groups) : term;
      if (/[ก-๙]/.test(match)) thai = true;
      found.push([at, word]);
      return ' '.repeat(match.length);
    });
  };
  for (const [pattern, term] of WORDS) take(pattern, term);
  take(PHASE, digit => digit === '1' ? '1p|single' : `${digit}p`);
  for (const [pattern, unit] of UNITS) take(pattern, number => `${digits(number)}${unit}`);
  if (!thai) return null;
  // What the asker typed in SAP's own words already (RMU, XLPE, 3P) counts as typed.
  for (const match of rest.matchAll(/[a-z0-9]+/g)) if (match[0].length > 1) found.push([match.index, match[0]]);
  const terms = [...new Set(found.sort((a, b) => a[0] - b[0]).map(([, term]) => term))].slice(0, 12);
  return terms.length ? terms.join(' ') : null;
}
