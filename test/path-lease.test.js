import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { leaseConflicts, openBranchFiles } from '../src/lease.js';
import { poll, pollExitCode } from '../src/poll.js';
import { matchesAny } from '../src/scan.js';
import { FIXED_SRC, FIXTURE_TEST, commit, fixtureRepo, g, tmp, write } from './helpers.js';

const BIN = resolve('bin/keel.js');

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

/** A repo on main with two open keel branches: keel/A changes src/x.js and README.md, keel/B changes src/y.js. */
function branches() {
  const { dir } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/A');
  commit(dir, { 'src/x.js': 'export const x = 1;\n', 'README.md': 'a\n' }, 'feat: x');
  g(dir, 'checkout', '-q', 'main');
  g(dir, 'checkout', '-q', '-b', 'keel/B');
  commit(dir, { 'src/y.js': 'export const y = 1;\n' }, 'feat: y');
  g(dir, 'checkout', '-q', 'main');
  return dir;
}

/** A `keel run` of card `id` in progress, as run.js makes one: a worktree under the state dir and a live lock of that name. */
function running(repo, id) {
  const key = `${basename(repo)}-test-${id}`;
  const wt = join(process.env.KEEL_STATE_DIR, 'worktrees', key);
  if (!existsSync(wt)) g(repo, 'worktree', 'add', '-q', wt, `keel/${id}`);
  mkdirSync(join(process.env.KEEL_STATE_DIR, 'locks', key), { recursive: true });
  writeFileSync(join(process.env.KEEL_STATE_DIR, 'locks', key, 'pid'), String(process.pid));
  return wt;
}

/** A fake `gh` on PATH that prints `prs` for `gh pr list`, fails when `prs` is null, and prints nothing when it is ''. */
function fakeGh(prs) {
  const bin = tmp('keel-bin-');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'list') { ${prs === '' ? 'process.exit(0);' : prs ? `console.log(${JSON.stringify(JSON.stringify(prs))}); process.exit(0);` : "console.error('gh: not logged in'); process.exit(1);"} }
process.exit(1);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}

function withPath(bin, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    return fn();
  } finally {
    process.env.PATH = old;
  }
}

test('REQ-LEASE-1 keel branches whose run is in progress lease the files they change; the own branch and prose never conflict', () => {
  const dir = branches();
  running(dir, 'A');
  running(dir, 'B');
  const open = openBranchFiles(dir, 'main', { own: 'keel/B', log: () => {} });
  assert.deepEqual([...open.keys()], ['keel/A']);
  assert.deepEqual(open.get('keel/A'), ['README.md', 'src/x.js']);
  assert.deepEqual(
    leaseConflicts(open, (f) => matchesAny(f, ['src/**', '**/*.md'])),
    [{ branch: 'keel/A', files: ['src/x.js'] }],
  );
  assert.deepEqual(
    leaseConflicts(open, (f) => matchesAny(f, ['lib/**'])),
    [],
  );
});

test('REQ-LEASE-1 open PRs lease their files too; a gh failure is logged and checks local runs only', () => {
  const dir = branches();
  running(dir, 'A');
  running(dir, 'B');
  g(dir, 'remote', 'add', 'origin', 'https://example.invalid/r.git');
  const prs = [
    { number: 7, headRefName: 'feat/z', files: [{ path: 'src/z.js' }] },
    { number: 8, headRefName: 'keel/B', files: [{ path: 'src/y.js' }] },
  ];
  const open = withPath(fakeGh(prs), () => openBranchFiles(dir, 'main', { own: 'keel/B', log: () => {} }));
  assert.deepEqual(open.get('PR #7 (feat/z)'), ['src/z.js']);
  assert.ok(![...open.keys()].some((k) => k.includes('keel/B')), 'the own branch is never leased, also as a PR');
  const logs = [];
  const local = withPath(fakeGh(null), () => openBranchFiles(dir, 'main', { own: null, log: (m) => logs.push(m) }));
  assert.deepEqual([...local.keys()].sort(), ['keel/A', 'keel/B']);
  assert.match(logs.join('\n'), /path lease: open PRs not checked: gh pr list failed: gh: not logged in/);
  const quiet = [];
  withPath(fakeGh(''), () => openBranchFiles(dir, 'main', { own: null, log: (m) => quiet.push(m) }));
  assert.match(quiet.join('\n'), /path lease: open PRs not checked: gh pr list printed no JSON/);
});

test('REQ-LEASE-2 keel run refuses a card whose paths overlap an open branch, names it, and exits 3', () => {
  const dir = branches();
  running(dir, 'A');
  running(dir, 'B');
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST }) }, 'chore: cfg');
  const card = join(tmp('keel-card-'), 'T-2.md');
  write('/', { [card]: '# T-2: change x\n\nkind: bug\nsize: S\npaths: src/**\n\n## Requirements\n\n- REQ-X-1: x shall be 2.\n' });
  const r = spawnSync(process.execPath, [BIN, 'run', card, '--repo', dir], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /^keel: path lease: T-2 overlaps keel\/A \(src\/x\.js\), keel\/B \(src\/y\.js\)/m);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', 'keel/T-2'], { cwd: dir }).status, 1, 'nothing was started');
});

