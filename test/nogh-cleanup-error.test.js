import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmp } from './helpers.js';

const ENV_JS = new URL('../src/env.js', import.meta.url).href;
function removeNoghDirs(tmpDir) {
  for (const name of readdirSync(tmpDir)) {
    if (!name.startsWith('keel-nogh-')) continue;
    rmSync(join(tmpDir, name), { recursive: true, force: true });
  }
}

const MAKE_UNREMOVABLE = `import { mock } from 'node:test';
import { mkdtempSync, readdirSync, rmSync as realRmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let removeCalls = 0;
mock.module('node:fs', { exports: {
  mkdtempSync,
  readdirSync,
  rmSync(dir, options) {
    if (removeCalls++ === 0) {
      const error = new Error('injected permission failure');
      error.code = 'EACCES';
      throw error;
    }
    realRmSync(dir, options);
  },
} });
const { candidateEnv } = await import(${JSON.stringify(ENV_JS)});
const first = candidateEnv({}).GH_CONFIG_DIR;
writeFileSync(join(first, 'hosts.yml'), 'x');
const second = candidateEnv({}).GH_CONFIG_DIR;
console.log(JSON.stringify({ first, second }));`;

test('REQ-RUN-40 an unremovable keel-nogh dir does not fail exit or stop cleanup of later dirs', (t) => {
  const tmpDir = tmp('keel-nogh-error-');
  t.after(() => removeNoghDirs(tmpDir));
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', MAKE_UNREMOVABLE], {
    env: { ...process.env, TMPDIR: tmpDir },
    encoding: 'utf8',
  });
  const { first, second } = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), false);
  assert.match(result.stderr, /keel: WARN could not remove temporary GH_CONFIG_DIR .*: [A-Z]+/u);
});

test('REQ-RUN-47 an unremovable keel-nogh dir does not replace the signal that ends the process', async (t) => {
  const tmpDir = tmp('keel-nogh-signal-error-');
  t.after(() => removeNoghDirs(tmpDir));
  const proc = spawn(
    process.execPath,
    ['--experimental-test-module-mocks', '--input-type=module', '-e', `${MAKE_UNREMOVABLE}\nsetInterval(() => {}, 1000);`],
    {
      env: { ...process.env, TMPDIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });

  let stdout = '';
  let stderr = '';
  const ended = new Promise((resolve, reject) => {
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('\n') && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => resolve({ code, signal }));
  });
  const { code, signal } = await ended;
  const { first, second } = JSON.parse(stdout);

  assert.equal(code, null);
  assert.equal(signal, 'SIGTERM');
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), false);
  assert.match(stderr, /keel: WARN could not remove temporary GH_CONFIG_DIR .*: [A-Z]+/u);
});
