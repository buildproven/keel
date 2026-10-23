import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { humanTouch } from '../src/autonomy.js';
import { readJsonl } from '../src/ledger.js';
import { pollLedgerFile } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { refineIssue } from '../src/refine.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = new URL('./fake-worker.js', import.meta.url).pathname;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-refine-retry-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-refine-retry-log-'), 'calls.jsonl');
});

/** A fixture config whose only tier is the fake worker answering `answer` to the refine turn. */
function configAnswering(answer) {
  const file = join(tmp('keel-refine-retry-script-'), 'script.json');
  writeFileSync(file, JSON.stringify([`say:${answer}`]));
  return fixtureConfig({ tiers: [{ provider: 'exec', model: 'cheap', effort: 'high', command: ['node', FAKE, 'script', file] }] });
}

const VAGUE = 'The add helper is wrong sometimes. Please make it right.';
const issueOf = (over = {}) => ({
  id: 'BUI-7',
  title: 'add is wrong',
  description: VAGUE,
  priority: 2,
  createdAt: '2026-10-01',
  labels: ['Bug'],
  estimate: null,
  blockedBy: [],
  ...over,
});

/** An in-memory Linear: the listed issues are open; comments and created sub-issues are recorded. */
function fakeClient(issues) {
  let next = 400;
  const c = {
    comments: [],
    created: [],
    listIssues: async () => issues,
    comment: async (id, body) => c.comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
    capacity: async () => ({ open: 0, teams: [] }), // room in the workspace: no hold (REQ-LINEAR-37)
    createIssue: async (sourceId, fields) => {
      c.created.push(fields);
      return `BUI-${next++}`;
    },
  };
  return c;
}

const noBuild = () => {
  throw new Error('nothing is built');
};

const card = (n) =>
  [
    `The add helper sums case ${n}.`,
    '',
    '## Requirements',
    '',
    `- REQ-ADD-${n}: When add is called with case ${n}, the add helper shall return its sum.`,
    '',
    '## Acceptance',
    '',
    `- [ ] A new test in test/add-${n}.test.js proves case ${n}.`,
    '',
    '```keel',
    'kind: bug',
    'size: S',
    'paths: src/**, test/**',
    '```',
  ].join('\n');
const SPLIT = `SPLIT\nTITLE: add case one\n${card(1)}\nTITLE: add case two\n${card(2)}`;

const rows = () => (existsSync(pollLedgerFile()) ? readJsonl(pollLedgerFile()) : []);

for (const priority of [0, 3]) {
  test(`REQ-LINEAR-33 a SPLIT keeps the parent's Linear priority ${priority} on every sub-issue`, async () => {
    const { dir } = fixtureRepo();
    const client = fakeClient([issueOf({ priority })]);
    const config = configAnswering(SPLIT);
    const r = await poll({ repo: dir, project: 'keel', client, config, runFn: noBuild, refineFn: refineIssue });
    assert.equal(r[0].outcome, 'split');
    assert.deepEqual(
      client.created.map((f) => f.priority),
      [priority, priority],
    );
  });
}

test('REQ-LINEAR-33 an --issue retry keeps the NEEDS_HUMAN question in the recorded detail', async () => {
  const { dir } = fixtureRepo();
  const question = 'accept the risk or replace the dependency?';
  const client = fakeClient([issueOf()]);
  const config = configAnswering(`NEEDS_HUMAN ${question}`);
  const r = await poll({ repo: dir, project: 'keel', client, config, runFn: noBuild, refineFn: refineIssue, issue: 'BUI-7' });
  assert.equal(r[0].outcome, 'needsHuman');
  const row = rows().find((x) => x.outcome === 'needsHuman');
  assert.deepEqual(row.detail, { question });
});

test('REQ-LINEAR-33 an --issue retry keeps the SPLIT child IDs in the recorded detail', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([issueOf()]);
  const config = configAnswering(SPLIT);
  await poll({ repo: dir, project: 'keel', client, config, runFn: noBuild, refineFn: refineIssue, issue: 'BUI-7' });
  const row = rows().find((x) => x.outcome === 'split');
  assert.deepEqual(row.detail, { children: ['BUI-400', 'BUI-401'] });
});

test('REQ-LINEAR-14 an --issue run is recorded with byHand, and the touch rate counts it as started by hand', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([issueOf()]);
  const config = configAnswering('NEEDS_HUMAN which dependency?');
  await poll({ repo: dir, project: 'keel', client, config, runFn: noBuild, refineFn: refineIssue, issue: 'BUI-7' });
  const row = rows().find((x) => x.outcome === 'needsHuman');
  assert.equal(row.byHand, true);
  const t = humanTouch({ pollRows: rows(), ledgerRows: [], prsFor: () => [] });
  assert.equal(t.started.issues, 1);
});

test('REQ-LED-16 a byHand poll row is an --issue run, whatever its detail', () => {
  const at = new Date().toISOString();
  const pollRows = [
    { repo: '/r/a', issue: 'H-1', outcome: 'needsHuman', detail: { question: 'q?' }, byHand: true, at },
    { repo: '/r/a', issue: 'H-2', outcome: 'blocked', detail: null, at },
    { repo: '/r/a', issue: 'H-2', outcome: 'needsHuman', detail: { question: 'q?' }, byHand: true, at },
  ];
  const t = humanTouch({ pollRows, ledgerRows: [], prsFor: () => [] });
  assert.equal(t.started.issues, 1, 'H-1 started by hand');
  assert.equal(t.reasons['retried by hand'], 1, 'H-2 retried by hand');
});
