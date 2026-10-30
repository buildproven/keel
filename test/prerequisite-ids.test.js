import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textPrerequisites } from '../src/linear.js';

const issue = (description) => ({ id: 'BUI-999', title: 'Card', description });

test('REQ-LINEAR-26 textPrerequisites ignores the tail of a hyphenated requirement ID', () => {
  const text = 'Remove the checkout after its last stage, on pass, fail, or throw (REQ-GATE-1, REQ-GATE-34).';
  assert.deepEqual(textPrerequisites(issue(text)), []);
  assert.deepEqual(textPrerequisites(issue('Needs REQ-LINEAR-26 kept and BUI-12 shipped.')), ['BUI-12']);
  assert.deepEqual(textPrerequisites(issue('Blocked by BUI-13 (see REQ-GATE-1).')), ['BUI-13']);
});
