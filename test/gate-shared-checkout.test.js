import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXTURE_TEST, commit, fixtureConfig, fixtureRepo, g, tmp, write } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = (header) => parseCard(`# T-1: test card\n${header}\n`);
const HELD_PASS = "import assert from 'node:assert';\nassert.ok(true);\n";
// The reviewer records whether it sees a file an earlier stage left, then passes.
const reviewer = (log) => ({
  provider: 'exec',
  family: 'claude',
  model: 'exec-review',
  effort: 'high',
  command: [
    'node',
    '-e',
    `const fs = require('fs'); fs.readFileSync(0); fs.appendFileSync(${JSON.stringify(log)}, fs.existsSync('leftover.txt') ? 'seen\\n' : 'clean\\n'); console.log('VERDICT: pass')`,
  ],
});

/** Run fn with GIT_TRACE on; returns fn's result and the head SHAs every `git worktree add` checked out. */
function traced(fn) {
  const trace = join(tmp('keel-trace-'), 'git.trace');
  const before = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace;
  try {
    const out = fn();
    const adds = existsSync(trace)
      ? readFileSync(trace, 'utf8')
          .split('\n')
          .filter((l) => /built-in: git .*worktree add /.test(l))
          .map((l) => l.trim().split(' ').at(-1))
      : [];
    return { out, adds };
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = before;
  }
}

const ownTemps = () => {
  const root = join(tmpdir(), 'keel.noindex');
  return existsSync(root)
    ? readdirSync(root).filter((n) => n.startsWith(`keel-wt-${process.pid}-`) || n.startsWith(`keel-prepared-${process.pid}-`))
    : [];
};

test('REQ-GATE-57: one gate with checks, held-out, and review creates one head worktree', () => {
  const { dir, base } = fixtureRepo();
  const head = commit(dir, { 'docs/note.md': 'a note\n' });
  const held = tmp('keel-held-');
  write(held, { 'test/held.test.js': HELD_PASS });
  const log = join(tmp('keel-review-'), 'review.log');
  const r1 = reviewer(log);
  const { out: receipt, adds } = traced(() =>
    gate({
      repo: dir,
      base,
      card: card(`kind: chore\nsize: M\nheldOut: ${held}`),
      config: fixtureConfig({ review: true, reviewFallback: false, tiers: [r1] }),
      reviewer: r1,
    }),
  );
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
  assert.deepEqual(
    receipt.results.map((x) => x.name).filter((n) => ['test', 'held-out', 'review'].includes(n)),
    ['test', 'held-out', 'review'],
  );
  assert.deepEqual(
    adds.filter((sha) => sha === head),
    [head],
    `one head worktree for every head stage: ${adds.join(', ')}`,
  );
});

test('REQ-GATE-58: a file a check writes is gone before the held-out stage', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'docs/note.md': 'a note\n' });
  const held = tmp('keel-held-');
  write(held, {
    'test/held.test.js':
      "import assert from 'node:assert';\nimport { existsSync } from 'node:fs';\nassert.ok(!existsSync('leftover.txt'), 'leftover.txt from a check');\n",
  });
  const log = join(tmp('keel-review-'), 'review.log');
  const r1 = reviewer(log);
  const receipt = gate({
    repo: dir,
    base,
    card: card(`kind: chore\nsize: M\nheldOut: ${held}`),
    config: fixtureConfig({
      checks: { test: `echo x > leftover.txt && ${FIXTURE_TEST}` },
      heldOutCommand: `${FIXTURE_TEST} && echo y > leftover.txt`,
      review: true,
      reviewFallback: false,
      tiers: [r1],
    }),
    reviewer: r1,
  });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
  // The reviewer, the stage after held-out, does not see the file the held-out command wrote either.
  assert.equal(readFileSync(log, 'utf8'), 'clean\n');
});

