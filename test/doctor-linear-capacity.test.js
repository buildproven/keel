import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINEAR_ISSUE_LIMIT, linearCapacity } from '../src/doctor.js';

const teams = [{ key: 'BUI', autoArchivePeriod: 1 }];

test('REQ-CLI-16 doctor reports unarchived Linear issues against the 250 limit and each team archive period', () => {
  assert.equal(LINEAR_ISSUE_LIMIT, 250);
  assert.deepEqual(linearCapacity({ open: 120, teams }), [
    { level: 'INFO', text: 'linear 120 of 250 unarchived issues' },
    { level: 'INFO', text: 'linear team BUI auto-archives closed issues after 1 month' },
  ]);
});

test('REQ-CLI-16 doctor warns at 200 unarchived issues and fails at 250', () => {
  assert.equal(linearCapacity({ open: 199, teams })[0].level, 'INFO');
  const warn = linearCapacity({ open: 200, teams })[0];
  assert.equal(warn.level, 'WARN');
  assert.match(warn.text, /200 of 250 unarchived issues: archive closed issues/);
  const fail = linearCapacity({ open: 250, teams })[0];
  assert.equal(fail.level, 'FAIL');
  assert.match(fail.text, /Linear refuses new issues/);
});

test('REQ-CLI-16 doctor warns when a team keeps closed issues unarchived longer than a month', () => {
  const rows = linearCapacity({ open: 10, teams: [{ key: 'A', autoArchivePeriod: 6 }] });
  assert.deepEqual(rows.slice(1), [
    { level: 'WARN', text: 'linear team A auto-archives closed issues after 6 months; set 1 so closed issues stop counting sooner' },
  ]);
});
