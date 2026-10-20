import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmp } from './helpers.js';

const ENV_JS = new URL('../src/env.js', import.meta.url).href;

function restoreAndRemoveNoghDirs(tmpDir) {
  for (const name of readdirSync(tmpDir)) {
    if (!name.startsWith('keel-nogh-')) continue;
    const dir = join(tmpDir, name);
    const locked = join(dir, 'locked');
    if (existsSync(locked)) chmodSync(locked, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
}

const MAKE_UNREMOVABLE = `import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateEnv } from ${JSON.stringify(ENV_JS)};
const first = candidateEnv({}).GH_CONFIG_DIR;
const locked = join(first, 'locked');
mkdirSync(locked);
writeFileSync(join(locked, 'hosts.yml'), 'x');
chmodSync(locked, 0);
const second = candidateEnv({}).GH_CONFIG_DIR;
console.log(JSON.stringify({ first, second }));`;

test('REQ-RUN-40 an unremovable keel-nogh dir does not fail exit or stop cleanup of later dirs', (t) => {
  const tmpDir = tmp('keel-nogh-error-');
  t.after(() => restoreAndRemoveNoghDirs(tmpDir));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', MAKE_UNREMOVABLE], {
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
  t.after(() => restoreAndRemoveNoghDirs(tmpDir));
  const proc = spawn(process.execPath, ['--input-type=module', '-e', `${MAKE_UNREMOVABLE}\nsetInterval(() => {}, 1000);`], {
    env: { ...process.env, TMPDIR: tmpDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
