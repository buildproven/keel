import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  activeProjects,
  addProject,
  formatProjects,
  projectsFile,
  readProjects,
  removeProject,
  setActive,
  setPaused,
  writeProjects,
} from '../src/projects.js';
import { UsageError } from '../src/usage.js';
import { fixtureRepo, tmp } from './helpers.js';

const fileWith = (data) => {
  const file = join(tmp('keel-projects-'), 'projects.json');
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
};

test('REQ-MULTI-1 the list lives at KEEL_PROJECTS_FILE, else under XDG_CONFIG_HOME, else ~/.config', () => {
  assert.equal(projectsFile({ KEEL_PROJECTS_FILE: '/x/p.json', XDG_CONFIG_HOME: '/c' }), '/x/p.json');
  assert.equal(projectsFile({ XDG_CONFIG_HOME: '/c' }), '/c/keel/projects.json');
  assert.equal(projectsFile({}), join(homedir(), '.config', 'keel', 'projects.json'));
});

test('REQ-MULTI-1 a missing file is an empty list; paths and ~ resolve; a bare string is a repo', () => {
  assert.deepEqual(readProjects(join(tmp('keel-projects-'), 'none.json')), { active: null, projects: [] });
  const data = readProjects(fileWith({ active: 2, projects: ['~/a', { repo: '/b', paused: true, limit: 3, base: 'origin/main' }] }));
  assert.equal(data.active, 2);
  assert.deepEqual(data.projects, [
    { repo: join(homedir(), 'a'), paused: false, limit: null, base: null },
    { repo: '/b', paused: true, limit: 3, base: 'origin/main' },
  ]);
});

test('REQ-MULTI-1 a malformed list is an error naming the file, never a shorter list', () => {
  const bad = [
    ['{', /not valid JSON/],
    [{ projects: [], extra: 1 }, /unknown keys: extra/],
    [{ active: 0, projects: [] }, /"active" must be a positive integer/],
    [{ projects: {} }, /"projects" must be an array/],
    [{ projects: [{ repo: '' }] }, /"repo" must be a non-empty path/],
    [{ projects: [{ repo: '/a', limit: 0 }] }, /"limit" must be a positive integer/],
    [{ projects: [{ repo: '/a', paused: 'yes' }] }, /"paused" must be true or false/],
    [{ projects: [{ repo: '/a', colour: 'red' }] }, /unknown keys: colour/],
    [{ projects: ['/a', '/a/'] }, /listed twice/],
  ];
  for (const [data, message] of bad) {
    const file = fileWith(data);
    assert.throws(
      () => readProjects(file),
      (e) => e.message.startsWith(file) && message.test(e.message),
      JSON.stringify(data),
    );
  }
});

test('REQ-MULTI-2 the active projects are the first N unpaused ones in rank order; null means all', () => {
  const p = (repo, paused = false) => ({ repo, paused, limit: null, base: null });
  const projects = [p('/1'), p('/2', true), p('/3'), p('/4'), p('/5')];
  assert.deepEqual(
    activeProjects({ active: 3, projects }).map((x) => x.repo),
    ['/1', '/3', '/4'],
  );
  assert.deepEqual(
    activeProjects({ active: null, projects }).map((x) => x.repo),
    ['/1', '/3', '/4', '/5'],
  );
});

test('REQ-MULTI-3 the listing shows rank, active/waiting/paused, and what a repo lacks', () => {
  const p = (repo, over = {}) => ({ repo, paused: false, limit: null, base: null, ...over });
  const data = { active: 1, projects: [p('/a'), p('/b'), p('/c', { paused: true, limit: 2 }), p('/d')] };
  const info = {
    '/a': { found: true, keelJson: true, linearProject: 'web' },
    '/b': { found: true, keelJson: false },
    '/c': { found: false },
  };
  const out = formatProjects(data, '/f.json', (r) => info[r] ?? { found: true, keelJson: true, linearProject: null });
  assert.match(out, /^Projects \(\/f\.json\): top 1 unpaused are active/);
  assert.match(out, / 1\. active {2}\/a — linear web/);
  assert.match(out, / 2\. waiting \/b — no keel\.json at HEAD \(keel init\)/);
  assert.match(out, / 3\. paused {2}\/c — missing directory, limit 2/);
  assert.match(out, / 4\. waiting \/d — no linearProject \(poll skips it\)/);
  assert.match(formatProjects({ active: null, projects: [] }, '/f.json'), /none yet: keel projects add <dir>/);
});

test('REQ-MULTI-4 add appends or moves to a rank, remove/pause/resume edit by path, active sets the count, and the file round-trips', () => {
  const a = fixtureRepo().dir;
  const b = fixtureRepo().dir;
  const c = fixtureRepo().dir;
  let data = { active: null, projects: [] };
  data = addProject(data, a);
  data = addProject(data, b);
  data = addProject(data, c, 1);
  assert.deepEqual(
    data.projects.map((p) => p.repo),
    [c, a, b],
  );
  data = addProject(data, b, 1); // already listed: moved, not duplicated
  assert.deepEqual(
    data.projects.map((p) => p.repo),
    [b, c, a],
  );
  data = setPaused(data, c, true);
  data = setActive(data, '1');
  data = removeProject(data, a);
  const file = join(tmp('keel-projects-'), 'nested', 'projects.json');
  writeProjects(file, data);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { active: 1, projects: [{ repo: b }, { repo: c, paused: true }] });
  assert.deepEqual(readProjects(file), data);
  assert.equal(setActive(data, 'all').active, null);
});

test('REQ-MULTI-4 a non-repo dir, an unlisted dir, or a bad count is a usage error', () => {
  const data = { active: null, projects: [] };
  assert.throws(
    () => addProject(data, tmp('keel-not-repo-')),
    (e) => e instanceof UsageError && /not a git repository/.test(e.message),
  );
  assert.throws(
    () => removeProject(data, '/nowhere'),
    (e) => e instanceof UsageError && /not in the project list/.test(e.message),
  );
  assert.throws(() => setPaused(data, '/nowhere', true), UsageError);
  for (const n of ['0', '-1', '2.5', 'x', undefined]) assert.throws(() => setActive(data, n), UsageError, String(n));
});
