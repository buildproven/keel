import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { sizeWarning, stackWarnings } from '../src/stack.js';
import { commit, fixtureConfig, fixtureRepo, g } from './helpers.js';

const lines = (n, tag) => `${Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n')}\n`;

test('REQ-GATE-30 a branch that contains another unmerged branch is reported as stacked on it', () => {
  const { dir } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/status');
  commit(dir, { 'src/status.js': lines(3, 's') }, 'feat: status');
  commit(dir, { 'src/status2.js': lines(3, 't') }, 'feat: status 2');
  g(dir, 'checkout', '-q', '-b', 'feat/weekly');
  commit(dir, { 'src/weekly.js': lines(3, 'w') }, 'feat: weekly');
  assert.deepEqual(stackWarnings(dir, 'main'), ['stacked on feat/status (2 commits): merge feat/status first, or rebase onto main']);
});

test('REQ-GATE-30 a branch with one concern on base, or with base merged in, is not stacked', () => {
  const { dir } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'feat/other');
  commit(dir, { 'src/other.js': lines(3, 'o') }, 'feat: other');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'src/main.js': lines(3, 'm') }, 'feat: main moves');
  g(dir, 'checkout', '-q', '-b', 'feat/solo', 'HEAD~1');
  commit(dir, { 'src/solo.js': lines(3, 'x') }, 'feat: solo');
  g(dir, 'merge', '-q', '--no-edit', 'main');
  assert.deepEqual(stackWarnings(dir, 'main'), []);
});

test('REQ-GATE-30 a diff over its card size budget in non-test files is reported with its largest files', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'src/a/big.js': lines(900, 'a'), 'src/b/big.js': lines(700, 'b'), 'test/x.test.js': lines(2000, 'x') }, 'feat: big');
  const config = fixtureConfig();
  const L = parseCard('# T-1: t\nkind: feature\nsize: L\n');
  const S = parseCard('# T-1: t\nkind: feature\nsize: S\n');
  assert.equal(
    sizeWarning(dir, base, 'HEAD', L, config),
    'diff is 1600 changed lines outside tests, over 1500 for size L: split it by concern; largest: src/a/big.js 900, src/b/big.js 700',
  );
  assert.match(sizeWarning(dir, base, 'HEAD', S, config), /over 300 for size S/);
  const small = fixtureRepo();
  commit(small.dir, { 'src/a.js': lines(10, 'a'), 'test/y.test.js': lines(5000, 'y') }, 'feat: small');
  assert.equal(sizeWarning(small.dir, small.base, 'HEAD', S, config), null);
});
