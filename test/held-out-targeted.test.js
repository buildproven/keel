import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig, parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { BUGGY, FIXED_SRC, REGRESSION_TEST, commit, fixtureRepo, tmp, write } from './helpers.js';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const heldCard = (dir) => parseCard(`# T-HELD: targeted held-out tests\nkind: bug\nsize: M\nheldOut: ${dir}\n`);
const rules = (receipt) => receipt.results.flatMap((result) => result.problems.map((problem) => problem.rule));
const heldTest = (expected = 2) =>
  `import assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\nassert.equal(add(1, 1), ${expected});\n`;

function commands(log, heldPath = 'test/held out.test.js', inconclusiveOnBase = false) {
  const record = quote(log);
  const whole = `for f in test/*.js; do echo "WHOLE:$PWD:$f" >> ${record}; node "$f" || exit 1; done`;
  const baseExit = inconclusiveOnBase
    ? `for f in "$@"; do if [ "$f" = ${quote(heldPath)} ] && grep -q 'a - b' src/add.js; then exit 127; fi; done; `
    : '';
  const targeted = `set -- {files}; for f in "$@"; do echo "TARGET:$PWD:$f" >> ${record}; done; ${baseExit}for f in "$@"; do node "$f" || exit 1; done`;
  return { whole, targeted };
}

function setup({ explicit = false, inconclusiveOnBase = false } = {}) {
  const log = `${tmp('keel-held-log-')}/runs.log`;
  const held = tmp('keel-held-');
  const heldPath = inconclusiveOnBase ? 'test/held.test.js' : 'test/held out.test.js';
  write(held, { [heldPath]: heldTest() });
  const { whole, targeted } = commands(log, heldPath, inconclusiveOnBase);
  const policy = {
    checks: { test: whole },
    testCommand: whole,
    testFilesCommand: targeted,
    review: false,
    ...(explicit ? { heldOutCommand: whole } : {}),
  };
  const { dir, base } = fixtureRepo({ ...BUGGY, 'keel.json': `${JSON.stringify(policy)}\n` });
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  return { dir, base, held, heldPath, log, config: loadConfig(dir, base) };
}

const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []);

test('REQ-GATE-10 omitted heldOutCommand targets only the quoted held-out files on head and base', () => {
  const fixture = setup();
  const receipt = gate({ repo: fixture.dir, base: fixture.base, card: heldCard(fixture.held), config: fixture.config });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));

  const ran = lines(fixture.log);
  const targetedHeld = ran.filter((line) => line.endsWith(`:${fixture.heldPath}`) && line.startsWith('TARGET:'));
  assert.equal(targetedHeld.length, 2, ran.join('\n'));
  assert.equal(
    new Set(targetedHeld.map((line) => line.slice(0, -fixture.heldPath.length))).size,
    2,
    'head and base use separate checkouts',
  );
  assert.ok(!ran.some((line) => line.startsWith('WHOLE:') && line.endsWith(`:${fixture.heldPath}`)), ran.join('\n'));
});

test('REQ-GATE-10 explicit heldOutCommand keeps running the whole command', () => {
  const fixture = setup({ explicit: true });
  const receipt = gate({ repo: fixture.dir, base: fixture.base, card: heldCard(fixture.held), config: fixture.config });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));

  const ran = lines(fixture.log);
  const wholeHeld = ran.filter((line) => line.startsWith('WHOLE:') && line.endsWith(`:${fixture.heldPath}`));
  assert.equal(wholeHeld.length, 2, ran.join('\n'));
  assert.ok(!ran.some((line) => line.startsWith('TARGET:') && line.endsWith(`:${fixture.heldPath}`)), ran.join('\n'));
});

test('REQ-GATE-10 an inconclusive targeted base run remains held-out-not-executed', () => {
  const fixture = setup({ inconclusiveOnBase: true });
  const receipt = gate({ repo: fixture.dir, base: fixture.base, card: heldCard(fixture.held), config: fixture.config });
  assert.deepEqual(rules(receipt), ['held-out-not-executed']);
});
