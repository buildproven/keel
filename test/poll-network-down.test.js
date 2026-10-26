import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { networkFailure } from '../src/network.js';
import { readPlan } from '../src/plan.js';
import { poll } from '../src/poll.js';
import { FIXTURE_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

/** What undici's fetch throws when the host cannot be reached: `TypeError: fetch failed` with the socket error as cause. */
const offline = (code = 'ENOTFOUND') =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error(`getaddrinfo ${code} api.linear.app`), { code, syscall: 'getaddrinfo', hostname: 'api.linear.app' }),
  });

/** The 2026-10-26 MacBook Pro error: a connect timeout on IPv4 and no route on IPv6, as one AggregateError. */
const timedOut = () => {
  const v4 = Object.assign(new Error('connect ETIMEDOUT 104.18.40.45:443'), { code: 'ETIMEDOUT', address: '104.18.40.45', port: 443 });
  const v6 = Object.assign(new Error('connect EHOSTUNREACH 2a06:98c1:3105::6812:282d:443'), { code: 'EHOSTUNREACH' });
  return new TypeError('fetch failed', { cause: Object.assign(new AggregateError([v4, v6], ''), { code: 'ETIMEDOUT' }) });
};

const issue = (id) => ({
  id,
  title: id,
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt: '2026-10-01',
  labels: [],
  estimate: null,
});

const pollRows = () => {
  const file = join(process.env.KEEL_STATE_DIR, 'poll-ledger.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
};

test('REQ-LINEAR-40 a network-level fetch failure is named with its host and code; any other error is not', () => {
  assert.deepEqual(networkFailure(offline('ENOTFOUND')), { host: 'api.linear.app', code: 'ENOTFOUND' });
  assert.deepEqual(networkFailure(timedOut()), { host: '104.18.40.45', code: 'ETIMEDOUT' });
  for (const code of [
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ECONNRESET',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
  ])
    assert.equal(networkFailure(offline(code))?.code, code, code);
  assert.equal(networkFailure(new Error('Linear API HTTP 500: boom')), null);
  assert.equal(networkFailure(new Error('Linear API error: usage limit exceeded')), null);
  assert.equal(
    networkFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('bad'), { code: 'ERR_INVALID_URL' }) })),
    null,
  );
  assert.equal(networkFailure(new TypeError('x is not a function')), null);
  assert.equal(networkFailure(undefined), null);
});

test('REQ-LINEAR-40 with the network down before any issue is picked, the poll stops at the first Linear call', async () => {
  const { dir } = fixtureRepo();
  let listed = 0;
  let built = 0;
  const client = {
    listIssues: async () => (listed++, [issue('BUI-7')]),
    comment: async () => {},
    stateType: async () => 'unstarted',
  };
  const err = offline();
  await assert.rejects(
    poll({ repo: dir, project: 'x', client, config: {}, archiveFn: () => Promise.reject(err), runFn: () => (built++, {}) }),
    (e) => e === err && networkFailure(e)?.code === 'ENOTFOUND',
  );
  assert.equal(listed, 0, 'an unarchived-issues error is not swallowed while the network is down');
  assert.equal(built, 0);
  assert.deepEqual(pollRows(), [], 'no issue recorded, so the next poll picks it');
});

test('REQ-LINEAR-40 a queued follow-up is not charged a try when the network is down', async () => {
  const { dir } = fixtureRepo();
  recordPollAttempt(dir, { issue: 'BUI-1', outcome: 'found', detail: [{ title: 'a finding', kind: 'bug' }] });
  const client = {
    listIssues: async () => [],
    createIssue: async () => {
      throw offline('EAI_AGAIN');
    },
    comment: async () => assert.fail('no comment while the network is down'),
    stateType: async () => 'unstarted',
  };
  await assert.rejects(poll({ repo: dir, project: 'x', client, config: fixtureConfig({ followUpsPerDay: 5 }), runFn: () => ({}) }), (e) =>
    Boolean(networkFailure(e)),
  );
  assert.deepEqual(
    pendingFollowUps(dir, 3).map((f) => f.tries),
    [0],
  );
  assert.ok(!pollRows().some((r) => r.outcome === 'file-error'));
});

