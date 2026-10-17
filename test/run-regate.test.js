import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { FIXTURE_TEST, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const tier = (mode) => ({ provider: 'exec', model: mode, effort: 'high', command: ['node', FAKE, mode] });
const card = () => parseCard('# T-42: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
let logFile;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
});
const calls = () => readFileSync(logFile, 'utf8').trim().split('\n');
/** A lint check that fails its first `n` runs on this machine, then passes. */
const flakyLint = (n) => {
  const counter = join(tmp('keel-flake-'), 'n');
  return `c=$(cat ${counter} 2>/dev/null || echo 0); echo $((c+1)) > ${counter}; [ "$c" -ge ${n} ]`;
};

test('REQ-RUN-34 a failed check is gated once more on the same head before escalating; a pass there is a flake', () => {
  const { dir } = fixtureRepo();
  const lines = [];
  const config = fixtureConfig({
    tiers: [tier('good'), tier('crash')],
    checks: { test: FIXTURE_TEST, lint: flakyLint(2) },
    learnStart: false,
  });
  const r = run({ repo: dir, card: card(), config, log: (l) => lines.push(l) });
  assert.equal(r.pass, true);
  assert.equal(r.tier, 0);
  assert.equal(r.attempt, 1);
  assert.equal(calls().length, 1, 'no worker call for the flake');
  const row = readLedger().find((x) => x.card === 'T-42');
  assert.equal(row.regated, true);
  assert.deepEqual(row.flaky, ['lint']);
  assert.equal(row.gatePass, true);
  assert.ok(r.receipt.results.find((x) => x.name === 'lint').flaky, 'the PR body marks the stage flaky');
  const dirOf = join(process.env.KEEL_STATE_DIR, 'receipts');
  const saved = readdirSync(dirOf).map((f) => JSON.parse(readFileSync(join(dirOf, f), 'utf8')));
  assert.ok(saved.find((x) => x.pass)?.results.find((x) => x.name === 'lint').flaky, 'the receipt on disk says flaky too');
  assert.ok(
    lines.some((l) => /gating the same head again/.test(l)),
    lines.join('\n'),
  );
});

test('REQ-RUN-34 a check that fails again escalates; the re-gate runs once per attempt', () => {
  const { dir } = fixtureRepo();
  const config = fixtureConfig({ tiers: [tier('good'), tier('good')], checks: { test: FIXTURE_TEST, lint: 'false' }, maxAttempts: 2 });
  const r = run({ repo: dir, card: card(), config: { ...config, learnStart: false } });
  assert.equal(r.pass, false);
  assert.deepEqual(
    readLedger()
      .filter((x) => x.card === 'T-42')
      .map((x) => [x.attempt, x.regated, x.gatePass]),
    [
      [1, true, false],
      [2, true, false],
    ],
  );
});

test('REQ-RUN-34 a failure outside the checks (red proof) is not gated again', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [tier('fix-only'), tier('good')], learnStart: false }) });
  assert.equal(r.pass, true);
  assert.equal(readLedger().find((x) => x.card === 'T-42' && x.attempt === 1).regated, undefined);
});
