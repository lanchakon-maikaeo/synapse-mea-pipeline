import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { thaiWords } from '../app/api/chat/thai-words.mjs';

// Words from the Python runtime of OpenThai2.0-LATTE-WordSeg-Lite 0.1.2 (unit short), recorded on 2026-11-24.
const reference = JSON.parse(readFileSync(new URL('./fixtures/thai-words-reference.json', import.meta.url), 'utf8'));

test('the port splits Thai text into the same words as the reference runtime', async () => {
  for (const { text, words } of reference) {
    const result = await thaiWords(text);
    assert.equal(result.splitter, 'latte');
    assert.deepEqual(result.words, words, text);
  }
});

test('the segmenter finds its model when the process runs from another directory', async () => {
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const entry = new URL('../app/api/chat/thai-words.mjs', import.meta.url).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { thaiWords } = await import(${JSON.stringify(entry)}); console.log(JSON.stringify(await thaiWords('ลูกถ้วยแขวน')))`],
  { cwd: tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.deepEqual(JSON.parse(out), { words: ['ลูก', 'ถ้วย', 'แขวน'], splitter: 'latte' });
});
