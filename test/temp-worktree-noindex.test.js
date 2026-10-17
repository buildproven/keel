import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { test } from 'node:test';
import { withTempWorktree } from '../src/git.js';
import { fixtureRepo } from './helpers.js';

test('REQ-GATE-34 temporary checkouts live in a .noindex directory under TMPDIR, so Spotlight skips them, and are removed', () => {
  const { dir: repo } = fixtureRepo();
  const dir = withTempWorktree(repo, 'HEAD', (d) => {
    assert.ok(existsSync(`${d}/package.json`), 'the checkout is there while fn runs');
    return d;
  });
  assert.equal(basename(dirname(dir)), 'keel.noindex');
  assert.equal(realpathSync(dirname(dirname(dir))), realpathSync(tmpdir()));
  assert.match(basename(dir), /^keel-wt-/);
  assert.equal(existsSync(dir), false);
});
