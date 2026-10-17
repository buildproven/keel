import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addedLines, changedFiles, fileMode, isDirty, revParse, showFile, trackedContentDirty, withTempWorktree } from '../src/git.js';
import { commit, fixtureRepo, g } from './helpers.js';

// Scoped to one test's own repo, so this is race-free against sibling test files that also call
// withTempWorktree concurrently (tests run with --test-concurrency).
const worktreeCount = (dir) => g(dir, 'worktree', 'list').trim().split('\n').length;

test('REQ-PROJ-1 changedFiles and addedLines handle a tab in a file name', () => {
  const { dir, base } = fixtureRepo();
  const weird = 'src/a\tb.js';
  commit(dir, { [weird]: 'export const x = 1;\n' });
  const changed = changedFiles(base, 'HEAD', dir);
  assert.deepEqual(
    changed.map((f) => f.path),
    [weird],
  );
  const lines = addedLines(base, 'HEAD', dir);
  assert.deepEqual(
    lines.map((l) => l.path),
    [weird],
  );
  assert.equal(showFile('HEAD', weird, dir).trim(), 'export const x = 1;');
});

test('REQ-PROJ-1 changedFiles and addedLines handle spaces and unicode in a file name', () => {
  const { dir, base } = fixtureRepo();
  const weird = 'src/héllo world.js';
  commit(dir, { [weird]: 'export const y = 2;\n' });
  assert.deepEqual(
    changedFiles(base, 'HEAD', dir).map((f) => f.path),
    [weird],
  );
  assert.deepEqual(
    addedLines(base, 'HEAD', dir).map((l) => l.path),
    [weird],
  );
});

test('REQ-PROJ-1 changedFiles and addedLines handle a double quote and a backslash in a file name', () => {
  const { dir, base } = fixtureRepo();
  const weird = 'src/quote"back\\slash.js';
  commit(dir, { [weird]: 'export const w = 4;\n' });
  assert.deepEqual(
    changedFiles(base, 'HEAD', dir).map((f) => f.path),
    [weird],
  );
  assert.deepEqual(
    addedLines(base, 'HEAD', dir).map((l) => l.path),
    [weird],
  );
});

test('REQ-PROJ-1 fileMode, isDirty, and trackedContentDirty work with a tab in a file name', () => {
  const { dir } = fixtureRepo();
  const weird = 'src/tab\tname.js';
  commit(dir, { [weird]: 'export const z = 3;\n' });
  assert.equal(fileMode('HEAD', weird, dir), '100644');
  assert.equal(isDirty(dir), false);
  assert.equal(trackedContentDirty(dir), false);
});

test('REQ-RUN-1 withTempWorktree leaves no orphaned worktree registration when `git worktree add` fails', () => {
  const { dir } = fixtureRepo();
  const before = worktreeCount(dir);
  assert.throws(() => withTempWorktree(dir, 'not-a-real-ref', () => {}), /git worktree add.*failed/);
  assert.equal(worktreeCount(dir), before, 'no orphaned worktree registered against this repo after a failed add');
});

test('REQ-RUN-1 withTempWorktree removes the directory and worktree registration on success', () => {
  const { dir, base } = fixtureRepo();
  let capturedPath;
  const result = withTempWorktree(dir, base, (wt) => {
    capturedPath = wt;
    assert.ok(existsSync(join(wt, 'package.json')));
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.ok(!existsSync(capturedPath), 'temp checkout directory removed');
  assert.ok(!g(dir, 'worktree', 'list').includes(capturedPath), 'worktree unregistered from the repo');
});

test('REQ-RUN-1 withTempWorktree cleans up even when fn throws', () => {
  const { dir, base } = fixtureRepo();
  let capturedPath;
  assert.throws(() => {
    withTempWorktree(dir, base, (wt) => {
      capturedPath = wt;
      throw new Error('boom');
    });
  }, /boom/);
  assert.ok(!existsSync(capturedPath), 'temp checkout directory removed even after fn throws');
  assert.ok(!g(dir, 'worktree', 'list').includes(capturedPath));
});

test('REQ-PROJ-1 revParse rejects an option-like ref and a nonexistent ref', () => {
  const { dir } = fixtureRepo();
  assert.throws(() => revParse('--upload-pack=x', dir), /git rev-parse.*failed/);
  assert.throws(() => revParse('does-not-exist', dir), /git rev-parse.*failed/);
});
