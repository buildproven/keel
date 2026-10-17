import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { formatValue, value } from '../src/value.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const row = (over) => ({ run: over.card, attempt: 1, tier: 0, attemptPass: true, cost: 0.1, at: new Date().toISOString(), ...over });

test('REQ-LED-15 the value report leads with plain lines a non-engineer can read', () => {
  const { dir, base } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/add-fix');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add sums');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'src/other.js': 'export const other = (x) => x.y;\n' }, 'feat: other');
  g(dir, 'merge', '-q', '--squash', 'keel/add-fix');
  commit(dir, {}, 'fix add (#1)');
  commit(dir, { 'src/other.js': 'export const other = (x) => x?.y;\n' }, 'fix: other handles null');
  const rows = [
    row({ card: 'add-fix', repo: dir, base, head, usage: { in: 1000, out: 500, cached: 0 } }),
    { ...row({ card: 'lost', run: 'r2', repo: dir, base, usage: { in: 100, out: 0, cached: 0 } }), attemptPass: false },
  ];
  const lines = formatValue(value(rows)).split('\n');
  assert.equal(lines[0], 'Finished cards: 1 of 2 (50%)');
  assert.equal(lines[1], 'Human touch rate: n/a (no polled issue yet; target under 5%)');
  assert.ok(lines.includes('Tokens per finished card: builder 1.6k + review 0 = 1.6k'), lines.join('\n'));
  assert.ok(lines.includes('Cost per finished card: builder $0.20 + review $0.00 = $0.20'), lines.join('\n'));
  assert.ok(lines.includes('Later fixed on the same lines: Keel 0% (0 of 1) vs other work 33% (1 of 3)'), lines.join('\n'));
  assert.ok(lines.includes('Cost by repo (what ran vs the same tokens on the top tier):'), lines.join('\n'));
});

test('REQ-LED-15 with no merged Keel change the quality line says there is nothing to compare yet', () => {
  assert.match(formatValue(value([])), /^Later fixed on the same lines: no Keel change merged yet$/m);
  assert.match(formatValue(value([])), /^Finished cards: 0 of 0$/m);
});
