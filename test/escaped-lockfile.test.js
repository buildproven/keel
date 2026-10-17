import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { escapedDefects } from '../src/escaped.js';
import { commit, FIXED_SRC, fixtureRepo, g, REGRESSION_TEST, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

test('REQ-LED-6 a later fix that shares only a lockfile with the merge is not a candidate', () => {
  const { dir, base } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-7');
  const head = commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST, 'package-lock.json': '{"v":1}\n', 'pnpm-lock.yaml': 'a\n' }, 'feat');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { ...FIXED_SRC, ...REGRESSION_TEST, 'package-lock.json': '{"v":1}\n', 'pnpm-lock.yaml': 'a\n' }, 'BUI-7: add (#1)');
  commit(dir, { 'package-lock.json': '{"v":2}\n', 'pnpm-lock.yaml': 'b\n' }, 'fix: clear audit advisories');
  commit(dir, { 'src/add.js': 'export const add = (a, b) => a + b + 0;\n', 'package-lock.json': '{"v":3}\n' }, 'fix: add keeps numbers');
  const row = { run: 'r', card: 'BUI-7', repo: dir, base, head, attempt: 1, tier: 0, attemptPass: true, at: new Date().toISOString() };
  const [m] = escapedDefects([row]).merged;
  assert.deepEqual(
    m.candidates.map((c) => [c.subject, c.files]),
    [['fix: add keeps numbers', ['src/add.js']]],
  );
});
