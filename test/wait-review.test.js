import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate, resetWaitMs } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const review = (r) => r.results.filter((x) => x.name === 'review');

/** A reviewer that is out of quota until a flag file exists, then passes. */
function outOnce(retry) {
  const flag = join(tmp('keel-flag-'), 'ran');
  const script = `const fs = require('fs'); fs.readFileSync(0);
if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, ''); console.error('usage limit reached, try again at ${retry}.'); process.exit(1); }
console.log('VERDICT: pass');`;
  return { tier: { provider: 'exec', family: 'codex', model: 'once', effort: 'high', command: ['node', '-e', script] }, flag };
}

function setup() {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  return { dir, base };
}

test('REQ-GATE-28 with waitReview, a gate whose reviewers are out sleeps until the named reset and re-runs only the review', () => {
  const { dir, base } = setup();
  const { tier } = outOnce(clock(new Date(Date.now() + 120000)));
  const slept = [];
  const config = fixtureConfig({ review: true, reviewFallback: false, tiers: [tier] });
  const r = gate({ repo: dir, base, card: card(), config, reviewer: tier, waitReviewHours: 1, sleep: (ms) => slept.push(ms) });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 0 && slept[0] <= 4 * 60000, `slept ${slept[0]} ms`);
  assert.equal(review(r).length, 1, 'one review result: the retried one');
  const names = r.results.map((x) => x.name);
  assert.equal(new Set(names).size, names.length, `each stage ran once: ${names}`);
});

test('REQ-GATE-28 without waitReview, or with a reset beyond the cap, the gate does not wait', () => {
  const { dir, base } = setup();
  for (const [hours, ahead] of [
    [0, 120000],
    [1, 3 * 3600000],
  ]) {
    const { tier, flag } = outOnce(clock(new Date(Date.now() + ahead)));
    const slept = [];
    const config = fixtureConfig({ review: true, reviewFallback: false, tiers: [tier] });
    const r = gate({ repo: dir, base, card: card(), config, reviewer: tier, waitReviewHours: hours, sleep: (ms) => slept.push(ms) });
    assert.equal(r.pass, false);
    assert.deepEqual(slept, []);
    assert.equal(existsSync(flag), true);
  }
});

test('REQ-GATE-28 a reset time reads as the next such local clock time', () => {
  const now = new Date(2026, 9, 13, 9, 0, 0);
  assert.equal(resetWaitMs([{ retryAt: '10:09 AM' }], now), (69 * 60 + 60) * 1000);
  assert.equal(resetWaitMs([{ retryAt: '3pm (America/Chicago)' }, { retryAt: '10:09 AM' }], now), (69 * 60 + 60) * 1000);
  assert.equal(resetWaitMs([{ retryAt: '8:30 AM' }], now), (23.5 * 3600 + 60) * 1000, 'past today: tomorrow');
  assert.equal(resetWaitMs([{ status: 'error' }], now), null);
});

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;
const keel = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('REQ-GATE-28 --wait-review takes positive hours and belongs to gate only', () => {
  const { dir } = setup();
  for (const args of [
    ['gate', '--wait-review', 'soon'],
    ['gate', '--wait-review', '0'],
    ['run', 'c.md', '--wait-review', '2'],
  ]) {
    const r = keel(...args, '--repo', dir);
    assert.equal(r.status, 2, `${args}: ${r.stderr}`);
    assert.match(r.stderr, /--wait-review/);
  }
});
