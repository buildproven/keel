import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { attemptedIssueIds, notKeelReason, pickIssue, textPrerequisites } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-triage-state-');
});

const issue = (over = {}) => ({
  id: 'BUI-1',
  title: 'fix the thing',
  description: '- REQ-1: it shall be fixed.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  blockedBy: [],
  ...over,
});

// Real titles and description lines of the issues that stopped for a human in October 2026.
const REAL_NOT_KEEL = [
  [
    'decision',
    'LinkedIn posting by API on a schedule conflicts with API Terms §3.1(26) — decide posting mode',
    '**Recommendation:** (c).\n\nDecision for Brett.',
  ],
  ['decision', 'Run three-day and paid validation, then make the go/kill decision', 'Execute the final validation sequence.'],
  ['playtest', 'Run the first five-player Telegram and OpenClaw playtest', 'Run the first real five-player May 1940 playtest.'],
  ['playtest', 'Resolve accelerated-playtest findings before delivery expansion', 'Triage and fix only defects.'],
  [
    'umbrella',
    'Ship the Acme founding validation beta',
    '## Completion evidence\n\nAll child issues complete, the protected repository quality workflow passes.',
  ],
  [
    'operator step',
    "Acknowledge Pipeline Health's missed 2026-10-12 slot after the 10-19 run (runtime-only)",
    'Runtime-only operator step. No code change.',
  ],
];

for (const [category, title, description] of REAL_NOT_KEEL) {
  test(`REQ-LINEAR-25 "${title.slice(0, 50)}…" reads as ${category}, not a code task`, () => {
    const r = notKeelReason(issue({ title, description }));
    assert.ok(r, 'triaged');
    assert.equal(r.category, category);
    assert.ok(r.match.length > 0);
  });
}

const REAL_CODE = [
  ['fix: keel audit reads every merge of the last 30 days, not the newest 20', '- REQ-1: it shall read every merge.'],
  ['Pass newsletter stats_sources to the post-draft example-app check', '**Root cause:** the check strips frontmatter.'],
  ['choose the review mode in config/review.json after the LinkedIn posting-mode decision (BUI-1129)', '- REQ-1: pick a mode.'],
  ['Build and validate the 15-lesson founding curriculum', 'Each lesson must define today’s result.'],
  ['keel decides the start tier from the ledger', '- REQ-1: learned routing.'],
];

for (const [title, description] of REAL_CODE) {
  test(`REQ-LINEAR-25 "${title.slice(0, 50)}…" stays a code task`, () => {
    assert.equal(notKeelReason(issue({ title, description })), null);
  });
}

test('REQ-LINEAR-25 an issue with a keel block is a card by intent and is not triaged', () => {
  const description = '```keel\nkind: chore\n```\n\nRuntime-only operator step.';
  assert.equal(notKeelReason(issue({ title: 'Run the playtest export', description })), null);
});

test('REQ-LINEAR-25 pickIssue reports a not-keel issue to onNotKeel and picks the next one', () => {
  const seen = [];
  const picked = pickIssue(
    [issue({ id: 'BUI-2', priority: 1, title: 'Run the first playtest' }), issue({ id: 'BUI-3', priority: 3 })],
    new Set(),
    () => {},
    () => {},
    (id, r) => seen.push({ id, category: r.category }),
  );
  assert.equal(picked.id, 'BUI-3');
  assert.deepEqual(seen, [{ id: 'BUI-2', category: 'playtest' }]);
});

const runner =
  (ran) =>
  ({ card }) => {
    ran.push(card.id);
    return { pass: true, tier: 0, attempt: 1, branch: `keel/${card.id}`, needsReview: false, worktree: '/wt' };
  };
const fakeClient = (issues, states = {}) => {
  const comments = [];
  return {
    comments,
    read: [],
    listIssues: async () => issues,
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    async stateType(id) {
      if (issues.some((i) => i.id === id)) return 'started'; // REQ-LINEAR-16 reads the run issue's own state
      this.read.push(id);
      if (!(id in states)) throw new Error(`Entity not found: ${id}`);
      return states[id];
    },
  };
};

