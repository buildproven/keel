import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, parseCard } from '../src/config.js';
import { failureSummary, gate } from '../src/gate.js';
import { BUGGY, FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = (kind = 'bug') => parseCard(`# T-1: test card\nkind: ${kind}\nsize: S\n`);
const names = (receipt) => receipt.results.map((r) => r.name);

// A one-operator mutation tester: swap `a + b` for `a * b` in each changed file, run the tests, restore the file.
// It records the KEEL_CHANGED_FILES it was given and fails when a mutant survives.
const MUTATE = `import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const files = process.env.KEEL_CHANGED_FILES.split('\\n').filter(Boolean);
writeFileSync(process.argv[2], files.join('\\n'));
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  if (!src.includes('a + b')) continue;
  writeFileSync(f, src.replace('a + b', 'a * b'));
  let survived = true;
  try { execSync(${JSON.stringify(FIXTURE_TEST)}, { stdio: 'ignore' }); } catch { survived = false; }
  writeFileSync(f, src);
  if (survived) { console.log('survived: ' + f + ': a + b -> a * b'); process.exit(1); }
}
`;
const WEAK_TEST = {
  'test/add.test.js': "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(2, 2), 4);\n",
};

function mutationRepo() {
  const seen = join(tmp('keel-mut-'), 'files');
  const { dir, base } = fixtureRepo({ ...BUGGY, 'mutate.js': MUTATE });
  return { dir, base, seen, config: fixtureConfig({ mutation: `node mutate.js ${seen}` }) };
}

test('REQ-GATE-20 a weak test passes the red proof but a surviving mutant fails the gate, with the survivor fed back', () => {
  const { dir, base, seen, config } = mutationRepo();
  commit(dir, { ...WEAK_TEST, ...FIXED_SRC });
  const receipt = gate({ repo: dir, base, card: card(), config });
  assert.equal(receipt.pass, false);
  assert.equal(receipt.results.find((r) => r.name === 'red-proof').pass, true, 'red proof alone accepts the weak test');
  const stage = receipt.results.find((r) => r.name === 'mutation');
  assert.equal(stage.pass, false);
  assert.match(stage.output, /survived: src\/add\.js/);
  assert.equal(readFileSync(seen, 'utf8'), 'src/add.js', 'only changed non-test files are mutated');
  assert.match(failureSummary(receipt, 4000), /## mutation[\s\S]*survived: src\/add\.js/);
});

test('REQ-GATE-20 a strong test kills the mutant and the gate passes with a mutation stage last', () => {
  const { dir, base, config } = mutationRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const receipt = gate({ repo: dir, base, card: card('feature'), config });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
  assert.equal(names(receipt).at(-1), 'mutation');
});

test('REQ-GATE-20 no mutation stage for kinds without red proof or when mutation is not configured', () => {
  const { dir, base, config } = mutationRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  assert.ok(!names(gate({ repo: dir, base, card: card('chore'), config })).includes('mutation'));
  assert.ok(!names(gate({ repo: dir, base, card: card(), config: fixtureConfig() })).includes('mutation'));
});

test('REQ-GATE-20 REQ-CFG-1 mutation defaults to none and must be a non-empty command string', () => {
  assert.equal(DEFAULTS.mutation, null);
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  for (const bad of ['', '  ', ['x'], 5]) assert.throws(() => loadConfig(dir, at({ mutation: bad })), /mutation/);
  assert.equal(loadConfig(dir, at({ mutation: 'npx stryker run' })).mutation, 'npx stryker run');
});
