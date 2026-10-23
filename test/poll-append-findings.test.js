import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { humanTouch } from '../src/autonomy.js';
import { DEFAULTS } from '../src/config.js';
import { attemptedIssueIds, pendingFollowUps, pollLedgerFile } from '../src/linear.js';
import { readJsonl } from '../src/ledger.js';
import { poll, queueFollowUps } from '../src/poll.js';
import { fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-append-state-');
});

const marker = (path) => `Keel adds later findings in \`${path}\` to this card.`;

/** A findings card on `path` holding `bullets` findings, as Keel files it. */
const card = (path, bullets) =>
  [
    'Found by keel.',
    marker(path),
    `## Problem\n\n${bullets.map((b) => `- ${b}`).join('\n')}`,
    `## Requirements\n\n${bullets.map((b) => `- When ${b} runs, the code shall not.`).join('\n')}`,
    '## Acceptance\n\n- [ ] A new test that fails before the change and passes after it proves the requirement.',
    '```keel\nkind: bug\nsize: S\n```',
  ].join('\n\n') + '\n';

/**
 * An in-memory Linear: `open` are the project's open issues (each `{ id, description, createdAt, stateType }`).
 * listIssues honours the `stateTypes` filter as Linear does; setDescription and createIssue are recorded.
 */
function fakeClient(open = []) {
  const created = [];
  const set = [];
  const comments = [];
  return {
    created,
    set,
    comments,
    open,
    listIssues: async (_project, { stateTypes } = {}) =>
      open
        .filter((i) => !stateTypes || stateTypes.includes(i.stateType))
        .map(({ id, title = `card ${id}`, description, createdAt }) => ({ id, title, description, createdAt, labels: [], blockedBy: [] })),
    comment: async (id, body) => comments.push({ id, body }),
    stateType: async () => 'completed',
    setDescription: async (id, description) => {
      set.push({ id, description });
      const i = open.find((o) => o.id === id);
      if (i) i.description = description;
    },
    createIssue: async (sourceId, fields) => {
      const id = `BUI-${900 + created.length}`;
      created.push({ id, sourceId, fields });
      return id;
    },
  };
}

const SRC = { 'src/sub.js': 'export const sub = (a, b) => b - a;\nexport const add = (a, b) => a - b;\n', 'test/basic.test.js': 'ok\n' };

async function file(client, findings, { source = 'BUI-7', config = {} } = {}) {
  const { dir } = fixtureRepo(SRC);
  queueFollowUps(dir, source, findings, g(dir, 'rev-parse', 'HEAD'));
  const logs = [];
  const results = await poll({
    repo: dir,
    project: 'keel',
    client,
    config: { ...DEFAULTS, followUpsPerDay: 5, ...config },
    runFn: () => assert.fail('no issue should run'),
    fileOnly: true,
    log: (l) => logs.push(l),
  });
  return { dir, logs, results };
}

const finding = (title, line = 1) => ({ kind: 'bug', title, detail: `src/sub.js:${line}` });

test('REQ-LINEAR-38 a finding on a file an open findings card names is appended to that card, not filed', async () => {
  const client = fakeClient([
    { id: 'BUI-10', description: card('src/sub.js', ['first finding']), createdAt: '2026-10-01T00:00:00Z', stateType: 'backlog' },
  ]);
  const { dir, logs } = await file(client, [finding('add() subtracts', 2)]);
  assert.deepEqual(client.created, []);
  assert.equal(client.set.length, 1);
  assert.equal(client.set[0].id, 'BUI-10');
  const d = client.set[0].description;
  assert.match(
    d,
    /## Problem\n\n- first finding\n- add\(\) subtracts \(src\/sub\.js:2\)\n\n`src\/sub\.js:2` reads:\n\n> export const add = \(a, b\) => a - b;\n\n## Requirements/,
  );
  const reqs = /## Requirements\n\n([\s\S]*?)\n\n## Acceptance/.exec(d)[1].split('\n');
  assert.equal(reqs.length, 2);
  assert.match(reqs[1], /^- When .+, the code in `src\/sub\.js` shall .+add\(\) subtracts\.$/);
  assert.ok(logs.includes('follow-up "add() subtracts" appended to BUI-10'), logs.join('\n'));
  const row = readJsonl(pollLedgerFile()).find((r) => r.outcome === 'appended');
  assert.deepEqual(row.detail, { source: 'BUI-7', title: 'add() subtracts', into: 'BUI-10' });
  assert.deepEqual(pendingFollowUps(dir), [], 'an appended item leaves the queue');
  assert.equal(attemptedIssueIds(dir).size, 0, 'an append is not an attempt');
  const rows = readJsonl(pollLedgerFile());
  assert.equal(humanTouch({ pollRows: rows, ledgerRows: [], prsFor: () => [] }).issues, 0, 'an append is not a run');
  assert.ok(
    client.comments.some((c) => c.id === 'BUI-7' && /appended to BUI-10/.test(c.body)),
    JSON.stringify(client.comments),
  );
});

