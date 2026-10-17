import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardFromIssue } from '../src/linear.js';

const issue = (over = {}) => ({
  id: 'BUI-1',
  title: 'Rename the sync job',
  description: '- REQ-1: it shall be renamed.',
  priority: 2,
  labels: [],
  estimate: null,
  ...over,
});
const kind = (over) => cardFromIssue(issue(over)).kind;

test('REQ-LINEAR-24 any label of the issue sets the kind, not only the first', () => {
  assert.equal(kind({ labels: ['Priority', 'Bug'] }), 'bug');
  assert.equal(kind({ labels: ['infra', 'Improvement'] }), 'feature');
  assert.equal(kind({ labels: ['Feature', 'Bug'] }), 'bug');
});

test('REQ-LINEAR-24 an unlabeled issue whose title describes a failure is a bug', () => {
  assert.equal(kind({ title: 'keel audit misses fallback-reviewed merges beyond the last 20 PRs' }), 'bug');
  assert.equal(kind({ title: 'test_cli_plan_and_show fails midweek: reads the real clock' }), 'bug');
  assert.equal(kind({ title: 'Gate hangs when a FIFO is named like a receipt' }), 'bug');
  assert.equal(kind({ title: 'Window line gives the wrong reason when reviewFallback is off' }), 'bug');
  assert.equal(kind({ title: 'fix: poll crashes on an empty project' }), 'bug');
});

test('REQ-LINEAR-24 an unlabeled issue with a neutral, docs:, or chore: title stays a chore; a keel block still wins', () => {
  assert.equal(kind({}), 'chore');
  assert.equal(kind({ title: 'docs: explain why the gate fails a locked file' }), 'chore');
  assert.equal(kind({ title: 'chore: bump the broken-link checker' }), 'chore');
  assert.equal(kind({ title: 'Gate hangs on a FIFO', description: '```keel\nkind: chore\n```\n\n- REQ-1: x' }), 'chore');
});
