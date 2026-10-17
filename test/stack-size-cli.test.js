import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FIXED_SRC, FIXTURE_TEST, commit, fixtureRepo, g, tmp, write } from './helpers.js';

const BIN = resolve('bin/keel.js');

test('REQ-GATE-30 keel gate prints the stacked-branch and size warnings before it gates, and still gates', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: false }) }, 'chore: cfg');
  g(dir, 'branch', '-q', '-f', 'base');
  g(dir, 'checkout', '-q', '-b', 'feat/status');
  commit(dir, { 'src/status.js': `${'export const s = 1;\n'.repeat(400)}` }, 'chore: status');
  g(dir, 'checkout', '-q', '-b', 'feat/weekly');
  commit(dir, FIXED_SRC, 'chore: weekly');
  const card = join(tmp('keel-card-'), 'card.md');
  write('/', { [card]: '# DEMO-1: change\n\nkind: chore\nsize: S\n\n## Requirements\n\nchange.\n' });
  const r = spawnSync(process.execPath, [BIN, 'gate', '--base', 'base', '--card', card], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, KEEL_STATE_DIR: tmp('keel-state-') },
  });
  assert.match(r.stderr, /^keel: WARN stacked on feat\/status \(1 commit\)/m);
  assert.match(r.stderr, /^keel: WARN diff is \d+ changed lines outside tests, over 300 for size S/m);
  assert.match(r.stderr, /^keel: PASS /m, 'warnings do not block');
});