const issue = (id, priority, description) => ({
  id,
  title: id,
  description,
  priority,
  createdAt: '2026-10-01',
  labels: [],
  estimate: null,
});

const client = (issues) => ({
  comments: [],
  listIssues: async () => issues,
  comment: async function (id, body) {
    this.comments.push({ id, body });
  },
  review: async () => {},
  stateType: async () => 'started',
  createIssue: async () => assert.fail('no follow-ups'),
});

test('REQ-LEASE-3 keel poll passes over an issue whose card paths overlap an open branch, records nothing, and builds the next', async () => {
  const dir = branches();
  running(dir, 'A');
  running(dir, 'B');
  const leased = issue('BUI-1', 1, '```keel\npaths: src/**\n```\n- REQ-1: x shall be 2.');
  const free = issue('BUI-2', 2, '```keel\npaths: lib/**\n```\n- REQ-1: lib shall work.');
  const ran = [];
  const logs = [];
  const runFn = ({ card }) => {
    ran.push(card.id);
    return { pass: true, tier: 0, attempt: 1, branch: `keel/${card.id}`, worktree: '/tmp/x' };
  };
  const c = client([leased, free]);
  await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn, log: (m) => logs.push(m), limit: 2 });
  assert.deepEqual(ran, ['BUI-2']);
  assert.match(logs.join('\n'), /BUI-1 waits for path lease: keel\/A \(src\/x\.js\), keel\/B \(src\/y\.js\)/);
  const ledger = join(process.env.KEEL_STATE_DIR, 'poll-ledger.jsonl');
  const rows = existsSync(ledger) ? readFileSync(ledger, 'utf8') : '';
  assert.doesNotMatch(rows, /BUI-1/, 'a leased issue is not an attempt');
  assert.ok(!c.comments.some((x) => x.id === 'BUI-1'));
});

test('REQ-LEASE-3 keel run <ISSUE-ID> on a leased issue does not start it and exits 3', async () => {
  const dir = branches();
  running(dir, 'A');
  const leased = issue('BUI-1', 1, '```keel\npaths: src/**\n```\n- REQ-1: x shall be 2.');
  const results = await poll({
    repo: dir,
    project: 'p',
    client: client([leased]),
    config: { ...DEFAULTS },
    runFn: () => assert.fail('a leased issue never runs'),
    issue: 'BUI-1',
  });
  assert.equal(results.at(-1).outcome, 'leased');
  assert.equal(pollExitCode(results), 3);
});

test('REQ-LEASE-1 keel gate warns, and still gates, when HEAD changes a file another open branch changes', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST }) }, 'chore: cfg');
  g(dir, 'checkout', '-q', '-b', 'keel/OTHER');
  commit(dir, FIXED_SRC, 'fix: other');
  g(dir, 'checkout', '-q', 'main');
  running(dir, 'OTHER');
  g(dir, 'checkout', '-q', '-b', 'feat/mine');
  commit(dir, FIXED_SRC, 'chore: mine');
  const card = join(tmp('keel-card-'), 'card.md');
  write('/', { [card]: '# DEMO-1: change\n\nkind: chore\nsize: S\n\n## Requirements\n\nchange.\n' });
  const r = spawnSync(process.execPath, [BIN, 'gate', '--base', 'main', '--card', card], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.match(r.stderr, /^keel: WARN paths overlap keel\/OTHER \(src\/add\.js\): merge one first, then rebase the other/m);
  assert.match(r.stderr, /^keel: PASS /m, 'the warning does not block');
});

test('REQ-LEASE-1 a keel branch with no run in progress leases nothing: a squash-merged or failed run never holds its files', () => {
  const dir = branches();
  // keel/A was squash-merged: main has its change, but keel/A is not an ancestor of main. keel/B failed and was parked
  // in its worktree; neither run holds a lock any more.
  running(dir, 'B');
  rmSync(join(process.env.KEEL_STATE_DIR, 'locks'), { recursive: true });
  commit(dir, { 'src/x.js': 'export const x = 1;\n', 'README.md': 'a\n' }, 'feat: x (#1)');
  assert.deepEqual([...openBranchFiles(dir, 'main', { own: null, log: () => {} }).keys()], []);
});

test('REQ-LEASE-1 a run in progress also leases what its worktree changed but has not committed yet', () => {
  const dir = branches();
  g(dir, 'branch', 'keel/C');
  const wt = running(dir, 'C');
  write(wt, { 'src/add.js': 'export const add = (a, b) => a + b;\n', 'src/new.js': 'export {};\n' });
  assert.deepEqual(openBranchFiles(dir, 'main', { own: null, log: () => {} }).get('keel/C'), ['src/add.js', 'src/new.js']);
});