test('REQ-LINEAR-38 a started card, a full card, or one on another file gets no append; the oldest match is used', async () => {
  const five = ['a', 'b', 'c', 'd', 'e'];
  const client = fakeClient([
    { id: 'BUI-11', description: card('src/sub.js', ['x']), createdAt: '2026-10-01T00:00:00Z', stateType: 'started' },
    { id: 'BUI-12', description: card('src/sub.js', five), createdAt: '2026-10-02T00:00:00Z', stateType: 'backlog' },
    { id: 'BUI-13', description: card('src/other.js', ['y']), createdAt: '2026-10-03T00:00:00Z', stateType: 'backlog' },
    { id: 'BUI-15', description: card('src/sub.js', ['z']), createdAt: '2026-10-05T00:00:00Z', stateType: 'unstarted' },
    { id: 'BUI-14', description: card('src/sub.js', ['w']), createdAt: '2026-10-04T00:00:00Z', stateType: 'triage' },
  ]);
  await file(client, [finding('sub() is reversed')]);
  assert.deepEqual(
    client.set.map((s) => s.id),
    ['BUI-14'],
  );
  assert.deepEqual(client.created, []);
});

test('REQ-LINEAR-38 with no matching card a new follow-up is filed and names the marker for later findings', async () => {
  const client = fakeClient();
  await file(client, [finding('sub() is reversed')]);
  assert.equal(client.created.length, 1);
  const d = client.created[0].fields.description;
  assert.ok(d.split('\n\n')[0].split('\n').includes(marker('src/sub.js')), d);
  // A second finding on the same file found later goes into that card.
  client.open.push({ id: client.created[0].id, description: d, createdAt: '2026-10-06T00:00:00Z', stateType: 'backlog' });
  await file(client, [finding('add() subtracts', 2)]);
  assert.equal(client.created.length, 1);
  assert.equal(client.set[0].id, 'BUI-900');
});

test('REQ-LINEAR-38 a finding whose title an open card already holds is a dup, so it is never appended twice', async () => {
  const client = fakeClient([
    {
      id: 'BUI-10',
      description: card('src/sub.js', ['Add() Subtracts (src/sub.js:2)']),
      createdAt: '2026-10-01T00:00:00Z',
      stateType: 'backlog',
    },
  ]);
  const { dir } = await file(client, [finding('add() subtracts', 2)]);
  assert.deepEqual(client.set, []);
  assert.deepEqual(client.created, []);
  assert.ok(readJsonl(pollLedgerFile()).some((r) => r.repo === dir && r.outcome === 'dup'));
});

test('REQ-LINEAR-38 an append does not count toward followUpsPerDay', async () => {
  const client = fakeClient([
    { id: 'BUI-10', description: card('src/sub.js', ['first']), createdAt: '2026-10-01T00:00:00Z', stateType: 'backlog' },
  ]);
  await file(client, [finding('add() subtracts', 2), { kind: 'bug', title: 'unrelated thing', detail: 'no path here' }], {
    config: { followUpsPerDay: 1 },
  });
  assert.equal(client.set.length, 1);
  assert.equal(client.created.length, 1, 'the append left the one daily filing for the other item');
});
