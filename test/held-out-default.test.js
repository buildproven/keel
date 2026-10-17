import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { commit, fixtureRepo } from './helpers.js';

const claude = (model) => ({ provider: 'claude', model, effort: 'high' });
const codex = (model) => ({ provider: 'codex', model, effort: 'high' });

function configWith(extra) {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
  return loadConfig(dir, 'HEAD');
}

test('REQ-RUN-28 without heldOutAuthorTier, the author is the strongest tier of another family than tier 0', () => {
  assert.equal(configWith({}).heldOutAuthorTier, 2, 'the default ladder: tier 2 is codex');
  assert.equal(configWith({ tiers: [codex('a'), claude('b'), claude('c'), codex('d')] }).heldOutAuthorTier, 2);
  assert.equal(
    configWith({
      tiers: [
        { provider: 'exec', family: 'x', command: ['a'] },
        { provider: 'exec', family: 'y', command: ['b'] },
      ],
    }).heldOutAuthorTier,
    1,
  );
});

test('REQ-RUN-28 one family only, or an explicit null, leaves held-out authoring off', () => {
  assert.equal(configWith({ tiers: [claude('a'), claude('b')] }).heldOutAuthorTier, null);
  assert.equal(configWith({ heldOutAuthorTier: null }).heldOutAuthorTier, null);
  assert.equal(configWith({ heldOutAuthorTier: 1 }).heldOutAuthorTier, 1);
});
