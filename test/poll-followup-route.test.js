import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { pendingFollowUps, pollLedgerFile } from '../src/linear.js';
import { readJsonl } from '../src/ledger.js';
import { poll, queueFollowUps } from '../src/poll.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

// By default Keel's install root is this checkout: its keel.json names the Linear project `keel`, and it holds
// `src/gate.js`.

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-route-state-');
});

/**
 * An in-memory Linear with one list of issues per project (each `{ id, title, description, stateType }`). createIssue
 * records the source and the project it was asked to file in; comment records each source comment.
 */
function fakeClient(projects = {}) {
  const created = [];
  const comments = [];
  const set = [];
  return {
    created,
    comments,
    set,
    listIssues: async (project, { stateTypes } = {}) =>
      (projects[project] ?? [])
        .filter((i) => !stateTypes || stateTypes.includes(i.stateType ?? 'backlog'))
        .map(({ id, title, description = '' }) => ({ id, title, description, createdAt: '2026-10-01', labels: [], blockedBy: [] })),
    comment: async (id, body) => comments.push({ id, body }),
    stateType: async () => 'completed',
    setDescription: async (id, description) => set.push({ id, description }),
    createIssue: async (sourceId, fields, project) => {
      const id = `BUI-${900 + created.length}`;
      created.push({ id, sourceId, fields, project });
      return id;
    },
  };
}

const KEEL_FINDING = {
  kind: 'bug',
  title: 'keel gate reports install failed for a slow npm ci',
  detail: 'keel src/gate.js:95 treats a spawn timeout as a failed install',
};

const fileOnly = (dir, client, extra = {}) =>
  poll({
    repo: dir,
    project: 'dead-man-working',
    client,
    config: fixtureConfig({ followUpsPerDay: 5, linearProject: 'dead-man-working' }),
    runFn: () => assert.fail('file-only must not build'),
    fileOnly: true,
    log: () => {},
    ...extra,
  });

test("REQ-LINEAR-47 a follow-up that cites `keel src/gate.js:95` from a product repo is filed in Keel's project, and the source comment names it", async () => {
  const { dir } = fixtureRepo();
  queueFollowUps(dir, 'BUI-1711', [KEEL_FINDING], 'HEAD');
  const client = fakeClient();
  const r = await fileOnly(dir, client);
  assert.deepEqual(r, []);
  assert.equal(client.created.length, 1);
  const [c] = client.created;
  assert.equal(c.project, 'keel', "filed in the project Keel's own keel.json names");
  assert.equal(c.sourceId, null, "the source issue's project is not used");
  assert.equal(c.fields.title, KEEL_FINDING.title);
  // The card is built against Keel's repo: its paths are Keel's, with Keel's own test globs.
  assert.match(c.fields.description, /paths: src\/\*\*, test\/\*\*/);
  assert.deepEqual(client.comments.length, 1);
  assert.equal(client.comments[0].id, 'BUI-1711');
  assert.match(client.comments[0].body, /BUI-900 \(in project keel\)/);
  const filed = readJsonl(pollLedgerFile(dir)).find((row) => row.outcome === 'filed');
  assert.equal(filed.detail.project, 'keel');
  assert.deepEqual(pendingFollowUps(dir), []);
});

test("REQ-LINEAR-47 a follow-up that cites a path missing from the product at base but present in Keel's root goes to Keel's project", async () => {
  const { dir } = fixtureRepo();
  queueFollowUps(dir, 'BUI-1711', [{ kind: 'bug', title: 'scan misses a marker', detail: 'src/scan.js:10 skips it' }], 'HEAD');
  const client = fakeClient();
  await fileOnly(dir, client);
  assert.equal(client.created[0].project, 'keel');
  assert.equal(client.created[0].sourceId, null);
});

test('REQ-LINEAR-47 a follow-up that cites a product path stays in the product project', async () => {
  const { dir } = fixtureRepo();
  queueFollowUps(dir, 'BUI-1711', [{ kind: 'bug', title: 'add subtracts', detail: 'src/add.js:1 subtracts' }], 'HEAD');
  const client = fakeClient();
  await fileOnly(dir, client);
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0].sourceId, 'BUI-1711', "filed in the source issue's project");
  assert.match(client.comments[0].body, /follow-ups filed: BUI-900\./);
  assert.doesNotMatch(client.comments[0].body, /in project/);
});

