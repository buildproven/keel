import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectBase } from '../src/projects.js';
import { commit, fixtureRepo, g, tmp } from './helpers.js';

/** A clone of a fresh repo, so it has an origin; returns { origin, clone }. */
function cloned() {
  const { dir: origin } = fixtureRepo();
  const clone = tmp('keel-clone-');
  g(clone, 'clone', '-q', origin, '.');
  return { origin, clone };
}

test("REQ-MULTI-6 a project with no base is fetched and polled against origin's default branch, so a pass never builds on stale code", () => {
  const { origin, clone } = cloned();
  const newer = commit(origin, { 'src/new.js': 'export const n = 1;\n' }, 'feat: newer');
  const lines = [];
  const base = projectBase({ repo: clone, base: null }, (m) => lines.push(m));
  assert.equal(base, 'origin/main');
  assert.equal(g(clone, 'rev-parse', 'origin/main'), newer, 'fetched before the pass');
  assert.deepEqual(lines, []);
});

test('REQ-MULTI-6 a configured base is kept and still fetched; a repo with no origin polls HEAD', () => {
  const { origin, clone } = cloned();
  g(origin, 'branch', 'release');
  assert.equal(projectBase({ repo: clone, base: 'origin/release' }), 'origin/release');
  assert.ok(g(clone, 'rev-parse', 'origin/release'));
  const { dir: local } = fixtureRepo();
  assert.equal(projectBase({ repo: local, base: null }), 'HEAD');
});

test('REQ-MULTI-6 a fetch that fails is a warning, and the pass goes on with the refs it has', () => {
  const { clone } = cloned();
  g(clone, 'remote', 'set-url', 'origin', '/nowhere/gone.git');
  const lines = [];
  assert.equal(
    projectBase({ repo: clone, base: null }, (m) => lines.push(m)),
    'origin/main',
  );
  assert.match(lines.join('\n'), /^WARN git fetch origin failed in .*; polling against the refs it has/);
});
