import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { failingTests } from '../src/gate.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = (name) => ({ provider: 'exec', model: name, effort: 'low', command: ['node', FAKE, 'good'] });
const judge = (mode) => ({ provider: 'exec', family: 'judge', model: 'exec-judge', effort: 'high', command: ['node', FAKE, mode] });
const REASON = 'it asserts add(1,1) is 3';
const PRIVATE = 'PRIVATE-HELD-OUT-MARKER';
let logFile;
let authorLog;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
  authorLog = join(tmp('keel-author-'), 'prompts.jsonl');
});

// A defective held-out test: no build can pass it. It prints the same failing test name every run, unless `vary`.
const bad = (vary = false) =>
  [
    "import { add } from '../src/add.js';",
    'if (add(1, 1) !== 3) {',
    `  console.log(${vary ? '`not ok 1 - REQ-ADD-1 case ${Math.random()}`' : "'not ok 1 - REQ-ADD-1 adds one and one'"});`,
    `  console.log('${PRIVATE}');`,
    "  throw new Error('held-out failed');",
    '}',
    '',
  ].join('\n');
const GOOD = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n";

/** The author tier: writes the defective test, or `fixed` once the prompt names the defect reason. */
const author = (badBody, fixed = GOOD) => ({
  provider: 'exec',
  model: 'exec-author',
  effort: 'high',
  command: [
    'node',
    '-e',
    `const fs = require('fs');
const p = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(authorLog)}, JSON.stringify(p) + '\\n');
fs.mkdirSync('test', { recursive: true });
fs.writeFileSync('test/held.test.js', p.includes(${JSON.stringify(REASON)}) ? ${JSON.stringify(fixed)} : ${JSON.stringify(badBody)});
console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
  ],
});

const card = (extra = '') =>
  parseCard(`# T-7: fix add\nkind: bug\nsize: M\n${extra}\n## Requirements\n- REQ-ADD-1: add(a, b) shall return a + b.\n`);
const config = (judgeMode, { badBody = bad(), fixed = GOOD, ...over } = {}) =>
  fixtureConfig({
    tiers: [builder('b0'), builder('b1'), builder('b2'), builder('b3'), author(badBody, fixed), judge(judgeMode)],
    heldOutAuthorTier: 4,
    maxAttempts: 3,
    ...over,
  });
const calls = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const isBuild = (c) => c.prompt.startsWith('You are the builder');
const builderCalls = () => calls().filter(isBuild);
// A judge that gives no answer hands the question to the fallbacks (REQ-GATE-22), the builder tiers too.
const judgeCalls = () => calls().filter((c) => !isBuild(c));
const authorPrompts = () =>
  existsSync(authorLog)
    ? readFileSync(authorLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const attemptRows = () => readLedger().filter((r) => r.role === undefined);

test('REQ-RUN-46 two attempts with the same held-out failing test trigger one defect check, and no third escalation happens before it', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config(`say:VALID: the build misses it`, { maxAttempts: 4 }) });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'max-attempts');
  const order = calls().map((c) => (isBuild(c) ? c.env.model : `judge:${c.env.model}`));
  // After VALID, the same failure on b2 and b3 asks nothing again: one check per held-out set.
  assert.deepEqual(
    order,
    ['b0', 'b1', 'judge:exec-judge', 'b2', 'b3'],
    'the check comes after the second failure and before the third tier',
  );
  const [ask] = judgeCalls();
  assert.match(ask.prompt, /DEFECT: <why>/);
  assert.match(ask.prompt, /REQ-ADD-1: add\(a, b\) shall return a \+ b/, 'the card text');
  assert.ok(ask.prompt.includes('if (add(1, 1) !== 3)'), 'the held-out test file');
  assert.ok(ask.prompt.includes(PRIVATE), 'the private held-out output');
  const rows = attemptRows();
  assert.deepEqual(rows[1].heldOutValid, { by: 'exec/exec-judge/high', reason: 'the build misses it' });
  assert.equal(rows[1].reviewCost, 0.01, 'the check spend counts toward the card');
  assert.equal(authorPrompts().length, 1, 'a VALID answer re-authors nothing');
});

test('REQ-RUN-46 a DEFECT answer re-authors held-out tests, records heldOutDefect, and the next attempt runs on the same tier', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config(`say:DEFECT: ${REASON}`) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.attempt, 3);
  assert.equal(r.tier, 1, 'the attempt after the defect runs on the same tier');
  assert.equal(judgeCalls().length, 1);
  const prompts = authorPrompts();
  assert.equal(prompts.length, 2, 'authored once, then re-authored');
  assert.ok(prompts[1].includes(REASON), 'the re-author prompt names the defect');
  assert.ok(!prompts[0].includes(REASON));
  const rows = attemptRows();
  assert.deepEqual(rows[1].heldOutDefect, { by: 'exec/exec-judge/high', reason: REASON });
  assert.equal(rows[2].tier, 1);
  assert.equal(readLedger().filter((x) => x.role === 'held-out-author').length, 2);
  for (const c of builderCalls()) {
    assert.ok(!c.prompt.includes(PRIVATE), 'the builder never sees the held-out output');
    assert.ok(!c.prompt.includes(REASON), 'the builder never sees the defect reason, which describes the tests');
  }
});

