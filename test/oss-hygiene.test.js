// REQ-OSS-1..4: the public repo names nothing private, and its quick start works as written.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readme = read('README.md');

// Personal identifiers only: naming the owner's private repos here would publish them. Private repo
// names are checked at publish time against the live `gh repo list --visibility private`.
// Each name is split so this file does not match its own pattern.
const PRIVATE = new RegExp(['brett' + 'stark', '~\\/Projects' + '\\/products'].join('|'), 'i');
const CLONE = 'git clone https://github.com/buildproven/keel && cd keel && npm ci && npm link';

test('REQ-OSS-1 the README installs from a clone and npm link, before any npm install -g line', () => {
  const clone = readme.indexOf(CLONE);
  assert.ok(clone >= 0, `README has no "${CLONE}" step`);
  // The package is not on npm yet (`npm view @buildproven/keel` is 404), so a global install may only follow the clone.
  const npmGlobal = readme.indexOf('npm install -g @buildproven/keel');
  assert.ok(npmGlobal < 0 || clone < npmGlobal, 'npm install -g comes before the clone step');
});

test('REQ-OSS-2 no tracked file outside bench/swebench names a private repo or personal path', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !f.startsWith('bench/swebench/'));
  assert.ok(files.length > 50, `listed only ${files.length} tracked files`);
  const hits = files.filter((f) => PRIVATE.test(readFileSync(`${ROOT}${f}`, 'utf8')));
  assert.deepEqual(hits, [], 'files naming a private repo or personal path');
});

test('REQ-OSS-3 DESIGN says in one line that BUI- and KEEL- ids are internal tracker ids', () => {
  const line = /^[^\n]*`BUI-`[^\n]*`KEEL-`[^\n]*internal tracker ids/m;
  assert.ok(line.test(read('docs/DESIGN.md')), 'DESIGN has no line saying BUI-/KEEL- ids are internal tracker ids');
});

test('REQ-OSS-4 the README gives the command that links the skills', () => {
  assert.ok(readme.includes('ln -s "$PWD/skills/<name>" ~/.claude/skills/<name>'));
});
