import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { checkCard } from '../src/check-card.js';
import { DEFAULTS } from '../src/config.js';
import { poll, pollExitCode } from '../src/poll.js';
import { commit, fixtureRepo, tmp } from './helpers.js';

// BUI-2139 (2026-11-23): `keel poll` ran only the missing-path and traceability checks of `keel check-card`, so a card
// that check-card rejects for a locked file was built and then failed by the gate (BUI-2109, BUI-2120).

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

const card = (kind, paths) => `- REQ-1: When add runs, it shall add.\n\n\`\`\`keel\nkind: ${kind}\npaths: ${paths}\n\`\`\``;

const pollRows = () =>
  readFileSync(join(process.env.KEEL_STATE_DIR, 'poll-ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const noBuild = () => assert.fail('a card that check-card rejects is not built');

/** check-card's lines for one issue, without the `check-card <id>: ` prefix that names the command. */
async function checkCardLines(dir, one) {
  const lines = [];
  const code = await checkCard({ repo: dir, base: 'HEAD', target: one.id, issues: async () => [one], log: (m) => lines.push(m) });
  return { code, lines: lines.map((l) => l.replace(`check-card ${one.id}: `, '')) };
}

test('REQ-CARD-15 poll defers a card that names a locked verification file without allowEdits, with check-card message', async () => {
  const { dir } = fixtureRepo();
  commit(dir, { '.github/workflows/ci.yml': 'on: push\n' }, 'ci');
  const locked = issue('BUI-1', card('chore', 'src/add.js, .github/workflows/ci.yml'));
  const c = client([locked]);
  const results = await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn: noBuild, issue: 'BUI-1' });
  const deferred = results.find((r) => r.issue === 'BUI-1');
  assert.equal(deferred.outcome, 'deferred');
  assert.equal(pollExitCode(results), 3);
  const { code, lines } = await checkCardLines(dir, locked);
  assert.equal(code, 1);
  assert.ok(lines.length > 0);
  const body = c.comments.find((x) => x.id === 'BUI-1')?.body ?? '';
  for (const l of lines) assert.ok(body.includes(l), `the comment holds check-card's line "${l}":\n${body}`);
  assert.match(body, /\.github\/workflows\/ci\.yml is locked \(verification file\)/);
  const row = pollRows().at(-1);
  assert.equal(row.outcome, 'deferred');
  assert.deepEqual(row.detail.lockedWithoutAllow, ['.github/workflows/ci.yml']);
});

test('REQ-CARD-15 poll defers a card whose only test paths are locked existing tests, with check-card message', async () => {
  const { dir } = fixtureRepo();
  const locked = issue('BUI-2', card('bug', 'src/add.js, test/basic.test.js'));
  const free = issue('BUI-3', card('bug', 'src/add.js, test/add.test.js (new)'), 2);
  const c = client([locked, free]);
  const ran = [];
  const runFn = ({ card: built }) => {
    ran.push(built.id);
    return { pass: true, tier: 0, attempt: 1, branch: `keel/${built.id}`, worktree: '/tmp/x' };
  };
  const results = await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn, limit: 1 });
  assert.deepEqual(ran, ['BUI-3'], 'the rejected card is not built and takes no limit slot; the next one builds');
  assert.equal(results.find((r) => r.issue === 'BUI-2').outcome, 'deferred');
  const { code, lines } = await checkCardLines(dir, locked);
  assert.equal(code, 1);
  const body = c.comments.find((x) => x.id === 'BUI-2')?.body ?? '';
  for (const l of lines) assert.ok(body.includes(l), `the comment holds check-card's line "${l}":\n${body}`);
  assert.match(body, /every test file in paths is on base .* locked \(test\/basic\.test\.js\)/);
  assert.deepEqual(pollRows().find((r) => r.issue === 'BUI-2').detail.lockedTests, ['test/basic.test.js']);
});

