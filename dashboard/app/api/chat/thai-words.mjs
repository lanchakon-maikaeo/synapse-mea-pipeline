// Thai word segmentation with OpenThai2.0-LATTE-WordSeg-Lite (OpenThai, iApp Technology and the LATTE authors;
// model and dictionary CC BY-SA 4.0, runtime Apache-2.0), ported from its Python runtime 0.1.2 for unit "short".
// Assets, licences and provenance: ./thai-words/README.md.
// Each line loses its whitespace; every character gets an id and 13 dictionary bits; the network gives one
// word-start logit per character; a word starts where the logit is >= 0 unless Thai spelling rules it out.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const NO_START = new Set([0x0e30, 0x0e31, 0x0e32, 0x0e33, 0x0e34, 0x0e35, 0x0e36, 0x0e37, 0x0e38, 0x0e39, 0x0e3a, 0x0e45,
  0x0e47, 0x0e48, 0x0e49, 0x0e4a, 0x0e4b, 0x0e4c, 0x0e4d, 0x0e4e]);
const LEADING = new Set([0x0e40, 0x0e41, 0x0e42, 0x0e43, 0x0e44]);
const LEN_BUCKET = n => n <= 2 ? 0 : n === 3 ? 1 : n === 4 ? 2 : n <= 6 ? 3 : n <= 9 ? 4 : 5;
const MAX_WORD = 16;
const MAX_LINE = 10000;            // the Python runtime reads longer lines in windows; callers here send short text
const UNIT = 1;                    // outputs coarse to fine: long, short, minimal; short's starts include long's
// Python str.isspace and str.isdecimal, so tokens match the reference runtime exactly.
const SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const DIGIT = /\p{Nd}/u;
const LETTER = /[A-Za-z]/;
const sameRun = (a, b) => (DIGIT.test(a) && DIGIT.test(b)) || (LETTER.test(a) && LETTER.test(b));

async function load(dir) {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const [model, lexicon, charids] = await Promise.all([readFile(path.join(dir, 'model.int8.onnx')),
    readFile(path.join(dir, 'lexicon.txt.gz')), readFile(path.join(dir, 'charids.json'), 'utf8')]);
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  const words = Array.from({ length: MAX_WORD + 1 }, () => new Set());
  for (const word of gunzipSync(lexicon).toString('utf8').split('\n')) {
    const chars = [...word];
    if (chars.length >= 2 && chars.length <= MAX_WORD && !chars.some(c => SPACE.test(c))) words[chars.length].add(word);
  }
  const { size, runs } = JSON.parse(charids);
  const ids = new Int16Array(size);
  runs.forEach(([start, id], i) => ids.fill(id, start, runs[i + 1]?.[0] ?? size));
  let queue = Promise.resolve();
  // One wasm session runs one inference at a time.
  const run = feed => { const next = queue.then(() => session.run(feed)); queue = next.catch(() => {}); return next; };
  return { ort, run, words, ids };
}

// Word starts of one whitespace-free line, as a boolean per character.
async function starts({ ort, run, words, ids }, chars) {
  const n = chars.length;
  const codes = chars.map(c => c.codePointAt(0));
  const bits = new BigInt64Array(n);
  const cover = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    let s = chars[i];
    for (let len = 2; len <= MAX_WORD && i + len <= n; len++) {
      s += chars[i + len - 1];
      if (!words[len].has(s)) continue;
      const b = BigInt(LEN_BUCKET(len));
      bits[i] |= 1n << b;
      bits[i + len - 1] |= 1n << (6n + b);
      if (len > 2) { cover[i + 1]++; cover[i + len - 1]--; }
    }
  }
  for (let i = 0, inside = 0; i < n; i++) { inside += cover[i]; if (inside > 0) bits[i] |= 1n << 12n; }
  const feed = {
    ids: new ort.Tensor('int64', BigInt64Array.from(codes, c => BigInt(ids[c])), [1, n]),
    bits: new ort.Tensor('int64', bits, [1, n]),
    lengths: new ort.Tensor('int32', Int32Array.of(n), [1]),
  };
  const { logits } = await run(feed);
  const units = logits.dims[2];
  return codes.map((code, i) => i === 0 || (!NO_START.has(code) && !LEADING.has(codes[i - 1]) &&
    Math.max(...Array.from({ length: UNIT + 1 }, (_, k) => logits.data[i * units + k])) >= 0));
}

function segmenter(dir) {
  let model;
  // Words of a text, whitespace dropped; runs of ASCII letters or of digits are never split.
  return async function words(text) {
    model ??= load(dir).catch(error => { model = undefined; throw error; });
    const loaded = await model;
    const chars = [...text];
    const cuts = new Set();
    let start = 0;
    for (const line of text.split('\n')) {
      const lineChars = [...line];
      const idx = lineChars.flatMap((c, j) => SPACE.test(c) ? [] : [start + j]);
      if (idx.length > MAX_LINE) throw new Error('thai_words_line_too_long');
      if (idx.length) (await starts(loaded, idx.map(j => chars[j]))).forEach((s, k) => { if (s && k > 0) cuts.add(idx[k]); });
      start += lineChars.length + 1;
    }
    const space = chars.flatMap((c, j) => SPACE.test(c) ? [j] : []);
    const cut = new Set([...[...cuts].filter(j => !sameRun(chars[j - 1], chars[j])), ...space, ...space.map(j => j + 1)]);
    const bounds = [0, ...[...cut].filter(j => j > 0 && j < chars.length).sort((a, b) => a - b), chars.length];
    return bounds.slice(1).map((end, i) => chars.slice(bounds[i], end).join('')).filter(t => t && !SPACE.test(t));
  };
}

const latte = segmenter(path.join(process.cwd(), 'app/api/chat/thai-words'));
const icu = new Intl.Segmenter('th', { granularity: 'word' });
let warned = false;

// Words of a text for search and ranking. ICU word breaks stand in when the model cannot load or run,
// so a chat never fails on word splitting; `splitter` says which one answered.
export async function thaiWords(text) {
  try {
    return { words: await latte(text), splitter: 'latte' };
  } catch (error) {
    if (!warned) { warned = true; console.error('thai_words_fallback', error instanceof Error ? error.message : 'unknown'); }
    return { words: [...icu.segment(text)].filter(x => x.isWordLike).map(x => x.segment), splitter: 'icu' };
  }
}
