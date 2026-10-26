import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { formatReport, readLedger, report } from '../src/ledger.js';
import { buildPrompt, describeStop, nextTier, run, startTier } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const tier = (mode, provider = 'exec') => ({
  provider: 'exec',
  model: `${provider}-${mode}`,
  effort: 'low',
  command: ['node', FAKE, mode],
  family: provider,
});
const card = (header = 'kind: bug\nsize: S', title = 'T-7: fix add') =>
  parseCard(`# ${title}\n${header}\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n`);
let logFile;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
});
const calls = () =>
  readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test('REQ-RUN-1 REQ-RUN-4 passes on the cheapest tier and stops', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('good'), tier('crash')] }) });
  assert.equal(r.pass, true);
  assert.equal(r.tier, 0);
  assert.equal(r.branch, 'keel/T-7');
  assert.equal(g(r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'keel/T-7');
  assert.match(r.worktree, /-[0-9a-f]{8}-T-7$/);
  assert.equal(calls().length, 1);
  assert.equal(g(dir, 'status', '--porcelain'), '', 'main checkout stays clean');
});

test('REQ-RUN-3 escalates one tier and feeds only the gate failure', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('fix-only'), tier('good')] }) });
  assert.equal(r.pass, true);
  assert.equal(r.tier, 1);
  const [first, second] = calls();
  assert.ok(!first.prompt.includes('previous attempt failed'));
  assert.match(second.prompt, /previous attempt failed the gate[\s\S]*no-test-changed/);
});

test('REQ-RUN-5 stops after maxAttempts and keeps the worktree', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('fix-only')], maxAttempts: 2 }) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'max-attempts');
  assert.ok(existsSync(r.worktree));
  assert.equal(calls().length, 2);
  const retry = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('good')] }) });
  assert.equal(retry.pass, true, retry.failure);
  assert.equal(retry.worktree, r.worktree);
  assert.equal(calls().length, 3);
});

test('REQ-RUN-6 a crashing worker escalates; auth stops; quota switches provider or stops', () => {
  const { dir } = fixtureRepo();
  const crash = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('crash'), tier('good')] }) });
  assert.equal(crash.tier, 1);
  assert.match(calls()[1].prompt, /worker error/);

  const auth = run({
    repo: dir,
    card: card('kind: bug\nsize: S', 'T-8: auth'),
    config: fixtureConfig({ tiers: [tier('auth'), tier('good')] }),
  });
  assert.deepEqual([auth.pass, auth.stopped], [false, 'auth']);

  assert.equal(nextTier([{ provider: 'claude' }, { provider: 'claude' }, { provider: 'codex' }], 0, 0, 'quota'), 2);
  assert.equal(nextTier([{ provider: 'claude' }, { provider: 'claude' }], 0, 0, 'quota'), null);
  assert.equal(nextTier([{ provider: 'claude' }, { provider: 'claude' }], 0, 0, 'error'), 1);
  // REQ-RUN-11: a network failure retries the same tier (a stronger model fixes nothing about a dropped
  // connection) for up to 2 same-tier attempts, then escalates like an ordinary error would.
  const tiers2 = [{ provider: 'claude' }, { provider: 'claude' }];
  assert.equal(nextTier(tiers2, 0, 0, 'network', 0), 0, 'first network failure: retry the same tier');
  assert.equal(nextTier(tiers2, 0, 0, 'network', 1), 0, 'second network failure: still the same tier');
  assert.equal(nextTier(tiers2, 0, 0, 'network', 2), 1, 'third network failure in a row: escalate, do not loop forever');
  const quota = run({
    repo: dir,
    card: card('kind: bug\nsize: S', 'T-9: quota'),
    config: fixtureConfig({ tiers: [tier('quota'), tier('good')] }),
  });
  assert.deepEqual([quota.pass, quota.stopped], [false, 'quota'], 'same provider (exec) after quota: stop, do not burn attempts');
});

test('REQ-RUN-7 commits leftover worker changes before the gate', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('good')] }) });
  assert.equal(g(r.worktree, 'status', '--porcelain'), '');
  assert.match(g(r.worktree, 'log', '-1', '--format=%s'), /keel attempt 1 leftovers/);
});

test('REQ-RUN-8 exec workers receive the tier model and effort', () => {
  const { dir } = fixtureRepo();
  run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('good')] }) });
  assert.deepEqual(calls()[0].env, { model: 'exec-good', effort: 'low' });
});

test('REQ-RUN-9 a worker that exits non-zero fails even when the gate would pass', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('good-exit42'), tier('good')] }) });
  assert.equal(r.tier, 1);
  assert.deepEqual(
    readLedger().map((x) => [x.workerStatus, x.gatePass]),
    [
      ['error', true],
      ['ok', true],
    ],
  );
});

test('REQ-RUN-2 start tier rises for size L, infra, and protected paths', () => {
  const config = fixtureConfig({ startTier: { L: 2, protected: 1 } });
  assert.equal(startTier(card(), config), 0);
  assert.equal(startTier(card('kind: bug\nsize: L'), config), 2);
  assert.equal(startTier(card('kind: bug\nsize: S\npaths: src/auth/**'), config), 1);
  assert.equal(startTier(card('kind: infra\nsize: S'), config), 1);
});