test('REQ-GATE-59: a failed reset falls back to a fresh worktree with an IMPROVE line', () => {
  const { dir, base } = fixtureRepo();
  const head = commit(dir, { 'docs/note.md': 'a note\n' });
  const held = tmp('keel-held-');
  write(held, { 'test/held.test.js': HELD_PASS });
  // A read-only directory with a file in it: `git clean` cannot remove the file, so the reset fails.
  const { out: receipt, adds } = traced(() =>
    gate({
      repo: dir,
      base,
      card: card(`kind: chore\nsize: M\nheldOut: ${held}`),
      config: fixtureConfig({ checks: { test: `mkdir -p ro && touch ro/f && chmod 555 ro && ${FIXTURE_TEST}` } }),
    }),
  );
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
  assert.equal(adds.filter((sha) => sha === head).length, 2, 'the shared checkout and one fresh fallback');
  const lines = (receipt.improve ?? []).filter((l) => /fresh worktree/.test(l));
  assert.equal(lines.length, 1, JSON.stringify(receipt.improve));
  assert.match(lines[0], /^IMPROVE: .*Permission denied/);
  assert.deepEqual(ownTemps(), []);
});

test('REQ-GATE-60: the shared head checkout is removed after the gate on pass, fail, and throw', () => {
  const held = tmp('keel-held-');
  write(held, { 'test/held.test.js': HELD_PASS });
  const worktrees = (dir) =>
    g(dir, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '));
  for (const [checks, outcome] of [
    [{ test: FIXTURE_TEST }, 'pass'],
    [{ test: FIXTURE_TEST, lint: 'exit 1' }, 'fail'],
    [{ test: FIXTURE_TEST, bad: 5 }, 'throw'],
  ]) {
    const { dir, base } = fixtureRepo();
    commit(dir, { 'docs/note.md': 'a note\n' });
    const run = () =>
      gate({
        repo: dir,
        base,
        card: card(`kind: chore\nsize: M\nheldOut: ${held}`),
        config: fixtureConfig({ checks, install: 'mkdir -p dist && echo built > dist/generated.txt' }),
      });
    if (outcome === 'throw') assert.throws(run);
    else assert.equal(run().pass, outcome === 'pass');
    assert.deepEqual(ownTemps(), [], outcome);
    assert.equal(worktrees(dir).length, 1, outcome);
  }
});

test('REQ-GATE-57: with install set, one gate installs once and later head stages keep what it made', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'docs/note.md': 'a note\n' });
  const held = tmp('keel-held-');
  write(held, {
    'test/held.test.js':
      "import assert from 'node:assert';\nimport { existsSync } from 'node:fs';\nassert.ok(existsSync('node_modules/dep.txt'));\n",
  });
  const log = join(tmp('keel-install-'), 'install.log');
  const receipt = gate({
    repo: dir,
    base,
    card: card(`kind: chore\nsize: M\nheldOut: ${held}`),
    config: fixtureConfig({ install: `echo run >> ${JSON.stringify(log)} && mkdir -p node_modules && echo dep > node_modules/dep.txt` }),
  });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
  assert.deepEqual(
    receipt.results.map((x) => x.name).filter((n) => ['install', 'test', 'held-out'].includes(n)),
    ['install', 'test', 'held-out'],
  );
  assert.equal(readFileSync(log, 'utf8'), 'run\n');
});

test('REQ-GATE-57: later head stages keep install artifacts outside shared dependency dirs', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'docs/note.md': 'a note\n' });
  const held = tmp('keel-held-');
  write(held, {
    'test/held.test.js':
      "import assert from 'node:assert';\nimport { readFileSync } from 'node:fs';\nassert.equal(readFileSync('dist/generated.txt', 'utf8'), 'built\\n');\n",
  });
  const log = join(tmp('keel-install-'), 'install.log');
  const receipt = gate({
    repo: dir,
    base,
    card: card(`kind: chore\nsize: M\nheldOut: ${held}`),
    config: fixtureConfig({
      install: `echo run >> ${JSON.stringify(log)} && mkdir -p dist && echo built > dist/generated.txt`,
      checks: { test: `echo changed > dist/generated.txt && ${FIXTURE_TEST}` },
    }),
  });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
  assert.equal(readFileSync(log, 'utf8'), 'run\n');
  assert.deepEqual(ownTemps(), []);
});
