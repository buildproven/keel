import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo } from './helpers.js';

const card = (header) => parseCard(`# T-1: test card\n${header}\n`);
const scope = (r) => r.results.find((x) => x.name === 'scope').problems;

test('REQ-GATE-50 an allowEdits path outside the card paths is in scope', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'README.md': 'x\n' });
  const r = gate({
    repo: dir,
    base,
    card: card('kind: bug\nsize: S\npaths: src/**\nallowEdits: test/add.test.js'),
    config: fixtureConfig(),
  });
  assert.deepEqual(scope(r), [{ rule: 'out-of-scope', path: 'README.md' }]);
});

test('REQ-GATE-50 allowEdits alone does not turn on the scope check', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC, 'README.md': 'x\n' });
  const r = gate({ repo: dir, base, card: card('kind: bug\nsize: S\nallowEdits: test/add.test.js'), config: fixtureConfig() });
  assert.deepEqual(scope(r), []);
});
