import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

let state;
beforeEach(() => {
  state = tmp('keel-state-');
  process.env.KEEL_STATE_DIR = state;
});

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const tier = (family, model, script) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); ${script}`],
});
// What the Claude CLI prints when it cannot read its login (2026-10-21, over SSH on the MacBook Pro).
const signedOut = tier('claude', 'claude-out', "console.log('Not logged in · Please run /login'); process.exit(1);");
const codexOut = tier('codex', 'codex-out', "console.error('unexpected status 401 Unauthorized'); process.exit(1);");
// Two hours ahead, as the provider writes it. A fixed clock time can be over a day away on the eve of a DST change, and
// during the fall-back hour one hour ahead repeats the same clock time; two hours ahead is always a later clock time.
const resetAt = new Date(Date.now() + 2 * 3600 * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const quota = tier('codex', 'codex-top', `console.error('You have hit your usage limit. Try again at ${resetAt}.'); process.exit(1);`);
const passes = tier('claude', 'claude-ok', "console.log('VERDICT: pass');");

function run(tiers, reviewer, extra = {}) {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC });
  const config = fixtureConfig({ review: true, tiers });
  return gate({ repo: dir, base, card: card(), config, reviewer, receiptDir: join(state, 'receipts'), ...extra });
}

const signIn = (r) => (r.improve ?? []).filter((l) => /cannot sign in/.test(l));

test('REQ-GATE-53 a reviewer out for auth adds an IMPROVE line naming it and its sign-in fix, even when a fallback reviewed', () => {
  const r = run([passes, signedOut, quota], quota);
  assert.equal(r.pass, true, JSON.stringify(r.results));
  const lines = signIn(r);
  assert.equal(lines.length, 1, JSON.stringify(r.improve));
  assert.match(lines[0], /^IMPROVE: reviewer exec\/claude-out\/high cannot sign in/);
  assert.match(lines[0], /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(lines[0], /claude setup-token/);
});

test('REQ-GATE-53 the fix names the CLI of the reviewer family, and a quota outage adds no sign-in line', () => {
  const r = run([codexOut, signedOut, quota], quota);
  assert.equal(r.pass, false);
  const lines = signIn(r);
  assert.equal(lines.length, 2, JSON.stringify(r.improve));
  assert.ok(lines.some((l) => /claude-out.*CLAUDE_CODE_OAUTH_TOKEN/.test(l)));
  assert.ok(lines.some((l) => /codex-out.*codex login/.test(l)));
  assert.ok(!lines.some((l) => /codex-top/.test(l)), 'the quota-out reviewer is not a sign-in fault');
});

test('REQ-GATE-53 with waitReview, the sign-in fix is printed before the gate waits for a reset', () => {
  const logged = [];
  run([signedOut, quota], quota, { waitReviewHours: 24, sleep: () => {}, log: (l) => logged.push(l) });
  const wait = logged.findIndex((l) => /waiting/.test(l));
  const fix = logged.findIndex((l) => /cannot sign in/.test(l));
  assert.ok(wait >= 0, JSON.stringify(logged));
  assert.ok(fix >= 0 && fix < wait, JSON.stringify(logged));
});
