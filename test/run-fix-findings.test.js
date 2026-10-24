import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { loadConfig, parseCard } from '../src/config.js';
import { escapedDefects } from '../src/escaped.js';
import { appendAttempt, formatReport, readLedger, report } from '../src/ledger.js';
import { learnedStart, run } from '../src/run.js';
import { parseFindings } from '../src/review.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp, unlockDir } from './helpers.js';

// A scripted builder: each call takes the next behaviour from a JSON list, prints a session id `s<call>` and its reply.
const BUILDER = `
const fs = require('fs');
const [script, log, state] = process.argv.slice(2);
const n = fs.existsSync(script + '.n') ? Number(fs.readFileSync(script + '.n', 'utf8')) : 0;
fs.writeFileSync(script + '.n', String(n + 1));
const mode = JSON.parse(fs.readFileSync(script, 'utf8'))[n];
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(log, JSON.stringify({ mode, prompt, resume: process.env.KEEL_RESUME }) + '\\n');
let reply = 'done';
if (mode === 'good' || mode === 'good-nosession') {
  fs.writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n');
  fs.mkdirSync('test', { recursive: true });
  fs.writeFileSync('test/add.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n");
}
if (mode === 'improve' || mode === 'lock-receipts')
  fs.writeFileSync('test/add-neg.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(-1, -1), -2);\\n");
if (mode === 'lock-receipts') {
  // A mode does not stop root: there the dir is made immutable too (unlockDir undoes both).
  fs.chmodSync(state + '/receipts', 0o500);
  if (process.getuid?.() === 0) require('child_process').execFileSync('chattr', ['+i', state + '/receipts']);
}
if (mode === 'wander') {
  fs.writeFileSync('src/extra.js', 'export const x = 1;\\n');
  require('child_process').execSync('git add -A && git commit -q -m unverified && git checkout -q -b wander');
  process.exit(3);
}
if (mode === 'lock-index') {
  const gitdir = fs.readFileSync('.git', 'utf8').replace('gitdir:', '').trim();
  fs.writeFileSync(gitdir + '/index.lock', '');
  process.exit(3);
}
if (mode === 'break') fs.writeFileSync('src/add.js', 'export const add = (a, b) => a * b;\\n');
if (mode === 'blocked') fs.writeFileSync('KEEL_BLOCKED', 'cannot\\n');
if (mode === 'dismiss') reply = 'KEEL_DISMISS src/add.js:1 negative sums are covered by the sum rule';
console.log(reply);
const session = mode === 'good-nosession' ? {} : { session_id: 's' + (n + 1) };
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 }, ...session }));
`;
// A reviewer that gives the next reply from a JSON list on each call (the last one repeats).
const REVIEWER = `
const fs = require('fs');
const [script] = process.argv.slice(2);
fs.readFileSync(0);
const n = fs.existsSync(script + '.n') ? Number(fs.readFileSync(script + '.n', 'utf8')) : 0;
fs.writeFileSync(script + '.n', String(n + 1));
const replies = JSON.parse(fs.readFileSync(script, 'utf8'));
console.log(replies[Math.min(n, replies.length - 1)]);
`;

const LOW = 'FINDING low src/add.js:1 negative sums are not tested\nVERDICT: pass';
const CLEAN = 'VERDICT: pass';

let dir;
let logFile;
beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  dir = tmp('keel-scripts-');
  logFile = join(dir, 'calls.jsonl');
});

const file = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
const setup = (modes, replies, over = {}) => {
  const builderScript = file('builder.js', BUILDER);
  const reviewerScript = file('reviewer.js', REVIEWER);
  const modesFile = file('modes.json', JSON.stringify(modes));
  const repliesFile = file('replies.json', JSON.stringify(replies));
  return fixtureConfig({
    review: true,
    learnStart: false,
    tiers: [
      {
        provider: 'exec',
        family: 'claude',
        model: 'b',
        effort: 'high',
        command: ['node', builderScript, modesFile, logFile, process.env.KEEL_STATE_DIR],
      },
      { provider: 'exec', family: 'codex', model: 'r', effort: 'high', command: ['node', reviewerScript, repliesFile] },
    ],
    ...over,
  });
};
const calls = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const reviews = () => Number(readFileSync(join(dir, 'replies.json.n'), 'utf8'));
const card = (kind = 'bug') => parseCard(`# T-50: fix add\nkind: ${kind}\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n`);
const fixRows = () => readLedger().filter((r) => r.role === 'fix-findings');