test('REQ-LINEAR-40 a prerequisite unreadable for lack of network stops the poll, not just logs', async () => {
  const { dir } = fixtureRepo();
  const logs = [];
  const client = {
    listIssues: async () => [{ ...issue('BUI-7'), description: 'Depends on BUI-3.\n\n- REQ-1: it shall work.' }],
    comment: async () => {},
    stateType: async () => {
      throw offline('ECONNREFUSED');
    },
  };
  let built = 0;
  await assert.rejects(
    poll({ repo: dir, project: 'x', client, config: {}, log: (m) => logs.push(m), runFn: () => (built++, {}) }),
    (e) => networkFailure(e)?.code === 'ECONNREFUSED',
  );
  assert.equal(built, 0);
  assert.ok(!logs.some((l) => /not read/.test(l)), logs.join('\n'));
});

test('REQ-LINEAR-40 an unknown plan reading (the probe offline) goes on, and the network stop comes at the issue list', async () => {
  const { dir } = fixtureRepo();
  const logs = [];
  const client = {
    listIssues: async () => {
      throw timedOut();
    },
    comment: async () => {},
    stateType: async () => 'unstarted',
  };
  const config = fixtureConfig({ planLimits: { fiveHour: 90, week: 90 } });
  let built = 0;
  await assert.rejects(
    poll({
      repo: dir,
      project: 'x',
      client,
      config,
      log: (m) => logs.push(m),
      runFn: () => (built++, {}),
      // The claude probe prints nothing without a network; no Codex session log: both windows unknown.
      planFn: (c) => readPlan(c, { claudeProbe: () => '', codexHome: tmp('keel-codex-') }),
    }),
    (e) => networkFailure(e)?.code === 'ETIMEDOUT',
  );
  assert.ok(
    logs.some((l) => /^plan: claude unknown/.test(l)),
    logs.join('\n'),
  );
  assert.equal(built, 0);
});

test('REQ-LINEAR-40 when the network drops after a build, the issue state is untouched and the build is recorded once', async () => {
  const { dir } = fixtureRepo();
  const logs = [];
  const moves = [];
  const client = {
    listIssues: async () => [issue('BUI-7')],
    comment: async (id) => moves.push(`comment ${id}`),
    review: async (id) => moves.push(`review ${id}`),
    done: async (id) => moves.push(`done ${id}`),
    stateType: async () => {
      throw offline('ENETUNREACH');
    },
  };
  const runFn = ({ card }) => ({
    pass: false,
    stopped: 'gate',
    tier: 0,
    attempt: 1,
    branch: `keel/${card.id}`,
    worktree: '/x',
    failure: 'red',
  });
  await assert.rejects(
    poll({ repo: dir, project: 'x', client, config: {}, log: (m) => logs.push(m), runFn }),
    (e) => networkFailure(e)?.code === 'ENETUNREACH',
  );
  assert.deepEqual(moves, [], 'no state move and no comment');
  assert.deepEqual(
    pollRows().map((r) => [r.issue, r.outcome]),
    [['BUI-7', 'reportFailed']],
  );
  assert.ok(
    logs.some((l) => l.startsWith('BUI-7 built (branch keel/BUI-7) but not reported to Linear: network unreachable')),
    logs.join('\n'),
  );
});

test('REQ-LINEAR-40 keel poll with no network prints one stop line, no stack trace, and exits 4', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, linearProject: 'x' }) });
  const stub = join(tmp('keel-stub-'), 'offline.mjs');
  writeFileSync(
    stub,
    `globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.linear.app'), { code: 'ENOTFOUND', hostname: 'api.linear.app' }) }); };\n`,
  );
  const r = spawnSync(process.execPath, [BIN, 'poll', '--repo', dir], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--import=${stub}`, LINEAR_API_KEY: 'test', KEEL_STATE_DIR: process.env.KEEL_STATE_DIR },
  });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /^keel: poll stopped: network unreachable \(api\.linear\.app: ENOTFOUND\)$/m);
  assert.doesNotMatch(r.stderr, /triggerUncaughtException|\n\s+at /);
});
