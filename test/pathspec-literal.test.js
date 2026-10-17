import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { showFile } from '../src/git.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const bug = () => parseCard('# T-1: t\nkind: bug\nsize: S\n');

test('REQ-GATE-5 a symlink whose name starts with ":" is still found, not read as git pathspec magic', () => {
  for (const name of [':evil', ':!x', ':(glob)y']) {
    const { dir, base } = fixtureRepo();
    symlinkSync('/etc/passwd', join(dir, name));
    commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
    const r = gate({ repo: dir, base, card: bug(), config: fixtureConfig() });
    assert.equal(r.pass, false, name);
    const locked = r.results.find((x) => x.name === 'locked');
    assert.ok(
      locked.problems.some((p) => p.rule === 'unsupported-mode' && p.path === name),
      `${name}: ${JSON.stringify(locked.problems)}`,
    );
  }
});

test('REQ-GATE-5 showFile reads a file whose name looks like pathspec magic', () => {
  const { dir } = fixtureRepo();
  const head = commit(dir, { ':(top)notes.txt': 'hello\n' });
  assert.equal(showFile(head, ':(top)notes.txt', dir), 'hello\n');
  assert.equal(showFile(head, ':(top)missing.txt', dir), null);
});
