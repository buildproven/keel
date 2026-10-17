import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, parseCard } from '../src/config.js';
import { gate, stageLine } from '../src/gate.js';
import { FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const USAGE = 'console.log(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } }))';
/** An exec reviewer tier; `script` runs after the prompt is read. */
const tier = (family, model, script, effort = 'high') => ({
  provider: 'exec',
  family,
  model,
  effort,
  command: ['node', '-e', `require('fs').readFileSync(0); ${script}`],
});
const codex = tier('codex', 'exec-codex', `console.log('VERDICT: pass'); ${USAGE}`);
const claude = tier('claude', 'exec-claude', "console.log('VERDICT: pass')");
const WINDOWS = { codex: { hours: 5, tokens: 1000 } };
const review = (r) => r.results.find((x) => x.name === 'review');
const spendFile = () => join(tmp('keel-spend-'), 'review-spend.jsonl');
const spend = (file, family, tokens, at = new Date()) =>
  appendFileSync(file, `${JSON.stringify({ at: at.toISOString(), family, tokens })}\n`);

function setup() {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  return { dir, base };
}

test('REQ-GATE-24 each review records its token spend under the reviewer family, and nothing without a spend file', () => {
  const { dir, base } = setup();
  const file = spendFile();
  const config = fixtureConfig({ review: true, tiers: [claude, codex] });
  const r = gate({ repo: dir, base, card: card(), config, reviewer: codex, spendFile: file });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  const rows = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].family, 'codex');
  assert.equal(rows[0].tokens, 150);
  assert.ok(Number.isFinite(Date.parse(rows[0].at)));
  assert.equal(gate({ repo: dir, base, card: card(), config, reviewer: codex }).pass, true);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'no spend file given, nothing recorded');
});

test('REQ-GATE-24 a reviewer whose window is nearly used is skipped for the fallback before the quota runs out', () => {
  const { dir, base } = setup();
  const file = spendFile();
  spend(file, 'codex', 950);
  const would = tier('codex', 'exec-codex', "console.log('FINDING high src/add.js:1 wrong'); console.log('VERDICT: block')");
  const config = fixtureConfig({ review: true, reviewWindows: WINDOWS, tiers: [claude, would] });
  const r = gate({ repo: dir, base, card: card(), config, reviewer: would, spendFile: file });
  assert.equal(r.pass, true, 'the codex reviewer never ran');
  assert.equal(review(r).reviewer, 'exec/exec-claude/high');
  assert.deepEqual(review(r).fallback, { from: 'exec/exec-codex/high', status: 'window nearly used' });
  assert.match(stageLine(review(r)), /fallback reviewer exec\/exec-claude\/high; exec\/exec-codex\/high window nearly used/);
});

test('REQ-GATE-24 the window counts only spend inside its hours, and the reviewer keeps the review while it has room', () => {
  const { dir, base } = setup();
  const file = spendFile();
  spend(file, 'codex', 950, new Date(Date.now() - 6 * 3600 * 1000)); // outside the 5 h window
  spend(file, 'claude', 5000); // another family's window
  spend(file, 'codex', 400);
  const config = fixtureConfig({ review: true, reviewWindows: WINDOWS, tiers: [claude, codex] });
  const r = gate({ repo: dir, base, card: card(), config, reviewer: codex, spendFile: file });
  assert.equal(review(r).reviewer, 'exec/exec-codex/high');
  assert.equal(review(r).fallback, undefined);
});

test('REQ-GATE-24 with reviewFallback off, or the fallback window also low, the reviewer still reviews', () => {
  const { dir, base } = setup();
  const file = spendFile();
  spend(file, 'codex', 950);
  const off = fixtureConfig({ review: true, reviewFallback: false, reviewWindows: WINDOWS, tiers: [claude, codex] });
  assert.equal(
    review(gate({ repo: dir, base, card: card(), config: off, reviewer: codex, spendFile: file })).reviewer,
    'exec/exec-codex/high',
  );
  spend(file, 'claude', 950);
  const both = fixtureConfig({
    review: true,
    reviewWindows: { ...WINDOWS, claude: { hours: 5, tokens: 1000 } },
    tiers: [claude, codex],
  });
  const r = gate({ repo: dir, base, card: card(), config: both, reviewer: codex, spendFile: file });
  assert.equal(review(r).reviewer, 'exec/exec-codex/high');
  assert.equal(review(r).fallback, undefined);
});

test('REQ-GATE-24 when the fallback chosen for a low window is unavailable too, the reviewer is tried', () => {
  const { dir, base } = setup();
  const file = spendFile();
  spend(file, 'codex', 950);
  const down = tier('claude', 'exec-claude', '');
  const config = fixtureConfig({ review: true, reviewWindows: WINDOWS, tiers: [down, codex] });
  const r = gate({ repo: dir, base, card: card(), config, reviewer: codex, spendFile: file });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(review(r).reviewer, 'exec/exec-codex/high');
  assert.equal(review(r).fallback, undefined);
});

test('REQ-GATE-24 reviewWindows defaults to none and rejects a window without hours and tokens', () => {
  assert.deepEqual(DEFAULTS.reviewWindows, {});
  const { dir } = fixtureRepo();
  const bad = (reviewWindows) => {
    const head = commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', reviewWindows }) }, 'cfg');
    return () => loadConfig(dir, head);
  };
  assert.throws(bad({ codex: { hours: 5 } }), /reviewWindows/);
  assert.throws(bad({ codex: { hours: 0, tokens: 10 } }), /reviewWindows/);
  assert.deepEqual(bad({ codex: { hours: 5, tokens: 10 } })().reviewWindows, { codex: { hours: 5, tokens: 10 } });
});