test('REQ-RUN-36 a passing bug card with a low review note gets one corrective turn in the same session, then a re-gate', () => {
  const { dir: repo } = fixtureRepo();
  const lines = [];
  const r = run({ repo, card: card(), config: setup(['good', 'improve'], [LOW, CLEAN]), log: (l) => lines.push(l) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.tier, 0);
  assert.equal(r.attempt, 1);
  const [first, second] = calls();
  assert.equal(calls().length, 2);
  assert.equal(first.resume, undefined);
  assert.equal(second.resume, 's1', 'the turn continues the session of the attempt');
  assert.match(second.prompt, /- low src\/add\.js:1 negative sums are not tested/);
  assert.ok(
    second.prompt.includes(
      'Fix each one that is real, with a test where it is a behaviour; for one that is not real, reply why in KEEL_DISMISS lines (`KEEL_DISMISS <path>:<line> <reason>`) and change nothing for it.',
    ),
    second.prompt,
  );
  assert.equal(reviews(), 2, 'the new head is gated again');
  assert.equal(r.receipt.head, g(r.worktree, 'rev-parse', 'HEAD'));
  assert.ok(g(r.worktree, 'ls-files', 'test/add-neg.test.js'), 'the fix is on the accepted head');
  assert.deepEqual(r.followUps, [], 'the fixed note is no follow-up');
  const [row] = fixRows();
  assert.equal(row.outcome, 'fixed');
  assert.equal(row.cost, 0.02);
  assert.equal(row.tier, 0);
  assert.equal(row.continued, true);
  assert.equal(row.notes, 1);
  assert.equal(row.head, r.receipt.head);
  assert.ok(
    lines.some((l) => /one corrective turn on 1 review note/.test(l)),
    lines.join('\n'),
  );
});

test('REQ-RUN-36 a note still reported after the turn becomes a follow-up as before', () => {
  const { dir: repo } = fixtureRepo();
  const r = run({ repo, card: card('feature'), config: setup(['good', 'improve'], [LOW, LOW]) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(calls().length, 2, 'one turn only');
  assert.deepEqual(r.followUps, [{ kind: 'bug', title: 'Review: negative sums are not tested', detail: 'low src/add.js:1' }]);
});

test('REQ-RUN-36 chore cards, fixLowFindings false, a review without notes, and no session to continue get no corrective turn', () => {
  for (const [kind, over, replies, first = 'good'] of [
    ['chore', {}, [LOW]],
    ['bug', { fixLowFindings: false }, [LOW]],
    ['bug', {}, [CLEAN]],
    ['bug', {}, [LOW], 'good-nosession'],
  ]) {
    process.env.KEEL_STATE_DIR = tmp('keel-state-');
    dir = tmp('keel-scripts-');
    logFile = join(dir, 'calls.jsonl');
    const { dir: repo } = fixtureRepo();
    const r = run({ repo, card: card(kind), config: setup([first, 'improve'], replies, over) });
    assert.equal(r.pass, true, `${kind} ${JSON.stringify(over)}: ${r.failure}`);
    assert.equal(calls().length, 1, `${kind} ${JSON.stringify(over)}`);
    assert.equal(fixRows().length, 0);
  }
});

test('REQ-RUN-36 fixLowFindings is on by default and must be a boolean', () => {
  const { dir: repo } = fixtureRepo();
  commit(repo, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true' }) }, 'cfg');
  assert.equal(loadConfig(repo, 'HEAD').fixLowFindings, true);
  commit(repo, { 'keel.json': JSON.stringify({ checks: { t: 'true' }, testCommand: 'true', fixLowFindings: 'yes' }) }, 'cfg2');
  assert.throws(() => loadConfig(repo, 'HEAD'), /"fixLowFindings" must be true or false/);
});

test('REQ-RUN-36 a turn that dismisses and changes nothing is not gated again; the dismissal is recorded', () => {
  const { dir: repo } = fixtureRepo();
  const r = run({ repo, card: card(), config: setup(['good', 'dismiss'], [LOW, CLEAN]) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(reviews(), 1, 'no re-gate of an unchanged head');
  const [row] = fixRows();
  assert.equal(row.outcome, 'unchanged');
  assert.deepEqual(row.dismissed, [{ path: 'src/add.js', line: 1, reason: 'negative sums are covered by the sum rule' }]);
  assert.equal(r.followUps.length, 1, 'the note stands as a follow-up');
});

test('REQ-RUN-37 a turn that breaks the gate falls back to the earlier passing head', () => {
  const { dir: repo } = fixtureRepo();
  const lines = [];
  const r = run({ repo, card: card(), config: setup(['good', 'break'], [LOW, CLEAN]), log: (l) => lines.push(l) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.attempt, 1);
  assert.equal(r.tier, 0);
  const passed = readLedger().find((x) => x.card === 'T-50' && x.attempt === 1 && !x.role).head;
  assert.equal(r.receipt.head, passed);
  assert.equal(g(r.worktree, 'rev-parse', 'HEAD'), passed, 'the branch is back at the passing head');
  assert.equal(g(r.worktree, 'status', '--porcelain'), '');
  assert.match(readFileSync(join(r.worktree, 'src/add.js'), 'utf8'), /a \+ b/);
  assert.equal(fixRows()[0].outcome, 'reverted');
  assert.deepEqual(r.followUps, [{ kind: 'bug', title: 'Review: negative sums are not tested', detail: 'low src/add.js:1' }]);
  assert.ok(
    lines.some((l) => /back to the passing head/.test(l)),
    lines.join('\n'),
  );
});

test('REQ-RUN-37 a turn that blocks falls back to the passing head and leaves no KEEL_BLOCKED', () => {
  const { dir: repo } = fixtureRepo();
  const r = run({ repo, card: card(), config: setup(['good', 'blocked'], [LOW]) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(existsSync(join(r.worktree, 'KEEL_BLOCKED')), false);
  assert.equal(g(r.worktree, 'rev-parse', 'HEAD'), r.receipt.head);
  assert.equal(fixRows()[0].outcome, 'reverted');
});

test('REQ-RUN-38 keel report shows findings turns and their cost, not as attempts; learned routing ignores them', () => {
  const base = { run: 'r1', card: 'T-1', repo: '/x', tier: 0, provider: 'exec', model: 'b', effort: 'high', durationMs: 1 };
  const rows = [
    { ...base, attempt: 1, cost: 0.5, usage: null, attemptPass: true },
    { ...base, attempt: 1, role: 'fix-findings', outcome: 'fixed', cost: 0.1, reviewCost: 0.05, usage: null, attemptPass: true },
    { ...base, run: 'r2', attempt: 1, cost: 0.5, usage: null, attemptPass: true },
    { ...base, run: 'r2', attempt: 1, role: 'fix-findings', outcome: 'reverted', cost: 0.2, usage: null },
  ];
  const s = report(rows);
  assert.equal(s.cards[0].attempts, 1);
  assert.match(formatReport(s), /findings turns: 2 \(fixed 1, unchanged 0, reverted 1\); cost \$0\.35/);
  assert.doesNotMatch(formatReport(report(rows.filter((x) => !x.role))), /findings turns/);
  const config = {
    learnStart: true,
    tiers: [
      { provider: 'exec', model: 'b', effort: 'high' },
      { provider: 'exec', model: 'c', effort: 'high' },
    ],
  };
  const only = (r) => learnedStart(r, '/x', 0, config);
  assert.deepEqual(only(rows), only(rows.filter((x) => !x.role)));
  appendAttempt({ ...rows[1], workerStatus: 'ok', gatePass: true });
  assert.equal(readLedger()[0].role, 'fix-findings');
});

test('REQ-GATE-41 an info finding with a path and line parses as a note and reaches the corrective turn', () => {
  assert.deepEqual(parseFindings('FINDING info src/a.js:2 could leak a handle', ['src/a.js']), [
    { severity: 'info', path: 'src/a.js', line: 2, text: 'could leak a handle' },
  ]);
  const { dir: repo } = fixtureRepo();
  const info = 'FINDING info src/add.js:1 negative sums are not tested\nVERDICT: pass';
  const r = run({ repo, card: card(), config: setup(['good', 'improve'], [info, CLEAN], { reviewBlock: 'low' }) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(calls().length, 2);
  assert.match(calls()[1].prompt, /- info src\/add\.js:1 negative sums/);
});

test('REQ-RUN-37 an error during the turn (here the re-gate cannot write its receipt) falls back to the passing head', () => {
  const { dir: repo } = fixtureRepo();
  const receipts = join(process.env.KEEL_STATE_DIR, 'receipts');
  try {
    const r = run({ repo, card: card(), config: setup(['good', 'lock-receipts'], [LOW, CLEAN]) });
    assert.equal(r.pass, true, r.failure);
    assert.equal(g(r.worktree, 'rev-parse', 'HEAD'), r.receipt.head);
    assert.equal(g(r.worktree, 'ls-files', 'test/add-neg.test.js'), '', 'the unverified fix is gone');
    const [row] = fixRows();
    assert.equal(row.outcome, 'reverted');
    assert.match(row.error, /EACCES|EPERM|permission|not permitted/i); // EPERM: the immutable flag under root
  } finally {
    unlockDir(receipts);
  }
});

test('REQ-RUN-38 keel report --escaped counts a run at its last passing row, the head a findings turn accepted', () => {
  const row = { run: 'r1', card: 'T-1', repo: '/nowhere/keel-repo', base: 'a'.repeat(40), attemptPass: true };
  const rows = [
    { ...row, head: 'b'.repeat(40), at: '2026-10-14T00:00:00Z' },
    { ...row, head: 'c'.repeat(40), role: 'fix-findings', at: '2026-10-14T00:01:00Z' },
  ];
  assert.equal(escapedDefects(rows).notFound.length, 1, 'one run, not one per head');
});

test('REQ-RUN-37 a turn that commits, switches branch, and crashes leaves the other branch alone and the card branch at the passing head', () => {
  const { dir: repo } = fixtureRepo();
  const r = run({ repo, card: card(), config: setup(['good', 'wander'], [LOW, CLEAN]) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(g(r.worktree, 'symbolic-ref', '--short', 'HEAD'), 'keel/T-50');
  assert.equal(g(r.worktree, 'rev-parse', 'keel/T-50'), r.receipt.head);
  assert.notEqual(g(r.worktree, 'rev-parse', 'wander'), r.receipt.head, 'the reset did not move the branch the worker made');
  assert.equal(fixRows()[0].outcome, 'reverted');
});

test('REQ-RUN-37 a restore that fails throws after the turn is recorded', () => {
  const { dir: repo } = fixtureRepo();
  assert.throws(() => run({ repo, card: card(), config: setup(['good', 'lock-index'], [LOW]) }), /index\.lock/);
  const [row] = fixRows();
  assert.equal(row.outcome, 'restore-failed');
  assert.match(row.error, /^restore: .*index\.lock/s);
});

test('REQ-RUN-38 keel report names findings turns whose restore failed, so the breakdown adds up', () => {
  const row = { run: 'r1', card: 'T-1', repo: '/x', tier: 0, attempt: 1, durationMs: 1, usage: null, role: 'fix-findings', cost: 0.1 };
  const text = formatReport(
    report([
      { ...row, outcome: 'fixed' },
      { ...row, outcome: 'restore-failed' },
    ]),
  );
  assert.match(text, /findings turns: 2 \(fixed 1, unchanged 0, reverted 0, restore failed 1\); cost \$0\.20/);
});
