import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cardFromIssue } from '../src/linear.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = (mode) => ({ provider: 'exec', family: 'claude', model: 'exec-build', effort: 'low', command: ['node', FAKE, mode] });
// An author that writes one held-out test that fails on base (src/add.js is buggy there) and passes on a good build.
const execAuthor = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-author',
  effort: 'high',
  command: [
    'node',
    '-e',
    "const fs=require('fs');fs.mkdirSync('test',{recursive:true});fs.writeFileSync('test/held.test.js',\"import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n\");console.log(JSON.stringify({total_cost_usd:0.01,usage:{input_tokens:1,output_tokens:1}}));",
  ],
};
// The author on its own provider; a reserved provider must stop the run before any worker, so this CLI never runs.
const codexAuthor = { provider: 'codex', family: 'codex', model: 'gpt-author', effort: 'high' };
const config = (build, author) => fixtureConfig({ tiers: [builder(build), author], heldOutAuthorTier: 1, maxAttempts: 1 });
const RESERVED = new Map([['codex', '5h 80% ≥ 50%']]);
const issue = (text) => ({
  id: 'BUI-9801',
  title: 'Reuse held-out tests on a retry',
  description: `- REQ-RUN-63: ${text}\n`,
  priority: 2,
  createdAt: '2026-11-01',
  labels: ['Bug'],
  estimate: 3,
});
const CARD = 'When add is called, the system shall return the sum.';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-heldout-reuse-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

const authorRows = () => readLedger().filter((r) => r.role === 'held-out-author');
const heldDirs = () => readdirSync(join(process.env.KEEL_STATE_DIR, 'heldout'), { withFileTypes: true }).filter((e) => e.isDirectory());
const calls = () =>
  existsSync(process.env.KEEL_FAKE_LOG)
    ? readFileSync(process.env.KEEL_FAKE_LOG, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

/** The 2026-11-01 incident: held-out tests authored, then the builder hit its quota and the run was deferred. */
function deferredAfterAuthoring(dir) {
  const first = run({ repo: dir, card: cardFromIssue(issue(CARD)), config: config('quota', execAuthor) });
  assert.equal(first.stopped, 'quota', first.failure);
  assert.equal(first.worktree, null, 'the deferred run left a worktree');
  assert.equal(authorRows().length, 1);
  assert.equal(heldDirs().length, 1, 'no held-out dir was kept');
  rmSync(process.env.KEEL_FAKE_LOG, { force: true });
}

test('REQ-RUN-63 a retry of the same card reuses its held-out tests and ignores a reserved author provider', () => {
  const { dir } = fixtureRepo();
  deferredAfterAuthoring(dir);

  const log = [];
  const r = run({
    repo: dir,
    card: cardFromIssue(issue(CARD)),
    config: config('good', codexAuthor),
    reserved: RESERVED,
    log: (m) => log.push(m),
  });

  assert.equal(r.pass, true, `${r.stopped}: ${r.failure}\n${log.join('\n')}`);
  assert.equal(authorRows().length, 1, 'the held-out tests were authored again');
  assert.deepEqual(
    calls().map((c) => c.env.model),
    ['exec-build'],
    'only the builder ran',
  );
  const held = r.receipt.results.find((x) => x.name === 'held-out');
  assert.equal(held?.pass, true, 'the gate did not run the kept held-out tests');
  assert.ok(
    log.some((m) => /reus/.test(m) && /held-out/.test(m)),
    `no reuse logged:\n${log.join('\n')}`,
  );
});

test('REQ-RUN-63 a changed card text authors again, so a reserved author provider defers it as quota before any worker', () => {
  const { dir } = fixtureRepo();
  deferredAfterAuthoring(dir);

  const changed = cardFromIssue(issue(`${CARD} It shall also handle negatives.`));
  const r = run({ repo: dir, card: changed, config: config('good', codexAuthor), reserved: RESERVED });

  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'quota');
  assert.match(r.failure, /held-out author \(tier 1\) is on a provider over its plan window: codex 5h 80% ≥ 50%/);
  assert.equal(r.worktree, null);
  assert.deepEqual(calls(), [], 'a worker ran');
});

