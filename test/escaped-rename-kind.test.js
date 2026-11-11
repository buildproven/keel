import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { escapedDefects } from '../src/escaped.js';
import { commit, fixtureRepo, g, tmp, write } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const LINES = 'one\ntwo\nthree\nfour\nfive\nsix\n';

/** Main starts with `start` files; a Keel change (BUI-9) runs `change` on a branch and lands as one merge commit. */
function merged(start, change) {
  const { dir } = fixtureRepo();
  commit(dir, start, 'chore: start');
  const base = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-9');
  change(dir);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'feat: lib');
  const head = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'checkout', '-q', 'main');
  g(dir, 'merge', '-q', '--squash', 'keel/BUI-9');
  g(dir, 'commit', '-q', '-m', 'BUI-9: lib (#1)');
  const row = { run: 'BUI-9', card: 'BUI-9', repo: dir, base, head, attempt: 1, tier: 0, attemptPass: true, at: new Date().toISOString() };
  return { dir, rows: [row] };
}

const candidates = (rows) => escapedDefects(rows).merged[0].candidates.map((c) => [c.subject, c.files]);

test('REQ-LED-10 a fix that renames a code file to a doc name and edits its lines counts against the code it changed', () => {
  const { dir, rows } = merged({ 'start.js': 's\n' }, (d) => write(d, { 'src/x.js': LINES }));
  g(dir, 'mv', 'src/x.js', 'src/x.txt');
  commit(dir, { 'src/x.txt': LINES.replace('three', 'THREE') }, 'fix: x is prose');
  assert.deepEqual(candidates(rows), [['fix: x is prose', ['src/x.txt']]]);
});

test('REQ-LED-10 a merge that renames a doc file to a code name owns the code lines it wrote', () => {
  const { dir, rows } = merged({ 'docs/x.txt': LINES }, (d) => {
    g(d, 'mv', 'docs/x.txt', 'src/x.js');
    write(d, { 'src/x.js': LINES.replace('two', 'export const two = 2;') });
  });
  commit(dir, { 'src/x.js': LINES.replace('two', 'export const two = 22;') }, 'fix: two is 22');
  assert.deepEqual(candidates(rows), [['fix: two is 22', ['src/x.js']]]);
});

test('REQ-LED-10 a fix that renames a doc file to a code name does not blame the prose it replaced', () => {
  const { dir, rows } = merged({ 'start.js': 's\n' }, (d) => write(d, { 'docs/x.txt': LINES, 'src/y.js': 'y\n' }));
  g(dir, 'mv', 'docs/x.txt', 'src/x.js');
  commit(dir, { 'src/x.js': LINES.replace('three', 'THREE') }, 'fix: x is code');
  assert.deepEqual(candidates(rows), []);
});
