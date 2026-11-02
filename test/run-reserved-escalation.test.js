import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { retryReserved, run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
/** One tier that plays `modes` in order, one per worker call (fake-worker `script`). */
const scripted = (modes, model = 'm', provider = 'exec') => {
  const file = join(tmp('keel-script-'), 'script.json');
  writeFileSync(file, JSON.stringify(modes));
  return { provider, model, effort: 'high', command: ['node', FAKE, 'script', file] };
};
const card = parseCard('# T-50: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
let logFile;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
});
const calls = () =>
  readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test('REQ-PLAN-8 a failed attempt retries the highest usable tier when the tiers above are reserved', () => {
  const { dir } = fixtureRepo();
  const log = [];
  // Tier 0 fails the gate (a fix with no regression test), then passes; tier 1 is on a reserved provider.
  const config = fixtureConfig({ tiers: [scripted(['fix-only', 'good']), scripted(['good'], 'strong', 'codex')], learnStart: false });
  const r = run({ repo: dir, card, config, reserved: new Map([['codex', '5h 64% ≥ 50%']]), log: (m) => log.push(m) });
  assert.equal(r.pass, true, log.join('\n'));
  assert.equal(r.attempt, 2);
  assert.equal(r.tier, 0);
  assert.ok(
    log.some((l) => l === 'tier 1 skipped: codex plan window 5h 64% ≥ 50%'),
    log.join('\n'),
  );
  assert.ok(
    log.some((l) => l === 'tier 0 retried: tiers 1..1 are on a provider over its plan window'),
    log.join('\n'),
  );
  const second = calls()[1];
  assert.equal(second.env.model, 'm', 'the retry ran on tier 0, not the reserved tier');
  assert.match(second.prompt, /The previous attempt failed the gate/, 'the retry gets the failure summary');
});

test('REQ-PLAN-8 the retry stops at maxAttempts', () => {
  const { dir } = fixtureRepo();
  const config = fixtureConfig({
    tiers: [scripted(['fix-only', 'fix-only', 'fix-only']), scripted(['good'], 'strong', 'codex')],
    learnStart: false,
    maxAttempts: 2,
  });
  const r = run({ repo: dir, card, config, reserved: new Map([['codex', '5h 64% ≥ 50%']]) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'max-attempts');
  assert.equal(calls().length, 2);
});

test('REQ-PLAN-8 with no usable tier left the run still stops as quota', () => {
  const { dir } = fixtureRepo();
  // The attempt touches a protected path, which raises the floor to tier 1 (REQ-RUN-2); tier 1 is reserved and tier 0
  // is below the floor, so no tier is usable.
  const config = fixtureConfig({
    tiers: [scripted(['fix-only', 'good']), scripted(['good'], 'strong', 'codex')],
    learnStart: false,
    protected: ['src/**'],
    startTier: { L: 1, protected: 1 },
  });
  const log = [];
  const r = run({ repo: dir, card, config, reserved: new Map([['codex', '5h 64% ≥ 50%']]), log: (m) => log.push(m) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'quota');
  assert.equal(calls().length, 1);
  assert.ok(!log.some((l) => /retried/.test(l)), log.join('\n'));
});

test('REQ-PLAN-8 a worker out of quota is not retried on its own provider', () => {
  const { dir } = fixtureRepo();
  const config = fixtureConfig({ tiers: [scripted(['quota', 'good']), scripted(['good'], 'strong', 'codex')], learnStart: false });
  const r = run({ repo: dir, card, config, reserved: new Map([['codex', '5h 64% ≥ 50%']]) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'quota');
  assert.equal(calls().length, 1);
});

test('REQ-PLAN-8 retryReserved gives the highest unreserved tier at or above the lowest, or null', () => {
  const tiers = [{ provider: 'claude' }, { provider: 'claude' }, { provider: 'codex' }, { provider: 'codex' }];
  const log = [];
  assert.equal(
    retryReserved(tiers, 0, new Map([['codex', '5h']]), (m) => log.push(m)),
    1,
  );
  assert.deepEqual(log, ['tier 1 retried: tiers 2..3 are on a provider over its plan window']);
  assert.equal(retryReserved(tiers, 2, new Map([['codex', '5h']])), null, 'never below the lowest tier');
  assert.equal(
    retryReserved(
      tiers,
      0,
      new Map([
        ['codex', 'w'],
        ['claude', 'w'],
      ]),
    ),
    null,
  );
});
