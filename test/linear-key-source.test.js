import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linearDoctor } from '../src/doctor.js';
import { LINEAR_KEY_NAMES, linearKey } from '../src/env.js';
import { linearHttpClient } from '../src/linear-http.js';

const NAMES = ['LINEAR_API_KEY', 'LINEAR_BUILDPROVEN_KEY'];

function withEnv(t, env) {
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const n of NAMES)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  });
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, env);
}

const respond = (seen) => async (url, init) => {
  seen.push(init.headers.Authorization);
  return { ok: true, json: async () => ({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } }) };
};

test('REQ-LINEAR-47 the key list is LINEAR_API_KEY then LINEAR_BUILDPROVEN_KEY, and an empty value is unset', () => {
  assert.deepEqual(LINEAR_KEY_NAMES, NAMES);
  assert.deepEqual(linearKey({ LINEAR_API_KEY: 'a', LINEAR_BUILDPROVEN_KEY: 'b' }), { name: 'LINEAR_API_KEY', value: 'a' });
  assert.deepEqual(linearKey({ LINEAR_API_KEY: '', LINEAR_BUILDPROVEN_KEY: 'b' }), { name: 'LINEAR_BUILDPROVEN_KEY', value: 'b' });
  assert.equal(linearKey({}), null);
});

test('REQ-LINEAR-47 with only LINEAR_BUILDPROVEN_KEY set the Linear client is built with it', async (t) => {
  withEnv(t, { LINEAR_BUILDPROVEN_KEY: 'lin_bp' });
  const seen = [];
  globalThis.fetch = respond(seen);
  await linearHttpClient().listIssues('Demo');
  assert.deepEqual(seen, ['lin_bp']);
});

test('REQ-LINEAR-47 LINEAR_API_KEY wins when both are set', async (t) => {
  withEnv(t, { LINEAR_API_KEY: 'lin_api', LINEAR_BUILDPROVEN_KEY: 'lin_bp' });
  const seen = [];
  globalThis.fetch = respond(seen);
  await linearHttpClient().listIssues('Demo');
  assert.deepEqual(seen, ['lin_api']);
});

test('REQ-LINEAR-47 with neither key set the error names both variables', async (t) => {
  withEnv(t, { LINEAR_API_KEY: '' });
  await assert.rejects(
    linearHttpClient().listIssues('Demo'),
    (e) => /LINEAR_API_KEY/.test(e.message) && /LINEAR_BUILDPROVEN_KEY/.test(e.message),
  );
});

test('REQ-LINEAR-47 the doctor names the variable that supplied the key and never prints the value', async () => {
  for (const name of NAMES) {
    const logs = [];
    const client = () => ({ capacity: async () => ({ open: 1, teams: [] }) });
    await linearDoctor({ env: { [name]: 'lin_secret_value' }, client, log: (l) => logs.push(l) });
    assert.ok(logs.includes(`INFO linear key from ${name}`), logs.join('\n'));
    assert.ok(!logs.join('\n').includes('lin_secret_value'));
  }
});

test('REQ-LINEAR-47 the doctor prints nothing about the key when none is set', async () => {
  const logs = [];
  await linearDoctor({ env: {}, client: () => assert.fail('no client without a key'), log: (l) => logs.push(l) });
  assert.deepEqual(logs, []);
});
