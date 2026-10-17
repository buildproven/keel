import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureRepo, g, tmp, write } from './helpers.js';

const BIN = resolve('bin/keel.js');
const keel = (cwd, args, env = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    // Own TMPDIR too: the automatic cleanup (REQ-CLEAN-5) would otherwise log other test processes' dead gate checkouts.
    env: { ...process.env, KEEL_STATE_DIR: tmp('keel-state-'), TMPDIR: tmp('keel-tmpdir-'), ...env },
  });

const CONFIG = JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, linearProject: 'demo', review: false });

/** A clone of a repo whose main holds keel.json, on a new branch `branch`. Returns the clone dir. */
function clone(branch = 'fix/add-sign') {
  const { dir: origin } = fixtureRepo();
  commit(origin, { 'keel.json': CONFIG }, 'chore: keel config');
  const dir = realpathSync(tmp('keel-clone-'));
  g(dir, 'clone', '-q', origin, '.');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'commit.gpgsign', 'false');
  g(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

const fixBranch = (dir, msg = 'fix(add)!: add numbers instead of subtracting them') =>
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST }, msg);

const card = (kind = 'bug') => {
  const file = join(tmp('keel-card-'), 'card.md');
  write('/', { [file]: `# DEMO-1: fix add\n\nkind: ${kind}\nsize: S\n\n## Requirements\n\nadd adds.\n` });
  return file;
};

test('REQ-CLI-6 gate without --base uses origin/HEAD and says so', () => {
  const dir = clone();
  fixBranch(dir);
  const r = keel(dir, ['gate', '--card', card()]);
  assert.match(r.stderr, /^keel: base origin\/main$/m);
  assert.equal(r.status, 0, r.stderr);
});

test('REQ-CLI-6 gate without origin/HEAD falls back to origin/main', () => {
  const dir = clone();
  g(dir, 'remote', 'set-head', 'origin', '-d');
  fixBranch(dir);
  const r = keel(dir, ['gate', '--card', card()]);
  assert.match(r.stderr, /^keel: base origin\/main$/m);
  assert.equal(r.status, 0, r.stderr);
});

test('REQ-CLI-6 a dangling origin/HEAD is skipped for origin/main', () => {
  const dir = clone();
  g(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/old-main');
  fixBranch(dir);
  const r = keel(dir, ['gate', '--card', card()]);
  assert.match(r.stderr, /^keel: base origin\/main$/m);
  assert.equal(r.status, 0, r.stderr);
});

test('REQ-CLI-6 gate without --base in a repo whose origin has no default branch is a usage error', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': CONFIG }, 'chore: cfg');
  const r = keel(dir, ['gate', '--card', card()]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^keel: gate needs --base <ref> \(origin has no default branch\)$/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('REQ-CLI-7 gate without --card derives the card from the branch name and commit types', () => {
  const dir = clone('fix/add@sign');
  fixBranch(dir);
  const r = keel(dir, ['gate']);
  assert.match(
    r.stderr,
    /^keel: no card — fix-add-sign: kind bug, size S from commit types; pass --card to set scope, size, or held-out tests$/m,
  );
  assert.match(r.stderr, /red-proof/);
  assert.equal(r.status, 0, r.stderr);
});

test('REQ-CLI-7 a feat commit outranks fix, and the derived feature still needs red proof', () => {
  const dir = clone('feat/x');
  commit(dir, { 'docs/a.md': 'a\n' }, 'docs: note');
  commit(dir, FIXED_SRC, 'feat: change add without a test');
  commit(dir, { 'docs/b.md': 'b\n' }, 'fix: typo');
  const r = keel(dir, ['gate']);
  assert.match(r.stderr, /^keel: no card — feat-x: kind feature, size S/m);
  assert.equal(r.status, 1);
});

test('REQ-CLI-7 docs and chore commits derive a chore card that needs no red proof', () => {
  const dir = clone('docs/readme');
  commit(dir, { 'docs/a.md': 'a\n' }, 'docs: add a note');
  commit(dir, { 'docs/b.md': 'b\n' }, 'chore(deps): nothing');
  const r = keel(dir, ['gate']);
  assert.match(r.stderr, /kind chore, size S/);
  assert.equal(r.status, 0, r.stderr);
});

test('REQ-CLI-7 ci and refactor types map to infra and refactor; infra outranks refactor', () => {
  const dir = clone('ci/x');
  commit(dir, { 'docs/a.md': 'a\n' }, 'refactor: tidy');
  commit(dir, { 'docs/b.md': 'b\n' }, 'ci: tweak');
  assert.match(keel(dir, ['gate']).stderr, /kind infra, size S/);
  const dir2 = clone('perf/x');
  commit(dir2, { 'docs/a.md': 'a\n' }, 'perf(core): faster');
  assert.match(keel(dir2, ['gate']).stderr, /kind refactor, size S/);
});

test('REQ-CLI-7 a detached HEAD uses the short commit id as the card id', () => {
  const dir = clone();
  const head = fixBranch(dir);
  g(dir, 'checkout', '-q', '--detach');
  const r = keel(dir, ['gate']);
  assert.match(r.stderr, new RegExp(`^keel: no card — ${head.slice(0, 7)}[0-9a-f]*: kind bug`, 'm'));
});

test('REQ-CLI-7 without any conventional commit type gate asks for --card', () => {
  const dir = clone('misc');
  commit(dir, { 'docs/a.md': 'a\n' }, 'update stuff');
  const r = keel(dir, ['gate']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^keel: .*--card/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('REQ-CLI-8 run with an issue ID behaves exactly as poll --issue', () => {
  const dir = clone();
  const env = { LINEAR_API_KEY: '' };
  const viaRun = keel(dir, ['run', 'DEMO-7'], env);
  const viaPoll = keel(dir, ['poll', '--issue', 'DEMO-7'], env);
  assert.match(viaRun.stderr, /LINEAR_API_KEY is not set/);
  assert.equal(viaRun.status, viaPoll.status);
  assert.equal(viaRun.stderr.split('\n')[0], viaPoll.stderr.split('\n')[0]);
});

test('REQ-CLI-8 a file named like an issue ID is still read as a card', () => {
  const dir = clone();
  write(dir, { 'DEMO-7': 'not a card\n' });
  const r = keel(dir, ['run', 'DEMO-7'], { LINEAR_API_KEY: '' });
  assert.doesNotMatch(r.stderr, /LINEAR_API_KEY/);
  assert.match(r.stderr, /card/);
});
