import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { attemptedIssueIds, cardFromIssue, pickIssue, recordPollAttempt } from '../src/linear.js';
import { tmp } from './helpers.js';

const issue = (over = {}) => ({
  id: 'BUI-545',
  title: "OSS Sync Bot's qa-architect regen silently reintroduces the broken tsc lint-staged gate",
  description: '- REQ-1: When the sync bot regenerates config, it shall not reintroduce the broken gate.',
  priority: 2,
  labels: ['Bug'],
  estimate: null,
  ...over,
});

test('REQ-LINEAR-2 maps a Bug issue to a bug card with the description as requirements', () => {
  const card = cardFromIssue(issue());
  assert.equal(card.kind, 'bug');
  assert.equal(card.size, 'S');
  assert.equal(card.id, 'BUI-545');
  assert.match(card.title, /qa-architect regen/);
  assert.match(card.text, /REQ-1: When the sync bot regenerates/);
});

test('REQ-LINEAR-2 maps Feature/Improvement labels to feature, an estimate to size, and defaults an unlabeled issue to chore', () => {
  assert.equal(cardFromIssue(issue({ labels: ['Feature'] })).kind, 'feature');
  assert.equal(cardFromIssue(issue({ labels: ['Improvement'] })).kind, 'feature');
  assert.equal(cardFromIssue(issue({ labels: [], title: 'Rename the sync job' })).kind, 'chore'); // REQ-LINEAR-24: a failure title is a bug
  assert.equal(cardFromIssue(issue({ estimate: 1 })).size, 'S');
  assert.equal(cardFromIssue(issue({ estimate: 3 })).size, 'M');
  assert.equal(cardFromIssue(issue({ estimate: 8 })).size, 'L');
});

test('REQ-LINEAR-2 REQ-LINEAR-3 an issue with no description cannot be mapped', () => {
  assert.throws(() => cardFromIssue(issue({ description: '' })), /no description/);
  assert.throws(() => cardFromIssue(issue({ description: null })), /no description/);
});

test('REQ-LINEAR-3 an issue blocked by an external/account condition cannot be mapped as a code task', () => {
  // Real text from BUI-669 (2026-09-27 live pilot run): 4 model attempts were burned on this before
  // the gate correctly rejected every one, because the issue was never fixable in code.
  const billingBlocked = issue({
    id: 'BUI-669',
    description:
      '## Status — external billing block remains\n\nGitHub Actions runner preallocation is still blocked for new example-app runs by the account payment/spending-limit condition. The required `summary` check fails before any runner steps start, so this issue remains **In Progress** until billing is restored.',
  });
  assert.throws(() => cardFromIssue(billingBlocked), /external|blocked/);
  // An ordinary bug that happens to mention "account" in passing must still map normally.
  assert.doesNotThrow(() => cardFromIssue(issue({ description: 'The account settings page throws a 500 on save.' })));
});

test('REQ-LINEAR-1 pickIssue orders by priority then age and skips already-attempted issues', () => {
  const issues = [
    { id: 'A', priority: 3, createdAt: '2026-09-01', labels: ['Bug'], description: 'x' },
    { id: 'B', priority: 1, createdAt: '2026-09-05', labels: ['Bug'], description: 'x' },
    { id: 'C', priority: 1, createdAt: '2026-09-02', labels: ['Bug'], description: 'x' },
  ];
  assert.equal(pickIssue(issues, new Set()).id, 'C', 'lower priority number and older wins over B');
  assert.equal(pickIssue(issues, new Set(['C'])).id, 'B');
  assert.equal(pickIssue(issues, new Set(['B', 'C'])).id, 'A');
  assert.equal(pickIssue(issues, new Set(['A', 'B', 'C'])), null);
});

test('REQ-LINEAR-3 pickIssue skips issues that cannot map to a card, recording why', () => {
  const issues = [
    { id: 'A', priority: 1, createdAt: '2026-09-01', labels: ['Bug'], description: '' },
    { id: 'B', priority: 2, createdAt: '2026-09-01', labels: ['Bug'], description: 'x' },
  ];
  const skipped = [];
  const picked = pickIssue(issues, new Set(), (id, reason) => skipped.push({ id, reason }));
  assert.equal(picked.id, 'B');
  assert.deepEqual(skipped, [{ id: 'A', reason: 'no description' }]);
});

test('REQ-LINEAR-6 recordPollAttempt and attemptedIssueIds round-trip through a repo-scoped poll ledger', () => {
  const dir = tmp('keel-poll-state-');
  process.env.KEEL_STATE_DIR = dir;
  assert.deepEqual(attemptedIssueIds('/repo/a'), new Set());
  recordPollAttempt('/repo/a', { issue: 'BUI-1', outcome: 'closed' });
  recordPollAttempt('/repo/a', { issue: 'BUI-2', outcome: 'failed' });
  recordPollAttempt('/repo/b', { issue: 'BUI-1', outcome: 'closed' });
  assert.deepEqual(attemptedIssueIds('/repo/a'), new Set(['BUI-1', 'BUI-2']));
  assert.deepEqual(attemptedIssueIds('/repo/b'), new Set(['BUI-1']), 'ledger is scoped per repo');
  const file = readFileSync(join(dir, 'poll-ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(file.length, 3);
  assert.ok(existsSync(join(dir, 'poll-ledger.jsonl')));
});
