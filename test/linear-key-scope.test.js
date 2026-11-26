import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { LINEAR_KEY_NAMES } from '../src/env.js';
import { LinearKeyError, linearHttpClient } from '../src/linear-http.js';
import { FIXTURE_TEST, commit, fixtureRepo, tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;

/** Stub fetch with one page per call; restores fetch and the key after the test. */
function stub(t, pages) {
  const original = globalThis.fetch;
  const saved = process.env.LINEAR_API_KEY;
  t.after(() => {
    globalThis.fetch = original;
    if (saved === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = saved;
  });
  process.env.LINEAR_API_KEY = ['lin', 'api', 'test'].join('_');
  const bodies = [];
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ data: pages[bodies.length - 1] }) };
  };
  return bodies;
}

const page = (n, { next = null, teams, org }) => ({
  issues: { pageInfo: { hasNextPage: Boolean(next), endCursor: next }, nodes: Array.from({ length: n }, (_, i) => ({ id: `i${i}` })) },
  teams: { nodes: teams },
  organization: { teams: { nodes: org } },
});

test('REQ-LINEAR-60 capacity() fails, naming the teams it cannot read, when the key reaches only some of the workspace teams', async (t) => {
  const bui = { key: 'BUI', autoArchivePeriod: 1 };
  stub(t, [page(120, { teams: [bui], org: [{ key: 'BUI' }, { key: 'OPS' }, { key: 'MKT' }] })]);
  await assert.rejects(
    () => linearHttpClient().capacity(),
    (e) => {
      assert.match(e.message, /reaches only team BUI of the workspace's 3 teams/);
      assert.match(e.message, /cannot read MKT, OPS/);
      assert.match(e.message, /250-issue count would be low/);
      return true;
    },
  );
});

test('REQ-LINEAR-60 capacity() asks for the workspace teams and counts every page when the key reaches every team', async (t) => {
  const teams = [
    { key: 'BUI', autoArchivePeriod: 1 },
    { key: 'OPS', autoArchivePeriod: 6 },
  ];
  const org = [{ key: 'OPS' }, { key: 'BUI' }];
  const bodies = stub(t, [page(250, { next: 'c1', teams, org }), page(3, { teams, org })]);
  assert.deepEqual(await linearHttpClient().capacity(), { open: 253, teams });
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].query, /organization\s*\{\s*teams\(first: 250\)/);
  assert.match(bodies[0].query, /\bteams\(first: 250\)\s*\{\s*nodes\s*\{\s*key autoArchivePeriod/);
});

test('REQ-LINEAR-60 capacity() fails when the workspace has more teams than one page reads', async (t) => {
  const teams = [{ key: 'BUI', autoArchivePeriod: 1 }];
  const many = page(1, { teams, org: [{ key: 'BUI' }] });
  many.organization.teams.pageInfo = { hasNextPage: true };
  stub(t, [many]);
  await assert.rejects(() => linearHttpClient().capacity(), /more than 250 teams/);
});

test('REQ-LINEAR-61 a missing Linear key is a LinearKeyError naming both variables, before any request', async (t) => {
  const saved = Object.fromEntries(LINEAR_KEY_NAMES.map((n) => [n, process.env[n]]));
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
    for (const [n, v] of Object.entries(saved))
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
  });
  for (const n of LINEAR_KEY_NAMES) delete process.env[n];
  globalThis.fetch = async () => assert.fail('must not call fetch without a key');
  await assert.rejects(
    () => linearHttpClient().listIssues('p'),
    (e) => e instanceof LinearKeyError && /LINEAR_API_KEY is not set and LINEAR_BUILDPROVEN_KEY is not set/.test(e.message),
  );
});

for (const args of [
  ['check-card', 'BUI-1'],
  ['gate', '--card', 'BUI-1'],
]) {
  test(`REQ-LINEAR-61 keel ${args[0]} with an issue ID and no Linear key stops with one line and exit 4, no stack trace`, () => {
    const { dir } = fixtureRepo();
    commit(dir, { 'keel.json': `${JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST })}\n` }, 'keel');
    const env = { ...process.env, KEEL_STATE_DIR: tmp('keel-state-') };
    for (const n of LINEAR_KEY_NAMES) delete env[n];
    const r = spawnSync(process.execPath, [BIN, ...args, '--repo', dir, '--base', 'HEAD', '--project', 'p'], { encoding: 'utf8', env });
    assert.equal(r.status, 4, r.stderr);
    const lines = r.stderr.trim().split('\n');
    assert.equal(
      lines.at(-1),
      `keel: ${args[0]} stopped: LINEAR_API_KEY is not set and LINEAR_BUILDPROVEN_KEY is not set; Keel needs a Linear personal API key in one of them`,
    );
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });
}
