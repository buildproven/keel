import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const card = (id = 'T-1') => parseCard(`# ${id}: test card\nkind: bug\nsize: S\n`);
const reviewer = (script) => ({
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', `const p = require('fs').readFileSync(0, 'utf8'); ${script}`],
});
const blocks = reviewer("console.log('FINDING medium src/add.js:1 add ignores NaN'); console.log('VERDICT: block')");
/** A reviewer that saves its prompt and passes. */
function recorder() {
  const file = join(tmp('keel-prompt-'), 'prompt.txt');
  return { file, tier: reviewer(`require('fs').writeFileSync(${JSON.stringify(file)}, p); console.log('VERDICT: pass')`) };
}

function setup() {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  return { dir, base, receiptDir: tmp('keel-receipts-'), config: fixtureConfig({ review: true }) };
}

test('REQ-GATE-23 a re-gate gives the reviewer the previous findings and the change since that review, and limits blocking to them', () => {
  const { dir, base, receiptDir, config } = setup();
  const first = gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: blocks });
  assert.equal(first.pass, false);
  commit(dir, { 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b);\n' }, 'fix: NaN');
  const rec = recorder();
  const second = gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: rec.tier });
  assert.equal(second.pass, true, JSON.stringify(second.results));
  const prompt = readFileSync(rec.file, 'utf8');
  assert.match(prompt, new RegExp(`# Previous review \\(at ${first.head.slice(0, 12)}\\)`));
  assert.match(prompt, /- medium src\/add\.js:1 add ignores NaN/);
  assert.match(prompt, /# Change since the previous review\n[\s\S]*Number\(a\) \+ Number\(b\)/);
  assert.match(
    prompt,
    /Use medium or higher only for a previous finding that is not fixed, or a defect in the change since the previous review/,
  );
});

test('REQ-GATE-23 the first review, another card, or a head that is not a descendant gets the plain prompt', () => {
  const { dir, base, receiptDir, config } = setup();
  const rec = recorder();
  gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: rec.tier });
  assert.doesNotMatch(readFileSync(rec.file, 'utf8'), /Previous review/);
  gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: blocks });
  gate({ repo: dir, base, card: card('T-2'), config, receiptDir, reviewer: rec.tier });
  assert.doesNotMatch(readFileSync(rec.file, 'utf8'), /Previous review/);
  g(dir, 'reset', '-q', '--hard', 'HEAD~1');
  commit(dir, { ...REGRESSION_TEST, 'src/add.js': 'export const add = (a, b) => b + a;\n' }, 'fix: add another way');
  gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: rec.tier });
  assert.doesNotMatch(readFileSync(rec.file, 'utf8'), /Previous review/);
});
