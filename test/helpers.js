import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULTS } from '../src/config.js';

// REQ-TRACE-5: every tmp() dir lives in one mkdtemp parent per test process, and the 'exit' hook removes exactly
// that recorded parent, so `npm test` leaves nothing in TMPDIR (BUI-1214: ~3,500 keel-* dirs had piled up).
let parent;
export function tmp(prefix = 'keel-test-') {
  if (!parent) {
    const created = mkdtempSync(join(tmpdir(), 'keel-test-'));
    process.on('exit', () => rmSync(created, { recursive: true, force: true }));
    parent = created;
  }
  return mkdtempSync(join(parent, prefix));
}
export const g = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

export function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(dir, path));
      continue;
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

export function commit(dir, files, msg = 'change') {
  write(dir, files);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', msg);
  return g(dir, 'rev-parse', 'HEAD');
}

/** Test command for fixture repos: run every test/*.js with node; non-zero if any fails. */
export const FIXTURE_TEST = 'for f in test/*.js; do node "$f" || exit 1; done';

export const BUGGY = {
  'src/add.js': 'export const add = (a, b) => a - b;\n',
  'test/basic.test.js': "import assert from 'node:assert';\nassert.ok(true);\n",
};
export const FIXED_SRC = { 'src/add.js': 'export const add = (a, b) => a + b;\n' };
export const REGRESSION_TEST = {
  'test/add.test.js': "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(2, 3), 5);\n",
};

/** A fresh repo whose base commit contains the buggy add(). Returns { dir, base }. */
export function fixtureRepo(files = BUGGY) {
  const dir = tmp('keel-repo-');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'commit.gpgsign', 'false');
  const base = commit(dir, { 'package.json': '{"type":"module"}\n', ...files }, 'base');
  return { dir, base };
}

export const fixtureConfig = (over = {}) => ({
  ...structuredClone(DEFAULTS),
  checks: { test: FIXTURE_TEST },
  testCommand: FIXTURE_TEST,
  heldOutCommand: FIXTURE_TEST,
  review: false, // the fixture tiers are one family; review tests turn it on with a reviewer
  ...over,
});
