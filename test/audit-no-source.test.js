import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { audit } from '../src/audit.js';
import { DEFAULTS } from '../src/config.js';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { linearHttpClient } from '../src/linear-http.js';
import { poll } from '../src/poll.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LINEAR_API_KEY;
});

const blocks = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-codex',
  effort: 'high',
  command: [
    'node',
    '-e',
    "require('fs').readFileSync(0); console.log('FINDING high src/add.js:1 add ignores NaN'); console.log('VERDICT: block')",
  ],
};

/** One fallback-reviewed merge whose PR body closes no issue, and a fake gh that reports it. */
function setup() {
  const { dir } = fixtureRepo();
  const m1 = commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add numbers (#1)');
  const prs = [{ number: 1, title: 'fix: add numbers', body: 'Fix add.', headRefOid: 'h1', mergeCommit: { oid: m1 } }];
  const statuses = {
    h1: [{ context: 'keel/gate', description: 'passed; review by claude/claude-opus-5-5/high (fallback: exec/exec-codex/high quota)' }],
  };
  const bin = tmp('keel-bin-');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'list') { console.log(${JSON.stringify(JSON.stringify(prs))}); process.exit(0); }
const m = a.join(' ').match(/commits\\/(\\w+)\\/statuses/);
if (a[0] === 'api' && m) { console.log(JSON.stringify((${JSON.stringify(statuses)})[m[1]] ?? [])); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { dir, bin };
}

test('REQ-CLI-11 audit findings on a merge that closes no issue still join the found-work queue, with no source', () => {
  const { dir, bin } = setup();
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    audit({ repo: dir, config: fixtureConfig({ tiers: [blocks] }), limit: 20 });
  } finally {
    process.env.PATH = old;
  }
  const queued = pendingFollowUps(dir);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].source, null);
  assert.match(queued[0].title, /^Audit #1: add ignores NaN/);
});

test('REQ-LINEAR-22 found work with no source issue is filed in the polled project, and no source comment is posted', async () => {
  const { dir } = fixtureRepo();
  recordPollAttempt(dir, {
    issue: null,
    outcome: 'found',
    detail: [{ kind: 'bug', title: 'Audit #1: add ignores NaN', detail: 'high a:1' }],
  });
  const created = [];
  const comments = [];
  const client = {
    listIssues: async () => [],
    comment: async (id, body) => comments.push({ id, body }),
    createIssue: async (sourceId, fields, project) => {
      created.push({ sourceId, fields, project });
      return 'BUI-300';
    },
  };
  await poll({ repo: dir, project: 'Keel', client, config: { ...DEFAULTS }, runFn: () => assert.fail('no issue to run') });
  assert.equal(created.length, 1);
  assert.equal(created[0].sourceId, null);
  assert.equal(created[0].project, 'Keel');
  assert.match(created[0].fields.description, /^Found by keel\./);
  assert.deepEqual(comments, []);
  assert.deepEqual(pendingFollowUps(dir), []);
});

test('REQ-LINEAR-22 createIssue with no source issue files in the named project and its team', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const calls = [];
  const responses = [
    { data: { projects: { nodes: [{ id: 'proj-1', teams: { nodes: [{ id: 'team-1' }] } }] } } },
    { data: { issueCreate: { success: true, issue: { identifier: 'BUI-201' } } } },
  ];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => responses[calls.length - 1] };
  };
  const id = await linearHttpClient().createIssue(null, { title: 'T', description: 'D', priority: 4 }, 'Keel');
  assert.equal(id, 'BUI-201');
  assert.deepEqual(calls[0].variables, { name: 'Keel' });
  assert.deepEqual(calls[1].variables, { input: { teamId: 'team-1', projectId: 'proj-1', title: 'T', description: 'D', priority: 4 } });
});

test('REQ-LINEAR-22 createIssue with no source issue fails visibly when the project is not found', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { projects: { nodes: [] } } }) });
  await assert.rejects(linearHttpClient().createIssue(null, { title: 'T', description: 'D', priority: 4 }, 'Nope'), /project "Nope"/);
});
