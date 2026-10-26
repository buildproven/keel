import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, loadConfig, parseCard } from '../src/config.js';
import { failureSummary, gate } from '../src/gate.js';
import { judgeHeldOut, reviewerFor } from '../src/review.js';
import { readLedger, report } from '../src/ledger.js';
import { prBody, run } from '../src/run.js';
import { gateDescription, gateState } from '../src/status.js';
import { resultText } from '../src/workers.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const card = parseCard('# T-1: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
let promptFile;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
  promptFile = join(tmp('keel-review-'), 'prompt.txt');
});

/** A reviewer of family `family` that saves its prompt and prints `reply` (exit `code`). */
const reviewer = (reply, family = 'codex', code = 0) => ({
  provider: 'exec',
  family,
  model: 'exec-reviewer',
  effort: 'high',
  command: [
    'node',
    '-e',
    `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(promptFile)}, fs.readFileSync(0, 'utf8')); process.stdout.write(${JSON.stringify(reply)}); process.exit(${code});`,
  ],
});
const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };

function reviewed(reply, { code = 0, family = 'codex', over = {} } = {}) {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const config = fixtureConfig({ review: true, tiers: [builder, reviewer(reply, family, code)], ...over });
  return gate({ repo: dir, base, card, config, reviewer: reviewerFor(config, builder) });
}
const stage = (receipt) => receipt.results.find((r) => r.name === 'review');

test('REQ-GATE-21 a high finding that cites a changed file fails the review stage and is fed back with a repair line', () => {
  const receipt = reviewed('FINDING high src/add.js:1 add() overflows for large inputs\nVERDICT: block\n');
  assert.equal(receipt.pass, false);
  assert.deepEqual(stage(receipt).problems, [
    { rule: 'review-finding', severity: 'high', path: 'src/add.js', line: 1, text: 'add() overflows for large inputs' },
  ]);
  const text = failureSummary(receipt, 4000);
  assert.match(text, /## review[\s\S]*add\(\) overflows[\s\S]*Fix: resolve the review finding at src\/add\.js:1/);
  const prompt = readFileSync(promptFile, 'utf8');
  assert.match(prompt, /REQ-ADD-1/, 'the reviewer sees the card');
  assert.match(prompt, /\+export const add = \(a, b\) => a \+ b;/, 'the reviewer sees the diff');
});

test('REQ-GATE-21 precision first: low findings and findings citing files outside the diff do not block', () => {
  const receipt = reviewed(
    'FINDING low src/add.js:1 name could be clearer\nFINDING high src/other.js:3 invented file\nFINDING high nowhere\nVERDICT: block\n',
  );
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
  assert.equal(stage(receipt).pass, true);
  assert.deepEqual(
    stage(receipt).notes.map((n) => n.severity),
    ['low'],
    'kept as notes for the PR, not as blockers',
  );
});

test('REQ-GATE-21 a medium finding on a changed file blocks by default; reviewBlock high lets it through as a note', () => {
  const reply = 'FINDING medium src/add.js:1 a dangling link is written through\nVERDICT: block\n';
  const blocked = reviewed(reply);
  assert.equal(blocked.pass, false);
  assert.deepEqual(
    stage(blocked).problems.map((p) => [p.rule, p.severity]),
    [['review-finding', 'medium']],
  );
  const noted = reviewed(reply, { over: { reviewBlock: 'high' } });
  assert.equal(noted.pass, true);
  assert.deepEqual(
    stage(noted).notes.map((n) => n.severity),
    ['medium'],
  );
});

test('REQ-GATE-21 a reviewer that fails or gives no verdict fails closed as review-unavailable', () => {
  for (const [reply, code] of [
    ['crashed', 3],
    ['no verdict here', 0],
  ]) {
    const receipt = reviewed(reply, { code });
    assert.equal(receipt.pass, false);
    assert.deepEqual(
      stage(receipt).problems.map((p) => p.rule),
      ['review-unavailable'],
    );
  }
});

test('REQ-GATE-21 the reviewer is the strongest tier of another family; none means no-cross-reviewer', () => {
  const tiers = [
    { provider: 'claude', model: 'a', effort: 'low' },
    { provider: 'codex', model: 'b', effort: 'low' },
    { provider: 'codex', model: 'c', effort: 'high' },
    { provider: 'claude', model: 'd', effort: 'high' },
  ];
  assert.equal(reviewerFor({ tiers }, tiers[0]).model, 'c');
  assert.equal(reviewerFor({ tiers }, tiers[2]).model, 'd');
  assert.equal(reviewerFor({ tiers }, null).model, 'd', 'keel gate alone: the strongest tier');
  assert.equal(reviewerFor({ tiers: [tiers[0], tiers[3]] }, tiers[0]), null);
  const receipt = reviewed('VERDICT: pass\n', { family: 'claude' });
  assert.deepEqual(
    stage(receipt).problems.map((p) => p.rule),
    ['no-cross-reviewer'],
  );
});

test('REQ-GATE-21 run stops on review-unavailable instead of escalating the builder', () => {
  const { dir } = fixtureRepo();
  const config = fixtureConfig({
    review: true,
    reviewFallback: false,
    tiers: [builder, { ...builder, model: 'exec-good-2' }, reviewer('crashed', 'codex', 3)],
  });
  const r = run({ repo: dir, card, config });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'review-unavailable');
  assert.equal(readFileSync(process.env.KEEL_FAKE_LOG, 'utf8').trim().split('\n').length, 1, 'one build attempt only');
});

