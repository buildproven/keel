import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { tmp } from './helpers.js';

const ENV_JS = new URL('../src/env.js', import.meta.url).href;

// Starts a child node process whose TMPDIR is `tmpDir`. `body` makes the dirs and prints JSON messages; the child then
// waits until `signal` arrives. Resolves with what it printed and how it ended.
function signalled(tmpDir, signal, body) {
  const script = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateEnv } from ${JSON.stringify(ENV_JS)};
${body}
setInterval(() => {}, 1000);`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: tmpDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  let sent = false;
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      if (!sent && out.includes('\n') && proc.signalCode === null && proc.exitCode === null) {
        sent = true;
        proc.kill(signal);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code, sig) => {
      const messages = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      resolve({ seen: messages[0], messages, code, signal: sig });
    });
  });
}

const noghDirs = (dir) => readdirSync(dir).filter((name) => name.startsWith('keel-nogh-'));

const MAKE_DIRS = `const first = candidateEnv({}).GH_CONFIG_DIR;
writeFileSync(join(first, 'hosts.yml'), 'x');
const second = candidateEnv({}).GH_CONFIG_DIR;`;

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`REQ-RUN-47 ${sig} removes every keel-nogh dir, including a dirtied one, and still ends the process by ${sig}`, async () => {
    const tmpDir = tmp('keel-nogh-sig-');
    const { seen, code, signal } = await signalled(
      tmpDir,
      sig,
      `${MAKE_DIRS}
console.log(JSON.stringify({ first, second }));`,
    );
    assert.notEqual(seen.first, seen.second);
    assert.equal(signal, sig);
    assert.equal(code, null);
    assert.equal(existsSync(seen.first), false);
    assert.equal(existsSync(seen.second), false);
    assert.deepEqual(noghDirs(tmpDir), []);
  });
}

test('REQ-RUN-47 when another listener handles the signal, the dirs are removed and that listener decides the end', async () => {
  const tmpDir = tmp('keel-nogh-sig-');
  const { seen, code, signal } = await signalled(
    tmpDir,
    'SIGTERM',
    `${MAKE_DIRS}
process.on('SIGTERM', () => process.exit(7));
console.log(JSON.stringify({ first, second }));`,
  );
  assert.equal(signal, null);
  assert.equal(code, 7);
  assert.deepEqual(noghDirs(tmpDir), []);
  assert.equal(existsSync(seen.second), false);
});

test('REQ-RUN-47 when another listener keeps the process alive, candidate environments remain available', async () => {
  const tmpDir = tmp('keel-nogh-sig-');
  const { messages, code, signal } = await signalled(
    tmpDir,
    'SIGTERM',
    `const first = candidateEnv({}).GH_CONFIG_DIR;
process.on('SIGTERM', () => {
  const second = candidateEnv({}).GH_CONFIG_DIR;
  console.log(JSON.stringify({ second }));
  process.exit(7);
});
console.log(JSON.stringify({ first }));`,
  );
  assert.equal(signal, null);
  assert.equal(code, 7);
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].first, messages[1].second);
  assert.deepEqual(noghDirs(tmpDir), []);
});

test('REQ-RUN-47 a process that made no keel-nogh dir keeps the default signal behaviour', async () => {
  const tmpDir = tmp('keel-nogh-sig-');
  const { code, signal } = await signalled(
    tmpDir,
    'SIGTERM',
    `const dir = candidateEnv({ GH_CONFIG_DIR: '/nowhere' }, ['GH_CONFIG_DIR']).GH_CONFIG_DIR;
console.log(JSON.stringify({ dir }));`,
  );
  assert.equal(signal, 'SIGTERM');
  assert.equal(code, null);
  assert.deepEqual(noghDirs(tmpDir), []);
});