test('REQ-CARD-15 a traceability file the card does not cover defers the card in poll too', async () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'docs/TRACEABILITY.md': '# T\n' }, 'traceability');
  const one = issue('BUI-4', card('feature', 'src/add.js, test/add.test.js (new)'));
  const c = client([one]);
  const results = await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn: noBuild, issue: 'BUI-4' });
  assert.equal(results.at(-1).outcome, 'deferred');
  const { lines } = await checkCardLines(dir, one);
  const body = c.comments.find((x) => x.id === 'BUI-4')?.body ?? '';
  for (const l of lines) assert.ok(body.includes(l), `the comment holds check-card's line "${l}":\n${body}`);
  assert.match(body, /docs\/TRACEABILITY\.md is a traceability file/);
});

test('REQ-CARD-15 a second poll with the same reasons does not comment again; changed reasons comment', async () => {
  const { dir } = fixtureRepo();
  commit(dir, { '.github/workflows/ci.yml': 'on: push\n' }, 'ci');
  const c = client([issue('BUI-5', card('chore', 'src/add.js, .github/workflows/ci.yml'))]);
  await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn: noBuild });
  // A new base commit changes the sha in the messages, not the reasons: still no second comment.
  commit(dir, { 'README.md': '# r\n' }, 'unrelated');
  await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn: noBuild });
  assert.equal(c.comments.filter((x) => x.id === 'BUI-5').length, 1, 'one comment for the same reasons');
  assert.deepEqual(
    pollRows().map((r) => r.outcome),
    ['deferred', 'deferred'],
  );
  const c2 = client([issue('BUI-5', card('chore', 'src/add.js, .github/workflows/ci.yml, lib/gone.js'))]);
  await poll({ repo: dir, project: 'p', client: c2, config: { ...DEFAULTS }, runFn: noBuild });
  const body = c2.comments.find((x) => x.id === 'BUI-5')?.body ?? '';
  assert.match(body, /`lib\/gone\.js`/, 'a changed set of reasons is commented');
  assert.match(body, /ci\.yml is locked/);
});

test('REQ-CARD-15 a legacy deferral row with only missing paths counts as the same reasons', async () => {
  const { dir } = fixtureRepo();
  const c = client([issue('BUI-6', card('chore', 'src/add.js, lib/gone.js'))]);
  // The row an older keel wrote: detail holds `missing` only.
  const { recordPollAttempt } = await import('../src/linear.js');
  recordPollAttempt(dir, { issue: 'BUI-6', outcome: 'deferred', detail: { missing: ['lib/gone.js'] } });
  await poll({ repo: dir, project: 'p', client: c, config: { ...DEFAULTS }, runFn: noBuild });
  assert.equal(c.comments.filter((x) => x.id === 'BUI-6').length, 0, 'no second comment after an upgrade');
});

test('REQ-CARD-15 a card that check-card passes is built by poll', async () => {
  const { dir } = fixtureRepo();
  commit(dir, { '.github/workflows/ci.yml': 'on: push\n' }, 'ci');
  const ok = issue(
    'BUI-7',
    `${card('bug', 'src/add.js, test/add.test.js (new), .github/workflows/ci.yml')}`.replace(
      '```keel\n',
      '```keel\nallowEdits: .github/workflows/ci.yml\n',
    ),
  );
  assert.equal((await checkCardLines(dir, ok)).code, 0);
  const ran = [];
  const c = client([ok]);
  await poll({
    repo: dir,
    project: 'p',
    client: c,
    config: { ...DEFAULTS },
    runFn: ({ card: built }) => {
      ran.push(built.id);
      return { pass: true, tier: 0, attempt: 1, branch: `keel/${built.id}`, worktree: '/tmp/x' };
    },
  });
  assert.deepEqual(ran, ['BUI-7']);
  assert.ok(!c.comments.some((x) => /deferred, not built/.test(x.body)));
});
