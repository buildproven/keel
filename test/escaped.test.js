import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { escapedDefects, formatEscaped } from '../src/escaped.js';
import { readLedger, stateDir } from '../src/ledger.js';
import { run } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, FIXED_SRC, g, REGRESSION_TEST, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

const accepted = (over) => ({ run: over.card, attempt: 1, tier: 0, attemptPass: true, at: new Date().toISOString(), ...over });

/** A Keel branch squash-merged to main under a subject that does not name the card, then later commits on main. */
function mergedRepo() {
  const { dir, base } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/add-fix');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add sums');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'README.md': 'unrelated\n' }, 'docs: readme');
  g(dir, 'merge', '-q', '--squash', 'keel/add-fix');
  const merge = commit(dir, {}, 'fix add (#1)');
  commit(dir, { 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b);\n' }, 'fix: add coerces strings');
  commit(dir, { 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b); // sum\n' }, 'feat: comment add');
  commit(dir, { 'README.md': 'fixed\n' }, 'fix(docs): readme typo');
  return { dir, base, head, merge };
}

test('REQ-LED-6 finds a squash-merged Keel change by patch identity and lists later fix: commits on its files', () => {
  const { dir, base, head, merge } = mergedRepo();
  const result = escapedDefects([accepted({ card: 'add-fix', repo: dir, base, head })]);
  assert.equal(result.merged.length, 1);
  const [m] = result.merged;
  assert.equal(m.card, 'add-fix');
  assert.equal(m.mergeSha, merge);
  assert.deepEqual(
    m.candidates.map((c) => c.subject),
    ['fix: add coerces strings'],
    'feat: on the same file and fix: on another file are not candidates',
  );
  assert.deepEqual(m.candidates[0].files, ['src/add.js']);
  const text = formatEscaped(result);
  assert.match(text, /add-fix merged [0-9a-f]{7} .* → fix [0-9a-f]{7} .*"fix: add coerces strings" \(src\/add\.js\)/);
  assert.match(text, /merged 1; not found on the default branch 0; later fixed on the same lines or reverted 1/);
});

test('REQ-LED-6 a Linear card merged under its ID counts even when main moved the context; an unmerged run is listed as not found', () => {
  const { dir, base } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-5');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add sums');
  g(dir, 'checkout', '-q', '-b', 'keel/T-6', 'main');
  const unmerged = commit(dir, { 'src/other.js': 'export const x = 1;\n' }, 'feat: other');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'src/add.js': '// header\nexport const add = (a, b) => a - b;\n' }, 'chore: header');
  commit(dir, { 'src/add.js': '// header\nexport const add = (a, b) => a + b;\n', ...REGRESSION_TEST }, 'BUI-5: fix add (#2)');
  const rows = [
    accepted({ card: 'BUI-5', repo: dir, base, head }),
    accepted({ card: 'T-6', run: 'r6', repo: dir, base, head: unmerged }),
    { ...accepted({ card: 'T-7', run: 'r7', repo: dir, base, head: unmerged }), attemptPass: false },
  ];
  const result = escapedDefects(rows);
  assert.deepEqual(
    result.merged.map((m) => m.card),
    ['BUI-5'],
  );
  assert.deepEqual(
    result.notFound.map((n) => [n.card, n.reason]),
    [['T-6', 'not on the default branch']],
    'failed runs are not changes',
  );
});

test('REQ-LED-6 an old row without a base uses its receipt; with neither, the run is reported, not dropped', () => {
  const { dir, base, head } = mergedRepo();
  mkdirSync(join(stateDir(), 'receipts'), { recursive: true });
  writeFileSync(join(stateDir(), 'receipts', `add-fix-${head}-1.json`), JSON.stringify({ base, head, pass: true }));
  const result = escapedDefects([
    accepted({ card: 'add-fix', repo: dir, head }),
    accepted({ card: 'old', run: 'r9', repo: dir, head: base }),
  ]);
  assert.deepEqual(
    result.merged.map((m) => m.card),
    ['add-fix'],
  );
  assert.deepEqual(
    result.notFound.map((n) => [n.card, n.reason]),
    [['old', 'base unknown']],
  );
  const gone = escapedDefects([accepted({ card: 'x', repo: join(dir, 'missing'), base, head })]);
  assert.deepEqual(
    gone.notFound.map((n) => n.reason),
    ['repo missing'],
  );
  const legacy = escapedDefects([{ ...accepted({ card: 'y', base, head }), repo: undefined }]);
  assert.deepEqual(
    legacy.notFound.map((n) => n.reason),
    ['repo unknown'],
  );
  assert.match(formatEscaped(legacy), /^y: repo unknown$/m);
});

test('REQ-LED-6 each keel run ledger row records the base commit it was built on', () => {
  const { dir, base } = fixtureRepo();
  const card = parseCard('# T-1: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
  const tier = { provider: 'exec', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
  run({ repo: dir, card, config: fixtureConfig({ tiers: [tier] }) });
  assert.equal(readLedger()[0].base, base);
});
