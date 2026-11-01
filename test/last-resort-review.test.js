import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { reviewerFor } from '../src/review.js';
import { commit, fixtureRepo } from './helpers.js';

function configWith(extra, env = {}) {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
  const saved = process.env.KEEL_LAST_RESORT_REVIEW;
  if ('KEEL_LAST_RESORT_REVIEW' in env) process.env.KEEL_LAST_RESORT_REVIEW = env.KEEL_LAST_RESORT_REVIEW;
  else delete process.env.KEEL_LAST_RESORT_REVIEW;
  try {
    return loadConfig(dir, 'HEAD');
  } finally {
    if (saved === undefined) delete process.env.KEEL_LAST_RESORT_REVIEW;
    else process.env.KEEL_LAST_RESORT_REVIEW = saved;
  }
}

test('REQ-GATE-56 with lastResortReview off, a last-resort provider never reviews a Claude build', () => {
  const config = configWith({ lastResortReview: false });
  const [sonnet, opus] = config.tiers;
  assert.equal(reviewerFor(config, sonnet).provider, 'claude');
  assert.equal(reviewerFor(config, sonnet).model, opus.model, 'the strongest tier off lastResort reviews');
  assert.equal(reviewerFor(config, opus).model, opus.model, 'a fresh session of the same tier when no other is left');
});

test('REQ-GATE-56 KEEL_LAST_RESORT_REVIEW=0 turns last-resort review off for every repo; the default keeps it', () => {
  const off = configWith({}, { KEEL_LAST_RESORT_REVIEW: '0' });
  assert.equal(off.lastResortReview, false);
  assert.equal(reviewerFor(off, off.tiers[0]).provider, 'claude');
  const on = configWith({});
  assert.equal(on.lastResortReview, true);
  assert.equal(reviewerFor(on, on.tiers[0]).provider, 'codex');
  assert.throws(() => configWith({ lastResortReview: 'no' }), /lastResortReview/);
});

test('REQ-RUN-64 with lastResortReview off, held-out tests are written by the strongest tier off lastResort', () => {
  assert.equal(configWith({}, { KEEL_LAST_RESORT_REVIEW: '0' }).heldOutAuthorTier, 1, 'claude opus, not codex');
  assert.equal(configWith({}).heldOutAuthorTier, 2, 'the default still uses the other family');
  assert.equal(configWith({ heldOutAuthorTier: 2 }, { KEEL_LAST_RESORT_REVIEW: '0' }).heldOutAuthorTier, 2, 'an explicit tier is kept');
});
