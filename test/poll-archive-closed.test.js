import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { linearHttpClient } from '../src/linear-http.js';
import { poll, pollExitCode } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

const originalFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-archive-state-');
  process.env.LINEAR_API_KEY = 'lin_api_test';
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINEAR_API_KEY;
});

function stubFetch(responses) {
  let i = 0;
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => responses[i++] };
  };
}

const client = { listIssues: async () => [], comment: async () => {} };

async function pollWith(archiveFn, fileOnly) {
  const { dir } = fixtureRepo();
  const logs = [];
  const results = await poll({
    repo: dir,
    project: 'keel',
    client,
    config: { ...DEFAULTS },
    runFn: () => assert.fail('no issue should run'),
    archiveFn,
    fileOnly,
    limit: 1,
    log: (l) => logs.push(l),
  });
  return { results, logs };
}

test('REQ-LINEAR-39 every poll, --file-only included, archives the project closed issues and logs them', async () => {
  for (const fileOnly of [false, true]) {
    let n = 0;
    const { results, logs } = await pollWith(async () => (n++, ['BUI-1', 'BUI-2']), fileOnly);
    assert.equal(n, 1);
    assert.ok(logs.includes('archived 2 closed issue(s): BUI-1, BUI-2'), logs.join('\n'));
    assert.notEqual(pollExitCode(results), 1);
  }
});

test('REQ-LINEAR-39 nothing closed logs nothing; an archive error is logged and fails the poll without stopping it', async () => {
  const quiet = await pollWith(async () => [], true);
  assert.ok(!quiet.logs.some((l) => /archived/.test(l)));
  const { results, logs } = await pollWith(async () => {
    throw new Error('HTTP 500');
  }, false);
  assert.ok(logs.includes('closed issues not archived: HTTP 500'), logs.join('\n'));
  assert.equal(pollExitCode(results), 1);
  assert.ok(
    results.some((r) => r.outcome === 'none'),
    'the poll went on',
  );
});

test('REQ-LINEAR-39 archiveClosed reads every page of the project closed issues and archives each', async () => {
  stubFetch([
    { data: { issues: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ id: 'u1', identifier: 'BUI-1' }] } } },
    { data: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'u2', identifier: 'BUI-2' }] } } },
    { data: { issueArchive: { success: true } } },
    { data: { issueArchive: { success: true } } },
  ]);
  assert.deepEqual(await linearHttpClient().archiveClosed('keel'), ['BUI-1', 'BUI-2']);
  assert.deepEqual(calls[0].variables.filter, { project: { name: { eq: 'keel' } }, state: { type: { in: ['completed', 'canceled'] } } });
  assert.equal(calls[1].variables.after, 'c1');
  assert.deepEqual(
    calls.slice(2).map((c) => [/issueArchive/.test(c.query), c.variables.id]),
    [
      [true, 'u1'],
      [true, 'u2'],
    ],
  );
});

test('REQ-LINEAR-39 the dedupe read of recently closed issues includes archived ones', async () => {
  stubFetch([
    { data: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } },
    { data: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } },
  ]);
  await linearHttpClient().listIssues('keel', { closedWithinDays: 30 });
  assert.equal(calls[0].variables.includeArchived, true);
  await linearHttpClient().listIssues('keel');
  assert.notEqual(calls[1].variables.includeArchived, true, 'picking reads open, unarchived issues only');
});

test('REQ-LINEAR-38 listIssues filters by state type when asked', async () => {
  stubFetch([{ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } }]);
  await linearHttpClient().listIssues('keel', { stateTypes: ['backlog', 'unstarted', 'triage'] });
  assert.deepEqual(calls[0].variables.filter, {
    project: { name: { eq: 'keel' } },
    state: { type: { in: ['backlog', 'unstarted', 'triage'] } },
  });
});

test('REQ-LINEAR-39 by default the poll archives through the Linear client', async () => {
  const { dir } = fixtureRepo();
  const asked = [];
  const logs = [];
  const archiving = { ...client, archiveClosed: async (project) => (asked.push(project), ['BUI-9']) };
  await poll({
    repo: dir,
    project: 'keel',
    client: archiving,
    config: { ...DEFAULTS },
    runFn: () => assert.fail('no run'),
    fileOnly: true,
    log: (l) => logs.push(l),
  });
  assert.deepEqual(asked, ['keel']);
  assert.ok(logs.includes('archived 1 closed issue(s): BUI-9'), logs.join('\n'));
});
