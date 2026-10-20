import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startReserved } from '../src/run.js';

const tiers = [{ provider: 'claude' }, { provider: 'claude' }, { provider: 'codex' }, { provider: 'codex' }];

test('REQ-PLAN-6 a learned start on a reserved provider falls back to the nearest usable tier below it', () => {
  const log = [];
  assert.equal(
    startReserved(tiers, 2, 0, new Map([['codex', '5h 98% ≥ 90%']]), (m) => log.push(m)),
    1,
  );
  assert.match(log.join('\n'), /start tier 1: tiers 2\.\.3 are on a provider over its plan window/);
});

test('REQ-PLAN-6 the fallback never goes below the card rule tier', () => {
  assert.equal(startReserved(tiers, 2, 2, new Map([['codex', 'week']])), null);
});

test('REQ-PLAN-6 a usable tier at or above the start is still preferred', () => {
  assert.equal(startReserved(tiers, 0, 0, new Map([['claude', 'week']])), 2);
  assert.equal(startReserved(tiers, 2, 0, new Map()), 2);
});

test('REQ-PLAN-6 with every provider reserved there is no start tier', () => {
  const both = new Map([
    ['claude', 'w'],
    ['codex', 'w'],
  ]);
  assert.equal(startReserved(tiers, 2, 0, both), null);
});
