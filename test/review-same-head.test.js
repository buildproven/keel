import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const reviewer = (script) => ({
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', `const p = require('fs').readFileSync(0, 'utf8'); ${script}`],
});

test('REQ-GATE-23 a re-gate of the same head counts that head as its own ancestor and gets its previous findings', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  const receiptDir = tmp('keel-receipts-');
  const config = fixtureConfig({ review: true });
  const blocks = reviewer("console.log('FINDING medium src/add.js:1 add ignores NaN'); console.log('VERDICT: block')");
  const first = gate({ repo: dir, base, card, config, receiptDir, reviewer: blocks });
  assert.equal(first.pass, false);
  const file = join(tmp('keel-prompt-'), 'prompt.txt');
  const rec = reviewer(`require('fs').writeFileSync(${JSON.stringify(file)}, p); console.log('VERDICT: pass')`);
  const second = gate({ repo: dir, base, card, config, receiptDir, reviewer: rec });
  assert.equal(second.head, first.head);
  const prompt = readFileSync(file, 'utf8');
  assert.match(prompt, new RegExp(`# Previous review \\(at ${first.head.slice(0, 12)}\\)`));
  assert.match(prompt, /- medium src\/add\.js:1 add ignores NaN/);
});
