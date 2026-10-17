import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commit, fixtureConfig, fixtureRepo, g } from './helpers.js';
import { parseCard, loadConfig, DEFAULTS } from '../src/config.js';
import { scrubEnv } from '../src/env.js';
import { gate } from '../src/gate.js';
import { runWorker } from '../src/workers.js';

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};

test('REQ-RUN-12 scrubEnv removes secret-looking names and keeps ordinary ones', () => {
  const env = {
    PATH: '/bin',
    HOME: '/h',
    CI: '1',
    KEYBOARD: 'us',
    MONKEY: 'x',
    LINEAR_API_KEY: 'l',
    GITHUB_TOKEN: 'g',
    AWS_SECRET_ACCESS_KEY: 'a',
    DB_PASSWORD: 'd',
    LEGACY_PASSWD: 'p',
    NEXTAUTH_SECRET: 'n',
    api_key: 'lower',
  };
  assert.deepEqual(Object.keys(scrubEnv(env)).sort(), ['CI', 'HOME', 'KEYBOARD', 'MONKEY', 'PATH']);
});

test('REQ-RUN-12 scrubEnv keeps a secret-looking name that is allowlisted', () => {
  const out = scrubEnv({ PATH: '/bin', GITHUB_TOKEN: 'g', LINEAR_API_KEY: 'l' }, ['GITHUB_TOKEN']);
  assert.deepEqual(Object.keys(out).sort(), ['GITHUB_TOKEN', 'PATH']);
});

test('REQ-RUN-12 a worker process does not receive LINEAR_API_KEY', () => {
  const probe = 'console.log(JSON.stringify({ key: process.env.LINEAR_API_KEY ?? null, path: Boolean(process.env.PATH) }))';
  const tier = { provider: 'exec', command: [process.execPath, '-e', probe] };
  const r = withEnv({ LINEAR_API_KEY: 'lin_secret' }, () => runWorker(tier, 'prompt', process.cwd(), fixtureConfig()));
  assert.equal(r.status, 'ok');
  assert.deepEqual(JSON.parse(r.output.trim().split('\n').at(-1)), { key: null, path: true });
});

test('REQ-RUN-12 an allowlisted secret still reaches the worker', () => {
  const probe = 'console.log(JSON.stringify({ key: process.env.LINEAR_API_KEY ?? null }))';
  const tier = { provider: 'exec', command: [process.execPath, '-e', probe] };
  const config = fixtureConfig({ workerEnvAllow: ['LINEAR_API_KEY'] });
  const r = withEnv({ LINEAR_API_KEY: 'lin_secret' }, () => runWorker(tier, 'prompt', process.cwd(), config));
  assert.deepEqual(JSON.parse(r.output.trim().split('\n').at(-1)), { key: 'lin_secret' });
});

const CHECK = `node -e "process.exit(process.env.KEEL_TEST_SECRET_TOKEN ? 1 : 0)"`;
const chore = () => parseCard('# T-1: env\nkind: chore\nsize: S\n');

test('REQ-RUN-12 configured checks run without secret-looking variables', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  const config = fixtureConfig({ checks: { env: CHECK }, testCommand: CHECK });
  const r = withEnv({ KEEL_TEST_SECRET_TOKEN: 'secret' }, () => gate({ repo: dir, base, card: chore(), config }));
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  assert.equal(g(dir, 'rev-parse', 'HEAD').length, 40);
});

test('REQ-RUN-12 an allowlisted variable reaches the configured checks', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  const config = fixtureConfig({ checks: { env: CHECK }, testCommand: CHECK, workerEnvAllow: ['KEEL_TEST_SECRET_TOKEN'] });
  const r = withEnv({ KEEL_TEST_SECRET_TOKEN: 'secret' }, () => gate({ repo: dir, base, card: chore(), config }));
  assert.equal(r.pass, false);
});

test('REQ-CFG-1 workerEnvAllow defaults to none and must be an array of strings', () => {
  assert.deepEqual(DEFAULTS.workerEnvAllow, []);
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  assert.throws(() => loadConfig(dir, at({ workerEnvAllow: 'LINEAR_API_KEY' })), /workerEnvAllow/);
  assert.throws(() => loadConfig(dir, at({ workerEnvAllow: [1] })), /workerEnvAllow/);
  assert.deepEqual(loadConfig(dir, at({ workerEnvAllow: ['LINEAR_API_KEY'] })).workerEnvAllow, ['LINEAR_API_KEY']);
});
