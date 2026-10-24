import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { scrubEnv } from '../src/env.js';
import { tmp } from './helpers.js';

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: 'Authorization: Bearer xyz',
  GIT_CONFIG_KEY_1: 'core.autocrlf',
  GIT_CONFIG_VALUE_1: 'false',
};

test('REQ-RUN-50 a scrubbed environment drops the whole GIT_CONFIG_COUNT set, so git still runs and no config value leaks', () => {
  const env = scrubEnv(GIT_ENV);
  for (const k of Object.keys(GIT_ENV).filter((n) => n.startsWith('GIT_CONFIG_'))) assert.equal(env[k], undefined, `${k} kept`);
  const dir = tmp('keel-env-git-');
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  assert.equal(execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, env, encoding: 'utf8' }).trim(), 'true');
});

test('REQ-RUN-50 workerEnvAllow naming every key of the set keeps the set whole', () => {
  const names = Object.keys(GIT_ENV).filter((n) => n.startsWith('GIT_CONFIG_'));
  const env = scrubEnv(GIT_ENV, names);
  for (const k of names) assert.equal(env[k], GIT_ENV[k]);
});