test('REQ-RUN-46 a VALID answer or no answer escalates as before, and the builder prompt never contains the held-out output', () => {
  for (const mode of ['say:VALID: the build misses it', 'crash']) {
    process.env.KEEL_STATE_DIR = tmp('keel-state-');
    const { dir } = fixtureRepo();
    const r = run({ repo: dir, card: card(), config: config(mode) });
    assert.equal(r.stopped, 'max-attempts', mode);
    assert.deepEqual(
      attemptRows().map((x) => x.tier),
      [0, 1, 2],
      `${mode}: escalates`,
    );
    assert.ok(attemptRows().every((x) => !x.heldOutDefect));
    const builders = builderCalls().slice(-3);
    assert.equal(builders.length, 3);
    assert.ok(judgeCalls().length > 0, `${mode}: the defect check ran`);
    for (const c of builders) {
      assert.ok(!c.prompt.includes(PRIVATE), `${mode}: the builder never sees the held-out output`);
      assert.ok(!c.prompt.includes('not ok 1'), `${mode}: nor the failing test name`);
    }
  }
});

test('REQ-RUN-46 no defect check when the failing test names differ between the two attempts', () => {
  const { dir } = fixtureRepo();
  const r = run({ repo: dir, card: card(), config: config(`say:DEFECT: ${REASON}`, { badBody: bad(true) }) });
  assert.equal(r.stopped, 'max-attempts');
  assert.equal(judgeCalls().length, 0);
  assert.deepEqual(
    attemptRows().map((x) => x.tier),
    [0, 1, 2],
  );
});

test('REQ-RUN-46 failing test names come from the usual runner formats; headers and timings are not names', () => {
  const out = [
    'FAILED tests/test_preview.py::test_score - AssertionError: assert False',
    'FAIL: test_strip (tests.test_x.Preview)',
    'not ok 3 - REQ-X-1 shows the score # time=12ms',
    '--- FAIL: TestPreview (0.01s)',
    '✖ failing tests:',
    '✖ REQ-X-2 waits for the list (1503.2ms)',
    '  ✘  1 [chromium] › quality.spec.ts:12:5 › opens the list (5.0s)',
    'ok 4 - REQ-X-3 passes',
    '✔ REQ-X-4 passes (1ms)',
  ].join('\n');
  assert.deepEqual(failingTests(out).sort(), [
    '1 [chromium] › quality.spec.ts:12:5 › opens the list',
    'REQ-X-1 shows the score',
    'REQ-X-2 waits for the list',
    'TestPreview',
    'test_strip (tests.test_x.Preview)',
    'tests/test_preview.py::test_score',
  ]);
  assert.deepEqual(failingTests(''), []);
});

test('REQ-RUN-46 re-authored tests that pass on base are not kept: the old set stays and the run escalates', () => {
  const { dir } = fixtureRepo();
  const weak = "import assert from 'node:assert';\nassert.ok(true);\n";
  const r = run({ repo: dir, card: card(), config: config(`say:DEFECT: ${REASON}`, { fixed: weak }) });
  assert.equal(r.stopped, 'max-attempts');
  assert.equal(authorPrompts().length, 2);
  const rows = attemptRows();
  assert.deepEqual(rows[1].heldOutDefect, { by: 'exec/exec-judge/high', reason: REASON, replaced: false });
  assert.deepEqual(
    rows.map((x) => x.tier),
    [0, 1, 2],
  );
  const heldDir = join(process.env.KEEL_STATE_DIR, 'heldout');
  const [key] = readdirSync(heldDir);
  assert.ok(readFileSync(join(heldDir, key, 'test', 'heldout_held.test.js'), 'utf8').includes('!== 3'), 'the old set stays');
});

test("REQ-RUN-46 card-named held-out tests: no check without an author tier; with one, new tests go to Keel's dir, never the card's", () => {
  const held = tmp('keel-held-');
  mkdirSync(join(held, 'test'));
  writeFileSync(join(held, 'test', 'held.test.js'), bad());
  const off = run({
    repo: fixtureRepo().dir,
    card: card(`heldOut: ${held}\n`),
    config: config(`say:DEFECT: ${REASON}`, { heldOutAuthorTier: null }),
  });
  assert.equal(off.stopped, 'max-attempts');
  assert.equal(judgeCalls().length, 0, 'nothing could re-author, so nothing is asked');

  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  const on = run({ repo: fixtureRepo().dir, card: card(`heldOut: ${held}\n`), config: config(`say:DEFECT: ${REASON}`) });
  assert.equal(on.pass, true, on.failure);
  assert.equal(on.tier, 1);
  assert.equal(readFileSync(join(held, 'test', 'held.test.js'), 'utf8'), bad(), "the card's own tests are untouched");
});
