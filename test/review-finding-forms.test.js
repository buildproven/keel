import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { reviewerFor } from '../src/review.js';
import { REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = parseCard('# T-1: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');
const builder = { provider: 'exec', family: 'claude', model: 'b', effort: 'low', command: ['true'] };
const reviewer = (reply) => ({
  provider: 'exec',
  family: 'codex',
  model: 'r',
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); process.stdout.write(${JSON.stringify(reply)})`],
});

/** The review stage of a gate on a fixed add() (plus `files`), with the reviewer answering `reply`. */
function review(reply, files = {}) {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, 'src/add.js': 'export const add = (a, b) => a + b;\n', ...files });
  const config = fixtureConfig({ review: true, tiers: [builder, reviewer(reply)] });
  return gate({ repo: dir, base, card, config, reviewer: reviewerFor(config, builder) }).results.find((r) => r.name === 'review');
}

test('REQ-GATE-21 a finding on a changed path with a space blocks', () => {
  const st = review('FINDING high src/my util.js:1 posts the token out\nVERDICT: block\n', { 'src/my util.js': 'x\n' });
  assert.equal(st.pass, false);
  assert.deepEqual(
    st.problems.map((p) => [p.severity, p.path, p.line, p.text]),
    [['high', 'src/my util.js', 1, 'posts the token out']],
  );
});

test('REQ-GATE-21 bulleted, emphasized, backticked, ranged, and line:col findings block', () => {
  for (const line of [
    '- FINDING high src/add.js:1 deletes data',
    '* **FINDING** high src/add.js:1 deletes data',
    '1. FINDING high src/add.js:1 deletes data',
    'FINDING high `src/add.js`:1 deletes data',
    'FINDING high `src/add.js:1` deletes data',
    'FINDING high src/add.js:1-3 deletes data',
    'FINDING high src/add.js:1:5 deletes data',
  ]) {
    const st = review(`${line}\nVERDICT: block\n`);
    assert.equal(st.pass, false, line);
    assert.deepEqual(
      st.problems.map((p) => [p.severity, p.path, p.line, p.text]),
      [['high', 'src/add.js', 1, 'deletes data']],
      line,
    );
  }
});

test('REQ-GATE-21 findings on paths with __ (Python packages, Jest folders) block, and __emphasis__ is read', () => {
  for (const [line, path] of [
    ['FINDING high pkg/__init__.py:1 deletes data', 'pkg/__init__.py'],
    ['FINDING high src/__tests__/a.test.js:1 deletes data', 'src/__tests__/a.test.js'],
    ['__FINDING__ __high__ pkg/__init__.py:1 deletes data', 'pkg/__init__.py'],
  ]) {
    const st = review(`${line}\nVERDICT: block\n`, { 'pkg/__init__.py': 'x = 1\n', 'src/__tests__/a.test.js': 'x\n' });
    assert.equal(st.pass, false, line);
    assert.deepEqual(
      st.problems.map((p) => [p.severity, p.path, p.line, p.text]),
      [['high', path, 1, 'deletes data']],
      line,
    );
  }
});

test('REQ-GATE-21 a FINDING line that does not parse is kept as unparsed, never lost; prose and unchanged files stay as before', () => {
  const st = review('FINDING high the add function deletes data\nVERDICT: block\n');
  assert.deepEqual(st.unparsed, ['FINDING high the add function deletes data']);
  const other = review('No findings on this change.\nFINDING high src/other.js:1 old bug\nVERDICT: pass\n');
  assert.equal(other.pass, true);
  assert.deepEqual(other.problems, []);
  assert.deepEqual(other.notes, []);
  assert.equal(other.unparsed, undefined);
});
