import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { commit, fixtureRepo } from './helpers.js';

const withKeelJson = (json) => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'npm test' }, testCommand: 'npm test', ...json }) }, 'chore: keel.json');
  return dir;
};

function captureStderr(fn) {
  const write = process.stderr.write;
  let out = '';
  process.stderr.write = (s) => {
    out += s;
    return true;
  };
  try {
    return { value: fn(), out };
  } finally {
    process.stderr.write = write;
  }
}

test('REQ-RUN-39 a heldOutAuthorTier past the default ladder uses the strongest other-family tier, with a warning', () => {
  const dir = withKeelJson({ heldOutAuthorTier: 3 });
  const { value: config, out } = captureStderr(() => loadConfig(dir, 'HEAD'));
  const family = (t) => t.family ?? t.provider;
  const expected = config.tiers.findLastIndex((t) => family(t) !== family(config.tiers[0]));
  assert.ok(expected >= 0);
  assert.equal(config.heldOutAuthorTier, expected);
  assert.match(out, /heldOutAuthorTier 3 is past the default tiers/);
});

test('REQ-RUN-39 a heldOutAuthorTier past tiers that keel.json sets itself is still an error', () => {
  const tier = { provider: 'claude', model: 'm', effort: 'high' };
  const dir = withKeelJson({ tiers: [tier], heldOutAuthorTier: 3 });
  assert.throws(() => loadConfig(dir, 'HEAD'), /heldOutAuthorTier/);
});
