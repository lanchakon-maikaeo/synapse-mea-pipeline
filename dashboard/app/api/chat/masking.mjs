// การปิดข้อมูลก่อนส่ง AI (docs/adr/0001): one masker per AI run (one chat question or one
// alert analysis). Personal data becomes a label such as [เบอร์โทร-1] before a provider sees
// it, and the label map lives only in this object while the run lasts.
// kind -> the word in its label. An earlier kind wins when two findings overlap.
const KINDS = { secret: 'รหัสลับ', word: 'ข้อมูลปิด', email: 'อีเมล', link: 'ลิงก์', line: 'ไลน์', national_id: 'เลขบัตร',
  phone: 'เบอร์โทร', plate: 'ทะเบียนรถ', employee: 'รหัสพนักงาน', name: 'ชื่อ' };
// A label as the model may copy it back: spaces, other dashes or full-width brackets.
const LABEL = new RegExp(`[[［]\\s*(${Object.values(KINDS).join('|')})\\s*[-‐‑–—]\\s*(\\d{1,4})\\s*[\\]］]`, 'g');
// The same label with its brackets dropped, as a writer sometimes copies it back; only labels this run issued are restored.
const BARE = new RegExp(`(?<![[［])(${Object.values(KINDS).join('|')})[-‐‑–—](\\d{1,4})(?![\\d\\]］])`, 'g');
const THAI = '\\u0e00-\\u0e7f';
// [pattern, kind, group]: group is the part to mask when a keyword leads the value.
const DETECTORS = [
  [/(?<![\w-])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|sbp_[0-9a-f]{40}|eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,})/g, 'secret'],
  [/Bearer\s+[\w.~+/=-]{6,}/gi, 'secret'],
  [/(?:password|passwd|pwd|api[_ -]?key|secret|token|รหัสผ่าน|พาสเวิร์ด)\s*[:=：]\s*([^\s,;]{4,})/gi, 'secret', 1],
  [/(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, 'email'],
  [/(?:https?:\/\/|www\.|line\.me\/|lin\.ee\/)[^\s<>"'[\]{}]*[^\s<>"'[\]{}.,;:!?)]/gi, 'link'],
  [/(?:(?<![a-z])line\s*id|(?<![a-z])id\s*line|(?<!ออน)ไลน์\s*ไอดี|ไอดี\s*ไลน์|(?<!ออน)ไลน์)\s*[:：]?\s*(@?(?=[\w.-]*[a-z])[a-z0-9][\w.-]{2,29})/gi, 'line', 1],
  [/(?<![\w.%+-])@[A-Za-z0-9][\w.-]{2,29}/g, 'line'],
  [/(?<![\w-])\d(?:[ -]?\d){12}(?![\w-])/g, 'national_id'],
  [/(?<![\w+-])(?:\+?66[ .-]?|0)(?:[689](?:[ .-]?\d){8}|[2-7](?:[ .-]?\d){7})(?!-?\d)(?:\s*(?:ต่อ|ext\.?)\s*\d{1,5}(?!\d))?/gi, 'phone'],
  [/(?:ป้ายทะเบียน|ทะเบียน(?:รถ)?|plate(?:\s*no\.?)?)\s*[:：]?\s*(\d{1,2}-\d{4}|\d?[ก-ฮ]{1,2}[ -]?\d{1,4})(?!\d)/gi, 'plate', 1],
  [new RegExp(`(?<![0-9A-Za-z${THAI}])\\d?[ก-ฮ]{2}[ -]?\\d{4}(?!\\d)|(?<![0-9A-Za-z${THAI}])\\d[ก-ฮ]{2}[ -]?\\d{1,4}(?!\\d)`, 'g'), 'plate'],
];
// A national ID counts only with a valid check digit; other 13-digit runs stay.
const nationalId = digits => digits.length === 13 &&
  (11 - [...digits.slice(0, 12)].reduce((sum, digit, i) => sum + Number(digit) * (13 - i), 0) % 11) % 10 === Number(digits[12]);

// A title keeps its place; the name after it is masked (DED Center ADR 0014). "คุณ" after
// ขอบ/บุญ/พระ is a word, and so is a title followed by one of TITLE_WORDS (นายช่าง, คุณภาพ).
const THAI_TITLE = /(นางสาว|เด็กชาย|เด็กหญิง|นาย|นาง|น\.ส\.?|ด\.ช\.|ด\.ญ\.|ดร\.|(?<!ขอบ)(?<!บุญ)(?<!พระ)คุณ) ?(?=[ก-ฮเ-ไ])/g;
const ENGLISH_TITLE = /(?<![A-Za-z])(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?)/g;
const NAME_TITLE = /^(?:นางสาว|เด็กชาย|เด็กหญิง|นาย|นาง|น\.ส\.?|ด\.ช\.|ด\.ญ\.|ดร\.|คุณ|(?:mrs|mr|ms|miss|dr)(?:\.|\s)+)\s*/;
const TITLE_WORDS = {
  นาย: ['จ้าง', 'ช่าง', 'ทุน', 'หน้า', 'ตรวจ', 'ประตู', 'ด่าน', 'อำเภอ', 'ทหาร', 'ตำรวจ', 'แพทย์', 'เวร', 'ห้าง', 'งาน',
    'ประกัน', 'ทะเบียน', 'สถานี', 'กเทศมนตรี', 'กรัฐมนตรี', 'กฯ'],
  นาง: ['พยาบาล', 'แบบ', 'ฟ้า', 'งาม', 'เอก'],
  คุณ: ['ภาพ', 'สมบัติ', 'ค่า', 'ประโยชน์', 'ลักษณะ', 'ธรรม', 'วุฒิ', 'ความ', 'แม่', 'พ่อ', 'ป้า', 'ลุง', 'ยาย', 'ปู่', 'ย่า',
    'น้า', 'พี่', 'น้อง', 'หมอ', 'ครู', 'ลูกค้า', 'ผู้', 'ท่าน'],
};
// Where a name typed without a space ends: a strong word first, a short weak one only if none.
const STRONG = ['แจ้ง', 'บอก', 'โทร', 'ติดต่อ', 'ครับ', 'คับ', 'ค่ะ', 'คะ', 'จ้า', 'ขอ', 'ช่วย', 'เบอร์', 'จาก', 'เขต', 'กอง',
  'ฝ่าย', 'แผนก', 'ฝาก', 'ส่ง', 'รับ', 'ทำ', 'อยู่', 'เป็น', 'ไม่', 'มี', 'ต้อง', 'เคย', 'กำลัง', 'ยัง', 'แล้ว', 'ซึ่ง', 'และ',
  'หรือ', 'กับ', 'ของ', 'ที่', 'ว่า', 'เมื่อ', 'วันที่', 'เวลา', 'ตอน', 'เรื่อง', 'เข้า', 'ออก', 'ถาม', 'ตอบ', 'เห็น', 'พบ', 'เจอ',
  'สั่ง', 'เบิก', 'จ่าย', 'เติม', 'แผน', 'คลัง', 'พัสดุ', 'วัสดุ', 'สต็อก', 'อนุมัติ', 'ยืนยัน', 'คืน', 'ซ่อม', 'เปลี่ยน', 'ตรวจ',
  'ดู', 'ผู้', 'เจ้าหน้าที่', 'หัวหน้า', 'ช่าง', 'มาก', 'ล่วงหน้า'].sort((a, b) => b.length - a.length);
const WEAK = ['มา', 'ไป', 'ได้', 'ให้', 'จะ', 'ก็', 'นะ', 'ด้วย', 'ค่า'];
// Words that are never a first name standing alone, even when an account is called that.
const COMMON = new Set(['เจ้าหน้าที่', 'ผู้ใช้', 'ผู้ขอ', 'หัวหน้า', 'พนักงาน', 'แอดมิน', 'admin', 'staff', 'user', 'test', 'ทดสอบ',
  'demo', 'เขต', 'คลัง', 'ระบบ', 'planner', 'district', 'viewer', 'picker', 'academic', 'synapse', 'mea', 'กฟน.']);
// คำที่ไม่ใช่ชื่อ: common words spelled like a first name. The full name is still masked.
const NOT_NAMES = new Set(['มานะ', 'สมบูรณ์', 'ทอง', 'เงิน', 'แก้ว', 'บุญ', 'สุข', 'ศรี', 'พร', 'ชัย', 'แสง', 'ฟ้า', 'น้ำ', 'ฝน',
  'ดาว', 'เดือน', 'ใหม่', 'เล็ก', 'น้อย', 'ใหญ่', 'โชค', 'เอก', 'อรุณ', 'จันทร์', 'สมหวัง', 'ประเสริฐ', 'วิเศษ',
  'max', 'min', 'sum', 'avg', 'count', 'will', 'may', 'june', 'april', 'mark', 'bill', 'grant', 'rose', 'art', 'top']);
const LETTER = /[ก-๎A-Za-z]/;
const THAI_CHAR = /[ก-๎]/;
const SURNAME = / {1,2}([ก-ฮเ-ไ][ก-๎]*)/y;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Lower case with the same length, so places in it are places in the text.
const lower = text => [...text].map(c => c.toLowerCase().length === c.length ? c.toLowerCase() : c).join('');
const clean = value => lower(String(value ?? '').split(/\s+/).filter(Boolean).join(' ')).replace(NAME_TITLE, '').trim();
const pattern = values => values.size ? new RegExp([...values].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g') : null;

// ชื่อที่ระบบรู้จัก: full names anywhere, first names only standing alone (DED Center ADR 0041).
function nameTables(names) {
  const full = new Set();
  const first = new Set();
  for (const tokens of names.map(name => clean(name).split(' ').filter(Boolean))) {
    if (tokens.length >= 2) for (const joined of [tokens.join(' '), tokens.join('')]) if (joined.length >= 4) full.add(joined);
    const head = tokens[0];
    if (head?.length >= 3 && !/^\d+$/.test(head) && !COMMON.has(head) && !NOT_NAMES.has(head)) first.add(head);
  }
  return { full: pattern(full), first: pattern(first) };
}

const boundaryAt = (text, at) => STRONG.some(word => text.startsWith(word, at)) || WEAK.some(word => text.startsWith(word, at));

// Where a name typed without a space ends inside a run of Thai letters.
function cut(run) {
  for (const words of [STRONG, WEAK]) {
    const found = words.map(word => run.indexOf(word, 2)).filter(at => at !== -1);
    if (found.length) return Math.min(...found);
  }
  return run.length;
}

function* titled(probe) {
  for (const m of probe.matchAll(THAI_TITLE)) {
    const start = m.index + m[0].length;
    let runEnd = start;
    while (runEnd < probe.length && THAI_CHAR.test(probe[runEnd])) runEnd++;
    const run = probe.slice(start, runEnd);
    if ((TITLE_WORDS[m[1]] ?? []).some(word => run.startsWith(word)) || boundaryAt(run, 0)) continue;
    let end = start + cut(run);
    if (end - start < 2) continue;
    if (end === runEnd) {
      SURNAME.lastIndex = end;
      const surname = SURNAME.exec(probe);
      if (surname && !boundaryAt(surname[1], 0)) {
        const length = cut(surname[1]);
        if (length >= 2 && !STRONG.some(word => word.length > 2 && surname[1].slice(0, length).includes(word))) end = surname.index + surname[0].length - surname[1].length + length;
      }
    }
    yield [start, end, 'name'];
  }
}

const RANK = Object.fromEntries(Object.keys(KINDS).map((kind, rank) => [kind, rank]));
// Detectors read Thai digits as Arabic ones; the replacement keeps every place in the text.
const arabic = text => text.replace(/[๐-๙]/g, digit => String(digit.charCodeAt(0) - 0x0e50));

function walk(value, change) {
  if (typeof value === 'string') return change(value);
  if (Array.isArray(value)) return value.map(item => walk(item, change));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, change)]));
  return value;
}

