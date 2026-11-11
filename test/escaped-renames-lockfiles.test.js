import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { escapedDefects } from '../src/escaped.js';
import { stateDir } from '../src/ledger.js';
import { commit, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const SRC = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

/** A Keel change (BUI-9) that writes the given files, merged to main under its ID. */
function merged(files) {
  const { dir } = fixtureRepo();
  commit(dir, { 'start.txt': 's\n' }, 'chore: start');
  const base = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-9');
  const head = commit(dir, files, 'feat: lib');
  g(dir, 'checkout', '-q', 'main');
  const merge = commit(dir, files, 'BUI-9: lib (#1)');
  const row = { run: 'BUI-9', card: 'BUI-9', repo: dir, base, head, attempt: 1, tier: 0, attemptPass: true, at: new Date().toISOString() };
  return { dir, merge, rows: [row] };
}

const candidates = (rows) => escapedDefects(rows).merged[0].candidates.map((c) => [c.subject, c.files]);

test('REQ-LED-10 a fix that only renames a file the merge wrote is not counted against it', () => {
  const { dir, rows } = merged({ 'src/lib.js': SRC });
  g(dir, 'mv', 'src/lib.js', 'src/core.js');
  g(dir, 'commit', '-q', '-m', 'fix: move lib to core');
  assert.deepEqual(candidates(rows), [], 'a rename changes no line the merge wrote');
});

test('REQ-LED-10 a fix that renames and edits a file counts only the edited lines, under the new path', () => {
  const { dir, rows } = merged({ 'src/lib.js': SRC, 'src/other.js': 'export const o = 1;\n' });
  g(dir, 'mv', 'src/lib.js', 'src/core.js');
  commit(dir, { 'src/core.js': 'export const a = 1;\nexport const b = 20;\nexport const c = 3;\n' }, 'fix: b is 20 in core');
  g(dir, 'mv', 'src/other.js', 'src/moved.js');
  commit(dir, { 'docs/x.md': 'x\n' }, 'fix: move other');
  assert.deepEqual(candidates(rows), [['fix: b is 20 in core', ['src/core.js']]]);
});

test('REQ-LED-10 a fix that deletes a file the merge wrote still counts', () => {
  const { dir, rows } = merged({ 'src/lib.js': SRC, 'src/keep.js': 'export const k = 1;\n' });
  g(dir, 'rm', '-q', 'src/lib.js');
  g(dir, 'commit', '-q', '-m', 'fix: drop lib');
  assert.deepEqual(candidates(rows), [['fix: drop lib', ['src/lib.js']]]);
});

const LOCKS = [
  '.terraform.lock.hcl',
  'infra/.terraform.lock.hcl',
  'flake.lock',
  'ios/Podfile.lock',
  'mix.lock',
  'pubspec.lock',
  'deno.lock',
  'bun.lock',
  'gradle.lockfile',
  'packages.lock.json',
  'conda-lock.yml',
  'Package.resolved',
  'package-lock.json',
  'pnpm-lock.yaml',
  'go.sum',
];

test('REQ-LED-10 a fix that changes only a standard lockfile of any ecosystem the merge wrote is not counted', () => {
  const files = { 'main.tf': 'resource "x" "y" {}\n' };
  for (const f of LOCKS) files[f] = 'v1\n';
  const { dir, rows } = merged(files);
  for (const f of LOCKS) commit(dir, { [f]: 'v2\n' }, `fix: bump ${f}`);
  assert.deepEqual(candidates(rows), [], 'dependency-only fixes are no evidence of a defect');
});

test('REQ-LED-10 files that only look like lockfiles stay attributable', () => {
  const names = ['src/lock.json', 'src/lockfile.js', 'src/block.js', 'src/unlock.ts'];
  const files = Object.fromEntries(names.map((f) => [f, 'one\n']));
  const { dir, rows } = merged(files);
  for (const f of names) commit(dir, { [f]: 'two\n' }, `fix: ${f}`);
  assert.deepEqual(
    candidates(rows),
    names.map((f) => [`fix: ${f}`, [f]]),
  );
});

test('REQ-LED-11 a blame cache written under the earlier rule is not reused', () => {
  const { dir, rows } = merged({ 'src/lib.js': SRC });
  g(dir, 'mv', 'src/lib.js', 'src/core.js');
  g(dir, 'commit', '-q', '-m', 'fix: move lib to core');
  const fix = g(dir, 'rev-parse', 'HEAD');
  // The earlier rule keyed the cache by the repo path alone and blamed every line of a renamed file's old path.
  const oldKey = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
  const cacheDir = join(stateDir(), 'blame', oldKey);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${fix}.json`), JSON.stringify({ 'src/lib.js': [rows[0].head, g(dir, 'rev-parse', 'HEAD~1')] }));
  assert.deepEqual(candidates(rows), []);
});