test('REQ-LINEAR-25 keel poll comments once, records notKeel, never runs it, and never picks it again', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const client = fakeClient([issue({ id: 'BUI-2', priority: 1, title: 'Run the first five-player playtest' })]);
  const first = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(first, [{ outcome: 'none' }]);
  assert.deepEqual(ran, []);
  assert.equal(client.comments.length, 1);
  assert.match(client.comments[0].body, /reads as a playtest[^\n]*not a code task/i);
  assert.match(client.comments[0].body, /keel` block|--issue/);
  assert.ok(attemptedIssueIds(dir).has('BUI-2'));
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.equal(client.comments.length, 1, 'one comment only');
});

test('REQ-LINEAR-25 a notKeel issue that gains a keel block is built by the next poll', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const triaged = issue({ id: 'BUI-2', priority: 1, title: 'Run the first five-player playtest' });
  const client = fakeClient([triaged]);
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, [], 'triaged, not built');
  triaged.description = `\`\`\`keel\nkind: chore\n\`\`\`\n\n${triaged.description}`;
  const r = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, ['BUI-2'], 'the keel block overrides triage');
  assert.equal(r[0].outcome, 'inReview');
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, ['BUI-2'], 'built once: the new outcome is an attempt');
});

test('REQ-LINEAR-25 a notKeel issue whose text still reads as human work stays suppressed', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const triaged = issue({ id: 'BUI-2', priority: 1, title: 'Run the first five-player playtest' });
  const client = fakeClient([triaged]);
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  triaged.description = 'Edited, but still no keel block.';
  await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.deepEqual(ran, []);
  assert.equal(client.comments.length, 1, 'no second comment');
});

test('REQ-LINEAR-25 --issue does not triage: an explicit run builds the issue', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const client = fakeClient([issue({ id: 'BUI-2', title: 'Run the first playtest export' })]);
  const r = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran), issue: 'BUI-2' });
  assert.equal(r[0].outcome, 'inReview');
  assert.deepEqual(ran, ['BUI-2']);
});

test('REQ-LINEAR-26 textPrerequisites reads the real prerequisite phrases and ignores the found-by source line', () => {
  assert.deepEqual(
    textPrerequisites(
      issue({
        id: 'BUI-1163',
        title: 'replace review_window.py check with `example-app status` once example-app BUI-1133 ships',
        description: 'Found by keel while building BUI-1130.\n\n## Requirements\n\n* replace the check.',
      }),
    ),
    ['BUI-1133'],
  );
  assert.deepEqual(
    textPrerequisites(
      issue({
        id: 'BUI-1164',
        title: 'choose the review mode in config/review.json after the LinkedIn posting-mode decision (BUI-1129)',
        description: 'Found by keel while building BUI-1130.',
      }),
    ),
    ['BUI-1129'],
  );
  assert.deepEqual(textPrerequisites(issue({ description: 'This needs BUI-7 and depends on ABC-12 first.' })), ['BUI-7', 'ABC-12']);
  assert.deepEqual(textPrerequisites(issue({ id: 'BUI-1', description: 'Blocked by BUI-1 itself? No.' })), []);
  assert.deepEqual(textPrerequisites(issue({ description: 'Decode after utf-8 normalisation. See BUI-9 for history.' })), []);
});

test('REQ-LINEAR-26 keel poll waits on a named open prerequisite, inside or outside the project, and builds once it closes', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const logs = [];
  const waiting = issue({ id: 'BUI-5', priority: 1, title: 'wire the status check once example-app BUI-1133 ships' });
  const insider = issue({ id: 'BUI-6', priority: 1, createdAt: '2026-09-02', description: 'Needs BUI-8 merged first.' });
  const blocker = issue({ id: 'BUI-8', priority: 4, labels: ['no-keel'] });
  const states = { 'BUI-1133': 'started' };
  const client = fakeClient([waiting, insider, blocker], states);
  const first = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran), log: (l) => logs.push(l) });
  assert.deepEqual(first, [{ outcome: 'none' }]);
  assert.deepEqual(ran, []);
  assert.deepEqual(client.comments, []);
  assert.ok(
    logs.some((l) => /BUI-5 waits for BUI-1133/.test(l)),
    logs.join('\n'),
  );
  assert.ok(
    logs.some((l) => /BUI-6 waits for BUI-8/.test(l)),
    logs.join('\n'),
  );
  assert.deepEqual(client.read, ['BUI-1133'], 'an open issue in the list is not read again');
  states['BUI-1133'] = 'completed';
  const second = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran) });
  assert.equal(second[0].outcome, 'inReview');
  assert.deepEqual(ran, ['BUI-5']);
});

test('REQ-LINEAR-26 a prerequisite Linear cannot read is logged and not waited on', async () => {
  const { dir } = fixtureRepo();
  const ran = [];
  const logs = [];
  const client = fakeClient([issue({ id: 'BUI-5', description: 'Depends on XYZ-404 landing.' })]);
  const r = await poll({ repo: dir, project: 'x', client, config: {}, runFn: runner(ran), log: (l) => logs.push(l) });
  assert.equal(r[0].outcome, 'inReview');
  assert.ok(
    logs.some((l) => /prerequisite XYZ-404 of BUI-5 not read: Entity not found/.test(l)),
    logs.join('\n'),
  );
});
