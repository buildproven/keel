import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stackWarnings } from '../src/stack.js';
import { commit, fixtureRepo, g, tmp } from './helpers.js';

test('REQ-GATE-30 an upstream of a different name is not reported as stacked, and another merged branch still is', () => {
  const { dir } = fixtureRepo();
  const remote = tmp();
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  g(dir, 'checkout', '-q', '-b', 'feat/status');
  commit(dir, { 'src/status.js': 'export const s = 1;\n' }, 'feat: status');
  g(dir, 'checkout', '-q', '-b', 'worktree-agent-x');
  commit(dir, { 'src/weekly.js': 'export const w = 1;\n' }, 'feat: weekly');
  g(dir, 'push', '-q', '-u', 'origin', 'HEAD:fix/bui-1-v2');
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/fix/bui-1-v2');
  assert.deepEqual(stackWarnings(dir, 'main'), ['stacked on feat/status (1 commit): merge feat/status first, or rebase onto main']);
});
