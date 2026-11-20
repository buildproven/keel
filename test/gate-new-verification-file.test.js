import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const card = (paths) => parseCard(`# T-1: test card\nkind: chore\nsize: S${paths === undefined ? '' : `\npaths: ${paths}`}\n`);
const result = (r, name) => r.results.find((x) => x.name === name);
const rules = (r) => r.results.flatMap((x) => x.problems.map((p) => p.rule));
const IGNORE = { '.prettierignore': 'pnpm-lock.yaml\n' };

test('REQ-GATE-68 a verification file the card marks (new) and the base lacks may be added', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, IGNORE);
  const r = gate({ repo: dir, base, card: card('.prettierignore (new)'), config: fixtureConfig() });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
  const locked = result(r, 'locked');
  assert.deepEqual(locked.problems, []);
  assert.deepEqual(
    locked.relaxed.map((x) => [x.path, x.rule]),
    [['.prettierignore', 'verification-file-changed']],
  );
});

test('REQ-GATE-68 a nested verification file marked (new) may be added', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'web/.prettierignore': 'dist\n' });
  const r = gate({ repo: dir, base, card: card('web/.prettierignore (new)'), config: fixtureConfig() });
  assert.equal(r.pass, true, JSON.stringify(r.results, null, 2));
});

test('REQ-GATE-68 an added verification file the card does not mark (new) stays locked', () => {
  for (const paths of [undefined, '.prettierignore', 'web/.prettierignore (new)', '*.prettierignore (new)']) {
    const { dir, base } = fixtureRepo();
    commit(dir, IGNORE);
    const r = gate({ repo: dir, base, card: card(paths), config: fixtureConfig() });
    assert.deepEqual(
      result(r, 'locked').problems,
      [{ rule: 'verification-file-changed', path: '.prettierignore', status: 'A' }],
      String(paths),
    );
  }
});

test('REQ-GATE-68 a card built without newPaths keeps an added verification file locked', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, IGNORE);
  const { newPaths, ...legacy } = card('.prettierignore (new)');
  assert.deepEqual(newPaths, ['.prettierignore']);
  const r = gate({ repo: dir, base, card: legacy, config: fixtureConfig() });
  assert.deepEqual(rules(r), ['verification-file-changed']);
});

test('REQ-GATE-68 a (new) mark does not open a verification file that exists on base', () => {
  const { dir, base } = fixtureRepo({ 'src/a.js': 'export {};\n', ...IGNORE });
  commit(dir, { '.prettierignore': '*\n' });
  const r = gate({ repo: dir, base, card: card('.prettierignore (new)'), config: fixtureConfig() });
  assert.deepEqual(result(r, 'locked').problems, [{ rule: 'verification-file-changed', path: '.prettierignore', status: 'M' }]);
});

test('REQ-GATE-68 a (new) mark does not open a file the base gained after the branch left', () => {
  const { dir } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'feature');
  commit(dir, IGNORE);
  g(dir, 'checkout', '-q', 'main');
  const base = commit(dir, { '.prettierignore': 'other\n' });
  g(dir, 'checkout', '-q', 'feature');
  const r = gate({ repo: dir, base, card: card('.prettierignore (new)'), config: fixtureConfig() });
  const locked = result(r, 'locked');
  assert.equal(locked.pass, false);
  assert.equal(locked.problems[0].rule, 'verification-file-changed');
  assert.match(locked.problems[0].why, /base/);
});

test('REQ-GATE-68 a (new) mark does not open a file whose name the base holds in another letter case', () => {
  const { dir } = fixtureRepo();
  // Index entries straight from blobs, kept out of the working tree, so a case-insensitive filesystem cannot merge the
  // two names into one file and leave the tree dirty.
  g(dir, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.prettierignore', '!/.Prettierignore');
  const add = (path, text) => {
    const file = join(tmp(), 'blob');
    writeFileSync(file, text);
    g(dir, 'update-index', '--add', '--cacheinfo', `100644,${g(dir, 'hash-object', '-w', file)},${path}`);
    g(dir, 'update-index', '--skip-worktree', path);
    g(dir, 'commit', '-q', '-m', path);
    return g(dir, 'rev-parse', 'HEAD');
  };
  const upper = add('.Prettierignore', 'a\n');
  add('.prettierignore', '*\n');
  const r = gate({ repo: dir, base: upper, card: card('.prettierignore (new)'), config: fixtureConfig() });
  const locked = result(r, 'locked');
  assert.deepEqual(
    locked.problems.map((p) => [p.rule, p.path, p.status]),
    [['verification-file-changed', '.prettierignore', 'A']],
  );
  assert.match(locked.problems[0].why, /letter case/);
});

test('REQ-GATE-68 a new workflow or keel.json marked (new) stays locked', () => {
  for (const path of ['.github/workflows/extra.yml', 'keel.json']) {
    const { dir, base } = fixtureRepo();
    commit(dir, { [path]: path === 'keel.json' ? '{"review":false}\n' : 'on: push\njobs: {}\n' });
    const r = gate({ repo: dir, base, card: card(`${path} (new)`), config: fixtureConfig() });
    assert.deepEqual(
      result(r, 'locked').problems.map((p) => [p.rule, p.path, p.status]),
      [['verification-file-changed', path, 'A']],
      path,
    );
  }
});

test('REQ-GATE-68 an authorized new verification file keeps scope in force', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...IGNORE, 'src/other.js': 'export {};\n' });
  const r = gate({ repo: dir, base, card: card('.prettierignore (new)'), config: fixtureConfig() });
  assert.equal(result(r, 'locked').pass, true);
  assert.equal(result(r, 'scope').pass, false);
  assert.deepEqual(rules(r), ['out-of-scope']);
});
