// BUI-2202: two keel processes on one repo filed every queued follow-up twice. One filer per repo at a time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { beforeEach, test } from 'node:test';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import * as pollModule from '../src/poll.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const { poll } = pollModule;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-follow-ups-concurrent-state-');
});

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Linear stub whose reads take a moment, so two filers interleave as two processes do. */
function slowClient({ failCreate = false } = {}) {
  const created = [];
  return {
    created,
    listIssues: async () => {
      await tick(30);
      return [];
    },
    comment: async () => {},
    stateType: async () => 'started',
    createIssue: async (sourceId, fields) => {
      await tick(10);
      if (failCreate) throw new Error('Linear API error: rate limited');
      created.push(fields.title);
      return `BUI-${100 + created.length}`;
    },
  };
}

const queue = (dir, titles) =>
  recordPollAttempt(dir, {
    issue: null,
    outcome: 'found',
    detail: titles.map((title, i) => ({ kind: 'bug', title, detail: `f${i}.js:1` })),
  });

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

const fileOnly = (dir, client, logs) =>
  poll({
    repo: dir,
    project: 'x',
    client,
    config: fixtureConfig({ followUpsPerDay: 10 }),
    runFn: () => assert.fail('file-only must not build'),
    fileOnly: true,
    log: (m) => logs.push(m),
  });

test('REQ-LINEAR-22 two follow-up filers started together on one repo create each issue once', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['first finding', 'second finding', 'third finding']);
  const client = slowClient();
  const logs = [];
  const [a, b] = await Promise.all([fileOnly(dir, client, logs), fileOnly(dir, client, logs)]);
  assert.deepEqual([a, b], [[], []]);
  assert.deepEqual(client.created.sort(), ['first finding', 'second finding', 'third finding']);
  assert.deepEqual(pendingFollowUps(dir), []);
  assert.ok(
    logs.some((m) => m.startsWith(`follow-ups wait: pid ${process.pid} is filing for this repo`)),
    logs.join('\n'),
  );
  assert.equal(existsSync(pollModule.followUpLockFile(dir)), false, 'the lock is removed after filing');
});

test('REQ-LINEAR-22 a follow-up lock holding a dead PID does not stop filing, and the log names the stale lock', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['stale lock finding']);
  const lock = pollModule.followUpLockFile(dir);
  mkdirSync(dirname(lock), { recursive: true });
  const pid = deadPid();
  writeFileSync(lock, `${pid}-1`);
  const client = slowClient();
  const logs = [];
  assert.deepEqual(await fileOnly(dir, client, logs), []);
  assert.deepEqual(client.created, ['stale lock finding']);
  assert.ok(logs.includes(`follow-ups: removed stale lock ${lock} (pid ${pid} is not running)`), logs.join('\n'));
  assert.equal(existsSync(lock), false);
});

test('REQ-LINEAR-22 an old follow-up lock with no PID in it is stale; a new one is waited for', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['empty lock finding']);
  const lock = pollModule.followUpLockFile(dir);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, '');
  const logs = [];
  // A lock created a moment ago may still be getting its PID written: it is waited for, not taken.
  const held = await pollModule.fileFollowUps({
    repo: dir,
    project: 'x',
    config: fixtureConfig({ followUpsPerDay: 10 }),
    client: slowClient(),
    log: (m) => logs.push(m),
    lockWait: { pollMs: 5, maxMs: 30 },
  });
  assert.match(held.error, /follow-up lock .* held by pid unknown/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const client = slowClient();
  assert.deepEqual(await fileOnly(dir, client, logs), []);
  assert.deepEqual(client.created, ['empty lock finding']);
  assert.ok(logs.includes(`follow-ups: removed stale lock ${lock} (pid unknown is not running)`), logs.join('\n'));
});

test('REQ-LINEAR-22 a live follow-up filer past the wait limit is a filing error that names it, and nothing is filed', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['held finding']);
  const lock = pollModule.followUpLockFile(dir);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, `${process.ppid}-7`);
  const client = slowClient();
  const logs = [];
  const r = await pollModule.fileFollowUps({
    repo: dir,
    project: 'x',
    config: fixtureConfig({ followUpsPerDay: 10 }),
    client,
    log: (m) => logs.push(m),
    lockWait: { pollMs: 5, maxMs: 30 },
  });
  assert.equal(r.error, `follow-up lock ${lock} held by pid ${process.ppid} for over 30 ms; filing waits for the next poll`);
  assert.deepEqual(client.created, []);
  assert.equal(pendingFollowUps(dir).length, 1, 'the item stays queued with no try counted');
  assert.ok(existsSync(lock), "another process's lock is left alone");
});

test('REQ-LINEAR-22 the follow-up lock is removed when filing fails', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['failing finding']);
  const logs = [];
  const r = await fileOnly(dir, slowClient({ failCreate: true }), logs);
  assert.equal(r[0].outcome, 'followUpsFailed');
  assert.equal(existsSync(pollModule.followUpLockFile(dir)), false);
});

test('REQ-LINEAR-22 a stale-lock takeover left by a dead filer is cleared, and filing goes on', async () => {
  const { dir } = fixtureRepo();
  queue(dir, ['takeover finding']);
  const lock = pollModule.followUpLockFile(dir);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, `${deadPid()}-1`);
  writeFileSync(`${lock}.takeover`, String(deadPid()));
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${lock}.takeover`, old, old);
  const client = slowClient();
  assert.deepEqual(await fileOnly(dir, client, []), []);
  assert.deepEqual(client.created, ['takeover finding']);
  assert.equal(existsSync(`${lock}.takeover`), false);
  assert.equal(existsSync(lock), false);
});

test('REQ-LINEAR-22 with nothing queued, filing takes no lock and does not wait for a live filer', async () => {
  const { dir } = fixtureRepo();
  const lock = pollModule.followUpLockFile(dir);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, `${process.ppid}-3`);
  const logs = [];
  const r = await pollModule.fileFollowUps({
    repo: dir,
    project: 'x',
    config: fixtureConfig({ followUpsPerDay: 10 }),
    client: slowClient(),
    log: (m) => logs.push(m),
    lockWait: { pollMs: 5, maxMs: 30 },
  });
  assert.deepEqual(r, {});
  assert.deepEqual(logs, []);
});
