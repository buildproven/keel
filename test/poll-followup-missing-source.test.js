import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { pendingFollowUps, pollLedgerFile } from '../src/linear.js';
import { readJsonl } from '../src/ledger.js';
import { poll, pollExitCode, queueFollowUps } from '../src/poll.js';
import { fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-missing-source-state-');
});

const GONE = 'Linear API error: Entity not found: Issue';

/**
 * A Linear fake in which the issues in `missing` do not exist (archived or deleted): reading their state, commenting on
 * them, or filing into their home answers `Entity not found: Issue`, as Linear does. `stateError` makes every state read
 * fail with that message instead.
 */
function fakeClient({ missing = [], stateError = null } = {}) {
  const created = [];
  const comments = [];
  const gone = (id) => {
    if (missing.includes(id)) throw new Error(GONE);
  };
  return {
    created,
    comments,
    listIssues: async () => [],
    stateType: async (id) => {
      if (stateError) throw new Error(stateError);
      gone(id);
      return 'started';
    },
    comment: async (id, body) => {
      gone(id);
      comments.push({ id, body });
    },
    createIssue: async (sourceId, fields, project) => {
      gone(sourceId);
      for (const b of fields.blockedBy ?? []) gone(b);
      const id = `BUI-${900 + created.length}`;
      created.push({ id, sourceId, fields, project });
      return id;
    },
  };
}

const SRC = { 'src/sub.js': 'export const sub = (a, b) => b - a;\n', 'test/basic.test.js': 'ok\n' };

/** Queue `findings` per source (in order), then run `times` file-only polls. */
async function pollWith(client, queued, { times = 1 } = {}) {
  const { dir } = fixtureRepo(SRC);
  for (const [source, findings] of queued) queueFollowUps(dir, source, findings, g(dir, 'rev-parse', 'HEAD'));
  const logs = [];
  const all = [];
  for (let i = 0; i < times; i++)
    all.push(
      await poll({
        repo: dir,
        project: 'two-dinners',
        client,
        config: { ...DEFAULTS, followUpsPerDay: 5 },
        runFn: () => assert.fail('file-only must not build'),
        fileOnly: true,
        log: (l) => logs.push(l),
      }),
    );
  return { dir, logs, results: all.at(-1), all };
}

// A finding that cites a file of the repo takes the append path (REQ-LINEAR-38); one that cites none goes straight to filing.
const onFile = (title) => ({ kind: 'bug', title, detail: 'src/sub.js:1' });
const noFile = (title) => ({ kind: 'bug', title, detail: 'no file cited' });

test('REQ-LINEAR-52 a follow-up whose source Linear no longer finds (append path) is filed source-less in the polled project', async () => {
  const client = fakeClient({ missing: ['TD-013'] });
  const { dir, results, logs } = await pollWith(client, [
    ['TD-013', [onFile('sub() is reversed')]],
    ['BUI-7', [noFile('second finding')]],
  ]);
  assert.deepEqual(results, [], logs.join('\n'));
  assert.equal(pollExitCode(results), 0);
  const first = client.created.find((c) => c.fields.title === 'sub() is reversed');
  assert.ok(first, 'the item is filed');
  assert.equal(first.sourceId, null, 'no source home to read');
  assert.equal(first.project, 'two-dinners');
  assert.equal(first.fields.blockedBy, undefined, 'nothing to wait for');
  assert.ok(
    client.created.some((c) => c.fields.title === 'second finding'),
    'the item behind it is filed too',
  );
  assert.ok(!client.comments.some((c) => c.id === 'TD-013'), 'no notice to the missing source');
  assert.ok(
    logs.some((l) => l === 'follow-up source TD-013 not found in Linear; filing its follow-ups in two-dinners'),
    logs.join('\n'),
  );
  assert.deepEqual(pendingFollowUps(dir), []);
});

test('REQ-LINEAR-52 a follow-up whose source Linear no longer finds (create path) is filed source-less in the polled project', async () => {
  const client = fakeClient({ missing: ['TD-013'] });
  const { dir, results, logs } = await pollWith(client, [['TD-013', [noFile('a finding'), noFile('another finding')]]]);
  assert.deepEqual(results, [], logs.join('\n'));
  assert.deepEqual(
    client.created.map((c) => [c.fields.title, c.sourceId, c.fields.blockedBy]),
    [
      ['a finding', null, undefined],
      ['another finding', null, undefined],
    ],
  );
  assert.deepEqual(client.comments, []);
  assert.equal(logs.filter((l) => /TD-013 not found in Linear/.test(l)).length, 1, 'logged once per source');
  assert.deepEqual(pendingFollowUps(dir), []);
});

test('REQ-LINEAR-52 another Linear error on the source state is still a filing error', async () => {
  const client = fakeClient({ stateError: 'Linear API error: rate limited' });
  const { dir, results } = await pollWith(client, [['BUI-7', [noFile('a finding')]]]);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'followUpsFailed');
  assert.equal(results[0].detail, 'Linear API error: rate limited');
  assert.equal(client.created.length, 0);
  assert.equal(pendingFollowUps(dir)[0].tries, 1, 'the try is counted');
});

test('REQ-LINEAR-52 a Linear error on the source state in the append path counts a try, so the item cannot pin the queue', async () => {
  const client = fakeClient({ stateError: 'Linear API error: rate limited' });
  const { dir, all } = await pollWith(client, [['BUI-7', [onFile('sub() is reversed')]]], { times: 3 });
  for (const r of all) assert.equal(r[0]?.outcome, 'followUpsFailed', JSON.stringify(all));
  const errors = readJsonl(pollLedgerFile()).filter((r) => r.repo === dir && r.outcome === 'file-error');
  assert.equal(errors.length, 3, 'each poll counts one try');
  assert.equal(errors[0].detail.title, 'sub() is reversed');
  assert.deepEqual(pendingFollowUps(dir, 3), [], 'after FILE_TRIES tries the item leaves the queue');
});
