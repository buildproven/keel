import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));
const temp = (p = 'keel-ho-poll-') => mkdtempSync(join(tmpdir(), p));
const gitIn = (dir) => (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();

function keel(args, file, cwd = temp('keel-ho-cwd-')) {
  const env = { ...process.env, KEEL_PROJECTS_FILE: file, KEEL_STATE_DIR: temp('keel-ho-state-'), HOME: temp('keel-ho-home-') };
  delete env.LINEAR_API_KEY;
  delete env.XDG_CONFIG_HOME;
  const r = spawnSync(process.execPath, [KEEL, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

const keelJson = (extra = {}) => JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', ...extra });

function repo(files = { 'keel.json': keelJson({ linearProject: 'Alpha' }) }) {
  const dir = temp('keel-ho-repo-');
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return dir;
}

/** A project cloned from a bare origin, whose origin then gains a commit the clone has not fetched. */
function clonedBehindOrigin() {
  const seed = repo({ 'keel.json': keelJson({ linearProject: 'Cloned' }) });
  const origin = join(temp('keel-ho-origin-'), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  const clone = join(temp('keel-ho-clone-'), 'work');
  execFileSync('git', ['clone', '-q', origin, clone]);
  const cg = gitIn(clone);
  cg('config', 'user.email', 'test@example.com');
  cg('config', 'user.name', 'test');
  cg('config', 'commit.gpgsign', 'false');
  const sg = gitIn(seed);
  sg('remote', 'add', 'origin', origin);
  writeFileSync(join(seed, 'later.txt'), 'merged later\n');
  sg('add', '-A');
  sg('commit', '-q', '-m', 'merged later');
  sg('push', '-q', 'origin', 'main');
  return { clone, newTip: sg('rev-parse', 'HEAD'), oldTip: cg('rev-parse', 'refs/remotes/origin/main') };
}

function projectsFile(content) {
  const file = join(temp('keel-ho-cfg-'), 'projects.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const lineWith = (text, s) => text.split('\n').filter((l) => l.includes(s));

test('REQ-MULTI-5 poll --projects runs every active project in rank order; a failing project is logged and the next still runs', () => {
  const first = repo({ 'keel.json': keelJson({ linearProject: 'First' }) });
  const missing = join(temp('keel-ho-gone-'), 'missing-project');
  const noProject = repo({ 'keel.json': keelJson() });
  const badJson = repo({ 'keel.json': '{ nope' });
  const last = repo({ 'keel.json': keelJson({ linearProject: 'Last' }) });
  const paused = repo({ 'keel.json': keelJson({ linearProject: 'Paused' }) });
  const waiting = repo({ 'keel.json': keelJson({ linearProject: 'Waiting' }) });
  const file = projectsFile({
    active: 5,
    projects: [first, missing, { repo: paused, paused: true }, noProject, badJson, last, waiting],
  });
  const r = keel(['poll', '--projects'], file);
  // No LINEAR_API_KEY: every pass that gets as far as Linear fails too, so every result is a failure.
  assert.equal(r.status, 1, r.out);
  assert.doesNotMatch(r.stderr, /Unknown option/);
  const order = [first, missing, noProject, badJson, last].map((p) => {
    const i = r.stderr.indexOf(p);
    assert.notEqual(i, -1, `${p} is logged:\n${r.stderr}`);
    return i;
  });
  assert.deepEqual(
    [...order].sort((x, y) => x - y),
    order,
    `projects run in rank order:\n${r.stderr}`,
  );
  assert.equal(r.stderr.includes(paused), false, `a paused project is not polled:\n${r.stderr}`);
  assert.equal(r.stderr.includes(waiting), false, `a project beyond the active count is not polled:\n${r.stderr}`);
});

test('REQ-MULTI-5 poll --projects needs no repo in the working directory and does not poll the working directory', () => {
  const only = repo({ 'keel.json': keelJson({ linearProject: 'Only' }) });
  const cwdRepo = repo({ 'keel.json': keelJson({ linearProject: 'Cwd' }) });
  const file = projectsFile({ active: null, projects: [only] });
  const r = keel(['poll', '--projects'], file, cwdRepo);
  assert.notEqual(r.status, 2, r.out);
  assert.ok(r.stderr.includes(only), r.out);
  assert.equal(r.stderr.includes(cwdRepo), false, r.out);
});

test('REQ-MULTI-5 --projects usage errors', async (t) => {
  const a = repo();
  const file = projectsFile({ active: null, projects: [a] });
  const cases = [
    ['--repo with --projects', ['poll', '--projects', '--repo', a]],
    ['--project with --projects', ['poll', '--projects', '--project', 'Alpha']],
    ['--issue with --projects', ['poll', '--projects', '--issue', 'BUI-1']],
    ['--base with --projects', ['poll', '--projects', '--base', 'main']],
    ['--file-only with --projects', ['poll', '--projects', '--file-only']],
    ['--projects outside poll', ['report', '--projects']],
    ['--projects on run', ['run', 'card.md', '--projects']],
    ['--propose outside poll', ['report', '--propose']],
    ['--propose on gate', ['gate', '--propose']],
  ];
  for (const [what, args] of cases) {
    await t.test(`REQ-MULTI-5 ${what} is a usage error`, () => {
      const r = keel(args, file, a);
      assert.equal(r.status, 2, r.out);
      assert.doesNotMatch(r.stderr, /Unknown option/, r.out);
    });
  }
});

test('REQ-MULTI-5 an empty active list is a usage error', async (t) => {
  const a = repo();
  const lists = [
    ['a missing projects file', join(temp('keel-ho-cfg-'), 'absent.json')],
    ['every project paused', projectsFile({ active: null, projects: [{ repo: a, paused: true }] })],
    ['no projects', projectsFile({ active: 2, projects: [] })],
  ];
  for (const [what, file] of lists) {
    await t.test(`REQ-MULTI-5 ${what}`, () => {
      const r = keel(['poll', '--projects'], file);
      assert.equal(r.status, 2, r.out);
      assert.doesNotMatch(r.stderr, /Unknown option/, r.out);
    });
  }
});

test('REQ-MULTI-6 poll --projects fetches origin first and polls against its default branch', () => {
  const { clone, newTip, oldTip } = clonedBehindOrigin();
  assert.notEqual(oldTip, newTip);
  const file = projectsFile({ active: null, projects: [clone] });
  const r = keel(['poll', '--projects'], file);
  assert.doesNotMatch(r.stderr, /Unknown option/, r.out);
  assert.equal(gitIn(clone)('rev-parse', 'refs/remotes/origin/main'), newTip, 'origin was fetched');
  assert.match(r.stderr, /base[^\n]*origin\/main/, `logs the base it uses:\n${r.stderr}`);
});

test('REQ-MULTI-6 a project with no origin polls against HEAD; a project base overrides; a failed fetch is a WARN naming the repo', () => {
  const local = repo({ 'keel.json': keelJson({ linearProject: 'Local' }) });
  const pinned = repo({ 'keel.json': keelJson({ linearProject: 'Pinned' }) });
  gitIn(pinned)('branch', 'release-line');
  const broken = repo({ 'keel.json': keelJson({ linearProject: 'Broken' }) });
  gitIn(broken)('remote', 'add', 'origin', join(temp('keel-ho-gone-'), 'no-such-origin.git'));
  const file = projectsFile({ active: null, projects: [local, { repo: pinned, base: 'release-line' }, broken] });
  const r = keel(['poll', '--projects'], file);
  assert.doesNotMatch(r.stderr, /Unknown option/, r.out);
  assert.match(r.stderr, /base[^\n]*\bHEAD\b/, `no origin: base HEAD is logged:\n${r.stderr}`);
  assert.match(r.stderr, /base[^\n]*release-line/, `the project's base is logged:\n${r.stderr}`);
  const warns = lineWith(r.stderr, broken).filter((l) => /\bWARN\b/.test(l));
  assert.ok(warns.length >= 1, `a WARN line names ${broken}:\n${r.stderr}`);
  assert.equal(
    lineWith(r.stderr, local).some((l) => /\bWARN\b/.test(l)),
    false,
    `no origin is not a failed fetch:\n${r.stderr}`,
  );
  // The pass went on after the failed fetch: the broken repo still got its base and its (failed) Linear pass.
  const after = r.stderr.slice(r.stderr.indexOf(warns[0]) + warns[0].length);
  assert.match(after, /base[^\n]*\bHEAD\b/, `the pass goes on with the refs it has:\n${r.stderr}`);
  assert.equal(r.status, 1, r.out);
});
