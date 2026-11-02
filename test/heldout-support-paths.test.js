import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { collisions, run, unmarkedSupport } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
let logFile;
let authorLog;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  logFile = join(tmp('keel-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = logFile;
  authorLog = join(tmp('keel-author-'), 'prompts.jsonl');
});

/** The builder fixes add and writes its own fixture at the obvious path, as the builders of BUI-1794 and BUI-1797 did. */
const builder = {
  provider: 'exec',
  model: 'exec-good',
  effort: 'low',
  command: ['sh', '-c', `node ${JSON.stringify(FAKE)} good && mkdir -p tests/fixtures && printf builder > tests/fixtures/add.txt`],
};

/**
 * An author whose test reads a fixture. It puts the fixture at `tests/fixtures/add.txt` unless its prompt matches
 * `obeyWhen` (a RegExp source, or null for never); then it uses `tests/fixtures/heldout-add/add.txt`.
 */
const author = (obeyWhen) => ({
  provider: 'exec',
  model: 'exec-author',
  effort: 'high',
  command: [
    'node',
    '-e',
    `const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(authorLog)}, JSON.stringify(prompt) + '\\n');
const when = ${JSON.stringify(obeyWhen)};
const dir = when !== null && new RegExp(when).test(prompt) ? 'tests/fixtures/heldout-add' : 'tests/fixtures';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/add.txt', 'a + b');
fs.writeFileSync('tests/test_add.py', "want = open('" + dir + "/add.txt').read()\\nassert want in open('src/add.js').read(), 'add is wrong'\\n");
console.log(JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
  ],
});

const HELD_CMD = 'for f in tests/test_*.py; do python3 "$f" || exit 1; done';
const card = () => parseCard('# T-66: fix add\nkind: bug\nsize: M\n\n## Requirements\n- REQ-ADD-1: add(a, b) shall return a + b.\n');
const prompts = () => readFileSync(authorLog, 'utf8').trim().split('\n').map(JSON.parse);
const builderCalls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);

test('REQ-RUN-66 unmarkedSupport flags a support file with no heldout segment, never a test file', () => {
  assert.equal(unmarkedSupport('tests/mcp/fixtures/offer-stage/acme.htm'), true);
  assert.equal(unmarkedSupport('tests/conftest.py'), true);
  assert.equal(unmarkedSupport('tests/mcp/fixtures/heldout-dossier/acme.htm'), false);
  assert.equal(unmarkedSupport('tests/heldout_helpers.ts'), false);
  assert.equal(unmarkedSupport('tests/HeldOut/data.json'), false, 'the prefix check ignores case');
  assert.equal(unmarkedSupport('tests/mcp/heldout_offer-stage.test.ts'), false);
  assert.equal(unmarkedSupport('tests/test_add.py'), false, 'a test file is renamed by heldOutName instead');
  assert.equal(unmarkedSupport('tests/fixtures/notheldout/a.txt'), true, 'only a segment that starts with heldout counts');
  for (const name of [
    'spec/add_spec.rb',
    'src/test/java/AddTest.java',
    'src/test/java/AddTests.java',
    'src/AddTest.kt',
    'Tests/AddTest.cs',
  ])
    assert.equal(unmarkedSupport(name), false, `${name} is a test file a runner finds by name`);
  assert.deepEqual(collisions(card(), ['tests/test_heldout_add.py', 'tests/fixtures/add.txt']), ['tests/fixtures/add.txt']);
});

test('REQ-RUN-66 the author prompt tells it to put support files under a heldout path', () => {
  const { dir } = fixtureRepo();
  const config = fixtureConfig({ tiers: [builder, author('heldout')], heldOutAuthorTier: 1, heldOutCommand: HELD_CMD, maxAttempts: 1 });
  run({ repo: dir, card: card(), config });
  assert.match(prompts()[0], /support file[^\n]*heldout/);
});

test('REQ-RUN-66 an unmarked fixture is authored again under a heldout path, so the builder fixture does not block the gate', () => {
  const { dir } = fixtureRepo();
  const lines = [];
  // The first prompt already names heldout, so an obedient author never collides; this author obeys only once forbidden.
  const stubborn = author('Do not write[^\\n]*tests/fixtures/add\\.txt');
  const config = fixtureConfig({ tiers: [builder, stubborn], heldOutAuthorTier: 1, heldOutCommand: HELD_CMD, maxAttempts: 1 });
  const r = run({ repo: dir, card: card(), config, log: (m) => lines.push(m) });
  const heldOut = r.receipt?.results.find((x) => x.name === 'held-out');
  assert.ok(heldOut, r.failure);
  assert.ok(!heldOut.problems.some((p) => p.rule === 'held-out-overwrite'), JSON.stringify(heldOut.problems));
  assert.equal(r.pass, true, r.failure);
  assert.equal(prompts().length, 2);
  assert.ok(
    lines.some((m) => m.includes('tests/fixtures/add.txt') && /author/.test(m)),
    lines.join('\n'),
  );
  const [key] = readdirSync(join(process.env.KEEL_STATE_DIR, 'heldout')).filter((n) => !n.endsWith('.card-hash'));
  assert.ok(existsSync(join(process.env.KEEL_STATE_DIR, 'heldout', key, 'tests/fixtures/heldout-add/add.txt')));
  assert.equal(builderCalls().length, 1);
});

test('REQ-RUN-66 an author that keeps an unmarked fixture twice stops held-out-author before any build', () => {
  const { dir } = fixtureRepo();
  const config = fixtureConfig({ tiers: [builder, author(null)], heldOutAuthorTier: 1, heldOutCommand: HELD_CMD });
  const r = run({ repo: dir, card: card(), config });
  assert.equal(r.stopped, 'held-out-author');
  assert.match(r.failure, /tests\/fixtures\/add\.txt/);
  assert.equal(builderCalls().length, 0);
});
