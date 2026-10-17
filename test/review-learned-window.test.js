import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { learnLimit, windowLines, windowUse } from '../src/window.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = () => parseCard('# T-1: test card\nkind: bug\nsize: S\n');
const tier = (family, model, script) => ({
  provider: 'exec',
  family,
  model,
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); ${script}`],
});
const out = tier('codex', 'exec-codex', "console.error('You have hit your usage limit. Try again at 10:09 AM.'); process.exit(1);");
const claude = tier('claude', 'exec-claude', "console.log('VERDICT: pass')");
const review = (r) => r.results.find((x) => x.name === 'review');
const spend = (file, family, tokens) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), family, tokens })}\n`);

function setup() {
  const { dir, base } = fixtureRepo();
  commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add');
  return { dir, base, file: join(tmp('keel-spend-'), 'review-spend.jsonl') };
}

test('REQ-GATE-27 a quota failure records the tokens the family spent in the window as its learned limit', () => {
  const { dir, base, file } = setup();
  spend(file, 'codex', 2000);
  const config = fixtureConfig({ review: true, tiers: [claude, out] });
  assert.equal(windowUse(file, 'codex', {}), null, 'no limit known before the first quota failure');
  assert.equal(gate({ repo: dir, base, card: card(), config, reviewer: out, spendFile: file }).pass, true);
  const learned = JSON.parse(readFileSync(join(dirname(file), 'review-limits.json'), 'utf8'));
  assert.deepEqual(learned.codex.tokens, 2000);
  assert.equal(learned.codex.hours, 5);
  assert.deepEqual(windowUse(file, 'codex', {}), { family: 'codex', hours: 5, limit: 2000, remaining: 0, learned: true });
});

test('REQ-GATE-27 after one quota failure, the next gate goes to the fallback first with no configuration', () => {
  const { dir, base, file } = setup();
  spend(file, 'codex', 2000);
  const config = fixtureConfig({ review: true, tiers: [claude, out] });
  gate({ repo: dir, base, card: card(), config, reviewer: out, spendFile: file });
  const r = gate({ repo: dir, base, card: card(), config, reviewer: out, spendFile: file });
  assert.equal(review(r).reviewer, 'exec/exec-claude/high');
  assert.equal(review(r).fallback.status, 'window nearly used');
});

test('REQ-GATE-27 a quota failure with no recorded spend learns nothing, and keel.json reviewWindows overrides a learned limit', () => {
  const { dir, base, file } = setup();
  const config = fixtureConfig({ review: true, tiers: [claude, out] });
  gate({ repo: dir, base, card: card(), config, reviewer: out, spendFile: file });
  assert.equal(existsSync(join(dirname(file), 'review-limits.json')), false);
  spend(file, 'codex', 2000);
  gate({ repo: dir, base, card: card(), config, reviewer: out, spendFile: file });
  assert.equal(windowUse(file, 'codex', { codex: { hours: 1, tokens: 9000 } }).limit, 9000);
});

test("REQ-GATE-27 keel doctor lists each reviewer family's window, marking a learned limit", () => {
  const { file } = setup();
  spend(file, 'codex', 2000);
  learnLimit(file, 'codex');
  const config = fixtureConfig({ review: true, tiers: [claude, out] });
  assert.deepEqual(windowLines(config, file), ['review window codex (learned): ~0 of 2000 tokens left in 5h (nearly used)']);
});
