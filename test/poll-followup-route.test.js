import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { poll, pollExitCode } from '../src/poll.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-route-state-');
});

const source = {
  id: 'BUI-7',
  title: 'build me',
  description: '- REQ-1: it shall work.',
  priority: 1,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  blockedBy: [],
};

/** An in-memory Linear: each project holds its own issues; `createIssue` records the project it was asked to file in. */
function fakeClient(byProject = {}) {
  const created = [];
  const comments = [];
  const listed = [];
  return {
    created,
    comments,
    listed,
    listIssues: async (project) => {
      listed.push(project);
      return [...(byProject[project] ?? []), ...created.filter((c) => c.home === project).map((c) => c.issue)];
    },
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
    setDescription: async () => assert.fail('no findings card takes an append here'),
    createIssue: async (sourceId, fields, project) => {
      const id = `BUI-${100 + created.length}`;
      // A source issue files in its own project (REQ-LINEAR-22); no source files in the project named.
      const home = sourceId ? 'dmw' : project;
      created.push({ sourceId, fields, project, home, issue: { id, title: fields.title, description: fields.description } });
      return id;
    },
  };
}

/** A Keel install root: a checkout whose keel.json names Keel's own Linear project. */
const keelJson = (over) => JSON.stringify({ checks: { test: 'npm test' }, testCommand: 'npm test', ...over });

function keelRoot(over = {}) {
  const { dir } = fixtureRepo();
  commit(dir, {
    'keel.json': keelJson({ linearProject: 'keel-own' }),
    'src/gate.js': 'export const gate = () => 0;\n',
    'bin/keel.js': '#!/usr/bin/env node\n',
    ...over,
  });
  return dir;
}

const productConfig = () => fixtureConfig({ followUpsPerDay: 5, linearProject: 'dmw' });

async function fileOnly(repo, client, root) {
  return poll({
    repo,
    project: 'dmw',
    client,
    config: productConfig(),
    runFn: () => assert.fail('file-only must not build'),
    fileOnly: true,
    keelRoot: root,
  });
}

