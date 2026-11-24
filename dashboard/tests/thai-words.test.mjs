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
