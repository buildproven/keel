import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseCard } from '../src/config.js';
import { gate, linkShared } from '../src/gate.js';
import { BUGGY, commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const chore = () => parseCard('# T-1: share dirs\nkind: chore\nsize: S\n');
const prepare = (r) => r.results.find((x) => x.name === 'prepare');
const KEEL_JSON = (over = {}) => `${JSON.stringify({ checks: { ok: 'true' }, testCommand: 'true', ...over })}\n`;

/** A main checkout that ignores node_modules, and a linked worktree of it with one commit on a branch. */
function linkedWorktree({ modules }) {
  const { dir: main, base } = fixtureRepo({ ...BUGGY, '.gitignore': 'node_modules/\n' });
  if (modules) {
    mkdirSync(join(main, 'node_modules'));
    writeFileSync(join(main, 'node_modules', 'pkg.txt'), 'x\n');
  }
  const wt = join(tmp('keel-wt-'), 'agent');
  g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  commit(wt, { 'notes.txt': 'x\n' });
  return { main, wt, base };
}

test('REQ-GATE-48 a gate run from a linked worktree without node_modules links the main worktree dir', () => {
  const { wt, base } = linkedWorktree({ modules: true });
  const config = fixtureConfig({ checks: { seen: 'test -f node_modules/pkg.txt' }, testCommand: 'true' });
  const r = gate({ repo: wt, base, card: chore(), config });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(prepare(r), undefined);
});

test('REQ-GATE-48 linkShared from a linked worktree links the main worktree dir (keel run worker worktree)', () => {
  const { main, wt } = linkedWorktree({ modules: true });
  const co = tmp('keel-co-');
  linkShared(wt, co, ['node_modules', '.venv']);
  assert.equal(realpathSync(readlinkSync(join(co, 'node_modules'))), realpathSync(join(main, 'node_modules')));
  assert.ok(!existsSync(join(co, '.venv')));
});

test('REQ-GATE-49 shareDirs written in keel.json are required; the defaults are not', () => {
  const { dir } = fixtureRepo({ ...BUGGY, 'keel.json': KEEL_JSON() });
  assert.equal(loadConfig(dir, 'HEAD').shareDirsRequired, false);
  commit(dir, { 'keel.json': KEEL_JSON({ shareDirs: ['node_modules'] }) });
  assert.equal(loadConfig(dir, 'HEAD').shareDirsRequired, true);
});

test('REQ-GATE-49 a written shareDirs entry missing in both worktrees fails as prepare before any gate slot', () => {
  const { wt, base } = linkedWorktree({ modules: false });
  const slotDir = join(tmp('keel-state-'), 'locks');
  const config = fixtureConfig({
    shareDirs: ['node_modules'],
    shareDirsRequired: true,
    checks: { ran: 'touch ran.marker' },
    testCommand: 'true',
  });
  const r = gate({ repo: wt, base, card: chore(), config, slotDir });
  assert.equal(r.pass, false);
  assert.deepEqual(prepare(r).problems, [
    {
      rule: 'missing-shared-dir',
      path: 'node_modules',
      detail: `missing node_modules in ${wt}: install dependencies there or set "install" in keel.json`,
    },
  ]);
  assert.ok(!r.results.some((x) => x.name === 'ran'), JSON.stringify(r.results));
  assert.ok(!existsSync(slotDir), 'no slot ticket was created');
});

test('REQ-GATE-49 a written shareDirs entry found in the main worktree passes', () => {
  const { wt, base } = linkedWorktree({ modules: true });
  const config = fixtureConfig({
    shareDirs: ['node_modules'],
    shareDirsRequired: true,
    checks: { seen: 'test -f node_modules/pkg.txt' },
    testCommand: 'true',
  });
  const r = gate({ repo: wt, base, card: chore(), config });
  assert.equal(r.pass, true, JSON.stringify(r.results));
});

test('REQ-GATE-49 default shareDirs missing everywhere never fail, even when .gitignore names them', () => {
  const { wt, base } = linkedWorktree({ modules: false });
  const config = fixtureConfig({ checks: { ok: 'true' }, testCommand: 'true' });
  const r = gate({ repo: wt, base, card: chore(), config });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(prepare(r), undefined);
});

test('REQ-GATE-49 with install set, nothing is linked and a missing written dir does not fail (REQ-GATE-16)', () => {
  const config = fixtureConfig({
    install: 'true',
    shareDirs: ['node_modules'],
    shareDirsRequired: true,
    checks: { seen: 'test ! -e node_modules' },
    testCommand: 'true',
  });
  const { wt, base } = linkedWorktree({ modules: true });
  const r = gate({ repo: wt, base, card: chore(), config });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  const none = linkedWorktree({ modules: false });
  const r2 = gate({ repo: none.wt, base: none.base, card: chore(), config });
  assert.equal(r2.pass, true, JSON.stringify(r2.results));
  assert.equal(prepare(r2), undefined);
});
