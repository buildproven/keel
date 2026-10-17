import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const item = { kind: 'bug', title: 'found thing', detail: 'a:1' };
const found = (dir, source) => recordPollAttempt(dir, { issue: source, outcome: 'found', detail: [item] });

test('REQ-LINEAR-22 work found again after its title was filed is queued again; the Linear dedupe decides', () => {
  const { dir } = fixtureRepo();
  found(dir, 'BUI-1');
  recordPollAttempt(dir, { issue: 'BUI-50', outcome: 'filed', detail: { source: 'BUI-1', title: 'Found Thing ' } });
  assert.deepEqual(pendingFollowUps(dir), []);
  found(dir, 'BUI-2');
  const pending = pendingFollowUps(dir);
  assert.deepEqual(
    pending.map((f) => [f.source, f.title, f.tries]),
    [['BUI-2', 'found thing', 0]],
  );
});

test('REQ-LINEAR-22 work found again after its title was marked dup is queued again', () => {
  const { dir } = fixtureRepo();
  found(dir, 'BUI-1');
  recordPollAttempt(dir, { issue: 'BUI-1', outcome: 'dup', detail: { source: 'BUI-1', title: 'found thing' } });
  found(dir, 'BUI-3');
  assert.deepEqual(
    pendingFollowUps(dir).map((f) => f.source),
    ['BUI-3'],
  );
});

test('REQ-LINEAR-22 an item that failed its tries leaves the queue, and work found again later starts with fresh tries', () => {
  const { dir } = fixtureRepo();
  found(dir, 'BUI-1');
  for (let i = 0; i < 3; i++)
    recordPollAttempt(dir, { issue: 'BUI-1', outcome: 'file-error', detail: { source: 'BUI-1', title: 'found thing', error: 'x' } });
  assert.deepEqual(pendingFollowUps(dir, 3), []);
  found(dir, 'BUI-4');
  assert.deepEqual(
    pendingFollowUps(dir, 3).map((f) => [f.source, f.tries]),
    [['BUI-4', 0]],
  );
});
