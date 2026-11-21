import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { checkCard } from '../src/check-card.js';
import { DEFAULTS } from '../src/config.js';
import { cardFromIssue } from '../src/linear.js';
import { poll, queueFollowUps } from '../src/poll.js';
import { fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-citedpaths-state-');
});

/** An in-memory Linear that records each created issue; every source is closed, so no relation is added. */
function fakeClient() {
  const created = [];
  return {
    created,
    listIssues: async () => [],
    comment: async () => {},
    stateType: async () => 'completed',
    createIssue: async (sourceId, fields) => {
      created.push({ sourceId, fields });
      return `BUI-${800 + created.length}`;
    },
  };
}

const noRun = () => assert.fail('no issue should run');
const BASE = {
  'lib/automation/publish-tools.ts': 'export const publish = 1;\n',
  'mcp/server.ts': 'export const server = 1;\n',
  'test/basic.test.js': 'ok\n',
};

/** File one finding from the repo's HEAD; returns the filed card's keel block and parsed card. */
async function file(dir, finding) {
  queueFollowUps(dir, 'BUI-7', [finding], g(dir, 'rev-parse', 'HEAD'));
  const client = fakeClient();
  await poll({ repo: dir, project: 'keel', client, config: { ...DEFAULTS }, runFn: noRun, limit: 0 });
  assert.equal(client.created.length, 1, 'one follow-up filed');
  const description = client.created[0].fields.description;
  const card = cardFromIssue({ id: 'BUI-801', title: 't', description, labels: [], estimate: null });
  return { block: /```keel\n([\s\S]*?)\n```/.exec(description)[1], card, description };
}

test('REQ-LINEAR-56 a follow-up allows every existing file its finding names, not only the cited one', async () => {
  const { dir } = fixtureRepo(BASE);
  const { card } = await file(dir, {
    kind: 'bug',
    title: 'publish_site reports no build progress',
    detail: 'lib/automation/publish-tools.ts:118 never calls the progress hook that `mcp/server.ts publish_site` passes.',
  });
  assert.ok(card.paths.includes('lib/automation/**'), card.paths.join(', '));
  assert.ok(card.paths.includes('mcp/server.ts'), card.paths.join(', '));
  assert.equal(card.paths.filter((p) => p === 'mcp/server.ts').length, 1);
});

test('REQ-LINEAR-56 a named file the gate locks is also an allowed edit; one a glob covers is not repeated', async () => {
  const { dir } = fixtureRepo({ ...BASE, '.github/workflows/ci.yml': 'name: ci\n', 'docs/guide.md': 'guide\n' });
  const { card } = await file(dir, {
    kind: 'bug',
    title: 'the publish job skips a step',
    detail: 'lib/automation/publish-tools.ts:3 must match `.github/workflows/ci.yml` and docs/guide.md.',
  });
  assert.ok(card.paths.includes('.github/workflows/ci.yml'));
  assert.deepEqual(card.allowEdits, ['.github/workflows/ci.yml']);
  assert.ok(!card.paths.includes('docs/guide.md'), '**/*.md already covers it');
});

test('REQ-LINEAR-56 a follow-up adds the traceability file a new test must be mapped in', async () => {
  const { dir } = fixtureRepo({ ...BASE, 'docs/traceability.json': '{}\n' });
  const { card, description } = await file(dir, {
    kind: 'bug',
    title: 'publish fails',
    detail: 'lib/automation/publish-tools.ts:1',
  });
  assert.ok(card.paths.includes('docs/traceability.json'), card.paths.join(', '));
  const lines = [];
  const issues = async () => [{ id: 'BUI-801', title: 't', description, labels: [], estimate: null }];
  const code = await checkCard({ repo: dir, base: 'HEAD', target: 'BUI-801', issues, log: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
});

test('REQ-LINEAR-56 a chore follow-up adds no traceability file, as check-card asks for none', async () => {
  const { dir } = fixtureRepo({ ...BASE, 'docs/traceability.json': '{}\n' });
  const { card } = await file(dir, { kind: 'chore', title: 'tidy publish', detail: 'lib/automation/publish-tools.ts:1' });
  assert.ok(!card.paths.includes('docs/traceability.json'), card.paths.join(', '));
});

test('REQ-LINEAR-56 a named path that is not at base is left out and the card passes check-card', async () => {
  const { dir } = fixtureRepo(BASE);
  const { card, description } = await file(dir, {
    kind: 'bug',
    title: 'publish_site reports no build progress',
    detail: 'lib/automation/publish-tools.ts:118 needs `mcp/missing.ts` and mcp/server.ts to agree.',
  });
  assert.ok(card.paths.includes('mcp/server.ts'));
  assert.ok(!card.paths.includes('mcp/missing.ts'), card.paths.join(', '));
  const lines = [];
  const issues = async () => [{ id: 'BUI-801', title: 't', description, labels: [], estimate: null }];
  const code = await checkCard({ repo: dir, base: 'HEAD', target: 'BUI-801', issues, log: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
});
