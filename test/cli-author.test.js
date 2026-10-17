import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { authorFamily } from '../src/review.js';
import { FIXED_SRC, FIXTURE_TEST, commit, fixtureRepo, g, tmp, write } from './helpers.js';

const BIN = resolve('bin/keel.js');
// The suite itself may run inside Claude Code (CLAUDECODE=1) or with KEEL_AUTHOR set: never inherit them.
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && k !== 'KEEL_AUTHOR'));
const keel = (cwd, args, env = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...clean, KEEL_STATE_DIR: tmp('keel-state-'), ...env } });

/** A reviewer tier that only answers VERDICT: pass. */
const tier = (model, family) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', "require('fs').readFileSync(0); process.stdout.write('VERDICT: pass\\n')"],
});

/** A repo whose base keel.json turns review on with these tiers, and one committed change on a branch. */
function repo(tiers) {
  const { dir } = fixtureRepo();
  commit(
    dir,
    { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: true, tiers }) },
    'chore: cfg',
  );
  g(dir, 'branch', '-q', '-f', 'base');
  g(dir, 'checkout', '-q', '-b', 'work');
  commit(dir, FIXED_SRC, 'chore: change');
  const card = join(tmp('keel-card-'), 'card.md');
  write('/', { [card]: '# DEMO-1: change\n\nkind: chore\nsize: S\n\n## Requirements\n\nchange.\n' });
  return { dir, gate: (args = [], env = {}) => keel(dir, ['gate', '--base', 'base', '--card', card, ...args], env) };
}

test('REQ-CLI-9 the author family is --author, else KEEL_AUTHOR, else claude inside Claude Code, else unknown', () => {
  assert.equal(authorFamily('codex', { KEEL_AUTHOR: 'x', CLAUDECODE: '1' }), 'codex');
  assert.equal(authorFamily(undefined, { KEEL_AUTHOR: 'codex', CLAUDECODE: '1' }), 'codex');
  assert.equal(authorFamily(undefined, { CLAUDECODE: '1' }), 'claude');
  assert.equal(authorFamily(undefined, {}), null);
  assert.equal(authorFamily(undefined, { KEEL_AUTHOR: '', CLAUDECODE: '1' }), 'claude', 'an empty KEEL_AUTHOR is unset');
  assert.throws(() => authorFamily(undefined, { KEEL_AUTHOR: 'Codex 5' }), /must be a model family/);
  assert.throws(() => authorFamily('', {}), /must be a model family/);
});

test('REQ-CLI-9 gate reviews with the strongest tier of another family than the author and says which', () => {
  const r = repo([tier('model-a', 'claude'), tier('model-b', 'codex')]);
  const inClaude = r.gate([], { CLAUDECODE: '1' });
  assert.equal(inClaude.status, 0, inClaude.stderr);
  assert.match(inClaude.stderr, /keel: reviewer exec\/model-b \(author claude\)/);
  assert.match(inClaude.stderr, /PASS review/);
  assert.match(r.gate(['--author', 'codex'], { CLAUDECODE: '1' }).stderr, /keel: reviewer exec\/model-a \(author codex\)/);
  assert.match(r.gate([], { KEEL_AUTHOR: 'codex' }).stderr, /keel: reviewer exec\/model-a \(author codex\)/);
  assert.match(r.gate().stderr, /keel: reviewer exec\/model-b \(author unknown\)/);
});

test('REQ-CLI-9 a known author with no tier of another family fails closed; --author is a gate option only', () => {
  const r = repo([tier('model-a', 'claude'), tier('model-b', 'claude')]);
  const same = r.gate(['--author', 'claude']);
  assert.equal(same.status, 1);
  assert.match(same.stderr, /keel: reviewer none \(author claude\)/);
  assert.match(same.stderr, /FAIL review \[\{"rule":"no-cross-reviewer"\}\]/);
  const misuse = keel(r.dir, ['doctor', '--author', 'codex']);
  assert.equal(misuse.status, 2);
  assert.match(misuse.stderr, /keel: --author is an option of gate only/);
});
