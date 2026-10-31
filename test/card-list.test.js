import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';

const card = (header) => `# X: t\nkind: bug\nsize: S\n${header}\n\n## Requirements\n\nx\n`;

test('REQ-CARD-5 a JSON array paths value parses to its strings', () => {
  assert.deepEqual(parseCard(card('paths: ["a.sh", "b.md"]')).paths, ['a.sh', 'b.md']);
  assert.deepEqual(parseCard(card('allowEdits: ["test/x.test.js"]')).allowEdits, ['test/x.test.js']);
  assert.deepEqual(parseCard(card('paths: []')).paths, []);
});

test('REQ-CARD-5 a bracket or quote left in a list item is a named error', () => {
  assert.throws(() => parseCard(card('paths: [a.sh, b.md]')), /paths.*"\[a\.sh"/);
  assert.throws(() => parseCard(card('paths: ["a.sh", 3]')), /paths.*item/);
  assert.throws(() => parseCard(card('allowEdits: "a.sh", b.md')), /allowEdits.*"\\"a\.sh\\""/);
  assert.throws(() => parseCard(card('paths: ["a[1].sh"]')), /paths.*a\[1\]\.sh/);
});

test('REQ-CARD-5 a comma list is unchanged', () => {
  assert.deepEqual(parseCard(card('paths: src/a.js, test/*.js ,docs/**')).paths, ['src/a.js', 'test/*.js', 'docs/**']);
  assert.deepEqual(parseCard(card('paths: a')).allowEdits, []);
});