test('REQ-RUN-63 a changed card text with an unreserved author writes new held-out tests, and its retry reuses those', () => {
  const { dir } = fixtureRepo();
  deferredAfterAuthoring(dir);

  const changed = cardFromIssue(issue(`${CARD} It shall also handle negatives.`));
  const again = run({ repo: dir, card: changed, config: config('quota', execAuthor) });
  assert.equal(again.stopped, 'quota', again.failure);
  assert.equal(authorRows().length, 2, 'the changed card did not author again');

  const r = run({ repo: dir, card: changed, config: config('good', codexAuthor), reserved: RESERVED });
  assert.equal(r.pass, true, `${r.stopped}: ${r.failure}`);
  assert.equal(authorRows().length, 2, 'the retry of the changed card authored again');
});

test('REQ-RUN-63 a held-out dir that records no card hash (written before REQ-RUN-63) is authored again', () => {
  const { dir } = fixtureRepo();
  deferredAfterAuthoring(dir);
  const root = join(process.env.KEEL_STATE_DIR, 'heldout');
  for (const name of readdirSync(root).filter((n) => !heldDirs().some((d) => d.name === n))) rmSync(join(root, name));
  assert.equal(heldDirs().length, 1, 'the held-out tests themselves must stay');

  const r = run({ repo: dir, card: cardFromIssue(issue(CARD)), config: config('good', execAuthor) });

  assert.equal(r.pass, true, `${r.stopped}: ${r.failure}`);
  assert.equal(authorRows().length, 2, 'a held-out dir of unknown card text was reused');
});

test('REQ-RUN-63 held-out tests re-authored after a defect check record the card hash, so a retry reuses them', () => {
  const { dir } = fixtureRepo();
  const REASON = 'it asserts add(1,1) is 3';
  // A defective held-out test no build can pass; it names the same failing test each run (REQ-RUN-46).
  const BAD =
    "import { add } from '../src/add.js';\nif (add(1, 1) !== 3) {\n  console.log('not ok 1 - REQ-ADD-1 adds one and one');\n  throw new Error('held-out failed');\n}\n";
  const GOOD = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n";
  const defectAuthor = {
    provider: 'exec',
    family: 'codex',
    model: 'exec-author',
    effort: 'high',
    command: [
      'node',
      '-e',
      `const fs = require('fs');
const p = fs.readFileSync(0, 'utf8');
fs.mkdirSync('test', { recursive: true });
fs.writeFileSync('test/held.test.js', p.includes(${JSON.stringify(REASON)}) ? ${JSON.stringify(GOOD)} : ${JSON.stringify(BAD)});
console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
    ],
  };
  const judge = {
    provider: 'exec',
    family: 'judge',
    model: 'exec-judge',
    effort: 'high',
    command: ['node', FAKE, `say:DEFECT: ${REASON}`],
  };
  const card = cardFromIssue(issue(CARD));
  const first = run({
    repo: dir,
    card,
    config: fixtureConfig({ tiers: [builder('good'), builder('good'), defectAuthor, judge], heldOutAuthorTier: 2, maxAttempts: 3 }),
  });
  assert.equal(first.pass, true, first.failure);
  assert.equal(authorRows().length, 2, 'authored, then re-authored after the defect check');
  g(dir, 'worktree', 'remove', '--force', first.worktree);
  g(dir, 'branch', '-D', first.branch);

  const r = run({
    repo: dir,
    card,
    config: fixtureConfig({ tiers: [builder('good'), builder('good'), codexAuthor], heldOutAuthorTier: 2, maxAttempts: 1 }),
    reserved: RESERVED,
  });
  assert.equal(r.pass, true, `${r.stopped}: ${r.failure}`);
  assert.equal(authorRows().length, 2, 'the re-authored set was not reused');
});

test('REQ-RUN-63 a recorded card hash without its held-out dir is authored again', () => {
  const { dir } = fixtureRepo();
  deferredAfterAuthoring(dir);
  for (const d of heldDirs()) rmSync(join(process.env.KEEL_STATE_DIR, 'heldout', d.name), { recursive: true });

  const r = run({ repo: dir, card: cardFromIssue(issue(CARD)), config: config('good', execAuthor) });

  assert.equal(r.pass, true, `${r.stopped}: ${r.failure}`);
  assert.equal(authorRows().length, 2, 'a missing held-out dir was treated as reusable');
});
