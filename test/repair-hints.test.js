import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { failureSummary, gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo } from './helpers.js';

const card = (header = 'kind: bug\nsize: S') => parseCard(`# T-1: test card\n${header}\n`);
const summary = (dir, base, c = card(), config = fixtureConfig()) => failureSummary(gate({ repo: dir, base, card: c, config }), 4000);

test('REQ-RUN-19 a changed existing test gets a repair line: restore it from base, test in a new file, or block naming allowEdits', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...FIXED_SRC, 'test/basic.test.js': "import assert from 'node:assert';\nassert.ok(2);\n" });
  const text = summary(dir, base);
  assert.match(text, new RegExp(`Fix: restore test/basic\\.test\\.js with \`git checkout ${base} -- test/basic\\.test\\.js\``));
  assert.match(text, /new test file/);
  assert.match(text, /KEEL_BLOCKED[^\n]*allowEdits: test\/basic\.test\.js/);
});

test('REQ-RUN-19 bypass, skip, scope, and red-proof failures each get their own repair line', () => {
  const bypass = fixtureRepo();
  commit(bypass.dir, { ...REGRESSION_TEST, 'src/add.js': '// eslint-disable-next-line\nexport const add = (a, b) => a + b;\n' });
  assert.match(summary(bypass.dir, bypass.base), /Fix: remove the marker at src\/add\.js:1 and fix what it hides/);

  const skip = fixtureRepo();
  commit(skip.dir, { ...FIXED_SRC, 'test/add.test.js': "import { test } from 'node:test';\ntest.skip('x', () => {});\n" });
  assert.match(summary(skip.dir, skip.base), /Fix: remove the skip or focus marker at test\/add\.test\.js:2/);

  const scope = fixtureRepo();
  commit(scope.dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'other.js': 'x\n' });
  assert.match(summary(scope.dir, scope.base, card('kind: bug\nsize: S\npaths: src/**, test/**')), /Fix: undo the change to other\.js/);

  const weak = fixtureRepo();
  commit(weak.dir, { ...FIXED_SRC, 'test/trivial.test.js': "import assert from 'node:assert';\nassert.ok(1);\n" });
  assert.match(summary(weak.dir, weak.base), /Fix: the new test passes on the old code too/);
});

test('REQ-RUN-19 held-out failures stay withheld: no repair line can leak them', () => {
  const receipt = { results: [{ name: 'held-out', pass: false, problems: [{ rule: 'held-out-fails-on-head' }] }], base: 'abc' };
  const text = failureSummary(receipt, 4000);
  assert.match(text, /details withheld/);
  assert.ok(!/Fix:/.test(text));
});
