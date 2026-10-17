import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { pickIssue } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const issue = (over = {}) => ({
  id: 'BUI-1',
  title: 't',
  description: '- REQ-1: x shall y.',
  priority: 1,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  ...over,
});

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-nokeel-state-');
});

test('REQ-LINEAR-11 pickIssue passes over a no-keel issue silently, whatever its label position or case', () => {
  const skipped = [];
  const issues = [
    issue({ id: 'A-1', priority: 1, labels: ['No-Keel', 'Bug'] }),
    issue({ id: 'A-2', priority: 2, labels: ['Bug', 'no-keel'] }),
    issue({ id: 'A-3', priority: 3, labels: ['Bug'] }),
  ];
  assert.equal(pickIssue(issues, new Set(), (id) => skipped.push(id))?.id, 'A-3');
  assert.deepEqual(skipped, [], 'an opt-out is not a skip: nothing is reported');
});

test('REQ-LINEAR-11 with only no-keel issues, poll runs nothing, comments nothing, and records nothing', async () => {
  const { dir } = fixtureRepo();
  const events = [];
  const client = {
    listIssues: async () => [issue({ labels: ['Bug', 'no-keel'] })],
    comment: async (id, body) => events.push({ id, body }),
    close: async (id) => events.push({ id, action: 'close' }),
  };
  let ran = 0;
  const results = await poll({
    repo: dir,
    project: 'p',
    client,
    config: fixtureConfig(),
    runFn: () => {
      ran += 1;
      return { pass: true };
    },
  });
  assert.equal(ran, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(results, [{ outcome: 'none' }]);
});
