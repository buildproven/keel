import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { commit, fixtureRepo } from './helpers.js';

const withJson = (extra) => {
  const { dir } = fixtureRepo();
  const base = commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'run-tests', ...extra }) });
  return { dir, base };
};

test('REQ-CFG-1 maxAttempts must be an integer of at least 1', () => {
  for (const bad of [1.5, 0, -1]) {
    const { dir, base } = withJson({ maxAttempts: bad });
    assert.throws(() => loadConfig(dir, base), /"maxAttempts" must be an integer ≥ 1/, String(bad));
  }
  const { dir, base } = withJson({ maxAttempts: 1 });
  assert.equal(loadConfig(dir, base).maxAttempts, 1);
});

test('REQ-CFG-1 heldOutCommand defaults to testCommand unless keel.json sets it', () => {
  const plain = withJson({});
  assert.equal(loadConfig(plain.dir, plain.base).heldOutCommand, 'run-tests');
  const own = withJson({ heldOutCommand: 'run-held' });
  assert.equal(loadConfig(own.dir, own.base).heldOutCommand, 'run-held');
});
