import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmp } from './helpers.js';

const ENV_JS = new URL('../src/env.js', import.meta.url).href;

// Runs `body` in a child node process whose TMPDIR is `tmpDir`; the child prints one JSON line and exits normally.
function child(tmpDir, body) {
  const script = `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateEnv } from ${JSON.stringify(ENV_JS)};
${body}`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: tmpDir },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const noghDirs = (dir) => readdirSync(dir).filter((name) => name.startsWith('keel-nogh-'));

test('REQ-RUN-40 a normal exit removes every keel-nogh dir the process created, including a dirtied one', () => {
  const tmpDir = tmp('keel-nogh-tmp-');
  const seen = child(
    tmpDir,
    `const first = candidateEnv({}).GH_CONFIG_DIR;
writeFileSync(join(first, 'hosts.yml'), 'x');
const second = candidateEnv({}).GH_CONFIG_DIR;
console.log(JSON.stringify({ first, second, existed: [existsSync(first), existsSync(second)] }));`,
  );
  assert.notEqual(seen.first, seen.second);
  assert.deepEqual(seen.existed, [true, true]);
  assert.equal(existsSync(seen.first), false);
  assert.equal(existsSync(seen.second), false);
  assert.deepEqual(noghDirs(tmpDir), []);
});

test('REQ-RUN-40 with GH_CONFIG_DIR allowed, no keel-nogh dir is made and the real dir is untouched', () => {
  const tmpDir = tmp('keel-nogh-tmp-');
  const real = join(tmp('keel-gh-real-'), 'gh');
  mkdirSync(real);
  writeFileSync(join(real, 'hosts.yml'), 'login');
  const seen = child(
    tmpDir,
    `const dir = candidateEnv({ GH_CONFIG_DIR: ${JSON.stringify(real)} }, ['GH_CONFIG_DIR']).GH_CONFIG_DIR;
console.log(JSON.stringify({ dir }));`,
  );
  assert.equal(seen.dir, real);
  assert.deepEqual(noghDirs(tmpDir), []);
  assert.deepEqual(readdirSync(real), ['hosts.yml']);
});