test('REQ-LINEAR-46 a follow-up citing `keel src/gate.js:95` is filed in Keel’s project and the source comment says so', async () => {
  const { dir } = fixtureRepo();
  const root = keelRoot();
  recordPollAttempt(dir, {
    issue: 'BUI-7',
    outcome: 'found',
    detail: [
      { kind: 'bug', title: 'gate reports install failed for a slow npm ci', detail: 'keel src/gate.js:95 uses sh' },
      { kind: 'bug', title: 'add subtracts', detail: 'src/add.js:1' },
    ],
  });
  const client = fakeClient({ dmw: [source] });
  const r = await fileOnly(dir, client, root);
  assert.deepEqual(r, []);
  assert.equal(pollExitCode(r), 0);
  assert.equal(client.created.length, 2);
  const [keel, product] = client.created;
  assert.equal(keel.fields.title, 'gate reports install failed for a slow npm ci');
  assert.equal(keel.sourceId, null, 'filed by project name, not in the source issue’s project');
  assert.equal(keel.project, 'keel-own');
  assert.equal(keel.fields.blockedBy, undefined, 'a product issue’s branch cannot change Keel’s code');
  assert.match(keel.fields.description, /^Found by keel while building BUI-7\./);
  assert.match(keel.fields.description, /paths: src\/\*\*/);
  assert.equal(product.fields.title, 'add subtracts');
  assert.equal(product.sourceId, 'BUI-7', 'a product path stays in the source issue’s project');
  assert.equal(product.home, 'dmw');
  assert.equal(client.comments.length, 1);
  assert.equal(client.comments[0].id, 'BUI-7');
  assert.match(client.comments[0].body, /BUI-100 \(Keel's own code, filed in project keel-own\)/);
  assert.match(client.comments[0].body, /BUI-101(?! \()/);
  assert.ok(client.listed.includes('keel-own'), 'a Keel finding is deduped against Keel’s project');
  assert.deepEqual(pendingFollowUps(dir), []);
});

test('REQ-LINEAR-46 a cited path missing from the built repo but present in Keel’s root goes to Keel’s project', async () => {
  const { dir } = fixtureRepo();
  const root = keelRoot();
  recordPollAttempt(dir, {
    issue: 'BUI-7',
    outcome: 'found',
    detail: [
      { kind: 'chore', title: 'keel bin prints no version', detail: 'bin/keel.js:1' },
      { kind: 'bug', title: 'missing everywhere', detail: 'lib/nowhere.js:3' },
    ],
  });
  const client = fakeClient({ dmw: [source] });
  await fileOnly(dir, client, root);
  assert.deepEqual(
    client.created.map((c) => [c.fields.title, c.home]),
    [
      ['keel bin prints no version', 'keel-own'],
      ['missing everywhere', 'dmw'],
    ],
  );
});

test('REQ-LINEAR-46 a title Keel’s project already has is marked dup, not filed again', async () => {
  const { dir } = fixtureRepo();
  const root = keelRoot();
  recordPollAttempt(dir, {
    issue: 'BUI-7',
    outcome: 'found',
    detail: [{ kind: 'bug', title: 'Gate reports install failed', detail: 'keel src/gate.js:95' }],
  });
  const client = fakeClient({ dmw: [source], 'keel-own': [{ id: 'BUI-50', title: 'gate reports install failed', description: '' }] });
  await fileOnly(dir, client, root);
  assert.deepEqual(client.created, []);
  assert.deepEqual(pendingFollowUps(dir), []);
});

test('REQ-LINEAR-46 a path the built repo has stays in the product project, even when Keel has the same path', async () => {
  const { dir } = fixtureRepo();
  const root = keelRoot({ 'src/add.js': 'export const add = () => 0;\n' });
  recordPollAttempt(dir, { issue: 'BUI-7', outcome: 'found', detail: [{ kind: 'bug', title: 'add is wrong', detail: 'src/add.js:1' }] });
  const client = fakeClient({ dmw: [source] });
  await fileOnly(dir, client, root);
  assert.equal(client.created[0].sourceId, 'BUI-7');
  assert.equal(client.created[0].home, 'dmw');
});

test('REQ-LINEAR-46 with no Keel project in its keel.json, or the poll in Keel’s own project, the source project is kept', async () => {
  for (const [root, project] of [
    [keelRoot({ 'keel.json': keelJson({}) }), 'dmw'],
    [keelRoot({ 'keel.json': keelJson({ linearProject: 'dmw' }) }), 'dmw'],
  ]) {
    process.env.KEEL_STATE_DIR = tmp('keel-route-state-');
    const { dir } = fixtureRepo();
    recordPollAttempt(dir, {
      issue: 'BUI-7',
      outcome: 'found',
      detail: [{ kind: 'bug', title: 'gate bug', detail: 'keel src/gate.js:95' }],
    });
    const client = fakeClient({ [project]: [source] });
    await fileOnly(dir, client, root);
    assert.equal(client.created.length, 1);
    assert.equal(client.created[0].sourceId, 'BUI-7');
    assert.doesNotMatch(client.comments[0].body, /Keel's own code/);
  }
});

test('REQ-LINEAR-46 a keel.json at Keel’s root that cannot be read is a filing error; the finding stays queued', async () => {
  const { dir } = fixtureRepo();
  const root = keelRoot({ 'keel.json': '{ not json' });
  recordPollAttempt(dir, { issue: 'BUI-7', outcome: 'found', detail: [{ kind: 'bug', title: 'gate bug', detail: 'keel src/gate.js:95' }] });
  const client = fakeClient({ dmw: [source] });
  const r = await fileOnly(dir, client, root);
  assert.equal(r[0].outcome, 'followUpsFailed');
  assert.match(r[0].detail, /JSON/);
  assert.equal(pollExitCode(r), 1);
  assert.deepEqual(client.created, []);
  assert.deepEqual(
    pendingFollowUps(dir).map((f) => f.title),
    ['gate bug'],
  );
});
