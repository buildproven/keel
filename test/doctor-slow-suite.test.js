import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctor } from '../src/doctor.js';
import { fixtureConfig, fixtureRepo } from './helpers.js';

test('REQ-CLI-14 a slow suite behind a wrapper script is flagged by its measured time, with how to find the slow tests', () => {
  const { dir, base } = fixtureRepo();
  const rows = doctor({
    repo: dir,
    base,
    slowSuiteMs: 100,
    config: fixtureConfig({ checks: { test: 'sh -c "sleep 0.2"' }, testCommand: 'sh -c "sleep 0.2"' }),
  });
  const advice = rows.filter((r) => r.kind === 'advice').map((r) => r.output);
  assert.equal(advice.length, 1, JSON.stringify(rows));
  assert.match(advice[0], /^tests took \d+s; find the slowest tests \(pytest --durations=30/);
});
