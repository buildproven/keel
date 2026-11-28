import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { gate } from '../src/gate.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

// Fixture sources are built from parts: a line that starts with a test call in this file would read as a test title
// (REQ-TRACE-1).
const src = (...lines) => `${lines.join('\n')}\n`;
const HEAD = ["import assert from 'node:assert';", "import { it } from 'node:test';", "import { render } from '../src/render.js';"];
const renders = (url) => src(...HEAD, "it('renders 2d', () => {", `  assert.strictEqual(render('${url}'), '2d');`, '});');
const FLAG = (on) => ({ 'src/flag.js': `export const flag = ${on};\n` });
const BASE = { ...FLAG(false), 'src/render.js': "export const render = () => '2d';\n", 'test/render.test.js': renders('/') };
// BUI-2048: 3D becomes the default at `/`; `?r=2d` still renders 2D. The new test is the card's regression test, red on
// base (REQ-GATE-3), so the edited test reaches test-edit-proof.
const THREE_D = {
  'src/render.js': "export const render = (url) => (url.includes('r=2d') ? '2d' : '3d');\n",
  'test/default.test.js': src(...HEAD, "it('renders 3d', () => {", "  assert.strictEqual(render('/'), '3d');", '});'),
};
// A change that does not touch render: it turns a flag on, with its own regression test.
const FLAG_ON = {
  ...FLAG(true),
  'test/flag.test.js': src(
    "import assert from 'node:assert';",
    "import { it } from 'node:test';",
    "import { flag } from '../src/flag.js';",
    "it('flag', () => {",
    '  assert.strictEqual(flag, true);',
    '});',
  ),
};
const EDITED = { 'test/render.test.js': renders('/?r=2d') };
const FILES_COMMAND = 'for f in {files}; do node "$f" || exit 1; done';
const card = {
  id: 'c1',
  kind: 'bug',
  size: 'S',
  paths: [],
  allowEdits: ['test/render.test.js'],
  approvedEdits: ['test/render.test.js'],
  acceptance: [],
  heldOut: null,
  text: '# c1\n\n- REQ-R-1: render shall default to 3d.\n',
};

/** A reviewer tier of the other family that approves the test edit and passes the review. */
const reviewer = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-codex',
  effort: 'high',
  command: [
    'node',
    '-e',
    `const p = require('fs').readFileSync(0, 'utf8');
console.log(p.includes('changed existing test files') ? 'APPROVE: the assertion is kept; only the URL changes' : 'VERDICT: pass');
console.log(JSON.stringify({ is_error: false, usage: { input_tokens: 5, output_tokens: 1 } }));`,
  ],
};

function gated(head, baseFiles = BASE) {
  const { dir, base } = fixtureRepo(baseFiles);
  commit(dir, head);
  const config = fixtureConfig({ testFilesCommand: FILES_COMMAND, review: true, tiers: [reviewer] });
  return gate({ repo: dir, base, card, config, reviewer });
}

const stage = (receipt, name) => receipt.results.find((r) => r.name === name);

test('REQ-GATE-75 a replaced test line the change needs passes test-edit-proof when the base version fails on head', () => {
  const receipt = gated({ ...THREE_D, ...EDITED });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 1));
  const proof = stage(receipt, 'test-edit-proof');
  assert.equal(proof.pass, true);
  assert.deepEqual(proof.files, ['test/render.test.js']);
  assert.equal(stage(receipt, 'test-edits').pass, true, 'the test-edits review still judges the edit');
});

test('REQ-GATE-76 a replaced test line with no change to its source fails test-edit-proof: the base version passes on head', () => {
  const receipt = gated({ ...FLAG_ON, ...EDITED });
  assert.equal(receipt.pass, false);
  const proof = stage(receipt, 'test-edit-proof');
  assert.equal(proof.pass, false);
  assert.deepEqual(
    proof.problems.map((p) => [p.rule, p.path, p.why]),
    [
      [
        'existing-test-changed',
        'test/render.test.js',
        'the base version of test/render.test.js passes on head: the change does not need this edit',
      ],
    ],
  );
  assert.equal(stage(receipt, 'test-edits'), undefined, 'the review is not asked');
});

test('REQ-GATE-75 an edit that only deletes lines never takes the base-on-head path', () => {
  // Head drops `legacy` from src and the import of it from the test: the base test fails on head, but a deleted line is
  // not a replaced one, so the proof stays as before (REQ-GATE-44).
  const legacy = {
    ...BASE,
    'src/render.js': "export const render = () => '2d';\nexport const legacy = 1;\n",
    'test/render.test.js': src(
      ...HEAD,
      "import { legacy } from '../src/render.js';",
      "it('renders 2d', () => {",
      "  assert.strictEqual(render('/'), '2d');",
      '});',
    ),
  };
  const receipt = gated({ ...FLAG_ON, 'src/render.js': BASE['src/render.js'], 'test/render.test.js': renders('/') }, legacy);
  const proof = stage(receipt, 'test-edit-proof');
  assert.equal(proof.pass, false, JSON.stringify(receipt.results, null, 1));
  assert.equal(proof.problems[0].why, 'passes alone on base, so the change does not need the edit');
});

test('REQ-GATE-75 a replaced line in a test already red on base stays locked: the change is not what breaks it', () => {
  // The base test expects 3d at `/`, red on base and on head; the edit points it at `?r=2d` and expects 2d, green on both.
  const red = {
    ...BASE,
    'test/render.test.js': src(...HEAD, "it('renders 2d', () => {", "  assert.strictEqual(render('/'), '3d');", '});'),
  };
  const receipt = gated({ ...FLAG_ON, ...EDITED }, red);
  const proof = stage(receipt, 'test-edit-proof');
  assert.equal(proof?.pass, false, JSON.stringify(receipt.results, null, 1));
  assert.equal(proof.problems[0].why, 'passes alone on base, so the change does not need the edit');
});
