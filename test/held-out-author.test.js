import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, loadConfig, parseCard } from '../src/config.js';
import { readLedger, report } from '../src/ledger.js';
import { run } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
let logFile;
let promptFile;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
  promptFile = join(tmp('keel-author-'), 'prompt.txt');
});

/** An author worker: saves its prompt, writes one test file, and reports a cost like Claude does. */
const author = (testBody) => ({
  provider: 'exec',
  model: 'exec-author',
  effort: 'high',
  command: [
    'node',
    '-e',
    `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(promptFile)}, fs.readFileSync(0, 'utf8'));
fs.mkdirSync('test', { recursive: true });
fs.writeFileSync('test/held.test.js', ${JSON.stringify(testBody)});
console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
  ],
});
const HELD = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n";
const card = (size = 'M', extra = '') =>
  parseCard(`# T-4: fix add\nkind: bug\nsize: ${size}\n${extra}\n## Requirements\n- REQ-ADD-1: add(a, b) shall return a + b.\n`);
const builderCalls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);

test('REQ-RUN-17 an M bug card with no held-out tests gets them from the author tier, and the gate runs them unseen by the builder', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [builder, author(HELD)], heldOutAuthorTier: 1 }) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.receipt.results.find((x) => x.name === 'held-out').pass, true);
  const heldDir = join(process.env.KEEL_STATE_DIR, 'heldout');
  const [key] = readdirSync(heldDir);
  assert.match(key, /-T-4$/);
  assert.equal(readFileSync(join(heldDir, key, 'test', 'heldout_held.test.js'), 'utf8'), HELD);
  assert.match(readFileSync(promptFile, 'utf8'), /held-out[\s\S]*REQ-ADD-1/);
  assert.equal(builderCalls().length, 1);
  assert.ok(!builderCalls()[0].includes(heldDir), 'the builder prompt never names the held-out location');
  assert.ok(!existsSync(join(r.worktree, 'test', 'held.test.js')), 'the builder worktree never sees the tests');
  const rows = readLedger();
  assert.equal(rows[0].role, 'held-out-author');
  const [summary] = report(rows).cards;
  assert.equal(summary.attempts, 1, 'authoring is not a build attempt');
  assert.equal(summary.cost.toFixed(2), '0.02', 'authoring cost counts toward the card');
});

test('REQ-RUN-17 authored tests that pass on base stop the run before any build attempt', () => {
  const { dir } = fixtureRepo();
  const weak = "import assert from 'node:assert';\nassert.ok(true);\n";
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [builder, author(weak)], heldOutAuthorTier: 1 }) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'held-out-author');
  assert.match(r.failure, /pass on base/);
  assert.equal(builderCalls().length, 0);
});

test('REQ-RUN-17 no authoring for an S card, a card that names held-out tests, or when the tier is not configured', () => {
  const held = tmp('keel-held-');
  mkdirSync(join(held, 'test'));
  writeFileSync(join(held, 'test', 'held.test.js'), HELD);
  for (const [c, config] of [
    [card('S'), fixtureConfig({ tiers: [builder, author(HELD)], heldOutAuthorTier: 1 })],
    [card('S'), fixtureConfig({ tiers: [builder, author(HELD)] })],
    [card('M', `heldOut: ${held}\n`), fixtureConfig({ tiers: [builder, author(HELD)], heldOutAuthorTier: 1 })],
  ]) {
    const { dir } = fixtureRepo();
    const r = run({ repo: dir, card: c, config });
    assert.equal(r.pass, true, r.failure);
    assert.ok(!existsSync(promptFile), `no author call for ${c.size}${c.heldOut ? ' with heldOut' : ''}`);
  }
});

test('REQ-RUN-17 REQ-CFG-1 heldOutAuthorTier defaults to none and must be a tier index', () => {
  assert.equal(DEFAULTS.heldOutAuthorTier, null);
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  for (const bad of [-1, 1.5, '3', 99]) assert.throws(() => loadConfig(dir, at({ heldOutAuthorTier: bad })), /heldOutAuthorTier/);
  assert.equal(loadConfig(dir, at({ heldOutAuthorTier: 2 })).heldOutAuthorTier, 2);
});
