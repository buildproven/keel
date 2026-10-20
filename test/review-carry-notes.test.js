import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const reviewer = (script) => ({
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', `const p = require('fs').readFileSync(0, 'utf8'); ${script}`],
});
const notes = reviewer(
  "console.log('FINDING low src/add.js:1 negative sums are not tested'); console.log('FINDING info src/add.js:1 name is terse'); console.log('VERDICT: pass')",
);
function recorder() {
  const file = join(tmp('keel-prompt-'), 'prompt.txt');
  return { file, tier: reviewer(`require('fs').writeFileSync(${JSON.stringify(file)}, p); console.log('VERDICT: pass')`) };
}
function setup() {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  return { dir, base, receiptDir: tmp('keel-receipts-'), config: fixtureConfig({ review: true }) };
}

test('REQ-GATE-23 a re-gate also shows the previous low and info notes, so a note left unfixed is reported again', () => {
  const { dir, base, receiptDir, config } = setup();
  const first = gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: notes });
  assert.equal(first.pass, true, JSON.stringify(first.results));
  commit(dir, { 'docs/unrelated.md': 'unrelated\n' }, 'docs: unrelated');
  const rec = recorder();
  const second = gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: rec.tier });
  assert.equal(second.pass, true, JSON.stringify(second.results));
  const prompt = readFileSync(rec.file, 'utf8');
  assert.match(prompt, /# Previous review/);
  assert.match(prompt, /- low src\/add\.js:1 negative sums are not tested/);
  assert.match(prompt, /- info src\/add\.js:1 name is terse/);
  assert.match(prompt, /Report again, at its own severity, any previous finding that is not fixed/);
  assert.match(prompt, /a previous info note that is not fixed is `FINDING info <path>:<line> <text>`, which never blocks/);
});

test('REQ-GATE-23 an info note repeated on a re-gate stays an info note: it is kept and never blocks, even at reviewBlock low', () => {
  const { dir, base, receiptDir } = setup();
  const config = fixtureConfig({ review: true, reviewBlock: 'low' });
  const info = reviewer("console.log('FINDING info src/add.js:1 name is terse'); console.log('VERDICT: pass')");
  assert.equal(gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: info }).pass, true);
  commit(dir, { 'docs/unrelated.md': 'unrelated\n' }, 'docs: unrelated');
  const again = gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: info });
  assert.equal(again.pass, true, JSON.stringify(again.results));
  const review = again.results.find((r) => r.name === 'review');
  assert.deepEqual(
    review.notes.map((n) => `${n.severity} ${n.path}:${n.line} ${n.text}`),
    ['info src/add.js:1 name is terse'],
  );
});

test('REQ-GATE-23 a receipt whose notes are not a list of objects is not the previous review; one without notes still is', () => {
  const { dir, base, receiptDir, config } = setup();
  const first = gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: notes });
  const file = join(
    receiptDir,
    readdirSync(receiptDir).find((f) => f.endsWith('.json')),
  );
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  const review = receipt.results.find((r) => r.name === 'review');
  review.notes = 'forged';
  writeFileSync(file, JSON.stringify(receipt));
  commit(dir, { 'docs/unrelated.md': 'unrelated\n' }, 'docs: unrelated');
  const rec = recorder();
  assert.equal(gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: rec.tier }).pass, true);
  assert.doesNotMatch(readFileSync(rec.file, 'utf8'), /Previous review/);
  delete review.notes;
  writeFileSync(file, JSON.stringify({ ...receipt, head: first.head }));
  commit(dir, { 'docs/unrelated2.md': 'unrelated\n' }, 'docs: unrelated 2');
  assert.equal(gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: rec.tier }).pass, true);
  assert.match(readFileSync(rec.file, 'utf8'), /# Previous review/);
});
