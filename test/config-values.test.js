import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { startTier } from '../src/run.js';
import { commit, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const withChecks = { checks: { test: 'npm test' }, testCommand: 'npm test' };

function at(cfg) {
  const { dir } = fixtureRepo();
  return () => loadConfig(dir, commit(dir, { 'keel.json': JSON.stringify({ ...withChecks, ...cfg }) }));
}

test('REQ-CFG-1 a partial startTier keeps the other default floors, so no card starts at an undefined tier', () => {
  const config = at({ startTier: { protected: 1 } })();
  assert.deepEqual(config.startTier, { L: 1, protected: 1 });
  assert.equal(startTier({ size: 'S', kind: 'infra', paths: [] }, config), 1);
});

test('REQ-CFG-1 a partial startTier on a short ladder clamps the default floors it fills in', () => {
  const config = at({ tiers: [{ provider: 'codex', model: 'm', effort: 'low' }], startTier: { L: 0 } })();
  assert.deepEqual(config.startTier, { L: 0, protected: 0 });
});

test('REQ-CFG-1 invalid values are rejected when keel.json loads, not when a run trips on them', () => {
  const cases = [
    [{ startTier: { L: 2, protected: 1, M: 3 } }, /startTier: unknown keys: M/],
    [{ startTier: 2 }, /"startTier" must be a table/],
    [{ checks: 'npm test' }, /"checks" must be a table of name to command/],
    [{ checks: ['npm test'] }, /"checks" must be a table of name to command/],
    [{ workerTimeoutSec: 'soon' }, /"workerTimeoutSec" must be an integer ≥ 1/],
    [{ workerTimeoutSec: 0 }, /"workerTimeoutSec" must be an integer ≥ 1/],
    [{ workerTimeoutSec: -1 }, /"workerTimeoutSec" must be an integer ≥ 1/],
    [{ failureTailChars: -5 }, /"failureTailChars" must be an integer ≥ 0/],
    [{ workerArgs: { claude: '--x' } }, /"workerArgs" must be a table of provider to an array of strings/],
    [{ workerArgs: [] }, /"workerArgs" must be a table of provider to an array of strings/],
    [{ heldOutCommand: null }, /"heldOutCommand" must be a non-empty command/],
    [{ claudePermissionMode: '' }, /"claudePermissionMode" must be a non-empty string/],
    [{ tiers: [{ provider: 'gpt', model: 'm', effort: 'e' }] }, /tiers/],
    [{ heldOutRequired: ['XL'] }, /"heldOutRequired" entries must be S, M, or L/],
    [{ protected: [1] }, /"protected" must be an array of strings/],
    [{ testGlobs: [null] }, /"testGlobs" must be an array of strings/],
  ];
  for (const [cfg, msg] of cases) assert.throws(at(cfg), msg, JSON.stringify(cfg));
});
