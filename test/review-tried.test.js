import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const down = (family, model) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', "require('fs').readFileSync(0); console.log(JSON.stringify({ is_error: false }));"],
});

test('REQ-GATE-22 when every fallback is out too, the unavailable result lists the fallbacks that were tried', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const codex = down('codex', 'codex-top');
  const tiers = [down('claude', 'claude-a'), down('claude', 'claude-b'), codex];
  const card = parseCard('# T-1: test card\nkind: bug\nsize: S\n');
  const r = gate({ repo: dir, base, card, config: fixtureConfig({ review: true, tiers }), reviewer: codex });
  const rev = r.results.find((x) => x.name === 'review');
  assert.equal(rev.problems[0].rule, 'review-unavailable');
  assert.deepEqual(rev.tried, ['exec/claude-b/high', 'exec/claude-a/high']);
});
