import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { formatReport, readLedger, report } from '../src/ledger.js';
import { buildPrompt, describeStop, issueStopNote, nextTier, run, startTier } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

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

const config51 = (mode) => fixtureConfig({ tiers: [tier(mode)], learnStart: false, maxAttempts: 1 });
const card51 = () => card(undefined, 'T-51: fix add');
const keelBranches = (dir) => g(dir, 'branch', '--list', 'keel/*');
/** The worktree path run() picks for a card: the repo name, a hash of its path, and the card id. */
const worktree51 = (dir) =>
  join(
    process.env.KEEL_STATE_DIR,
    'worktrees',
    `${basename(dir)}-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 8)}-T-51`,
  );
/**
 * A preload for `node --import` that answers Linear's GraphQL endpoint from memory, so `keel run BUI-N` runs offline.
 * KEEL_FAKE_LINEAR is the issue as JSON; KEEL_FAKE_LINEAR_LOG gets each comment body.
 */
const FAKE_LINEAR = `// Preload for CLI tests (\`node --import\`): answers Linear's GraphQL endpoint from memory, so \`keel run BUI-N\` runs offline.
// KEEL_FAKE_LINEAR is a JSON issue (id, title, description, labels, estimate); KEEL_FAKE_LINEAR_LOG gets each comment body.
import { appendFileSync } from 'node:fs';

const issue = JSON.parse(process.env.KEEL_FAKE_LINEAR);
const ok = (data) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (query.includes('commentCreate')) {
    appendFileSync(process.env.KEEL_FAKE_LINEAR_LOG, \`\${JSON.stringify(variables.body)}\\n\`);
    return ok({ commentCreate: { success: true } });
  }
  if (query.includes('state { type }') && query.includes('issue(id')) return ok({ issue: { state: { type: 'started' } } });
  // Keel archives the project's closed issues at the start of a pass (REQ-LINEAR-39): none are closed here.
  if (query.includes('nodes { id identifier }')) return ok({ issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
  if (query.includes('issues(filter')) {
    return ok({
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            identifier: issue.id,
            title: issue.title,
            description: issue.description,
            priority: 2,
            createdAt: '2026-10-01T00:00:00Z',
            estimate: issue.estimate ?? null,
            labels: { nodes: (issue.labels ?? []).map((name) => ({ name })) },
            inverseRelations: { nodes: [] },
          },
        ],
      },
    });
  }
  throw new Error(\`fake Linear: unexpected query \${query.slice(0, 80)}\`);
};
`;
const preloadFile = () => {
  const file = join(tmp('keel-preload-'), 'fake-linear-fetch.mjs');
  writeFileSync(file, FAKE_LINEAR);
  return file;
};

test('REQ-RUN-51 a run that stops before any commit removes its clean worktree and branch', () => {
  const { dir } = fixtureRepo();
  const lines = [];
  const r = run({ repo: dir, card: card51(), config: config51('auth'), log: (l) => lines.push(l) });
  assert.equal(r.stopped, 'auth');
  assert.equal(r.worktree, null);
  assert.ok(!existsSync(worktree51(dir)), 'worktree removed');
  assert.equal(keelBranches(dir), '', 'branch removed');
  assert.ok(
    lines.some((l) => /^removed empty worktree .*stopped before any change/.test(l)),
    lines.join('\n'),
  );
  assert.equal(readLedger().at(-1).workerStatus, 'auth', 'the ledger row stays');
  const stop = describeStop(r);
  assert.match(stop, /^STOPPED \(auth\):\n[\s\S]* no worktree kept$/);
  assert.equal(stop.split(r.failure.trim()).length, 2, 'the failure is printed once');
  const next = run({ repo: dir, card: card51(), config: config51('good') });
  assert.equal(next.pass, true, next.failure);
});

test('REQ-RUN-51 a quota stop with no change frees its worktree too', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card51(), config: config51('quota') });
  assert.equal(r.stopped, 'quota');
  assert.equal(r.worktree, null);
  assert.equal(keelBranches(dir), '');
});

test('REQ-RUN-51 a run that stopped with a change keeps its worktree and branch', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card51(), config: fixtureConfig({ tiers: [tier('fix-only')], learnStart: false, maxAttempts: 1 }) });
  assert.equal(r.stopped, 'max-attempts');
  assert.ok(existsSync(r.worktree));
  assert.match(keelBranches(dir), /keel\/T-51/);
});

test('REQ-RUN-51 a crashed worker that changed nothing keeps its worktree for inspection (REQ-RUN-5)', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card51(), config: config51('crash') });
  assert.equal(r.stopped, 'max-attempts');
  assert.ok(existsSync(r.worktree));
});

test('REQ-RUN-51 a blocked run keeps its worktree for inspection (REQ-RUN-13)', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card51(), config: config51('blocked') });
  assert.equal(r.stopped, 'blocked');
  assert.ok(existsSync(r.worktree));
});

