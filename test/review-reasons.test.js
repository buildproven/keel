import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate, stageLine } from '../src/gate.js';
import { retryAt } from '../src/review.js';
import { gateDescription } from '../src/status.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const tier = (family, model, script) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); ${script}`],
});
const quota = tier('codex', 'codex-top', "console.error('You have hit your usage limit. Try again at 10:09 AM.'); process.exit(1);");
const crash = tier('claude', 'claude-b', "console.error('boom: wrapper failed'); process.exit(2);");
const silent = tier('claude', 'claude-a', 'console.log(JSON.stringify({ is_error: false }));');
const review = (r) => r.results.find((x) => x.name === 'review');

function gateAllOut() {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const config = fixtureConfig({ review: true, tiers: [silent, crash, quota] });
  return gate({ repo: dir, base, card: card(), config, reviewer: quota });
}

test("REQ-GATE-26 when every reviewer is out, the result records each one's status, reset time, and output tail", () => {
  const rev = review(gateAllOut());
  assert.equal(rev.problems[0].rule, 'review-unavailable');
  assert.deepEqual(
    rev.unavailable.map((u) => [u.reviewer, u.status, u.retryAt ?? null]),
    [
      ['exec/codex-top/high', 'quota', '10:09 AM'],
      ['exec/claude-b/high', 'error', null],
      ['exec/claude-a/high', 'no verdict', null],
    ],
  );
  assert.match(rev.unavailable[1].output, /boom: wrapper failed/);
});

test('REQ-GATE-26 the stage line names every reviewer that was out, with its status and reset time', () => {
  const line = stageLine(review(gateAllOut()));
  assert.match(line, /exec\/codex-top\/high quota \(retry 10:09 AM\)/);
  assert.match(line, /exec\/claude-b\/high error/);
  assert.match(line, /exec\/claude-a\/high no verdict/);
});

test('REQ-GATE-26 the reset time is read from Codex and Claude limit messages', () => {
  assert.equal(retryAt('visit the usage page or try again at 10:09 AM.'), '10:09 AM');
  assert.equal(retryAt('5-hour limit reached ∙ resets 3pm (America/Chicago)'), '3pm (America/Chicago)');
  assert.equal(retryAt('Your limit will reset at 11:30 PM.'), '11:30 PM');
  assert.equal(retryAt('Error: fetch failed'), null);
});

test('REQ-GATE-26 the keel/gate description names each reviewer that was out, within 140 characters', () => {
  const desc = gateDescription(gateAllOut(), { review: true });
  assert.match(desc, /^review unavailable: exec\/codex-top\/high quota \(retry 10:09 AM\); exec\/claude-b\/high error/);
  assert.ok(desc.length <= 140);
});
