import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendAttempt } from '../src/ledger.js';
import { formatValue, value } from '../src/value.js';
import { commit, FIXED_SRC, fixtureRepo, g, REGRESSION_TEST, tmp } from './helpers.js';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const row = (over) => ({ run: over.card, attempt: 1, tier: 0, attemptPass: true, cost: 0.1, at: new Date().toISOString(), ...over });

/** One Keel change merged clean; one hand-written change later needs a fix; the fix itself is not followed. */
function repoWithBaseline() {
  const { dir, base } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/add-fix');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add sums');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'src/other.js': 'export const other = (x) => x.y;\n' }, 'feat: other');
  g(dir, 'merge', '-q', '--squash', 'keel/add-fix');
  commit(dir, {}, 'fix add (#1)');
  commit(dir, { 'src/other.js': 'export const other = (x) => x?.y;\n' }, 'fix: other handles null');
  return { dir, base, head };
}

test('REQ-LED-8 compares the later-fixed share of Keel merges with every other change in the same repos', () => {
  const { dir, base, head } = repoWithBaseline();
  const rows = [
    row({ card: 'add-fix', repo: dir, base, head }),
    { ...row({ card: 'lost', run: 'r2', repo: dir, base }), attemptPass: false },
  ];
  const v = value(rows);
  assert.deepEqual(v.keel, { merged: 1, followed: 0 });
  assert.deepEqual(v.other, { changes: 3, followed: 1 }, 'base, feat: other (fixed later), and the fix itself');
  assert.equal(v.spend.total, 2);
  assert.equal(v.spend.accepted, 1);
  const text = formatValue(v); // REQ-LED-15 reworded these lines; they count the same things.
  assert.match(text, /^Later fixed on the same lines: Keel 0% \(0 of 1\) vs other work 33% \(1 of 3\)$/m);
  assert.match(text, /^Finished cards: 1 of 2 \(50%\)$/m);
  assert.match(text, /^Cost per finished card: builder \$0\.20 \+ review \$0\.00 = \$0\.20$/m);
});

test('REQ-LED-8 with no merged Keel change there is nothing to compare, and the report says so', () => {
  const v = value([]);
  assert.match(formatValue(v), /^Later fixed on the same lines: no Keel change merged yet$/m);
});

test('REQ-LED-8 keel report --value prints the comparison', () => {
  const { dir, base, head } = repoWithBaseline();
  appendAttempt({ ...row({ card: 'add-fix', repo: dir, base, head }), workerStatus: 'ok', gatePass: true, usage: null, durationMs: 1 });
  const out = execFileSync('node', [KEEL, 'report', '--value'], { encoding: 'utf8', env: { ...process.env } });
  assert.match(out, /Later fixed on the same lines: Keel 0% \(0 of 1\) vs other work 33% \(1 of 3\)/);
});

test('REQ-LED-8 two accepted runs of one card that land as one merge count once', () => {
  const { dir, base } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-12');
  const first = commit(dir, { 'src/add.js': 'export const add = (a, b) => b + a;\n' }, 'try 1');
  const second = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'try 2');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'BUI-12: fix add (#3)');
  const rows = [
    row({ card: 'BUI-12', run: 'a', repo: dir, base, head: first }),
    row({ card: 'BUI-12', run: 'b', repo: dir, base, head: second }),
  ];
  assert.deepEqual(value(rows).keel, { merged: 1, followed: 0 });
});
