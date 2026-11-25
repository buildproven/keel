import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { gateCardForIssue, issueBranchHint } from '../src/check-card.js';
import { LINEAR_KEY_NAMES } from '../src/env.js';
import { gate } from '../src/gate.js';
import { cardFromIssue } from '../src/linear.js';
import { UsageError } from '../src/usage.js';
import { FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g, tmp, write } from './helpers.js';

const BIN = resolve('bin/keel.js');

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

/** `keel` in `cwd` with no Linear key, so no test reaches Linear. */
function keel(cwd, args) {
  const env = { ...process.env, TMPDIR: tmp('keel-tmpdir-') };
  for (const n of LINEAR_KEY_NAMES) delete env[n];
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
}

const ISSUE = {
  id: 'BUI-1',
  title: 'add numbers',
  estimate: 3,
  labels: ['Feature'],
  description:
    'Fix add.\n\n## Requirements\n\n- When add runs, it shall add.\n\n```keel\npaths: src/add.js, test/add.test.js, package.json\nallowEdits: package.json\n```\n',
};
const issues =
  (list = [ISSUE]) =>
  async () =>
    list;

/** The held-out dir `keel run` writes for issue `id` of the checkout `repo` (run.js `heldDir`). */
const runHeldDir = (repo, id) =>
  join(
    process.env.KEEL_STATE_DIR,
    'heldout',
    `${basename(repo)}-${createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 8)}-${id}`,
  );

const HELD_TEST = {
  'test/held.test.js': "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n",
};

test('REQ-CARD-17 an issue ID maps to the card keel run builds: kind, size, paths and allowEdits', async () => {
  const { dir } = fixtureRepo();
  const card = await gateCardForIssue({ repo: dir, id: 'BUI-1', issues: issues() });
  const expected = cardFromIssue(ISSUE);
  assert.equal(card.id, 'BUI-1');
  assert.equal(card.kind, expected.kind);
  assert.equal(card.size, 'M');
  assert.deepEqual(card.paths, expected.paths);
  assert.deepEqual(card.allowEdits, ['package.json']);
});

test('REQ-CARD-17 an ID that is not an open issue is a usage error naming it', async () => {
  const { dir } = fixtureRepo();
  await assert.rejects(gateCardForIssue({ repo: dir, id: 'BUI-2', issues: issues() }), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /^gate: BUI-2 is not an open issue of the project$/);
    return true;
  });
});

test('REQ-CARD-17 keel gate --card <ISSUE-ID> reads the issue from Linear, not a card file', () => {
  const { dir } = fixtureRepo();
  commit(
    dir,
    { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, linearProject: 'demo', review: false }) },
    'chore: cfg',
  );
  const r = keel(dir, ['gate', '--card', 'BUI-1', '--base', 'HEAD']);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /card BUI-1 is not in the base commit/);
  assert.match(r.stderr, new RegExp(`${LINEAR_KEY_NAMES[0]} is not set`));
});

test('REQ-CARD-18 the held-out dir keel run wrote for the issue is the card heldOut, also from a linked worktree', async () => {
  const { dir, base } = fixtureRepo();
  const repo = realpathSync(dir);
  const held = runHeldDir(repo, 'BUI-1');
  mkdirSync(held, { recursive: true });
  write(held, HELD_TEST);
  assert.equal((await gateCardForIssue({ repo, id: 'BUI-1', issues: issues() })).heldOut, held);

  const wt = join(realpathSync(tmp('keel-wt-')), 'keel-BUI-1');
  g(repo, 'worktree', 'add', '-q', '-b', 'keel/BUI-1', wt, base);
  commit(wt, { ...FIXED_SRC, ...REGRESSION_TEST });
  const card = await gateCardForIssue({ repo: wt, id: 'BUI-1', issues: issues() });
  assert.equal(card.heldOut, held);
  const r = gate({ repo: wt, base, card, config: fixtureConfig() });
  const stage = r.results.find((x) => x.name === 'held-out');
  assert.equal(stage?.pass, true, JSON.stringify(r.results));
});