// The same value typed twice gets one label: 081-234-5678, 0812345678 and +66 81 234 5678.
function valueKey(kind, value) {
  if (kind === 'phone') return arabic(value).replace(/\D/g, '').replace(/^66/, '0');
  if (kind === 'national_id') return arabic(value).replace(/\D/g, '');
  return value.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

// [start, end, kind] of everything to mask, earlier kinds winning overlaps.
function spans(text, { words, full, first, exact = [] }) {
  const cased = arabic(text);
  const probe = lower(cased);
  let segments;
  // ICU word boundaries tell สมพงษ์ in ถามสมพงษ์ดู apart from ทอง in ทองแดง.
  const boundary = at => (segments ??= new Set([...new Intl.Segmenter('th', { granularity: 'word' }).segment(probe)].flatMap(s => [s.index, s.index + s.segment.length]))).has(at);
  const alone = (start, end) => (start === 0 || !LETTER.test(probe[start - 1]) || boundary(start)) &&
    (end >= probe.length || !LETTER.test(probe[end]) || boundaryAt(probe, end) || boundary(end));
  const known = (table, kind, standing) => table ? [...probe.matchAll(table)]
    .filter(m => !standing || alone(m.index, m.index + m[0].length)).map(m => [m.index, m.index + m[0].length, kind]) : [];
  const found = [...known(words, 'word'), ...exact.flatMap(([table, kind]) => known(table, kind)),
    ...known(full, 'name'), ...known(first, 'name', true), ...titled(probe),
    ...[...cased.matchAll(ENGLISH_TITLE)].map(m => [m.index + m[0].length - m[1].length, m.index + m[0].length, 'name']),
    ...DETECTORS.flatMap(([pattern, kind, group]) => [...probe.matchAll(pattern)]
    .filter(m => kind !== 'national_id' || nationalId(m[0].replace(/\D/g, '')))
    .map(m => {
      const start = group ? m.index + m[0].lastIndexOf(m[group]) : m.index;
      return [start, start + m[group ?? 0].length, kind];
    }))];
  const chosen = [];
  for (const span of found.sort((a, b) => RANK[a[2]] - RANK[b[2]] || (b[1] - b[0]) - (a[1] - a[0]) || a[0] - b[0])) {
    if (span[1] > span[0] && chosen.every(([start, end]) => span[1] <= start || span[0] >= end)) chosen.push(span);
  }
  return chosen.sort((a, b) => a[0] - b[0]);
}

// การตรวจขาออก: after the values are back, contact details and IDs must come from the evidence or
// from the asker's own words; secrets never go out.
const GUARDED = new Set(['secret', 'email', 'national_id', 'phone']);
const NO_TABLES = { words: null, full: null, first: null };

// Columns whose whole value is personal data, and keys never sent at all (user ids, ADR 0001 Q5).
const COLUMNS = [
  [/(?:^|_)(?:display|driver|full|requester|contact|person)_name$/, 'name'],
  [/(?:^|_)e?mail$/, 'email'],
  [/(?:^|_)(?:phone|mobile|tel)(?:_no|_number)?$/, 'phone'],
  [/(?:^|_)plate(?:_no|_number)?$/, 'plate'],
  [/^employee_(?:id|reference|code|no|number)$/, 'employee'],
  [/(?:^|_)(?:national|citizen)_id$/, 'national_id'],
  [/(?:^|_)line_id$/, 'line'],
];
const columnKind = key => COLUMNS.find(([pattern]) => pattern.test(key))?.[1];
const dropped = key => (/_by$/.test(key) && !/^(?:group|order|sort|partition)_by$/.test(key)) || ['actor_id', 'user_id'].includes(key);

// Strings that hold JSON (tool input built with JSON.stringify) are masked as JSON so they stay
// valid; a catalog's `columns` maps column names to types, so its values are not people.
function visit(value, leaf, key = '', schema = false) {
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object') return JSON.stringify(visit(parsed, leaf, key, schema));
  }
  if (Array.isArray(value)) return value.map(item => visit(item, leaf, key, schema));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => !dropped(name))
    .map(([name, item]) => [name, visit(item, leaf, name, schema || (name === 'columns' && !Array.isArray(item)))]));
  return leaf(value, schema ? undefined : columnKind(key));
}

