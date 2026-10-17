import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTier } from '../src/run.js';

test('REQ-RUN-6 a quota failure never moves to a tier of the same provider, also when the floor is above the next other provider', () => {
  const tiers = [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'claude' }, { provider: 'codex' }];
  assert.equal(nextTier(tiers, 0, 2, 'quota'), 3, 'first other-provider tier at or above the floor');
  assert.equal(nextTier(tiers.slice(0, 3), 0, 2, 'quota'), null, 'no other provider at or above the floor: stop');
  assert.equal(nextTier(tiers, 0, 0, 'quota'), 1);
});
