import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = (id) => parseCard('# derived card\nkind: bug\nsize: S\n', `${id}.md`);
const reviewer = (script) => ({
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', `const p = require('fs').readFileSync(0, 'utf8'); ${script}`],
});

test('REQ-GATE-23 a receipt of a card whose id only starts with this card id is not the previous review', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  const receiptDir = tmp('keel-receipts-');
  const config = fixtureConfig({ review: true });
  const blocks = reviewer("console.log('FINDING medium src/add.js:1 add ignores NaN'); console.log('VERDICT: block')");
  const other = gate({ repo: dir, base, card: card('feature-fix'), config, receiptDir, reviewer: blocks });
  assert.equal(other.card, 'feature-fix');
  commit(dir, { 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b);\n' }, 'fix: NaN');
  const file = join(tmp('keel-prompt-'), 'prompt.txt');
  const rec = reviewer(`require('fs').writeFileSync(${JSON.stringify(file)}, p); console.log('VERDICT: pass')`);
  gate({ repo: dir, base, card: card('feature'), config, receiptDir, reviewer: rec });
  assert.doesNotMatch(readFileSync(file, 'utf8'), /Previous review/);
});
