import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { poll } from '../src/poll.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const priced = (cost) =>
  `console.log(JSON.stringify({ is_error: false, total_cost_usd: ${cost}, usage: { input_tokens: 1, output_tokens: 1 } }));`;
const tier = (family, model, script) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); ${script}`],
});
const down = (family, model) => tier(family, model, priced(0.01));
const passes = (family, model) => tier(family, model, `console.log('VERDICT: pass'); ${priced(0.01)}`);
const review = (r) => r.results.find((x) => x.name === 'review');

function setup() {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  return { dir, base };
}

test('REQ-GATE-22 when the reviewer and the first fallback are out, every other tier is tried: other families first, then the rest', () => {
  const { dir, base } = setup();
  const codex = down('codex', 'codex-top');
  const tiers = [passes('codex', 'codex-small'), down('claude', 'claude-a'), down('claude', 'claude-b'), codex];
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig({ review: true, tiers }), reviewer: codex });
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(review(r).reviewer, 'exec/codex-small/high');
  assert.deepEqual(review(r).fallback, {
    from: 'exec/codex-top/high',
    status: 'no verdict',
    tried: ['exec/claude-b/high', 'exec/claude-a/high'],
  });
  assert.equal(Math.round(review(r).cost * 100), 4, 'every reviewer that ran is paid for');
});

test('REQ-GATE-22 only when every tier is out does the review stay unavailable', () => {
  const { dir, base } = setup();
  const codex = down('codex', 'codex-top');
  const tiers = [down('claude', 'claude-a'), down('claude', 'claude-b'), codex];
  const r = gate({ repo: dir, base, card: card(), config: fixtureConfig({ review: true, tiers }), reviewer: codex });
  assert.equal(review(r).problems[0].rule, 'review-unavailable');
  assert.equal(Math.round(review(r).cost * 100), 3);
});

const issue = (id, createdAt) => ({
  id,
  title: id,
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt,
  labels: [],
  estimate: null,
});

test('REQ-LINEAR-19 a poll does not pick an issue it deferred again in the same pass; it moves on to the next issue', async () => {
  const { dir } = fixtureRepo();
  const wt = `${tmp('keel-wt-')}/wt`;
  g(dir, 'worktree', 'add', '-q', '-b', 'keel/BUI-7', wt);
  const client = {
    listIssues: async () => [issue('BUI-7', '2026-09-01'), issue('BUI-8', '2026-09-02')],
    comment: async () => {},
    review: async () => {},
    stateType: async () => 'started',
  };
  const seen = [];
  const runFn = ({ card: c }) => {
    seen.push(c.id);
    return c.id === 'BUI-7'
      ? { pass: false, stopped: 'review-unavailable', pendingReview: true, branch: 'keel/BUI-7', worktree: wt, failure: 'out' }
      : { pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-8', worktree: '/tmp/x' };
  };
  await poll({ repo: dir, project: 'x', client, config: {}, runFn, limit: 3 });
  assert.deepEqual(seen, ['BUI-7', 'BUI-8']);
});