test("REQ-LINEAR-47 a path the finding's own branch added stays in the product project even when Keel has the same file", async () => {
  const { dir } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-1711');
  commit(dir, { 'src/scan.js': 'export const scan = () => 1;\n' }, 'add scan');
  queueFollowUps(dir, 'BUI-1711', [{ kind: 'bug', title: 'scan returns 1', detail: 'src/scan.js:1 returns 1' }], 'HEAD');
  g(dir, 'checkout', '-q', 'main');
  const client = fakeClient();
  await fileOnly(dir, client, { base: 'main' });
  assert.equal(client.created[0].sourceId, 'BUI-1711');
  assert.equal(client.created[0].project, 'dead-man-working');
});

test("REQ-LINEAR-47 a Keel finding whose title Keel's project already has is a dup, and is never appended to a product card", async () => {
  const { dir } = fixtureRepo();
  queueFollowUps(dir, 'BUI-1711', [KEEL_FINDING], 'HEAD');
  const productCard =
    'Found by keel.\n\nKeel adds later findings in `src/gate.js` to this card.\n\n## Problem\n\n- x\n\n## Requirements\n\n- y\n\n## Acceptance\n\n- [ ] z\n\n```keel\nkind: bug\nsize: S\n```\n';
  const client = fakeClient({
    keel: [{ id: 'BUI-500', title: KEEL_FINDING.title.toUpperCase() }],
    'dead-man-working': [{ id: 'BUI-600', title: 'a product gate card', description: productCard }],
  });
  await fileOnly(dir, client);
  assert.deepEqual(client.created, []);
  assert.deepEqual(client.set, [], 'no product card takes a Keel finding');
  assert.equal(readJsonl(pollLedgerFile(dir)).at(-1).outcome, 'dup');
});

test("REQ-LINEAR-47 a poll of Keel's own project files a Keel finding in the source issue's project, as before", async () => {
  const { dir } = fixtureRepo();
  queueFollowUps(dir, 'BUI-1711', [KEEL_FINDING], 'HEAD');
  const client = fakeClient();
  await poll({
    repo: dir,
    project: 'keel',
    client,
    config: fixtureConfig({ followUpsPerDay: 5, linearProject: 'keel' }),
    runFn: () => assert.fail('file-only must not build'),
    fileOnly: true,
  });
  assert.equal(client.created[0].sourceId, 'BUI-1711');
});

test("REQ-LINEAR-47 when Keel's install root names no Linear project, a Keel finding stays in the product project and the poll logs why", async () => {
  const { dir } = fixtureRepo();
  const { dir: bare } = fixtureRepo({ 'src/gate.js': 'export const gate = 1;\n' });
  queueFollowUps(dir, 'BUI-1711', [KEEL_FINDING], 'HEAD');
  const client = fakeClient();
  const logs = [];
  await fileOnly(dir, client, { keelRoot: bare, log: (l) => logs.push(l) });
  assert.equal(client.created[0].sourceId, 'BUI-1711');
  assert.ok(
    logs.some((l) => /cites Keel's own code/.test(l) && /no "linearProject"/.test(l)),
    logs.join('\n'),
  );
});

test("REQ-LINEAR-47 a Keel finding is held by Keel's project's unbuilt follow-ups, not the product project's", async () => {
  const unbuilt = (prefix) =>
    Array.from({ length: 2 }, (_, i) => ({ id: `${prefix}-${i}`, title: `${prefix} finding ${i}`, description: 'Found by keel.\n' }));
  const config = fixtureConfig({ followUpsPerDay: 5, followUpOpenMax: 2, linearProject: 'dead-man-working' });
  const run = async (projects) => {
    const { dir } = fixtureRepo();
    queueFollowUps(dir, 'BUI-1711', [KEEL_FINDING], 'HEAD');
    const client = fakeClient(projects);
    await poll({ repo: dir, project: 'dead-man-working', client, config, runFn: () => assert.fail('no build'), fileOnly: true });
    return { client, last: readJsonl(pollLedgerFile(dir)).at(-1) };
  };
  const productFull = await run({ 'dead-man-working': unbuilt('DMW') });
  assert.equal(productFull.client.created[0]?.project, 'keel', 'a full product project does not hold a Keel finding');
  const keelFull = await run({ keel: unbuilt('KEEL') });
  assert.deepEqual(keelFull.client.created, []);
  assert.equal(keelFull.last.outcome, 'held');
});
