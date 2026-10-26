import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));
const temp = (p = 'keel-ho-list-') => mkdtempSync(join(tmpdir(), p));

function env(extra = {}) {
  const e = { ...process.env, KEEL_STATE_DIR: temp('keel-ho-state-'), ...extra };
  delete e.LINEAR_API_KEY;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete e[k];
  return e;
}

function keel(args, extraEnv = {}, cwd = temp('keel-ho-cwd-')) {
  const r = spawnSync(process.execPath, [KEEL, ...args], { cwd, env: env(extraEnv), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` };
}

function repo(files = { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true' }) }, dir = temp('keel-ho-repo-')) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return dir;
}

const keelJson = (extra = {}) => JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', ...extra });

function projectsFile(content) {
  const file = join(temp('keel-ho-cfg-'), 'projects.json');
  if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

/** The output chunk that describes one project: from the line naming its path up to the next project's line. */
function chunkFor(out, path, allPaths) {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.includes(path) && !allPaths.some((o) => o !== path && o.startsWith(path) && l.includes(o)));
  assert.notEqual(start, -1, `no line names ${path} in:\n${out}`);
  let end = start + 1;
  while (end < lines.length && !allPaths.some((p) => lines[end].includes(p))) end++;
  return lines.slice(start, end).join('\n');
}
const stateOf = (chunk, paths) => {
  let s = chunk;
  for (const p of paths) s = s.split(p).join('');
  return s;
};

test('REQ-MULTI-1 a missing projects file is an empty list: listing exits 0, prints the path, and creates nothing', () => {
  const file = projectsFile();
  const r = keel(['projects'], { KEEL_PROJECTS_FILE: file });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(file), `output names ${file}:\n${r.out}`);
  assert.equal(existsSync(file), false, 'listing writes nothing');
});

test('REQ-MULTI-1 without KEEL_PROJECTS_FILE the list lives at $XDG_CONFIG_HOME/keel/projects.json', () => {
  const xdg = temp('keel-ho-xdg-');
  const r = keel(['projects'], { KEEL_PROJECTS_FILE: undefined, XDG_CONFIG_HOME: xdg, HOME: temp('keel-ho-home-') });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(join(xdg, 'keel', 'projects.json')), r.out);
});

test('REQ-MULTI-1 without KEEL_PROJECTS_FILE or XDG_CONFIG_HOME the list lives at ~/.config/keel/projects.json', () => {
  const home = temp('keel-ho-home-');
  const r = keel(['projects'], { KEEL_PROJECTS_FILE: undefined, XDG_CONFIG_HOME: undefined, HOME: home });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(join(home, '.config', 'keel', 'projects.json')), r.out);
});

test('REQ-MULTI-1 a repo path starting with ~ is read under the home directory', () => {
  const home = temp('keel-ho-home-');
  const dir = repo({ 'keel.json': keelJson({ linearProject: 'Tilde Project' }) }, join(home, 'code', 'tilde-repo'));
  const file = projectsFile({ active: null, projects: ['~/code/tilde-repo'] });
  const r = keel(['projects'], { KEEL_PROJECTS_FILE: file, HOME: home });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(dir), `expanded path ${dir} listed:\n${r.out}`);
  assert.ok(r.out.includes('Tilde Project'), r.out);
});

const INVALID = [
  ['invalid JSON', '{ "projects": [ '],
  ['an unknown top-level key', { projects: [], colour: 'red' }],
  ['an unknown project key', { projects: [{ repo: '/tmp/x', priority: 1 }] }],
  ['an empty repo', { projects: [''] }],
  ['an object project without repo', { projects: [{ paused: true }] }],
  ['a repo that is not a string', { projects: [42] }],
  ['a repo listed twice', { projects: ['/tmp/keel-ho-dupe', { repo: '/tmp/keel-ho-dupe', paused: true }] }],
  ['active zero', { active: 0, projects: [] }],
  ['active a fraction', { active: 1.5, projects: [] }],
  ['active a string', { active: '2', projects: [] }],
  ['paused not a boolean', { projects: [{ repo: '/tmp/x', paused: 'yes' }] }],
  ['limit zero', { projects: [{ repo: '/tmp/x', limit: 0 }] }],
  ['limit a fraction', { projects: [{ repo: '/tmp/x', limit: 2.5 }] }],
  ['base empty', { projects: [{ repo: '/tmp/x', base: '' }] }],
  ['base not a string', { projects: [{ repo: '/tmp/x', base: 7 }] }],
  ['projects not an array', { projects: '/tmp/x' }],
];
for (const [what, content] of INVALID) {
  test(`REQ-MULTI-1 ${what} in the projects file is an error naming the file, never a shorter list`, () => {
    const file = projectsFile(content);
    const before = readFileSync(file, 'utf8');
    const r = keel(['projects'], { KEEL_PROJECTS_FILE: file });
    assert.notEqual(r.status, 0, `must fail:\n${r.out}`);
    assert.ok(r.stderr.includes(file), `error names ${file}:\n${r.out}`);
    assert.doesNotMatch(r.out, /unknown command/i);
    assert.equal(readFileSync(file, 'utf8'), before);
  });
}

test('REQ-MULTI-2 the first `active` unpaused projects in list order are active; the rest wait; paused stay paused', () => {
  const name = (n) => ({ 'keel.json': keelJson({ linearProject: `Proj ${n}` }) });
  const a = repo(name('A'));
  const b = repo(name('B'));
  const c = repo(name('C'));
  const d = repo(name('D'));
  const file = projectsFile({ active: 2, projects: [{ repo: a, paused: true }, b, { repo: c, limit: 2 }, d] });
  const r = keel(['projects'], { KEEL_PROJECTS_FILE: file });
  assert.equal(r.status, 0, r.out);
  const all = [a, b, c, d];
  const st = (p) => stateOf(chunkFor(r.stdout, p, all), all);
  assert.match(st(a), /\bpaused\b/);
  assert.match(st(b), /\bactive\b/);
  assert.match(st(c), /\bactive\b/);
  assert.match(st(d), /\bwaiting\b/);
  assert.doesNotMatch(st(d), /\bactive\b/);
  assert.doesNotMatch(st(a), /\bactive\b|\bwaiting\b/);
});

test('REQ-MULTI-2 active null makes every unpaused project active', () => {
  const a = repo({ 'keel.json': keelJson({ linearProject: 'A' }) });
  const b = repo({ 'keel.json': keelJson({ linearProject: 'B' }) });
  const c = repo({ 'keel.json': keelJson({ linearProject: 'C' }) });
  const file = projectsFile({ active: null, projects: [a, { repo: b, paused: true }, c] });
  const r = keel(['projects', 'list'], { KEEL_PROJECTS_FILE: file });
  assert.equal(r.status, 0, r.out);
  const all = [a, b, c];
  const st = (p) => stateOf(chunkFor(r.stdout, p, all), all);
  assert.match(st(a), /\bactive\b/);
  assert.match(st(b), /\bpaused\b/);
  assert.match(st(c), /\bactive\b/);
  assert.doesNotMatch(r.stdout, /\bwaiting\b/);
});

test('REQ-MULTI-3 listing prints the path, active count, rank, state, and what each committed HEAD names, and writes nothing', () => {
  const good = repo({ 'keel.json': keelJson({ linearProject: 'Good Linear Project' }) });
  const missing = join(temp('keel-ho-gone-'), 'not-here');
  const noKeel = repo({ 'other.txt': 'x\n' });
  const notJson = repo({ 'keel.json': '{ this is not json' });
  const noProject = repo({ 'keel.json': keelJson() });
  // The working tree says otherwise; Keel reads the committed HEAD.
  writeFileSync(join(noProject, 'keel.json'), keelJson({ linearProject: 'Uncommitted Name' }));
  const all = [good, missing, noKeel, notJson, noProject];
  const file = projectsFile({ active: 3, projects: all });
  const before = readFileSync(file, 'utf8');
  const mtime = statSync(file).mtimeMs;
  const r = keel(['projects'], { KEEL_PROJECTS_FILE: file });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.stdout.includes(file), `names the file:\n${r.out}`);
  assert.ok(
    r.stdout.split('\n').some((l) => !all.some((p) => l.includes(p)) && /active/i.test(l) && /\b3\b/.test(l.split(file).join(''))),
    `an active count of 3 is printed:\n${r.stdout}`,
  );
  const chunk = (p) => chunkFor(r.stdout, p, all);
  const bare = (p) => stateOf(chunk(p), all);
  all.forEach((p, i) => assert.match(bare(p), new RegExp(`\\b${i + 1}\\b`), `rank ${i + 1} for ${p}:\n${chunk(p)}`));
  assert.match(bare(good), /Good Linear Project/);
  assert.match(bare(missing), /missing|not found|does not exist|no such/i);
  assert.match(bare(noKeel), /keel\.json/);
  assert.doesNotMatch(bare(noKeel), /linearProject/);
  assert.match(bare(notJson), /JSON/);
  assert.match(bare(noProject), /linearProject/);
  assert.doesNotMatch(bare(noProject), /Uncommitted Name/);
  assert.match(bare(good), /\bactive\b/);
  assert.match(bare(noProject), /\bwaiting\b/);
  assert.equal(readFileSync(file, 'utf8'), before, 'listing writes nothing');
  assert.equal(statSync(file).mtimeMs, mtime);
});
