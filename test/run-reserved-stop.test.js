import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { attemptedIssueIds } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { describeStop, run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
/** One tier that plays `modes` in order, one per worker call (fake-worker `script`). */
const scripted = (modes, model, provider = 'exec') => {
  const file = join(tmp('keel-script-'), 'script.json');
  writeFileSync(file, JSON.stringify(modes));
  return { provider, model, effort: 'high', command: ['node', FAKE, 'script', file] };
};
// An L card starts on tier 1 (startTier.L). Its change touches src/, a protected path, so the floor rises to tier 2
// (REQ-RUN-2): with tier 2 reserved, no tier is left to escalate to or retry (REQ-PLAN-8).
const card = parseCard('# T-60: fix add\nkind: bug\nsize: L\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const RESERVED = new Map([['codex', 'week 59% ≥ 50%']]);
// The worker builds a good fix, but the `test` check fails the way a missing Playwright browser does.
const config = (over = {}) =>
  fixtureConfig({
    tiers: [scripted(['good'], 'cheap'), scripted(['good', 'good'], 'strong'), scripted(['good'], 'codex', 'codex')],
    checks: { test: 'echo "browserType.launch: Executable doesn\'t exist"; exit 1' },
    learnStart: false,
    protected: ['src/**'],
    startTier: { L: 1, protected: 2 },
    ...over,
  });
let logFile;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
});
const calls = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

test('REQ-RUN-68 a gate failure with every higher tier reserved stops as reserved, naming the failed stage and the reserved tiers', () => {
  const { dir } = fixtureRepo();
  const log = [];
  const r = run({ repo: dir, card, config: config(), reserved: RESERVED, log: (m) => log.push(m) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'reserved', r.failure);
  assert.equal(calls().length, 1, 'one attempt on tier 1, no retry');
  assert.equal(calls()[0].env.model, 'strong');
  const first = r.failure.split('\n')[0];
  assert.match(first, /attempt 1 on tier 1 failed the gate at `test`/);
  assert.match(first, /tier 2 \(codex: week 59% ≥ 50%\)/);
  assert.doesNotMatch(r.failure, /quota/);
  assert.match(r.failure, /## test/, 'the gate failure summary follows');
  assert.match(r.failure, /Executable doesn't exist/);
  assert.ok(r.worktree && existsSync(r.worktree), 'the failed work is kept for inspection');
  assert.match(describeStop(r), /^STOPPED \(reserved\)/);
});

test('REQ-RUN-68 a worker failure (not the gate) with every higher tier reserved names the worker status', () => {
  const { dir } = fixtureRepo();
  // A worker that edits a protected path, then exits non-zero: no gate stage to name, so the failure names the status.
  const crash = {
    provider: 'exec',
    model: 'strong',
    effort: 'high',
    command: ['sh', '-c', 'cat >/dev/null; echo "export const add = 1;" > src/add.js; exit 3'],
  };
  const tiers = [scripted(['good'], 'cheap'), crash, scripted(['good'], 'codex', 'codex')];
  const r = run({ repo: dir, card, config: config({ tiers }), reserved: RESERVED });
  assert.equal(r.stopped, 'reserved', r.failure);
  assert.match(
    r.failure.split('\n')[0],
    /^attempt 1 on tier 1 failed (the gate at `[\w-]+`(, `[\w-]+`)* )?\(worker error\); no tier is left: tier 2 \(codex: week 59% ≥ 50%\)/,
  );
});

test('REQ-RUN-68 a worker out of quota with every higher tier reserved still stops as quota', () => {
  const { dir } = fixtureRepo();
  const tiers = [scripted(['good'], 'cheap'), scripted(['quota'], 'strong'), scripted(['good'], 'codex', 'codex')];
  const r = run({ repo: dir, card, config: config({ tiers }), reserved: RESERVED });
  assert.equal(r.stopped, 'quota', r.failure);
});

const issue = {
  id: 'BUI-8',
  title: 't',
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
};

test('REQ-LINEAR-51 a run stopped reserved is deferred with a comment naming the failed stage, not an unavailable provider', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = {
    listIssues: async () => [issue],
    comment: async (id, body) => comments.push({ id, body }),
    review: async (id) => comments.push({ id, action: 'review' }),
    stateType: async () => 'started',
  };
  let picks = 0;
  const runFn = () => {
    picks += 1;
    const wt = join(tmp('keel-wt-'), 'wt');
    g(dir, 'worktree', 'add', '-q', '-b', `keel/BUI-8-${picks}`, wt);
    return {
      pass: false,
      stopped: 'reserved',
      branch: `keel/BUI-8-${picks}`,
      worktree: wt,
      failure:
        "attempt 1 on tier 1 failed the gate at `test`; no tier is left: tier 2 (codex: week 59% ≥ 50%) is held back by its plan reserve.\n\n## test\nbrowserType.launch: Executable doesn't exist",
    };
  };
  const [first] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(first.outcome, 'deferred');
  const body = comments.find((c) => c.body)?.body ?? '';
  assert.match(body, /deferred \(reserved\)/);
  assert.match(body, /failed the gate at `test`/);
  assert.match(body, /## test\nbrowserType\.launch: Executable doesn't exist/, 'the stage output summary');
  assert.match(body, /next poll/);
  assert.doesNotMatch(body, /provider was unavailable/);
  assert.ok(existsSync(first.result.worktree), 'the failed work stays for inspection');
  assert.match(body, new RegExp(`Worktree kept at ${first.result.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const [second] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(second.outcome, 'deferred');
  assert.equal(picks, 2, 'the next poll picked the issue again');
});

test('REQ-LINEAR-51 a Linear error while reporting a reserved stop still records the issue as deferred', async () => {
  const { dir } = fixtureRepo();
  const client = {
    listIssues: async () => [issue],
    comment: async () => {
      throw new Error('linear down');
    },
    review: async () => {},
    stateType: async () => 'started',
  };
  const runFn = () => ({ pass: false, stopped: 'reserved', branch: 'keel/BUI-8', worktree: null, failure: 'failed the gate at `test`' });
  await assert.rejects(poll({ repo: dir, project: 'x', client, config: {}, runFn }), /linear down/);
  assert.equal(attemptedIssueIds(dir).has('BUI-8'), false, 'a reserved stop stays retryable');
});

test('REQ-LINEAR-51 a long failure keeps its first line, which names the stage and the reserved tiers', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = {
    listIssues: async () => [issue],
    comment: async (id, body) => comments.push(body),
    review: async () => {},
    stateType: async () => 'started',
  };
  const head =
    'attempt 1 on tier 1 failed the gate at `test`; no tier is left: tier 2 (codex: week 59% ≥ 50%) is held back by its plan reserve.';
  const failure = `${head}\n\n## test\n${'x'.repeat(9000)}\nlast line`;
  const runFn = () => ({ pass: false, stopped: 'reserved', branch: 'keel/BUI-8', worktree: null, failure });
  const [first] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(first.outcome, 'deferred');
  assert.ok(comments[0].includes(head), comments[0].slice(0, 400));
  assert.match(comments[0], /last line$/);
  assert.ok(comments[0].length < 4600, 'the summary is still trimmed');
  assert.doesNotMatch(comments[0], /Worktree kept/, 'no worktree, none named');
});