test('REQ-RUN-3 prompt carries kind rules, scope, checks, and the card without the held-out path', () => {
  const p = buildPrompt(card('kind: refactor\nsize: S\npaths: src/**'), fixtureConfig(), null);
  assert.match(p, /Do not change any existing test file/);
  assert.match(p, /Change only files matching: src\/\*\*/);
  assert.match(p, /REQ-ADD-1/);
  assert.ok(!buildPrompt(card('kind: bug\nsize: M\nheldOut: /secret/h'), fixtureConfig(), null).includes('/secret/h'));
});

test('REQ-RUN-4 opens the PR with literal argv (no shell) and as a draft when protected files change', () => {
  const { dir } = fixtureRepo();
  const remote = tmp('keel-remote-');
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  const bin = tmp('keel-bin-');
  const argvLog = join(bin, 'gh-argv.json');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node\nif (process.argv[2] === 'pr') require('fs').writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('https://example.test/pr/1');\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const marker = join(dir, 'PWNED');
  const title = `T-7: $(touch ${marker}) \`touch ${marker}\` "quote" 'single'`;
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const r = run({
      repo: dir,
      card: card('kind: bug\nsize: S', title),
      config: fixtureConfig({ tiers: [tier('good')], protected: ['src/**'] }),
      pr: true,
    });
    assert.equal(r.pr.ok, true, r.pr.out);
    assert.equal(r.needsReview, true);
  } finally {
    process.env.PATH = oldPath;
  }
  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  assert.equal(argv[argv.indexOf('--title') + 1], title);
  assert.equal(argv[argv.indexOf('--base') + 1], 'main');
  assert.ok(argv.includes('--draft'));
  assert.ok(!existsSync(marker), 'card title must never run as shell');
  assert.equal(g(remote, 'rev-parse', 'keel/T-7'), g(dir, 'rev-parse', 'keel/T-7'), 'remote branch is the certified commit');
});

test('REQ-LED-1 REQ-LED-2 REQ-LED-3 ledger rows and report count every run', () => {
  const { dir } = fixtureRepo();
  run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('no-usage'), tier('good')] }) });
  run({ repo: dir, card: card('kind: bug\nsize: S', 'T-10: never'), config: fixtureConfig({ tiers: [tier('fix-only')], maxAttempts: 1 }) });
  const rows = readLedger();
  assert.deepEqual(
    rows.map((r) => [r.card, r.attempt, r.tier, r.gatePass, r.usageMissing]),
    [
      ['T-7', 1, 0, false, true],
      ['T-7', 2, 1, true, false],
      ['T-10', 1, 0, false, false],
    ],
  );
  assert.deepEqual(rows[1].usage, { in: 100, out: 10, cached: 50 });
  assert.ok(rows[1].gateMs >= 0);
  const rep = report(rows);
  assert.deepEqual([rep.passed, rep.total, rep.tier0Share], [1, 2, 0]);
  assert.match(formatReport(rep), /T-7 +attempts=2 passTier=1 tokens=110 cached=50 \(usage missing on 1\)/);
  assert.match(formatReport(rep), /passed 1\/2; passed on tier 0: 0%/);
});

test('REQ-RUN-7 a worker that leaves the keel branch fails the attempt, so a different commit is never published', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('detach')], maxAttempts: 1 }) });
  assert.equal(r.pass, false);
  assert.match(r.failure, /left branch keel\/T-7/);
});

test('REQ-LED-3 a run whose worker failed is not reported as a success even if the gate passed', () => {
  const { dir } = fixtureRepo();
  run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('good-exit42')], maxAttempts: 1 }) });
  const rep = report(readLedger());
  assert.deepEqual([rep.passed, rep.total], [0, 1]);
  assert.equal(readLedger()[0].attemptPass, false);
});

test('REQ-RUN-11 a network failure retries the same tier before escalating, in a real run', () => {
  const { dir } = fixtureRepo();
  // Every tier is 'network' except tier 1 is 'good': a run that escalated on the very first network
  // failure (the old behavior) would pass at tier 1 on attempt 2. Correct behavior stays on tier 0
  // through its retry budget and only reaches tier 1 (and passes) on attempt 4.
  const r = run({
    repo: dir,
    card: card(),
    config: fixtureConfig({ tiers: [tier('network'), tier('good')], maxAttempts: 4 }),
  });
  assert.equal(r.pass, true);
  assert.equal(r.attempt, 4);
  assert.equal(r.tier, 1);
  const tiersUsed = readLedger()
    .filter((row) => row.card === 'T-7')
    .map((row) => row.tier);
  assert.deepEqual(tiersUsed, [0, 0, 0, 1], 'stays on tier 0 through its network-retry budget before escalating');
});

test('REQ-RUN-8 exec workers get workerArgs.exec appended', () => {
  const { dir } = fixtureRepo();
  run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('good')], workerArgs: { exec: ['--extra'] } }) });
  assert.equal(calls()[0].argv.at(-1), '--extra');
});

