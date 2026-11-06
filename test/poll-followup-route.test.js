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

test("REQ-LINEAR-47 a full project holds only its own queued follow-ups: the other project's, queued behind them, are filed", async () => {
  const unbuilt = (prefix) =>
    Array.from({ length: 2 }, (_, i) => ({ id: `${prefix}-${i}`, title: `${prefix} finding ${i}`, description: 'Found by keel.\n' }));
  const config = fixtureConfig({ followUpsPerDay: 5, followUpOpenMax: 2, linearProject: 'dead-man-working' });
  const PRODUCT = { kind: 'bug', title: 'add subtracts', detail: 'src/add.js:1 subtracts' };
  const run = async (projects, findings) => {
    process.env.KEEL_STATE_DIR = tmp('keel-route-state-'); // one ledger per run, so each run reads only its own rows
    const { dir } = fixtureRepo();
    queueFollowUps(dir, 'BUI-1711', findings, 'HEAD');
    const client = fakeClient(projects);
    const logs = [];
    const r = await poll({
      repo: dir,
      project: 'dead-man-working',
      client,
      config,
      runFn: () => assert.fail('no build'),
      fileOnly: true,
      log: (l) => logs.push(l),
    });
    return { r, client, logs, dir, held: readJsonl(pollLedgerFile(dir)).filter((row) => row.outcome === 'held') };
  };
  // Keel's project is full and its finding is first: the product finding behind it is still filed.
  const keelFull = await run({ keel: unbuilt('KEEL') }, [KEEL_FINDING, PRODUCT]);
  assert.deepEqual(keelFull.r, []);
  assert.deepEqual(
    keelFull.client.created.map((c) => [c.fields.title, c.sourceId]),
    [[PRODUCT.title, 'BUI-1711']],
  );
  assert.equal(keelFull.held.length, 1);
  assert.deepEqual(keelFull.held[0].detail, { reason: 'unbuilt', unbuilt: 2, max: 2, waiting: 1, project: 'keel' });
  assert.ok(
    keelFull.logs.some((l) => /^follow-ups held for project keel: 2 unbuilt follow-ups >= 2 \(followUpOpenMax\); 1 wait/.test(l)),
    keelFull.logs.join('\n'),
  );
  assert.deepEqual(
    pendingFollowUps(keelFull.dir, 3).map((f) => f.title),
    [KEEL_FINDING.title],
    'the held Keel finding stays queued',
  );
  // The product project is full and its finding is first: the Keel finding behind it is still filed.
  const productFull = await run({ 'dead-man-working': unbuilt('DMW') }, [PRODUCT, KEEL_FINDING]);
  assert.deepEqual(
    productFull.client.created.map((c) => [c.fields.title, c.project]),
    [[KEEL_FINDING.title, 'keel']],
  );
  assert.deepEqual(productFull.held[0].detail, { reason: 'unbuilt', unbuilt: 2, max: 2, waiting: 1 });
});

test("REQ-LINEAR-47 a card filed in Keel's project says which repo its source, commit, and PR are in", async () => {
  const { dir } = fixtureRepo();
  const repoName = dir.split('/').at(-1);
  const sha = g(dir, 'rev-parse', 'HEAD');
  const PR = 'https://github.com/example/dead-man-working/pull/7';
  queueFollowUps(dir, 'BUI-1711', [KEEL_FINDING, { kind: 'bug', title: 'add subtracts', detail: 'src/add.js:1 subtracts' }], 'HEAD', PR);
  const client = fakeClient();
  await fileOnly(dir, client);
  const [keel, product] = client.created.map((c) => c.fields.description);
  assert.match(keel, new RegExp(`^Found by keel while building BUI-1711 in ${repoName}\\.$`, 'm'));
  assert.ok(keel.includes(`seen at commit ${sha.slice(0, 12)} of ${repoName}, PR ${PR}.`), keel);
  // A card filed in the repo it was found in reads as before.
  assert.match(product, /^Found by keel while building BUI-1711\.$/m);
  assert.ok(product.includes(`seen at commit ${sha.slice(0, 12)}, PR ${PR}.`), product);
});

test("REQ-LINEAR-47 when the daily cap or the workspace hold ends the pass, a full project's held row counts every item queued for it", async () => {
  const unbuilt = Array.from({ length: 2 }, (_, i) => ({ id: `KEEL-${i}`, title: `keel finding ${i}`, description: 'Found by keel.\n' }));
  const PRODUCT = { kind: 'bug', title: 'add subtracts', detail: 'src/add.js:1 subtracts' };
  const SECOND = { kind: 'bug', title: 'keel gate drops a log line', detail: 'keel src/gate.js:120 drops it' };
  const run = async (over, extra = {}) => {
    process.env.KEEL_STATE_DIR = tmp('keel-route-state-');
    const { dir } = fixtureRepo();
    queueFollowUps(dir, 'BUI-1711', [KEEL_FINDING, PRODUCT, SECOND], 'HEAD');
    const client = fakeClient({ keel: unbuilt });
    const logs = [];
    await poll({
      repo: dir,
      project: 'dead-man-working',
      client,
      config: fixtureConfig({ followUpOpenMax: 2, linearProject: 'dead-man-working', ...over }),
      runFn: () => assert.fail('no build'),
      fileOnly: true,
      log: (l) => logs.push(l),
      ...extra,
    });
    const held = readJsonl(pollLedgerFile(dir)).filter((r) => r.outcome === 'held' && r.detail.project === 'keel');
    return { client, logs, held };
  };
  // The cap of 1 a day ends the pass at SECOND, after PRODUCT is filed: both Keel findings wait for Keel's project.
  const capped = await run({ followUpsPerDay: 1 });
  assert.deepEqual(
    capped.client.created.map((c) => c.fields.title),
    [PRODUCT.title],
  );
  assert.equal(capped.held.length, 1);
  assert.equal(capped.held[0].detail.waiting, 2);
  assert.ok(
    capped.logs.some((l) => /held for project keel: .*; 2 wait in the queue/.test(l)),
    capped.logs.join('\n'),
  );
  // The workspace hold ends the pass at PRODUCT: SECOND, behind it, still counts as waiting for Keel's project.
  const full = await run({ followUpsPerDay: 5, followUpHoldAt: 200 }, { capacityFn: async () => ({ open: 250 }) });
  assert.deepEqual(full.client.created, []);
  assert.equal(full.held[0].detail.waiting, 2);
});
