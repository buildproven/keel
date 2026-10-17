import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withTempWorktree } from '../src/git.js';
import { fixtureRepo, g } from './helpers.js';

test('REQ-GATE-1 a check that leaves a read-only directory does not lose the stage result or leak the temporary checkout', () => {
  const { dir, base } = fixtureRepo();
  let checkout = null;
  const result = withTempWorktree(dir, base, (wt) => {
    checkout = wt;
    mkdirSync(join(wt, '.cache/x'), { recursive: true }); // as a module cache does
    writeFileSync(join(wt, '.cache/x/f'), 'cached\n');
    chmodSync(join(wt, '.cache/x'), 0o555);
    return 'stage result';
  });
  assert.equal(result, 'stage result');
  assert.equal(existsSync(checkout), false, `${checkout} leaked`);
  assert.doesNotMatch(g(dir, 'worktree', 'list', '--porcelain'), new RegExp(checkout.split('/').at(-1)));
});
