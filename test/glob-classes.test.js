import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globMatches } from '../src/glob.js';

// BUI-1635: each case is glob → path → match, as Node's path.matchesGlob (the prior matcher) reads it.
const wrong = (cases) => cases.filter(([path, glob, want]) => globMatches(path, glob) !== want);

test('REQ-PROJ-9 a class that names only a dot matches a leading dot; other leading classes do not (BUI-1576)', () => {
  const cases = [
    ['.env', '[.]env', true],
    ['a/.env', 'a/[.]env', true],
    ['a/b/.env', '**/[.]env', true],
    ['xenv', '[.]env', false],
    ['.env', '[!a]env', false],
    ['.env', '[^a]env', false],
    ['.env', '[a.]env', false],
    ['aenv', '[a.]env', true],
    ['.env', '[..]env', false],
    ['.env', '[!.]env', false],
    ['.env', '?env', false],
    ['.env', '*env', false],
    ['x.env', 'x[.]env', true],
  ];
  assert.deepEqual(wrong(cases), []);
});

test('REQ-PROJ-9 extglob, POSIX, and range markers inside a class are class members, not syntax (BUI-1577)', () => {
  const cases = [
    ['?', '[?()]', true],
    ['(', '[?()]', true],
    [')', '[?()]', true],
    ['x', '[?()]', false],
    ['a(', 'a[*+@!(]', true],
    ['a!', 'a[*+@!(]', true],
    ['b', '[!(]', true],
    ['(', '[!(]', false],
    [':', '[:]', true],
    ['a.b', 'a[.]b', true],
  ];
  assert.deepEqual(wrong(cases), []);
  for (const glob of ['[ab]+(a|b).js', '[?]@(a)', 'x/[[:alpha:]]', '[a]{1..3}', '{a,?(b)}', '{a,{1..3}}'])
    assert.throws(() => globMatches('a.js', glob), /unsupported glob syntax/, glob);
});

test('REQ-PROJ-9 an empty brace alternative does not leave an empty path segment (BUI-1578)', () => {
  const cases = [
    ['a/c', 'a/{,b}/c', true],
    ['a/b/c', 'a/{,b}/c', true],
    ['a/x/c', 'a/{,b}/c', false],
    ['a/c', 'a/{b,}/c', true],
    ['a/c', 'a/{,b/}c', true],
    ['a/b/c', 'a/{,b/}c', true],
    ['a/c', 'a//c', true],
    ['a/c', 'a/{,,}/c', true],
    ['a/c', 'a/{,**}/c', true],
    ['a/x/y/c', 'a/{,**}/c', true],
  ];
  assert.deepEqual(wrong(cases), []);
});
