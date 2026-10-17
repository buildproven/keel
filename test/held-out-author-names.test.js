import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { heldOutName, run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

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

test('REQ-RUN-17 authored tests keep a heldout_ name, so a builder test at the same path does not block the gate', () => {
  const { dir } = fixtureRepo();
  const same = author(HELD).command.map((c) => c.replaceAll('test/held.test.js', 'test/add.test.js'));
  const config = fixtureConfig({ tiers: [builder, { ...author(HELD), command: same }], heldOutAuthorTier: 1 });
  const r = run({ repo: dir, card: card(), config });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.receipt.results.find((x) => x.name === 'held-out').pass, true);
});

test('REQ-RUN-17 heldOutName keeps test-runner naming and falls back when the glob would not match', () => {
  const config = { testGlobs: ['**/*.test.ts', '**/test_*.py', 'tests/**'] };
  assert.equal(heldOutName('src/lib/__tests__/printful-order.test.ts', config), 'src/lib/__tests__/heldout_printful-order.test.ts');
  assert.equal(heldOutName('pkg/test_order.py', config), 'pkg/test_heldout_order.py');
  assert.equal(heldOutName('tests/order_test.rs', config), 'tests/heldout_order_test.rs');
  for (const support of ['tests/conftest.py', 'tests/__init__.py', 'test/helpers.js', 'tests/common/mod.rs'])
    assert.equal(heldOutName(support, config), support, 'support files keep their name so imports still resolve');
  assert.equal(heldOutName('src/order.spec.js', { testGlobs: ['**/order.spec.js'] }), 'src/order.spec.js');
});

test('REQ-RUN-17 authored tests keep their own name when the renamed tests no longer fail on base', () => {
  const { dir } = fixtureRepo();
  const cmd = 'node test/held.test.js'; // finds only the original name, so the renamed tests do not run
  const config = fixtureConfig({ tiers: [builder, author(HELD)], heldOutAuthorTier: 1, heldOutCommand: cmd });
  const r = run({ repo: dir, card: card(), config });
  assert.equal(r.pass, true, r.failure);
  const heldDir = join(process.env.KEEL_STATE_DIR, 'heldout');
  const [key] = readdirSync(heldDir);
  assert.deepEqual(readdirSync(join(heldDir, key, 'test')), ['held.test.js']);
});
