import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { poll, pollExitCode } from '../src/poll.js';
import { fixtureRepo, tmp } from './helpers.js';

// The card's own ID, REQ-LINEAR-36, already names the Linear HTTP retry rule; this rule takes the next free ID.

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const issue = (id, description, priority = 1) => ({
  id,
  title: id,
  description,
  priority,
  createdAt: '2026-10-01',
  labels: [],
  estimate: null,
});

const client = (issues) => ({
  comments: [],
  listIssues: async () => issues,
  comment: async function (id, body) {
    this.comments.push({ id, body });
  },
  review: async () => {},
  stateType: async () => 'started',
  createIssue: async () => assert.fail('no follow-ups'),
});

const pass =
  (ran) =>
  ({ card }) => {
    ran.push(card.id);
    return { pass: true, tier: 0, attempt: 1, branch: `keel/${card.id}`, worktree: '/tmp/x' };
  };

const pollRows = () =>
  readFileSync(join(process.env.KEEL_STATE_DIR, 'poll-ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const card = (paths, body = '- REQ-1: When add runs, it shall add.') => `${body}\n\n\`\`\`keel\nkind: feature\npaths: ${paths}\n\`\`\``;

test('REQ-LINEAR-44 an issue that names a file missing on base is deferred with a comment', async () => {
  const { dir } = fixtureRepo();
  const missing = issue('BUI-1', card('src/add.js, src/**, lib/missing.js, docs/gone.md'));
  const free = issue('BUI-2', card('src/add.js'), 2);
  const ran = [];
  const c = client([missing, free]);
  const results = await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn: pass(ran), limit: 1 });
  assert.deepEqual(ran, ['BUI-2'], 'the issue with a missing file is not built and takes no limit slot; the next one builds');
  const deferred = results.find((r) => r.issue === 'BUI-1');
  assert.equal(deferred.outcome, 'deferred');
  assert.equal(pollExitCode(results), 3);
  const comment = c.comments.find((x) => x.id === 'BUI-1');
  assert.ok(comment, 'the issue gets a comment');
  assert.match(comment.body, /`lib\/missing\.js`/);
  assert.match(comment.body, /`docs\/gone\.md`/);
  assert.doesNotMatch(comment.body, /`src\/add\.js`/, 'a file on base is not listed');
  assert.doesNotMatch(comment.body, /src\/\*\*/, 'a glob is not checked');
  const row = pollRows().find((r) => r.issue === 'BUI-1');
  assert.equal(row.outcome, 'deferred');
  assert.deepEqual(row.detail.missing, ['lib/missing.js', 'docs/gone.md']);

  // The next poll tries it again: once the file is on base, it builds.
  const again = [];
  const c2 = client([issue('BUI-1', card('src/add.js'))]);
  await poll({ repo: dir, project: 'p', client: c2, config: { ...DEFAULTS }, runFn: pass(again) });
  assert.deepEqual(again, ['BUI-1'], 'a deferred issue is tried again by the next poll');
});

test('REQ-LINEAR-44 an issue whose new file is marked new builds', async () => {
  const { dir } = fixtureRepo();
  const marked = issue(
    'BUI-3',
    card(
      'src/add.js, src/sub.js, test/sub.test.js, ./src/mul.js',
      [
        '- REQ-1: When sub runs, it shall subtract. Put it in the new module `src/sub.js`.',
        '- REQ-2: All tests go in the new file `test/sub.test.js`; no existing test file changes.',
        '- REQ-3: `src/mul.js` (new) shall multiply.',
      ].join('\n'),
    ),
  );
  const ran = [];
  const c = client([marked]);
  const results = await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn: pass(ran) });
  assert.deepEqual(ran, ['BUI-3']);
  assert.equal(results.at(-1).outcome, 'inReview');
  assert.ok(!c.comments.some((x) => /not on the base|does not mark new/.test(x.body)));
});

test('REQ-LINEAR-44 a path named without "new" in its own sentence is still missing, and an explicit --issue retry defers too', async () => {
  const { dir } = fixtureRepo();
  // "new" in an earlier sentence, or inside another path, does not mark this one new.
  const body = '- REQ-1: Add a new check. Then `src/sub.js` shall subtract, beside `src/new.js`.';
  const c = client([issue('BUI-4', card('src/sub.js', body))]);
  const results = await poll({
    repo: dir,
    project: 'p',
    client: c,
    config: { ...DEFAULTS },
    runFn: () => assert.fail('a card with a missing file never runs'),
    issue: 'BUI-4',
  });
  assert.equal(results.at(-1).outcome, 'deferred');
  assert.match(c.comments.find((x) => x.id === 'BUI-4').body, /`src\/sub\.js`/);
  assert.equal(pollRows().at(-1).outcome, 'deferred');
});

test('REQ-LINEAR-44 a later poll that finds the same files missing does not comment again', async () => {
  const { dir } = fixtureRepo();
  const c = client([issue('BUI-5', card('lib/missing.js'))]);
  const runFn = () => assert.fail('never built');
  await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn });
  await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn });
  assert.equal(c.comments.filter((x) => x.id === 'BUI-5').length, 1, 'one comment for the same missing files');
  assert.deepEqual(
    pollRows().map((r) => r.outcome),
    ['deferred', 'deferred'],
  );
  const c2 = client([issue('BUI-5', card('lib/missing.js, lib/other.js'))]);
  await poll({ repo: dir, project: 'p', client: c2, config: { ...DEFAULTS }, runFn });
  assert.match(c2.comments.find((x) => x.id === 'BUI-5').body, /`lib\/other\.js`/, 'a changed list is commented');
});
