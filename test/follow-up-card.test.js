import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { cardFromIssue } from '../src/linear.js';
import { poll, queueFollowUps } from '../src/poll.js';
import { refineReason } from '../src/refine.js';
import { fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-fucard-state-');
});

/** An in-memory Linear that records each created issue; every source is closed, so no relation is added. */
function fakeClient() {
  const created = [];
  let next = 500;
  return {
    created,
    listIssues: async () => [],
    comment: async () => {},
    stateType: async () => 'completed',
    capacity: async () => ({ open: 0, teams: [] }), // room in the workspace: no hold (REQ-LINEAR-37)
    createIssue: async (sourceId, fields) => {
      const id = `BUI-${next++}`;
      created.push({ id, sourceId, fields });
      return id;
    },
  };
}

const noRun = () => assert.fail('no issue should run');
const config = { ...DEFAULTS };

/** File `findings` queued from `source` at the repo's HEAD with `pr`; returns the created descriptions. */
async function filed(files, source, findings, pr = null) {
  const { dir } = fixtureRepo(files);
  const head = g(dir, 'rev-parse', 'HEAD');
  queueFollowUps(dir, source, findings, head, pr);
  const client = fakeClient();
  await poll({ repo: dir, project: 'keel', client, config, runFn: noRun, limit: 0 });
  return { head, created: client.created };
}

const SUB = { 'src/sub.js': 'export const sub = (a, b) => b - a;\n', 'test/basic.test.js': 'ok\n' };

test('REQ-LINEAR-22 a follow-up is a card: context, Problem with the cited line, one EARS requirement, Acceptance, keel block', async () => {
  const { head, created } = await filed(
    SUB,
    'BUI-7',
    [{ kind: 'bug', title: 'sub() subtracts in the wrong order', detail: 'src/sub.js:1' }],
    'https://github.com/o/r/pull/9',
  );
  const d = created[0].fields.description;
  const [first, second] = d.split('\n');
  assert.equal(first, 'Found by keel while building BUI-7.');
  assert.ok(second.includes(head.slice(0, 12)), 'names the commit');
  assert.ok(second.includes('https://github.com/o/r/pull/9'), 'names the PR');
  assert.match(
    d,
    /## Problem\n\n- sub\(\) subtracts in the wrong order \(src\/sub\.js:1\)\n\n`src\/sub\.js:1` reads:\n\n> export const sub = \(a, b\) => b - a;\n/,
  );
  const reqs = /## Requirements\n\n((?:- .*\n)+)/.exec(d)[1].trim().split('\n');
  assert.equal(reqs.length, 1, 'one requirement line');
  assert.match(reqs[0], /^- When .+, the .+ shall .+\.$/);
  assert.match(d, /## Acceptance\n\n- \[ \] A new test that fails before the change and passes after it proves the requirement\./);
  assert.match(d, /```keel\nkind: bug\nsize: S\npaths: src\/\*\*, test\/\*\*, \*\*\/\*\.md\n```/);
  const issue = { id: 'BUI-500', title: 't', description: d, labels: [], estimate: null };
  const card = cardFromIssue(issue);
  assert.deepEqual([card.kind, card.size], ['bug', 'S']);
  assert.equal(refineReason(issue), null, 'Keel never refines its own follow-up');
});

test('REQ-LINEAR-22 a chore follow-up asks for new tests in a new file; one with no source or citation has no paths', async () => {
  const { created } = await filed(SUB, null, [{ kind: 'chore', title: 'cover sub() with tests', detail: 'no tests exist for it' }]);
  const d = created[0].fields.description;
  assert.match(d, /^Found by keel\.\n/);
  assert.match(d, /## Acceptance\n\n- \[ \] New tests in a new test file prove the requirement; no existing test file changes\./);
  assert.match(d, /```keel\nkind: chore\nsize: S\n```/);
  assert.match(d, /## Requirements\n\n- When .+ shall .+\n/);
});

test('REQ-LINEAR-29 a follow-up on a locked file keeps allowEdits and the lock note in the card format', async () => {
  const files = { '.github/workflows/quality.yml': 'jobs:\n  test:\n    timeout-minutes: 10\n', 'src/a.js': 'x\n' };
  const { created } = await filed(files, null, [
    { kind: 'bug', title: 'timeout too short', detail: 'medium .github/workflows/quality.yml:3' },
  ]);
  const d = created[0].fields.description;
  assert.match(
    d,
    /```keel\nkind: bug\nsize: S\npaths: \.github\/workflows\/\*\*, \*\*\/\*\.md\nallowEdits: \.github\/workflows\/quality\.yml\n```/,
  );
  assert.match(d, /must not remove or weaken any check, job, or test step/);
  assert.match(d, /> timeout-minutes: 10/);
});
