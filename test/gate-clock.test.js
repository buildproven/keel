import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const out = {
  provider: 'exec',
  family: 'codex',
  model: 'out',
  effort: 'high',
  command: [
    'node',
    '-e',
    "require('fs').readFileSync(0); console.error('You have hit your usage limit. Try again at 10:09 AM.'); process.exit(1);",
  ],
};

function waits(now) {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const logged = [];
  const slept = [];
  const config = fixtureConfig({ review: true, reviewFallback: false, tiers: [out] });
  gate({
    repo: dir,
    base,
    card: parseCard('# T-1: test card\nkind: bug\nsize: S\n'),
    config,
    reviewer: out,
    waitReviewHours: 24,
    sleep: (ms) => slept.push(ms),
    now,
    log: (l) => logged.push(l),
  });
  return { slept, logged };
}

test('REQ-GATE-28 the reset wait is read against the clock the caller gives, not the machine clock', () => {
  const early = waits(() => new Date(2026, 5, 15, 9, 0, 0));
  assert.deepEqual(early.slept, [(69 * 60 + 60) * 1000]);
  assert.ok(
    early.logged.some((l) => /waiting 70 min/.test(l)),
    early.logged.join('\n'),
  );
  // The same reset from a clock just past it is tomorrow's, about a day away: the cap decides, whatever today's date is.
  const late = waits(() => new Date(2026, 5, 15, 10, 30, 0));
  assert.equal(late.slept.length, 1);
  assert.ok(Math.abs(late.slept[0] - (23 * 3600 + 39 * 60 + 60) * 1000) < 2 * 3600 * 1000);
});

test('REQ-GATE-28 a test that waits for a reviewer reset sets the clock, so the wall clock and DST cannot fail it', () => {
  const dir = new URL('./', import.meta.url);
  const bad = readdirSync(dir)
    .filter((f) => f.endsWith('.test.js') && f !== 'gate-clock.test.js')
    .filter((f) => {
      const src = readFileSync(new URL(f, dir), 'utf8');
      return /waitReviewHours: (?!1\b|hours\b|0\b)/.test(src) && !/\bnow\b/.test(src) && /Try again at \d/.test(src);
    });
  assert.deepEqual(bad, [], 'these tests wait for a fixed clock time without setting `now`');
});