test('REQ-GATE-21 review defaults on, blocking from medium; it must be a boolean, and needs no stage when off', () => {
  assert.equal(DEFAULTS.review, true);
  assert.equal(DEFAULTS.reviewBlock, 'medium');
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  assert.throws(() => loadConfig(dir, at({ review: 'yes' })), /review/);
  assert.equal(loadConfig(dir, at({ review: true })).review, true);
  assert.throws(() => loadConfig(dir, at({ reviewBlock: 'severe' })), /"reviewBlock" must be one of critical, high, medium, low/);
  const { dir: d2, base } = fixtureRepo();
  commit(d2, { ...REGRESSION_TEST, ...FIXED_SRC });
  assert.equal(stage(gate({ repo: d2, base, card, config: fixtureConfig() })), undefined);
  assert.equal(existsSync(promptFile), false);
});

test('REQ-GATE-21 reviewer text is read from Claude JSON and Codex JSONL output', () => {
  assert.equal(resultText('claude', `${JSON.stringify({ result: 'VERDICT: pass', usage: {} })}\n`), 'VERDICT: pass');
  const codex = [
    { type: 'thread.started' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'FINDING high a.js:1 x\nVERDICT: block' } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  assert.equal(resultText('codex', codex), 'FINDING high a.js:1 x\nVERDICT: block');
  assert.equal(resultText('exec', 'plain\n'), 'plain\n');
});

test('REQ-GATE-21 the review cost counts toward the card and non-blocking notes reach the PR body', () => {
  const { dir } = fixtureRepo();
  const reply = 'FINDING low src/add.js:1 name could be clearer\nVERDICT: pass\n{"total_cost_usd":0.05}\n';
  const config = fixtureConfig({ review: true, tiers: [builder, reviewer(reply)] });
  const r = run({ repo: dir, card, config });
  assert.equal(r.pass, true, r.failure);
  const [row] = readLedger();
  assert.equal(row.reviewer, 'exec/exec-reviewer/high');
  assert.equal(row.reviewCost, 0.05);
  assert.equal(report(readLedger()).cards[0].cost.toFixed(2), '0.06', 'builder 0.01 + review 0.05');
  const body = prBody({ card, receipt: r.receipt, tier: { index: 0, ...builder }, attempt: 1, cost: 0.06 });
  assert.match(body, /\| review \| pass \| by exec\/exec-reviewer\/high; non-blocking: low src\/add\.js:1 name could be clearer \|/);
});

// An edit to an existing test that the test-edit proof accepts, so the gate asks for approval (REQ-GATE-44).
const lines = (...l) => `${l.join('\n')}\n`;
const ADD_HEAD = ["import assert from 'node:assert';", "import { it } from 'node:test';", "import { add } from '../src/add.js';"];
const pinned = (sum) => lines(...ADD_HEAD, "it('adds', () => {", `  assert.strictEqual(add(5, 3), ${sum});`, '});');
const approver = (model, script) => ({ provider: 'exec', family: 'codex', model, effort: 'high', command: ['node', '-e', script] });
const outOfQuota = (model) =>
  approver(model, `require('fs').readFileSync(0); console.error("You've hit your usage limit. Try again at 3:05 PM."); process.exit(1);`);
const offFormat = (model) =>
  approver(model, `require('fs').readFileSync(0); console.log('I think it is fine'); console.log('VERDICT: pass');`);

function editGate(first, ...fallbacks) {
  const { dir, base } = fixtureRepo({ 'src/add.js': 'export const add = (a, b) => a - b;\n', 'test/add.test.js': pinned(2) });
  commit(dir, { ...FIXED_SRC, 'test/add.test.js': pinned(8) });
  const config = fixtureConfig({
    review: true,
    testFilesCommand: 'for f in {files}; do node "$f" || exit 1; done',
    tiers: [builder, first, ...fallbacks],
  });
  const receipt = gate({ repo: dir, base, card, config, reviewer: first });
  return { receipt, stage: receipt.results.find((r) => r.name === 'test-edits') };
}

test('REQ-GATE-44 a quota-failed approver is named with its status, not as no answer', () => {
  const { receipt, stage } = editGate(outOfQuota('exec-codex'), outOfQuota('exec-codex-mini'));
  assert.equal(stage.pass, false);
  const { why } = stage.problems[0];
  assert.match(why, /quota/);
  assert.match(why, /exec\/exec-codex\/high: quota \(You've hit your usage limit/);
  assert.match(why, /exec\/exec-codex-mini\/high: quota/, 'every asked tier is named');
  assert.doesNotMatch(why, /gave no APPROVE or DENY line/);
  assert.equal(stage.problems[0].rule, 'review-unavailable', 'an approver that is out did not judge the edit');
  assert.equal(gateState(receipt), 'error', 'keel gate --status posts error, not failure (REQ-CLI-10)');
  assert.match(gateDescription(receipt, {}), /^review unavailable: exec\/exec-codex\/high quota \(retry 3:05 PM\)/);
});

test('REQ-GATE-44 an off-format answer still says no APPROVE or DENY line', () => {
  const { receipt, stage } = editGate(offFormat('exec-codex'));
  assert.equal(stage.problems[0].rule, 'existing-test-changed');
  assert.equal(stage.problems[0].why, 'no approval: exec/exec-codex/high: no APPROVE or DENY line');
  assert.equal(gateState(receipt), 'failure');
});

test('REQ-GATE-44 an approver out of quota beside one that answered off-format names both and still fails', () => {
  const { receipt, stage } = editGate(outOfQuota('exec-codex'), offFormat('exec-codex-mini'));
  assert.equal(stage.problems[0].rule, 'existing-test-changed', 'one tier ran and gave no answer, so the edit stays locked');
  assert.match(
    stage.problems[0].why,
    /^no approval: exec\/exec-codex\/high: quota \(.+\); exec\/exec-codex-mini\/high: no APPROVE or DENY line$/,
  );
  assert.equal(gateState(receipt), 'failure');
});

test('REQ-GATE-44 approvers that are out of quota or cannot sign in report the stage as review unavailable', () => {
  const signedOut = approver(
    'exec-codex-mini',
    `require('fs').readFileSync(0); console.error('Not logged in. Please log in.'); process.exit(1);`,
  );
  const { receipt, stage } = editGate(outOfQuota('exec-codex'), signedOut);
  assert.deepEqual(
    stage.unavailable.map((u) => `${u.reviewer} ${u.status}`),
    ['exec/exec-codex/high quota', 'exec/exec-codex-mini/high auth'],
  );
  assert.match(stage.problems[0].why, /exec\/exec-codex-mini\/high: auth \(Not logged in\. Please log in\.\)$/);
  assert.equal(gateState(receipt), 'error');
});

test('REQ-GATE-44 a held-out verdict nobody gave names each tier outcome', () => {
  const { dir } = fixtureRepo();
  const config = fixtureConfig({ review: true, tiers: [builder, offFormat('exec-codex-mini'), outOfQuota('exec-codex')] });
  const files = [{ path: 'test/h.test.js', text: 'x' }];
  const r = judgeHeldOut({ config, builder, card, files, output: 'not ok 1 - h', cwd: dir, head: 'HEAD' });
  assert.equal(r.answer, null);
  assert.match(r.why, /^no verdict: exec\/exec-codex\/high: quota \(You've hit your usage limit/);
  assert.match(r.why, /; exec\/exec-codex-mini\/high: no DEFECT or VALID line/);
});

test('REQ-GATE-44 a failed approver is named with only the first 200 characters of its output, on one line', () => {
  const noisy = approver('exec-codex', `require('fs').readFileSync(0); console.error('boom\\n' + 'x'.repeat(300)); process.exit(1);`);
  const { stage } = editGate(noisy);
  assert.equal(stage.problems[0].why, `no approval: exec/exec-codex/high: error (boom ${'x'.repeat(195)})`);
});