test('REQ-RUN-10 a second run on the same card while the first is in progress fails cleanly, not with a git race', () => {
  const { dir } = fixtureRepo();
  // The fake worker itself attempts a concurrent second run mid-attempt (real concurrency, not simulated
  // timing): whichever of the two `git worktree add` calls loses the race must fail on Keel's own lock,
  // never on a raw git error, and must never leave two worktrees registered for one card.
  const selfConcurrent = {
    provider: 'exec',
    model: 'exec-concurrent',
    effort: 'low',
    command: ['node', FAKE, 'good'],
    family: 'exec',
  };
  const config = fixtureConfig({ tiers: [selfConcurrent] });
  let concurrentError = null;
  const originalLog = () => {};
  const first = run({
    repo: dir,
    card: card(),
    config,
    log: (msg) => {
      if (msg.startsWith('attempt 1') && concurrentError === null) {
        try {
          run({ repo: dir, card: card(), config, log: originalLog });
          concurrentError = 'DID_NOT_THROW';
        } catch (err) {
          concurrentError = err.message;
        }
      }
    },
  });
  assert.equal(first.pass, true);
  assert.match(concurrentError, /locked|in progress/i, "the losing run must fail on Keel's lock, not a raw git error or silently succeed");
  assert.equal(
    g(dir, 'worktree', 'list')
      .trim()
      .split('\n')
      .filter((l) => l.includes('keel/T-7')).length,
    1,
    'exactly one worktree for the card',
  );
});

test('REQ-RUN-13 a worker that reports the card blocked parks it: no gate, no escalation, reason kept', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('blocked'), tier('good')] }) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'blocked');
  assert.match(r.failure, /column the schema does not have/);
  assert.equal(calls().length, 1, 'a stronger tier is not tried');
  assert.ok(existsSync(r.worktree), 'worktree kept for inspection');
  assert.ok(!existsSync(join(r.worktree, 'KEEL_BLOCKED')), 'marker removed so it is never committed');
  const [row] = readLedger();
  assert.equal(row.workerStatus, 'blocked');
  assert.equal(row.gatePass, false);
  assert.equal(row.attemptPass, false);
});

test('REQ-RUN-13 the builder prompt names the KEEL_BLOCKED file and forbids working around a defect', () => {
  const prompt = buildPrompt(card(), fixtureConfig(), null);
  assert.match(prompt, /KEEL_BLOCKED/);
  assert.match(prompt, /do not work around/i);
});

test('REQ-RUN-13 the ledger row stores the blocked reason and the stop line shows it', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('blocked')] }) });
  const [row] = readLedger();
  assert.match(row.blockedReason, /column the schema does not have/);
  assert.match(describeStop(r), /STOPPED \(blocked\)[\s\S]*column the schema does not have[\s\S]*worktree kept at /);
  assert.doesNotMatch(describeStop({ stopped: 'max-attempts', worktree: '/wt', failure: 'long gate output' }), /long gate output/);
});

test('REQ-RUN-14 bug, feature and ui prompts tell the worker to put new tests in a new file, not an existing one', () => {
  for (const kind of ['bug', 'feature', 'ui']) {
    const prompt = buildPrompt(card(`kind: ${kind}\nsize: S`), fixtureConfig(), null);
    assert.match(prompt, /new test file/i, kind);
    assert.match(prompt, /do not (edit|modify) (any )?existing test/i, kind);
  }
  assert.doesNotMatch(buildPrompt(card('kind: chore\nsize: S'), fixtureConfig(), null), /new test file/i);
});

test('REQ-RUN-14 the prompt allows editing an existing test file the card names in allowEdits', () => {
  const prompt = buildPrompt(card('kind: bug\nsize: S\nallowEdits: test/add.test.js'), fixtureConfig(), null);
  assert.match(prompt, /unless the card's allowEdits names it/);
});

test('REQ-GATE-18 a run whose gate passed only on a retry records the flaky stages in the ledger', () => {
  const { dir } = fixtureRepo();
  const marker = join(tmp('keel-flaky-'), 'seen');
  const flaky = `if [ -f "${marker}" ]; then for f in test/*.js; do node "$f" || exit 1; done; else touch "${marker}"; exit 1; fi`;
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('good')], checks: { test: flaky } }) });
  assert.equal(r.pass, true);
  assert.deepEqual(readLedger()[0].flaky, ['test']);
});

test('REQ-RUN-15 the prompt asks for targeted checks only and names the full checks the gate runs afterwards', () => {
  const prompt = buildPrompt(card(), fixtureConfig({ checks: { lint: 'npm run lint', test: 'npm test' } }), null);
  assert.match(prompt, /run only the checks that cover your change/i);
  assert.match(prompt, /the gate then runs: npm run lint ; npm test/i);
  assert.doesNotMatch(prompt, /Run these checks before you finish/);
});

test('REQ-RUN-13 the prompt tells the worker to report an already-satisfied card through KEEL_BLOCKED', () => {
  assert.match(buildPrompt(card(), fixtureConfig(), null), /already satisfied/i);
});
