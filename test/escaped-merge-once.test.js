import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dora } from '../src/dora.js';
import { escapedDefects } from '../src/escaped.js';
import { commit, g, tmp } from './helpers.js';

/** Two accepted runs of BUI-5 (the first PR closed for a conflict, REQ-LINEAR-23) that land as one merge, later fixed. */
function twoRunsOneMerge() {
  const dir = tmp('keel-repo-');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com'); // CI has no global git identity
  g(dir, 'config', 'user.name', 'test');
  commit(dir, { 'a.js': '1\n' }, 'init');
  const base = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-5');
  commit(dir, { 'a.js': '2\n' }, 'first build');
  const head1 = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'checkout', '-q', 'main');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-5b');
  commit(dir, { 'a.js': '3\n' }, 'second build');
  const head2 = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'a.js': '3\n' }, 'fix the thing (BUI-5)');
  commit(dir, { 'a.js': '4\n' }, 'fix: a.js regression');
  const now = Date.now();
  return [
    { run: 'r2', card: 'BUI-5', repo: dir, attemptPass: true, head: head2, base, at: new Date(now - 60000).toISOString() },
    { run: 'r1', card: 'BUI-5', repo: dir, attemptPass: true, head: head1, base, at: new Date(now - 3600000).toISOString() },
  ];
}

test('REQ-LED-6 two accepted runs that land as one merge count as one merge, from the earliest run', () => {
  const { merged } = escapedDefects(twoRunsOneMerge());
  assert.equal(merged.length, 1);
  assert.equal(merged[0].run, 'r1');
});

test('REQ-LED-7 --dora counts one merge and one failure when two accepted runs land as one merge', () => {
  const [d] = dora(twoRunsOneMerge());
  assert.equal(d.merged, 1);
  assert.equal(d.failures.length, 1);
  assert.equal(d.failureRate, 1);
});