const leave51 = (dir, base) => {
  mkdirSync(join(process.env.KEEL_STATE_DIR, 'worktrees'), { recursive: true });
  const wt = worktree51(dir);
  g(dir, 'worktree', 'add', '--quiet', '-b', 'keel/T-51', wt, base);
  return wt;
};

test('REQ-RUN-51 a clean worktree at the base does not block the next run', () => {
  const { dir, base } = fixtureRepo();
  leave51(dir, base);
  const lines = [];
  const r = run({ repo: dir, card: card51(), config: config51('good'), log: (l) => lines.push(l) });
  assert.equal(r.pass, true, r.failure);
  assert.ok(
    lines.some((l) => l.startsWith('removed empty worktree ')),
    lines.join('\n'),
  );
});

test('REQ-RUN-51 a clean worktree behind a base that has moved on does not block the next run', () => {
  const { dir, base } = fixtureRepo();
  leave51(dir, base);
  commit(dir, { 'docs/note.md': 'moved on\n' }, 'docs: move the base');
  const r = run({ repo: dir, card: card51(), config: config51('good') });
  assert.equal(r.pass, true, r.failure);
});

test('REQ-RUN-51 a worktree with a commit, an untracked file, or a tracked change still stops the run', () => {
  for (const [name, touch] of [
    ['a commit', (wt) => commit(wt, { 'work.txt': 'kept\n' }, 'wip: human work')],
    ['an untracked file', (wt) => writeFileSync(join(wt, 'scratch.txt'), 'x\n')],
    ['a tracked change', (wt) => writeFileSync(join(wt, 'src/add.js'), 'export const add = 1;\n')],
  ]) {
    const { dir, base } = fixtureRepo();
    const wt = leave51(dir, base);
    touch(wt);
    assert.throws(() => run({ repo: dir, card: card51(), config: config51('good') }), /worktree exists/, name);
    assert.ok(existsSync(wt), `${name} kept`);
    assert.match(keelBranches(dir), /keel\/T-51/, `${name} branch kept`);
  }
});

test('REQ-RUN-51 a worktree on a branch other than the card branch is not removed', () => {
  const { dir, base } = fixtureRepo();
  const wt = leave51(dir, base);
  g(wt, 'checkout', '-q', '--detach');
  assert.throws(() => run({ repo: dir, card: card51(), config: config51('good') }), /worktree exists/);
  assert.ok(existsSync(wt));
});

test('REQ-RUN-51 issueStopNote names the stop class and the first line of the failure', () => {
  assert.equal(issueStopNote({ pass: true }), '');
  assert.equal(issueStopNote(undefined), '');
  assert.equal(issueStopNote({ pass: false, stopped: 'auth', failure: '\n  Not logged in.\nsecond line' }), ' (auth: Not logged in.)');
  assert.equal(issueStopNote({ pass: false, stopped: 'quota', failure: '' }), ' (quota)');
  assert.equal(issueStopNote({ pass: false, stopped: 'quota' }), ' (quota)');
  const long = issueStopNote({ pass: false, stopped: 'max-attempts', failure: 'x'.repeat(500) });
  assert.ok(long.length < 230, long);
});

test('REQ-RUN-51 keel run of a Linear issue prints the stop class and failure on a failed run, and the next run proceeds', () => {
  const { dir: origin } = fixtureRepo();
  const json = { checks: { test: 'true' }, testCommand: 'true', linearProject: 'demo', review: false, learnStart: false, maxAttempts: 1 };
  const keelJson = (mode) => JSON.stringify({ ...json, tiers: [tier(mode)] });
  commit(origin, { 'keel.json': keelJson('auth') }, 'chore: keel config');
  const dir = realpathSync(tmp('keel-clone-'));
  g(dir, 'clone', '-q', origin, '.');
  const logFile = join(tmp('keel-linear-'), 'comments.jsonl');
  const env = {
    ...process.env,
    KEEL_STATE_DIR: process.env.KEEL_STATE_DIR,
    TMPDIR: tmp('keel-tmpdir-'),
    LINEAR_API_KEY: 'lin_api_test',
    NODE_OPTIONS: `--import=${preloadFile()}`,
    KEEL_FAKE_LINEAR: JSON.stringify({
      id: 'BUI-51',
      title: 'fix add',
      description: '- REQ-ADD-1: add shall sum.',
      labels: ['Bug'],
      estimate: 2,
    }),
    KEEL_FAKE_LINEAR_LOG: logFile,
  };
  const keel = () => spawnSync(process.execPath, [resolve('bin/keel.js'), 'run', 'BUI-51'], { cwd: dir, encoding: 'utf8', env });
  const first = keel();
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stderr, /^keel: BUI-51: failed \(auth: .+\)$/m);
  assert.doesNotMatch(first.stderr, /worktree exists/);
  assert.equal(g(dir, 'branch', '--list', 'keel/*'), '', 'no branch left');
  assert.match(readFileSync(logFile, 'utf8'), /auth/);
  const second = keel();
  assert.doesNotMatch(second.stderr, /worktree exists/, second.stderr);
  assert.match(second.stderr, /^keel: BUI-51: failed \(auth: /m, 'the second run reached the worker again');
});
