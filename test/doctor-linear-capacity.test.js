import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { LINEAR_ISSUE_LIMIT, linearCapacity, linearDoctor } from '../src/doctor.js';
import { linearHttpClient } from '../src/linear-http.js';

const teams = [{ key: 'BUI', autoArchivePeriod: 1 }];

test('REQ-CLI-16 doctor reports unarchived Linear issues against the 250 limit and each team archive period', () => {
  assert.equal(LINEAR_ISSUE_LIMIT, 250);
  assert.deepEqual(linearCapacity({ open: 120, teams }), [
    { level: 'INFO', text: 'linear 120 of 250 unarchived issues' },
    { level: 'INFO', text: 'linear team BUI auto-archives closed issues after 1 month' },
  ]);
});

test('REQ-CLI-16 doctor warns at 200 unarchived issues and fails at 250', () => {
  assert.equal(linearCapacity({ open: 199, teams })[0].level, 'INFO');
  const warn = linearCapacity({ open: 200, teams })[0];
  assert.equal(warn.level, 'WARN');
  assert.match(warn.text, /200 of 250 unarchived issues: archive closed issues/);
  const fail = linearCapacity({ open: 250, teams })[0];
  assert.equal(fail.level, 'FAIL');
  assert.match(fail.text, /Linear refuses new issues/);
});

test('REQ-CLI-16 doctor warns when a team keeps closed issues unarchived longer than a month', () => {
  const rows = linearCapacity({ open: 10, teams: [{ key: 'A', autoArchivePeriod: 6 }] });
  assert.deepEqual(rows.slice(1), [
    { level: 'WARN', text: 'linear team A auto-archives closed issues after 6 months; set 1 so closed issues stop counting sooner' },
  ]);
});

const fake = (usage) => () => ({ capacity: async () => (usage instanceof Error ? Promise.reject(usage) : usage) });

test('REQ-CLI-16 without LINEAR_API_KEY the doctor reads nothing from Linear and prints nothing', async () => {
  const logs = [];
  const failed = await linearDoctor({ env: {}, client: () => assert.fail('no client without a key'), log: (l) => logs.push(l) });
  assert.equal(failed, false);
  assert.deepEqual(logs, []);
});

test('REQ-CLI-16 a FAIL row fails the doctor, a WARN does not, and a read error is a WARN that does not fail it', async () => {
  const env = { LINEAR_API_KEY: 'k' };
  let logs = [];
  assert.equal(await linearDoctor({ env, client: fake({ open: 250, teams }), log: (l) => logs.push(l) }), true);
  assert.match(logs[0], /^FAIL linear 250 of 250/);
  logs = [];
  assert.equal(await linearDoctor({ env, client: fake({ open: 210, teams }), log: (l) => logs.push(l) }), false);
  assert.match(logs[0], /^WARN linear 210 of 250/);
  logs = [];
  assert.equal(await linearDoctor({ env, client: fake(new Error('HTTP 500')), log: (l) => logs.push(l) }), false);
  assert.deepEqual(logs, ['WARN linear capacity unknown: HTTP 500']);
});

test('REQ-CLI-16 capacity() counts unarchived issues across every page and returns each team archive period', async (t) => {
  const original = globalThis.fetch;
  const key = process.env.LINEAR_API_KEY;
  t.after(() => {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = key;
  });
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const pages = [
    {
      issues: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: Array.from({ length: 250 }, (_, i) => ({ id: `a${i}` })) },
      teams: { nodes: teams },
    },
    { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'b0' }, { id: 'b1' }] }, teams: { nodes: teams } },
  ];
  const bodies = [];
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ data: pages[bodies.length - 1] }) };
  };
  assert.deepEqual(await linearHttpClient().capacity(), { open: 252, teams });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].variables.after, 'c1');
  assert.match(bodies[0].query, /issues\(first: 250/);
  assert.doesNotMatch(bodies[0].query, /includeArchived: true/);
});

test('REQ-CLI-16 the test script runs with LINEAR_API_KEY cleared, so no test reaches the real Linear', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /^LINEAR_API_KEY= /);
});
