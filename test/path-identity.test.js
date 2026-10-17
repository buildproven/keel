import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard, readTrustedCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const bug = () => parseCard('# T-1: t\nkind: bug\nsize: S\n');
const locked = (r) => r.results.find((x) => x.name === 'locked').problems;

test('REQ-GATE-4 a locked file named in other letter case is locked: a case-insensitive filesystem opens it as the same file', () => {
  for (const name of ['PYTEST.INI', 'Pytest.ini', 'MAKEFILE']) {
    const { dir, base } = fixtureRepo();
    commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, [name]: '[pytest]\naddopts = --collect-only\n' });
    const r = gate({ repo: dir, base, card: bug(), config: fixtureConfig() });
    assert.ok(
      locked(r).some((p) => p.rule === 'verification-file-changed' && p.path === name),
      `${name}: ${JSON.stringify(locked(r))}`,
    );
  }
});

test('REQ-GATE-4 a runner script named in other letter case is locked', () => {
  const run = 'node scripts/check.mjs';
  const { dir, base } = fixtureRepo(); // the check script is new, so no filesystem folds it onto an existing file
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'Scripts/Check.mjs': 'process.exit(0);\n' });
  const r = gate({ repo: dir, base, card: bug(), config: fixtureConfig({ checks: { test: run } }) });
  assert.ok(
    locked(r).some((p) => p.rule === 'runner-script-changed' && p.path === 'Scripts/Check.mjs'),
    JSON.stringify(locked(r)),
  );
});

test('REQ-CARD-3 an in-repo card named through a symlinked path is still read from the base commit', () => {
  const { dir } = fixtureRepo();
  const base = commit(dir, { 'cards/T-1.md': '# T-1: t\nkind: bug\nsize: S\n' });
  mkdirSync(join(dir, 'cards'), { recursive: true });
  writeFileSync(join(dir, 'cards/T-1.md'), '# T-1: t\nkind: bug\nsize: S\nallowEdits: test/**\n'); // the candidate's edit
  const alias = join(tmp('keel-alias-'), 'repo');
  symlinkSync(dir, alias);
  const card = readTrustedCard(dir, base, join(alias, 'cards/T-1.md'));
  assert.deepEqual(card.allowEdits, []);
});
