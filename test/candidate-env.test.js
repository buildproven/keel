import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { candidateEnv } from '../src/env.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

test('REQ-RUN-12 candidate code gets an empty gh config, no system git config, no ssh agent, and no prompts', () => {
  const env = candidateEnv({ PATH: '/bin', GH_TOKEN: 't', GH_CONFIG_DIR: '/real/gh', SSH_AUTH_SOCK: '/agent', HOME: '/home/me' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/me');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.notEqual(env.GH_CONFIG_DIR, '/real/gh');
  assert.ok(existsSync(env.GH_CONFIG_DIR));
  assert.deepEqual(readdirSync(env.GH_CONFIG_DIR), []);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('REQ-RUN-12 workerEnvAllow keeps the real GH_CONFIG_DIR and SSH_AUTH_SOCK', () => {
  const env = candidateEnv({ GH_CONFIG_DIR: '/real/gh', SSH_AUTH_SOCK: '/agent' }, ['GH_CONFIG_DIR', 'SSH_AUTH_SOCK']);
  assert.equal(env.GH_CONFIG_DIR, '/real/gh');
  assert.equal(env.SSH_AUTH_SOCK, '/agent');
});

test('REQ-RUN-12 a configured check runs with the candidate environment', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const probeDir = tmp('keel-env-');
  const out = join(probeDir, 'env.json');
  writeFileSync(join(probeDir, 'probe.cjs'), `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n`);
  const probe = `node ${join(probeDir, 'probe.cjs')}`;
  const card = parseCard('# T-1: t\nkind: bug\nsize: S\n');
  process.env.SSH_AUTH_SOCK = '/agent';
  try {
    const r = gate({ repo: dir, base, card, config: fixtureConfig({ checks: { probe, test: FIXTURE_TEST } }) });
    assert.equal(r.pass, true, JSON.stringify(r.results));
  } finally {
    delete process.env.SSH_AUTH_SOCK;
  }
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(seen.SSH_AUTH_SOCK, undefined);
  assert.deepEqual(readdirSync(seen.GH_CONFIG_DIR), []);
  assert.equal(seen.GIT_CONFIG_NOSYSTEM, '1');
});
