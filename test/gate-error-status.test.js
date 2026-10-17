import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateDescription, gateState } from '../src/status.js';

test('REQ-CLI-10 a gate that failed only because the reviewer was unavailable posts error, not failure', () => {
  const receipt = {
    pass: false,
    head: 'abc',
    results: [
      { name: 'test', pass: true, problems: [] },
      { name: 'review', pass: false, problems: [{ rule: 'review-unavailable', status: 'quota' }] },
    ],
  };
  assert.equal(gateState(receipt), 'error');
  assert.equal(gateDescription(receipt, { review: true }), 'review unavailable (quota); gate again later');
  assert.equal(gateState({ ...receipt, results: [{ name: 'test', pass: false, problems: [] }] }), 'failure');
  assert.equal(gateState({ pass: true, results: [] }), 'success');
});
