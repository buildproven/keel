import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { globMatches } from '../src/glob.js';
import { locksAny, matchesAny, outOfScope } from '../src/scan.js';
import { BUGGY, FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

// Each case holds on every platform: on 2026-10-13 Node's path.matchesGlob folded the wildcard parts on macOS only.
test('REQ-PROJ-9 test globs and allow lists match letter case exactly, wildcard parts too', () => {
  assert.equal(matchesAny('a/Latest.java', ['**/*Test.java']), false);
  assert.equal(matchesAny('a/XTEST.JAVA', ['**/*Test.java']), false);
  assert.equal(matchesAny('a/foo.test.JS', ['**/*.test.js']), false);
  assert.equal(matchesAny('a/FooTest.java', ['**/*Test.java']), true);
  assert.deepEqual(outOfScope(['src/A.JS', 'src/b.js', 'SRC/c.js'], ['src/*.js']), ['src/A.JS', 'SRC/c.js']);
});

test('REQ-PROJ-9 locks match literal and wildcard parts without regard to letter case', () => {
  assert.equal(locksAny('a/PYTEST.INI', ['**/pytest.ini']), true);
  assert.equal(locksAny('.ESLINTRC.JSON', ['**/.eslintrc*']), true);
  assert.equal(locksAny('Web/Vite.Config.TS', ['**/vite.config.*']), true);
  assert.equal(locksAny('a/pytest.cfg', ['**/pytest.ini']), false);
});

test('REQ-PROJ-9 keeps the `**`, `*`, `?`, class, brace, and dotfile rules', () => {
  const cases = [
    ['c.js', '**/c.js', true],
    ['a/b', 'a/**/b', true],
    ['a/x/y/b', 'a/**/b', true],
    ['test/a.test.js', 'test/**', true],
    ['test', 'test/**', false],
    ['a/b/c.js', 'a/*.js', false],
    ['a/b', '*', false],
    ['abc', '*b*', true],
    ['ab', 'a**b', true],
    ['a/x/b', 'a**b', false],
    ['a/xb', 'a/**b', true],
    ['xa/b', '**a/b', true],
    ['a/b/c', '**/b/**', true],
    ['b', '**/b/**', false],
    ['ab', 'a?', true],
    ['a/b', 'a?b', false],
    ['a.js', '[ab].js', true],
    ['c.js', '[ab].js', false],
    ['c', '[!ab]', true],
    ['c', '[^ab]', true],
    ['a', '[!ab]', false],
    ['a[b', 'a[b', true],
    ['a.js', '{a,b}.js', true],
    ['c.js', '{a,b}.js', false],
    ['a/c/d.js', 'a/{b,c/d}.js', true],
    ['a', 'a{,b}', true],
    ['a{b', 'a{b', true],
    ['a(1).txt', 'a(1).txt', true],
    ['x', '!x', false],
    ['!x', '!x', true],
    ['#x', '#x', true],
    ['a+b.js', 'a+b.js', true],
    ['a/b', 'a\\b', true],
    ['.foo.js', '*.js', false],
    ['a/.foo.js', '**/*.js', false],
    ['a/.git/x', '**', false],
    ['a/.git/x', '**/x', false],
    ['a/.b', 'a/*', false],
    ['a/.b', 'a/.*', true],
    ['a/x/.b', 'a/**/.b', true],
    ['.github/workflows/ci.yml', '.github/**', true],
    ['.env.local', '**/.env*', true],
    ['x/.y.test.js', '**/*.test.js', false],
    ['.a', '{.a,b}', true],
    ['/a/b', '/a/b', true],
    ['a/b', '/a/b', false],
  ];
  const wrong = cases.filter(([path, glob, want]) => globMatches(path, glob) !== want);
  assert.deepEqual(wrong, []);
});

test('REQ-PROJ-9 glob syntax the matcher does not support fails visibly', () => {
  for (const glob of ['+(a|b).js', '@(a|b).js', '!(a).js', '?(a).js', '*(a).js', '[[:alpha:]]', 'a{1..3}'])
    assert.throws(() => globMatches('a.js', glob), /unsupported glob syntax/, glob);
});

test('REQ-PROJ-9 an edit to an existing file that only folds onto a test glob is not an existing-test change', () => {
  const { dir, base } = fixtureRepo({ ...BUGGY, 'src/Latest.java': 'class Latest {}\n' });
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'src/Latest.java': 'class Latest { int v; }\n' });
  const r = gate({
    repo: dir,
    base,
    card: parseCard('# T-1: t\nkind: bug\nsize: S\n'),
    config: fixtureConfig({ testGlobs: ['test/**', '**/*Test.java'] }),
  });
  const locked = r.results.find((x) => x.name === 'locked').problems;
  assert.deepEqual(
    locked.filter((p) => p.path === 'src/Latest.java'),
    [],
  );
});
