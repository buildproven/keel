import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AGENT_ENV } from '../src/env.js';
import { commit, fixtureRepo, tmp } from './helpers.js';

const BIN = resolve('bin/keel.js');

/** Run `keel test` in a fixture whose testCommand writes its environment to a file; returns that environment. */
function testCommandEnv(env, keel = {}) {
  const { dir } = fixtureRepo();
  const out = join(tmp('keel-env-'), 'env.json');
  const probe = `node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))" ${out}`;
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: probe }, testCommand: probe, ...keel }) }, 'chore: cfg');
  const r = spawnSync(process.execPath, [BIN, 'test', '--repo', dir], {
    encoding: 'utf8',
    env: { ...process.env, ...env, KEEL_STATE_DIR: tmp('keel-state-'), KEEL_GATE_SLOTS: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(out, 'utf8'));
}

const agentVars = Object.fromEntries(AGENT_ENV.map((name) => [name, '1']));

test('REQ-SLOT-2 REQ-GATE-51 keel test runs testCommand without the coding-agent variables, as the gate does', () => {
  const seen = testCommandEnv(agentVars);
  for (const name of AGENT_ENV) assert.equal(seen[name], undefined, `${name} reaches testCommand`);
  assert.equal(seen.GIT_TERMINAL_PROMPT, '0', 'the candidate environment still applies (REQ-RUN-12)');
  assert.ok(seen.PATH, 'PATH stays');
});

test('REQ-SLOT-2 REQ-GATE-51 keel test keeps a coding-agent variable named in workerEnvAllow', () => {
  const seen = testCommandEnv(agentVars, { workerEnvAllow: ['CLAUDECODE'] });
  assert.equal(seen.CLAUDECODE, '1');
  assert.equal(seen.AI_AGENT, undefined);
});