test('REQ-CARD-18 a heldOut the issue names itself is kept', async () => {
  const { dir } = fixtureRepo();
  const own = realpathSync(tmp('keel-own-held-'));
  mkdirSync(runHeldDir(realpathSync(dir), 'BUI-1'), { recursive: true });
  const issue = { ...ISSUE, description: ISSUE.description.replace('allowEdits:', `heldOut: ${own}\nallowEdits:`) };
  assert.equal((await gateCardForIssue({ repo: dir, id: 'BUI-1', issues: issues([issue]) })).heldOut, own);
});

test('REQ-CARD-18 with no held-out dir, a size that needs one fails held-out-required naming the expected dir', async () => {
  const { dir, base } = fixtureRepo();
  const repo = realpathSync(dir);
  commit(repo, { ...FIXED_SRC, ...REGRESSION_TEST });
  const card = await gateCardForIssue({ repo, id: 'BUI-1', issues: issues() });
  assert.equal(card.heldOut, null);
  const r = gate({ repo, base, card, config: fixtureConfig() });
  const stage = r.results.find((x) => x.name === 'held-out');
  assert.equal(stage?.pass, false, JSON.stringify(r.results));
  assert.equal(stage.problems[0].rule, 'held-out-required');
  assert.equal(stage.problems[0].expected, runHeldDir(repo, 'BUI-1'));
  assert.ok(stage.problems[0].detail.includes(runHeldDir(repo, 'BUI-1')), stage.problems[0].detail);
});

test('REQ-CARD-18 with no held-out dir, a size S card needs none and the gate passes', async () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST });
  const card = await gateCardForIssue({ repo: dir, id: 'BUI-1', issues: issues([{ ...ISSUE, estimate: 1 }]) });
  assert.equal(card.size, 'S');
  const r = gate({ repo: dir, base, card, config: fixtureConfig() });
  assert.equal(r.pass, true, JSON.stringify(r.results));
});

test('REQ-CARD-19 the hint names only a keel/<ISSUE-ID> branch', () => {
  const { dir } = fixtureRepo();
  assert.equal(issueBranchHint(dir), null, 'main');
  for (const [branch, hint] of [
    ['keel/BUI-7', 'branch keel/BUI-7: pass --card BUI-7 to gate with its card'],
    ['keel/BUI-7-x', null],
    ['keel/bui-7', null],
    ['fix/BUI-7', null],
  ]) {
    g(dir, 'checkout', '-q', '-B', branch);
    assert.equal(issueBranchHint(dir), hint, branch);
  }
  g(dir, 'checkout', '-q', '--detach');
  assert.equal(issueBranchHint(dir), null, 'detached');
});

test('REQ-CARD-19 keel gate on keel/BUI-1 without --card logs the hint before it gates', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: false }) }, 'chore: cfg');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-1');
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add numbers');
  const r = keel(dir, ['gate', '--base', 'main']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stderr.split('\n');
  const hint = lines.indexOf('keel: branch keel/BUI-1: pass --card BUI-1 to gate with its card');
  assert.ok(hint >= 0, r.stderr);
  assert.ok(hint < lines.findIndex((l) => /^keel: (PASS|FAIL) /.test(l)), r.stderr);
});

test('REQ-CARD-17 a card file named like an issue ID is still read as a file', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: false }) }, 'chore: cfg');
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, 'fix: add numbers');
  const cwd = tmp('keel-cards-');
  write(cwd, { 'BUI-1': '# BUI-1: fix add\nkind: bug\nsize: S\n\n## Requirements\n\nadd adds.\n' });
  const r = keel(cwd, ['gate', '--card', 'BUI-1', '--repo', dir, '--base', 'HEAD~1']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /from Linear|is not set/);
});
