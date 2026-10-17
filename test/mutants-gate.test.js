import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate, linkShared } from '../src/gate.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = (header = 'kind: chore\nsize: S') => parseCard(`# T-1: test card\n${header}\n`);

test('REQ-GATE-1 a failing check stops the later checks from running', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  const config = fixtureConfig({ checks: { first: 'exit 1', second: 'true' } });
  const r = gate({ repo: dir, base, card: card(), config });
  assert.ok(r.results.some((x) => x.name === 'first'));
  assert.ok(!r.results.some((x) => x.name === 'second'));
});

test('REQ-GATE-15 a failing acceptance command stops the later acceptance commands', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  const config = fixtureConfig({ acceptance: { a: 'exit 1', b: 'true' } });
  const r = gate({ repo: dir, base, card: card('kind: chore\nsize: S\nacceptance: a, b'), config });
  assert.ok(r.results.some((x) => x.name === 'acceptance:a'));
  assert.ok(!r.results.some((x) => x.name === 'acceptance:b'));
});

test('REQ-GATE-1 stage output over the tail limit is cut to its last 2000 characters behind a leading ellipsis', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'x\n' });
  const outputOf = (script) => {
    const config = fixtureConfig({ checks: { loud: `node -e "${script}; process.exit(1)"` } });
    return gate({ repo: dir, base, card: card(), config }).results.find((x) => x.name === 'loud').output;
  };
  const long = outputOf("process.stdout.write('a'.repeat(3000)+'END')");
  assert.equal(long.length, 2001);
  assert.ok(long.startsWith('…a'));
  assert.ok(long.endsWith('END'));
  const exact = outputOf("process.stdout.write('b'.repeat(2000))");
  assert.equal(exact, 'b'.repeat(2000));
  assert.equal(outputOf("process.stdout.write('hello')"), 'hello');
});

test('REQ-GATE-16 linkShared links a dir only when it exists in the repo and is absent in the checkout', () => {
  const repo = tmp('keel-ls-repo-');
  const co = tmp('keel-ls-co-');
  mkdirSync(join(repo, 'node_modules'));
  mkdirSync(join(repo, '.venv'));
  mkdirSync(join(co, '.venv'));
  linkShared(repo, co, ['node_modules', '.venv', 'missing']);
  assert.equal(lstatSync(join(co, 'node_modules')).isSymbolicLink(), true);
  assert.equal(lstatSync(join(co, '.venv')).isSymbolicLink(), false);
  assert.ok(!existsSync(join(co, 'missing')));
});
