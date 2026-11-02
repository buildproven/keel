import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { readLedger } from '../src/ledger.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
// A Python test that fails on the fixture's buggy add and passes once it is fixed; a failure names the file.
const PY = "src = open('src/add.js').read()\nassert 'a + b' in src, 'add is wrong'\n";
let logFile;
let authorLog;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
  authorLog = join(tmp('keel-author-'), 'prompts.jsonl');
});

/** The builder fixes add and, as the card tells it, creates tests/test_x.py. */
const builder = {
  provider: 'exec',
  model: 'exec-good',
  effort: 'low',
  command: ['sh', '-c', `node ${JSON.stringify(FAKE)} good && mkdir -p tests && printf ${JSON.stringify(PY)} > tests/test_x.py`],
};

/**
 * An author that writes `tests/test_x.py`, the path the card names, unless its prompt forbids that path and `obeys`
 * is set; then it writes `tests/test_y.py`. It records each prompt.
 */
const author = (obeys) => ({
  provider: 'exec',
  model: 'exec-author',
  effort: 'high',
  command: [
    'node',
    '-e',
    `const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(authorLog)}, JSON.stringify(prompt) + '\\n');
const forbidden = /Do not write[^\\n]*tests\\/test_x\\.py/.test(prompt);
fs.mkdirSync('tests', { recursive: true });
fs.writeFileSync(${obeys} && forbidden ? 'tests/test_y.py' : 'tests/test_x.py', ${JSON.stringify(PY)});
console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
  ],
});

// Runs only single-letter test names, so the `test_heldout_` rename never fails on base as the authored test and Keel
// falls back to the original name (REQ-RUN-17), the fallback that brought the collision back on BUI-1779.
const HELD_CMD = 'for f in tests/test_?.py; do python3 "$f" || exit 1; done';
const card = () =>
  parseCard(
    '# T-62: fix add\nkind: bug\nsize: M\n\n## Requirements\n- REQ-ADD-1: add(a, b) shall return a + b. Create `tests/test_x.py` for it.\n',
  );
const prompts = () => readFileSync(authorLog, 'utf8').trim().split('\n').map(JSON.parse);
const builderCalls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);

test('REQ-RUN-62 a held-out test kept at a path the card names is authored again under another name before the attempt', () => {
  const { dir } = fixtureRepo();
  const lines = [];
  const config = fixtureConfig({ tiers: [builder, author(true)], heldOutAuthorTier: 1, heldOutCommand: HELD_CMD, maxAttempts: 1 });
  const r = run({ repo: dir, card: card(), config, log: (m) => lines.push(m) });
  const heldOut = r.receipt?.results.find((x) => x.name === 'held-out');
  assert.ok(heldOut, r.failure);
  assert.ok(!heldOut.problems.some((p) => p.rule === 'held-out-overwrite'), JSON.stringify(heldOut.problems));
  assert.equal(heldOut.pass, true, JSON.stringify(heldOut.problems));
  assert.equal(r.pass, true, r.failure);
  const [key] = readdirSync(join(process.env.KEEL_STATE_DIR, 'heldout')).filter((n) => !n.endsWith('.card-hash'));
  assert.deepEqual(readdirSync(join(process.env.KEEL_STATE_DIR, 'heldout', key, 'tests')), ['test_y.py']);
  const [first, second] = prompts();
  assert.ok(!first.includes('Do not write'), 'the first author prompt forbids nothing');
  assert.match(second, /Do not write[^\n]*tests\/test_x\.py/, 'the second author prompt names the forbidden path');
  const rename = lines.findIndex((m) => m.includes('tests/test_x.py') && /author/.test(m));
  assert.ok(rename >= 0, `the log names the colliding path:\n${lines.join('\n')}`);
  assert.equal(builderCalls().length, 1, 'one build attempt, after the held-out tests were authored again');
  assert.deepEqual(
    readLedger().map((row) => row.role ?? 'build'),
    ['held-out-author', 'held-out-author', 'build'],
  );
});

test('REQ-RUN-62 a collision that stays after one re-author stops held-out-author naming the path, before any build', () => {
  const { dir } = fixtureRepo();
  const config = fixtureConfig({ tiers: [builder, author(false)], heldOutAuthorTier: 1, heldOutCommand: HELD_CMD });
  const r = run({ repo: dir, card: card(), config });
  assert.equal(r.pass, false);
  assert.equal(r.stopped, 'held-out-author');
  assert.match(r.failure, /tests\/test_x\.py/);
  assert.equal(prompts().length, 2, 'the author runs once more, not again and again');
  assert.equal(builderCalls().length, 0, 'no build attempt, so no paid attempt');
  assert.equal(r.worktree, null);
  const state = join(process.env.KEEL_STATE_DIR, 'heldout');
  const hashes = existsSync(state) ? readdirSync(state).filter((n) => n.endsWith('.card-hash')) : [];
  assert.deepEqual(hashes, [], 'colliding tests are never kept for a retry to reuse (REQ-RUN-63)');
});