export function createMasker({ names = [], words = [] } = {}) {
  const alwaysMasked = pattern(new Set(words.map(clean).filter(word => word.length >= 2)));
  // kind -> values this run has seen in people columns or already labeled: once hidden, a value
  // stays hidden in every later call, even when it comes back without the title that found it.
  const seen = { name: new Set(names) };
  let tables;
  const learn = (kind, value) => {
    const text = String(value).trim();
    if (text.length < 3 || (seen[kind] ??= new Set()).has(text)) return;
    seen[kind].add(text);
    tables = undefined;
  };
  const current = () => tables ??= { words: alwaysMasked, ...nameTables([...seen.name]),
    exact: Object.entries(seen).filter(([kind]) => kind !== 'name').map(([kind, found]) => [pattern(new Set([...found].map(lower))), kind]) };
  const values = new Map(); // kind:value key -> label
  const labels = new Map(); // word-n -> the original text
  const reserved = new Set(); // label-like text already in what people typed or stored
  const next = {};
  const label = (kind, value) => {
    const key = `${kind}:${valueKey(kind, value)}`;
    if (!values.has(key)) {
      const word = KINDS[kind];
      let number = (next[word] ?? 0) + 1;
      while (reserved.has(`${word}-${number}`)) number++;
      next[word] = number;
      values.set(key, `[${word}-${number}]`);
      labels.set(`${word}-${number}`, value);
      learn(kind, value);
    }
    return values.get(key);
  };
  const maskText = text => {
    let masked = '';
    let last = 0;
    for (const [start, end, kind] of spans(text, current())) {
      masked += text.slice(last, start) + label(kind, text.slice(start, end));
      last = end;
    }
    return masked + text.slice(last);
  };
  // First pass: keep typed labels' numbers out of use and learn this run's people-column values,
  // so a note that repeats a requester's name is masked wherever it comes in the body.
  const prepare = value => visit(value, (leaf, kind) => {
    if (typeof leaf === 'string') for (const [, word, n] of leaf.matchAll(LABEL)) reserved.add(`${word}-${Number(n)}`);
    if (kind && (typeof leaf === 'number' || typeof leaf === 'string')) learn(kind, leaf);
    return leaf;
  });
  const mask = value => visit(value, (leaf, kind) => kind && (typeof leaf === 'number' || (typeof leaf === 'string' && leaf.trim()))
    ? label(kind, String(leaf).trim()) : typeof leaf === 'string' ? maskText(leaf) : leaf);
  return {
    mask: value => {
      prepare(value);
      return mask(value);
    },
    // Gemini-style body: the turns carry what people typed and what the database returned.
    maskBody: body => {
      prepare(body.contents);
      return { ...body, contents: mask(body.contents) };
    },
    guard: (text, allowed = []) => {
      const known = new Set();
      walk(allowed, part => {
        for (const [start, end, kind] of spans(part, NO_TABLES)) if (GUARDED.has(kind)) known.add(`${kind}:${valueKey(kind, part.slice(start, end))}`);
        return part;
      });
      let checked = '';
      let last = 0;
      for (const [start, end, kind] of spans(text, NO_TABLES)) {
        if (!GUARDED.has(kind) || (kind !== 'secret' && known.has(`${kind}:${valueKey(kind, text.slice(start, end))}`))) continue;
        checked += `${text.slice(last, start)}[ปิดไว้]`;
        last = end;
      }
      return checked + text.slice(last);
    },
    // How many distinct values of each kind this run hid; never the values (ADR 0001 Q7).
    counts: () => {
      const counts = {};
      for (const key of values.keys()) counts[key.split(':')[0]] = (counts[key.split(':')[0]] ?? 0) + 1;
      return counts;
    },
    // A label this run never issued means the output is unusable (ADR 0001, round two Q6);
    // label-like text that people typed comes back as it was.
    restore: value => walk(value, text => text.replace(LABEL, (found, word, n) => {
      const original = labels.get(`${word}-${Number(n)}`);
      if (original !== undefined) return original;
      if (reserved.has(`${word}-${Number(n)}`)) return found;
      throw new Error('unknown_label');
    }).replace(BARE, (found, word, n) => labels.get(`${word}-${Number(n)}`) ?? found)),
  };
}

// ชื่อที่ระบบรู้จัก and คำที่ต้องปิดเสมอ come from ai_privacy_terms() (service role). Without them
// no AI call goes out: the caller fails closed. A cache object keeps them for five minutes.
export async function privacyTerms(rpc, cache) {
  if (cache?.terms && Date.now() - cache.at < 300_000) return cache.terms;
  let terms;
  try { terms = await rpc('ai_privacy_terms', {}); } catch { terms = undefined; }
  if (!Array.isArray(terms?.names) || !Array.isArray(terms?.words) ||
      [...terms.names, ...terms.words].some(value => typeof value !== 'string')) throw new Error('privacy_terms_unavailable');
  if (cache) Object.assign(cache, { terms, at: Date.now() });
  return terms;
}
