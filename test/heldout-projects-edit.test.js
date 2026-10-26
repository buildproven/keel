import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));
const temp = (p = 'keel-ho-edit-') => mkdtempSync(join(tmpdir(), p));

function keel(args, file, cwd = temp('keel-ho-cwd-')) {
  const env = { ...process.env, KEEL_PROJECTS_FILE: file, KEEL_STATE_DIR: temp('keel-ho-state-'), HOME: temp('keel-ho-home-') };
  delete env.LINEAR_API_KEY;
  delete env.XDG_CONFIG_HOME;
  const r = spawnSync(process.execPath, [KEEL, ...args], { cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

function repo() {
  const dir = temp('keel-ho-repo-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'keel.json'), JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', linearProject: 'P' }));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return dir;
}

const freshFile = () => join(temp('keel-ho-cfg-'), 'nested', 'keel', 'projects.json');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const repoOf = (p) => (typeof p === 'string' ? p : p.repo);
const repos = (file) => read(file).projects.map((p) => resolve(repoOf(p)));
const entry = (file, dir) => read(file).projects.find((p) => resolve(repoOf(p)) === dir);

/** A usage error from the projects command itself, not from today's "unknown command" / "Unknown option". */
function assertUsage(r) {
  assert.equal(r.status, 2, r.out);
  assert.doesNotMatch(r.stderr, /unknown command "projects"|Unknown option '--rank'/, r.out);
}

test('REQ-MULTI-4 projects add appends a git repo, creating the file and its directory, and prints the list', () => {
  const file = freshFile();
  const a = repo();
  const b = repo();
  let r = keel(['projects', 'add', a], file);
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(file), 'file and its directory are created');
  assert.deepEqual(repos(file), [a]);
  assert.ok(r.stdout.includes(a), `prints the list:\n${r.out}`);
  r = keel(['projects', 'add', b], file);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(repos(file), [a, b], 'default rank is last');
  assert.ok(r.stdout.includes(a) && r.stdout.includes(b), r.out);
  assert.deepEqual(
    readdirSync(dirname(file)).filter((n) => n !== 'projects.json'),
    [],
    'written through a rename: no temp file is left behind',
  );
});

test('REQ-MULTI-4 projects add resolves a relative directory against the working directory', () => {
  const file = freshFile();
  const a = repo();
  const r = keel(['projects', 'add', '.'], file, a);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(repos(file), [a]);
});

test('REQ-MULTI-4 projects add --rank N inserts at rank N, and moves a listed project there instead of listing it twice', () => {
  const file = freshFile();
  const [a, b, c] = [repo(), repo(), repo()];
  for (const d of [a, b]) assert.equal(keel(['projects', 'add', d], file).status, 0);
  let r = keel(['projects', 'add', c, '--rank', '1'], file);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(repos(file), [c, a, b]);
  r = keel(['projects', 'add', c, '--rank', '3'], file);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(repos(file), [a, b, c]);
  r = keel(['projects', 'add', b, '--rank', '1'], file);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(repos(file), [b, a, c]);
});

test('REQ-MULTI-4 remove, pause, resume change the listed project; active sets the count; each prints the list', () => {
  const file = freshFile();
  const [a, b, c] = [repo(), repo(), repo()];
  for (const d of [a, b, c]) assert.equal(keel(['projects', 'add', d], file).status, 0);

  let r = keel(['projects', 'pause', b], file);
  assert.equal(r.status, 0, r.out);
  assert.equal(entry(file, b).paused, true);
  assert.ok(r.stdout.includes(b), r.out);
  assert.match(r.stdout.split('\n').find((l) => l.includes(b)) ?? '', /\bpaused\b/);
  assert.deepEqual(repos(file), [a, b, c], 'pausing keeps the rank');

  r = keel(['projects', 'resume', b], file);
  assert.equal(r.status, 0, r.out);
  const e = entry(file, b);
  assert.ok(typeof e === 'string' || e.paused !== true, `resumed: ${JSON.stringify(e)}`);
  assert.doesNotMatch(r.stdout, /\bpaused\b/);

  r = keel(['projects', 'active', '2'], file);
  assert.equal(r.status, 0, r.out);
  assert.equal(read(file).active, 2);
  assert.match(r.stdout.split('\n').find((l) => l.includes(c)) ?? '', /\bwaiting\b/);

  r = keel(['projects', 'active', 'all'], file);
  assert.equal(r.status, 0, r.out);
  assert.equal(read(file).active, null);
  assert.doesNotMatch(r.stdout, /\bwaiting\b/);

  r = keel(['projects', 'remove', a], file);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(repos(file), [b, c]);
  assert.ok(!r.stdout.includes(a), r.out);
});

test('REQ-MULTI-4 projects active on a missing file creates it with that count', () => {
  const file = freshFile();
  const r = keel(['projects', 'active', '4'], file);
  assert.equal(r.status, 0, r.out);
  assert.equal(read(file).active, 4);
  assert.deepEqual(read(file).projects, []);
});

test('REQ-MULTI-4 usage errors leave the projects file as it was', async (t) => {
  const file = freshFile();
  const listed = repo();
  const unlisted = repo();
  const notGit = temp('keel-ho-plain-');
  const gone = join(temp('keel-ho-gone-'), 'nope');
  mkdirSync(dirname(file), { recursive: true });
  assert.equal(keel(['projects', 'add', listed], file).status, 0);
  const before = readFileSync(file, 'utf8');
  const cases = [
    ['add a directory that is not a git repository', ['projects', 'add', notGit]],
    ['add a directory that does not exist', ['projects', 'add', gone]],
    ['remove an unlisted project', ['projects', 'remove', unlisted]],
    ['pause an unlisted project', ['projects', 'pause', unlisted]],
    ['resume an unlisted project', ['projects', 'resume', unlisted]],
    ['add with no directory', ['projects', 'add']],
    ['remove with no directory', ['projects', 'remove']],
    ['pause with no directory', ['projects', 'pause']],
    ['resume with no directory', ['projects', 'resume']],
    ['an unknown subcommand', ['projects', 'frobnicate']],
    ['active zero', ['projects', 'active', '0']],
    ['active negative', ['projects', 'active', '-1']],
    ['active a fraction', ['projects', 'active', '1.5']],
    ['active a word other than all', ['projects', 'active', 'some']],
    ['active with no count', ['projects', 'active']],
    ['--rank on remove', ['projects', 'remove', listed, '--rank', '1']],
    ['--rank on listing', ['projects', '--rank', '1']],
    ['--rank on another command', ['report', '--rank', '1']],
  ];
  for (const [what, args] of cases) {
    await t.test(`REQ-MULTI-4 ${what} is a usage error`, () => {
      assertUsage(keel(args, file));
      assert.equal(readFileSync(file, 'utf8'), before);
    });
  }
});