test('REQ-GATE-24 keel gate prints the estimated tokens left in the reviewer window and the state dir is shared', () => {
  const { dir } = fixtureRepo();
  const keelJson = {
    checks: { test: FIXTURE_TEST },
    testCommand: FIXTURE_TEST,
    review: true,
    reviewWindows: WINDOWS,
    tiers: [claude, codex],
  };
  commit(dir, { 'keel.json': JSON.stringify(keelJson) }, 'chore: cfg');
  g(dir, 'branch', '-q', '-f', 'base');
  g(dir, 'checkout', '-q', '-b', 'work');
  commit(dir, FIXED_SRC, 'chore: change');
  const state = tmp('keel-state-');
  spend(join(state, 'review-spend.jsonl'), 'codex', 950);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && k !== 'KEEL_AUTHOR'));
  const run = spawnSync(process.execPath, [resolve('bin/keel.js'), 'gate', '--base', 'base', '--author', 'claude'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, KEEL_STATE_DIR: state },
  });
  const out = `${run.stdout}${run.stderr}`;
  assert.match(out, /review window codex: ~50 of 1000 tokens left in 5h/);
  assert.match(out, /nearly used/);
  assert.ok(existsSync(join(state, 'review-spend.jsonl')));
});

const lightReviewer = (file) =>
  tier(
    'codex',
    'exec-codex',
    `require('fs').writeFileSync(${JSON.stringify(file)}, process.env.KEEL_EFFORT); console.log('VERDICT: pass')`,
  );
const blocks = tier('codex', 'exec-codex', "console.log('FINDING medium src/add.js:1 add ignores NaN'); console.log('VERDICT: block')");

/** A first review that blocks, then one more commit with `files`; returns the effort the re-gate reviewer ran at. */
function regate(files, over = {}) {
  const { dir, base } = setup();
  const receiptDir = tmp('keel-receipts-');
  const config = fixtureConfig({ review: true, ...over });
  gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: blocks });
  commit(dir, files, 'docs: tweak');
  const file = join(tmp('keel-effort-'), 'effort.txt');
  const r = gate({ repo: dir, base, card: card(), config, receiptDir, reviewer: lightReviewer(file) });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  return { effort: readFileSync(file, 'utf8'), result: review(r) };
}

test('REQ-GATE-25 a re-gate of a small doc-only change runs the reviewer at the light effort and records it', () => {
  const { effort, result } = regate({ 'README.md': 'one line\n' });
  assert.equal(effort, 'low');
  assert.equal(result.effort, 'low');
  assert.equal(result.reviewer, 'exec/exec-codex/high', 'the tier label stays the configured one');
  assert.match(stageLine(result), /effort low/);
});

test('REQ-GATE-25 the first review, a code change, a large doc change, or lightReview null keep the tier effort', () => {
  assert.equal(regate({ 'src/add.js': 'export const add = (a, b) => Number(a) + Number(b);\n' }).effort, 'high');
  assert.equal(regate({ 'README.md': 'x\n'.repeat(30) }).effort, 'high');
  assert.equal(regate({ 'README.md': 'x\n'.repeat(30) }, { lightReview: { maxLines: 40, effort: 'medium' } }).effort, 'medium');
  const off = regate({ 'README.md': 'one line\n' }, { lightReview: null });
  assert.equal(off.effort, 'high');
  assert.equal(off.result.effort, undefined);
  const { dir, base } = setup();
  const file = join(tmp('keel-effort-'), 'effort.txt');
  gate({ repo: dir, base, card: card(), config: fixtureConfig({ review: true }), reviewer: lightReviewer(file) });
  assert.equal(readFileSync(file, 'utf8'), 'high');
});

test('REQ-GATE-25 lightReview defaults to 20 lines at low effort and rejects bad values', () => {
  assert.deepEqual(DEFAULTS.lightReview, { maxLines: 20, effort: 'low' });
  const { dir } = fixtureRepo();
  const load = (lightReview) => {
    const head = commit(dir, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', lightReview }) }, 'cfg');
    return loadConfig(dir, head);
  };
  assert.equal(load(null).lightReview, null);
  assert.throws(() => load({ maxLines: -1, effort: 'low' }), /lightReview/);
  assert.throws(() => load({ maxLines: 5 }), /lightReview/);
});

test('REQ-GATE-24 keel run records its review spend in the shared state dir, and moves off a nearly used window', async () => {
  const { run } = await import('../src/run.js');
  const FAKE = resolve('test/fake-worker.js');
  const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
  const { dir } = fixtureRepo();
  const state = tmp('keel-state-');
  process.env.KEEL_STATE_DIR = state;
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
  spend(join(state, 'review-spend.jsonl'), 'codex', 950);
  const config = fixtureConfig({ review: true, reviewWindows: WINDOWS, tiers: [builder, claude, codex] });
  const r = run({
    repo: dir,
    card: parseCard('# BUI-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n'),
    config,
  });
  assert.equal(r.pass, true, JSON.stringify(r));
  const receipts = join(state, 'receipts');
  const files = readdirSync(receipts);
  const receipt = JSON.parse(readFileSync(join(receipts, files.at(-1)), 'utf8'));
  assert.equal(receipt.results.find((x) => x.name === 'review').fallback.status, 'window nearly used');
});
