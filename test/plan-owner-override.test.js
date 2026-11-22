import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerPlanLimits, reservedProviders } from '../src/plan.js';

const LIMITS = { fiveHour: 90, week: 80 };
const AT_87 = { claude: { fiveHour: { used: 6 }, week: { used: 87 } } };

test('REQ-PLAN-9 without KEEL_PLAN_LIMITS the keel.json limits hold and claude at 87% of the week is reserved', () => {
  const { limits, note } = ownerPlanLimits(LIMITS, {});
  assert.deepEqual(limits, LIMITS);
  assert.equal(note, null);
  assert.ok(reservedProviders(AT_87, limits).has('claude'));
});

test('REQ-PLAN-9 KEEL_PLAN_LIMITS=week=95 lets a run spend to 95% of the week, and says so', () => {
  const { limits, note } = ownerPlanLimits(LIMITS, { KEEL_PLAN_LIMITS: 'week=95' });
  assert.deepEqual(limits, { fiveHour: 90, week: 95 });
  assert.equal(note, "plan limits overridden by KEEL_PLAN_LIMITS (owner's OK): 5h 90%, week 95%");
  assert.equal(reservedProviders(AT_87, limits).has('claude'), false);
});

test('REQ-PLAN-9 KEEL_PLAN_LIMITS can set both windows', () => {
  const { limits } = ownerPlanLimits(LIMITS, { KEEL_PLAN_LIMITS: 'fiveHour=95, week=97' });
  assert.deepEqual(limits, { fiveHour: 95, week: 97 });
});

test('REQ-PLAN-9 a malformed KEEL_PLAN_LIMITS stops the run with the expected form', () => {
  for (const bad of ['week', 'week=0', 'week=101', 'month=90', 'week=95;fiveHour=90'])
    assert.throws(() => ownerPlanLimits(LIMITS, { KEEL_PLAN_LIMITS: bad }), /KEEL_PLAN_LIMITS must be fiveHour=<percent>/, bad);
});
