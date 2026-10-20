import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cachedPlan, savePlan } from '../src/plan.js';
import { poll } from '../src/poll.js';
import { nearlyUsed, windowLine, windowUse } from '../src/window.js';
import { fixtureRepo, tmp } from './helpers.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const S = NOW.getTime() / 1000;

/** A state dir whose learned codex limit is used up: the token estimate alone says "nearly used". */
function stateWithExhaustedLearnedLimit() {
  const dir = tmp('keel-plan-rw-');
  const file = join(dir, 'review-spend.jsonl');
  writeFileSync(file, `${JSON.stringify({ at: new Date(NOW.getTime() - 3600e3).toISOString(), family: 'codex', tokens: 630109 })}\n`);
  writeFileSync(join(dir, 'review-limits.json'), JSON.stringify({ codex: { hours: 5, tokens: 453604, at: NOW.toISOString() } }));
  return { dir, file };
}

test('REQ-PLAN-5 a fresh plan reading of the reviewer family wins over the learned token limit', () => {
  const { dir, file } = stateWithExhaustedLearnedLimit();
  assert.equal(nearlyUsed(windowUse(file, 'codex', {}, NOW)), true, 'the learned estimate alone says nearly used');
  savePlan({ codex: { fiveHour: { used: 7, resetsAt: S + 3600 }, week: { used: 14, resetsAt: S + 86400 } } }, dir, NOW);
  const use = windowUse(file, 'codex', {}, NOW);
  assert.equal(use.plan, true);
  assert.equal(nearlyUsed(use), false);
  assert.match(windowLine(use, { first: null, reviewer: 'codex/x' }), /^review window codex \(plan\): 14% used$/);
});

test('REQ-PLAN-5 a plan window at 90 % or more is nearly used, and the line names the fallback', () => {
  const { dir, file } = stateWithExhaustedLearnedLimit();
  savePlan({ codex: { fiveHour: { used: 92, resetsAt: S + 3600 }, week: { used: 14, resetsAt: S + 86400 } } }, dir, NOW);
  const use = windowUse(file, 'codex', {}, NOW);
  assert.equal(nearlyUsed(use), true);
  assert.match(
    windowLine(use, { first: 'claude/opus', reviewer: 'codex/x' }),
    /92% used \(nearly used: fallback claude\/opus reviews first\)/,
  );
});

test('REQ-PLAN-5 a stale or unknown plan reading falls back to the token estimate; a window past its reset reads 0', () => {
  const { dir, file } = stateWithExhaustedLearnedLimit();
  savePlan({ codex: { fiveHour: { used: 7, resetsAt: S + 3600 } } }, dir, new Date(NOW.getTime() - 31 * 60e3));
  assert.equal(windowUse(file, 'codex', {}, NOW).plan, undefined, 'a reading over 30 minutes old is not used');
  savePlan({ codex: null }, dir, NOW);
  assert.equal(windowUse(file, 'codex', {}, NOW).learned, true, 'an unknown reading leaves the learned limit');
  savePlan(
    { codex: { fiveHour: { used: 95, resetsAt: S - 1 }, week: { used: 20, resetsAt: S + 86400 } } },
    dir,
    new Date(NOW.getTime() - 60e3),
  );
  assert.equal(cachedPlan(dir, 'codex', NOW).fiveHour.used, 0);
});

test('REQ-PLAN-5 keel poll saves its plan reading in the state dir for the gates of its runs', async () => {
  process.env.KEEL_STATE_DIR = tmp('keel-plan-poll-');
  const { dir } = fixtureRepo();
  const issue = { id: 'BUI-9', title: 't', description: '- REQ-1: it shall work.', priority: 2, createdAt: '2026-09-01', labels: ['Bug'] };
  const client = { listIssues: async () => [issue], comment: async () => {}, review: async () => {}, stateType: async () => 'started' };
  const reading = { fiveHour: { used: 7, resetsAt: Date.now() / 1000 + 3600 }, week: { used: 14, resetsAt: Date.now() / 1000 + 86400 } };
  await poll({
    repo: dir,
    project: 'x',
    client,
    config: { planLimits: { fiveHour: 90, week: 80 }, tiers: [{ provider: 'codex' }] },
    runFn: () => ({ pass: false, stopped: 'blocked', failure: 'x' }),
    planFn: () => ({ codex: reading }),
  });
  assert.equal(cachedPlan(process.env.KEEL_STATE_DIR, 'codex').week.used, 14);
});
