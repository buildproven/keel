import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { pendingFollowUps, recordPollAttempt } from '../src/linear.js';
import { poll, pollExitCode } from '../src/poll.js';
import { fixtureConfig, fixtureRepo, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-archived-source-state-');
});

/** A Linear fake whose `comment` throws `error` for the issues in `archived`, the way Linear answers for an archived issue. */
function fakeClient({ archived = [], error = 'Linear API error: Entity not found: Issue', failCreate = false } = {}) {
  const created = [];
  const comments = [];
  return {
    created,
    comments,
    listIssues: async () => [],
    stateType: async () => 'completed',
    comment: async (id, body) => {
      if (archived.includes(id)) throw new Error(error);
      comments.push({ id, body });
    },
    createIssue: async (sourceId, fields) => {
      if (failCreate) throw new Error('Linear API error: rate limited');
      created.push({ sourceId, fields });
      return `BUI-${100 + created.length}`;
    },
  };
}

/** Queue one finding from each of BUI-1 and BUI-2, then run a file-only poll (the archive already ran). */
async function pollWith(client, { tries = 1 } = {}) {
  const { dir } = fixtureRepo();
  recordPollAttempt(dir, { issue: 'BUI-1', outcome: 'found', detail: [{ kind: 'bug', title: 'finding from one', detail: 'a.js:1' }] });
  recordPollAttempt(dir, { issue: 'BUI-2', outcome: 'found', detail: [{ kind: 'bug', title: 'finding from two', detail: 'b.js:1' }] });
  const logs = [];
  let results;
  for (let i = 0; i < tries; i++)
    results = await poll({
      repo: dir,
      project: 'x',
      client,
      config: fixtureConfig({ followUpsPerDay: 5 }),
      runFn: () => assert.fail('file-only must not build'),
      fileOnly: true,
      log: (l) => logs.push(l),
    });
  return { dir, results, logs };
}

test('REQ-LINEAR-49 a follow-up notice on an archived source issue is skipped and logged, not a filing error', async () => {
  const client = fakeClient({ archived: ['BUI-1'] });
  const { dir, results, logs } = await pollWith(client);
  assert.deepEqual(results, [], JSON.stringify(results));
  assert.equal(pollExitCode(results), 0);
  assert.equal(client.created.length, 2, 'both follow-ups are filed');
  assert.deepEqual(
    client.comments.map((c) => c.id),
    ['BUI-2'],
    'the other source still gets its notice',
  );
  assert.equal(logs.filter((l) => /BUI-1/.test(l) && /archived/.test(l)).length, 1, logs.join('\n'));
  assert.ok(logs.includes('follow-up notice skipped: BUI-1 is archived'), logs.join('\n'));
  assert.ok(!logs.some((l) => /notice failed/.test(l)), logs.join('\n'));
  assert.deepEqual(pendingFollowUps(dir), []);
});

test('REQ-LINEAR-49 the could-not-file notice on an archived source is skipped too; the filing error stays', async () => {
  const client = fakeClient({ archived: ['BUI-1', 'BUI-2'], failCreate: true });
  const { results, logs } = await pollWith(client, { tries: 3 });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'followUpsFailed');
  assert.equal(results[0].detail, 'Linear API error: rate limited', 'only the filing error, no notice error');
  assert.ok(logs.includes('follow-up notice skipped: BUI-1 is archived'), logs.join('\n'));
});

test('REQ-LINEAR-50 a follow-up notice that fails for another reason is still a filing error', async () => {
  const client = fakeClient({ archived: ['BUI-1'], error: 'Linear API error: rate limited' });
  const { results, logs } = await pollWith(client);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'followUpsFailed');
  assert.equal(results[0].detail, 'comment on BUI-1: Linear API error: rate limited');
  assert.equal(pollExitCode(results), 1);
  assert.ok(!logs.some((l) => /archived/.test(l)), logs.join('\n'));
  assert.deepEqual(
    client.comments.map((c) => c.id),
    ['BUI-2'],
  );
});
