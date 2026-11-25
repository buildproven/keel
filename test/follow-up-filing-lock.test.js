import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { beforeEach, test } from 'node:test';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { followUpFilingLock, poll } from '../src/poll.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-filing-lock-state-');
});

const TITLES = ['filing lock finding one', 'filing lock finding two', 'filing lock finding three'];

/** One fake Linear for both passes: every read waits, so two passes interleave at each await. */
function fakeClient() {
  const created = [];
  const listed = [];
  return {
    created,
    listed,
    listIssues: async (project) => {
      await wait(20);
      listed.push(project);
      return created.map((c, i) => ({ id: `BUI-${100 + i}`, title: c.title, description: '' }));
    },
    comment: async () => {},
    stateType: async () => 'started',
    createIssue: async (sourceId, fields) => {
      await wait(5);
      created.push(fields);
      return `BUI-${100 + created.length - 1}`;
    },
  };
}

function queue(dir) {
  recordPollAttempt(dir, {
    issue: null,
    outcome: 'found',
    detail: TITLES.map((title, i) => ({ kind: 'bug', title, detail: `x${i}.js:1` })),
  });
}

const filingPass = (dir, client, logs) =>
  poll({
    repo: dir,
    project: 'x',
    client,
    config: fixtureConfig({ followUpsPerDay: 10, followUpOpenMax: 0, followUpHoldAt: 0, staleDays: 0, followUpStaleDays: 0 }),
    runFn: () => assert.fail('file-only must not build'),
    fileOnly: true,
    log: (m) => logs.push(m),
  });

/** A pid that was alive a moment ago and is not now. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

test('REQ-LINEAR-59 two concurrent filing passes on one queue create each title once; the second logs the skip line', async () => {
  const { dir } = fixtureRepo();
  queue(dir);
  const client = fakeClient();
  const logsA = [];
  const logsB = [];
  await Promise.all([filingPass(dir, client, logsA), filingPass(dir, client, logsB)]);
  const titles = client.created.map((c) => c.title).sort();
  assert.deepEqual(titles, [...TITLES].sort(), 'each queued title is created exactly once');
  const skip = `follow-ups: another poll is filing for ${dir}`;
  assert.deepEqual(
    [logsA, logsB].map((l) => l.includes(skip)).sort(),
    [false, true],
    `exactly one pass logs the skip line:\n${[...logsA, '---', ...logsB].join('\n')}`,
  );
  assert.deepEqual(pendingFollowUps(dir), []);
  const lock = followUpFilingLock(dir);
  assert.equal(existsSync(lock), false, 'the lock is released after filing');
  assert.deepEqual(
    readdirSync(dirname(lock)).filter((f) => f.startsWith(basename(lock))),
    [],
    'no lock entry is left behind',
  );

  // A later pass files what is queued then: the lock does not stay held.
  recordPollAttempt(dir, { issue: null, outcome: 'found', detail: [{ kind: 'bug', title: 'filing lock finding four', detail: 'y.js:1' }] });
  const logsC = [];
  await filingPass(dir, client, logsC);
  assert.equal(client.created.at(-1).title, 'filing lock finding four');
  assert.equal(logsC.includes(skip), false);
});

test('REQ-LINEAR-59 a filing lock left by a dead pid does not block filing', async () => {
  const { dir } = fixtureRepo();
  queue(dir);
  const lock = followUpFilingLock(dir);
  const dead = deadPid();
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), String(dead)); // the marker a crashed pass leaves
  writeFileSync(`${lock}.run-${dead}-1`, ''); // and its entry
  const client = fakeClient();
  const logs = [];
  await filingPass(dir, client, logs);
  assert.deepEqual(client.created.map((c) => c.title).sort(), [...TITLES].sort());
  assert.equal(
    logs.some((m) => m.startsWith('follow-ups: another poll is filing')),
    false,
    logs.join('\n'),
  );
  assert.equal(existsSync(lock), false, 'the dead marker is replaced and then released');
  assert.equal(existsSync(`${lock}.run-${dead}-1`), false, "the dead pass's entry is removed");
});

test('REQ-LINEAR-59 a filing lock held by a live process skips filing and leaves the queue for a later poll', async () => {
  const { dir } = fixtureRepo();
  queue(dir);
  const lock = followUpFilingLock(dir);
  mkdirSync(dirname(lock), { recursive: true });
  const holder = `${lock}.run-${process.ppid}-1`; // the test runner's parent: alive for the whole test
  writeFileSync(holder, '');
  const client = fakeClient();
  const logs = [];
  const r = await filingPass(dir, client, logs);
  assert.deepEqual(r, [], 'a skipped pass is not a filing error');
  assert.deepEqual(client.created, []);
  assert.ok(logs.includes(`follow-ups: another poll is filing for ${dir}`), logs.join('\n'));
  assert.equal(pendingFollowUps(dir).length, TITLES.length, 'the queue waits for the next poll');
  assert.equal(existsSync(holder), true, "another process's entry is never removed");
});
