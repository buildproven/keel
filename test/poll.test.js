import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { checkCard } from '../src/check-card.js';
import { DEFAULTS } from '../src/config.js';
import { attemptedIssueIds, cardFromIssue } from '../src/linear.js';
import { poll, queueFollowUps } from '../src/poll.js';
import { fixtureRepo, g, tmp } from './helpers.js';

const issue = (over = {}) => ({
  id: 'BUI-1',
  title: 'fix the thing',
  description: '- REQ-1: it shall be fixed.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: ['Bug'],
  estimate: null,
  ...over,
});

function fakeClient(issues, comments) {
  return {
    listIssues: async () => issues,
    comment: async (id, body) => comments.push({ id, body }),
    review: async (id) => comments.push({ id, action: 'review' }),
    stateType: async () => 'started',
  };
}

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-poll-state-');
});

test('REQ-LINEAR-4 REQ-LINEAR-5 REQ-LINEAR-13 a passing, non-review run comments the branch and moves the issue to review', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue()], comments);
  const runFn = () => ({ pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1', needsReview: false, worktree: '/wt' });
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  const result = results[0];
  assert.equal(result.outcome, 'inReview');
  assert.deepEqual(
    comments.map((c) => c.action),
    [undefined, 'review'],
  );
  assert.match(comments[0].body, /keel\/BUI-1/);
  assert.match(comments[0].body, /tier 0/);
});

test('REQ-LINEAR-5 a passing run that needs human review comments but changes no state', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue()], comments);
  const runFn = () => ({ pass: true, tier: 2, attempt: 1, branch: 'keel/BUI-1', needsReview: true, worktree: '/wt' });
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  const result = results[0];
  assert.equal(result.outcome, 'needsReview');
  assert.deepEqual(
    comments.map((c) => c.action),
    [undefined],
  );
  assert.match(comments[0].body, /review/i);
});

test('REQ-LINEAR-4 a failing run comments the failure summary and leaves the issue open', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue()], comments);
  const runFn = () => ({ pass: false, stopped: 'max-attempts', failure: 'red-proof: test-passes-on-base', worktree: '/wt' });
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  const result = results[0];
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(
    comments.map((c) => c.action),
    [undefined],
  );
  assert.match(comments[0].body, /test-passes-on-base/);
  assert.match(comments[0].body, /\/wt/);
});

test('REQ-LINEAR-3 an unmappable issue is skipped (commented, not run) and polling continues to the next', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue({ id: 'BUI-1', description: '' }), issue({ id: 'BUI-2', priority: 3 })], comments);
  let ran = null;
  const runFn = (args) => {
    ran = args.card.id;
    return { pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-2', needsReview: false, worktree: '/wt' };
  };
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  const result = results[0];
  assert.equal(result.outcome, 'inReview');
  assert.equal(ran, 'BUI-2');
  assert.deepEqual(comments[0], { id: 'BUI-1', body: 'Skipped by keel poll: no description' });
});

test('REQ-LINEAR-1 REQ-LINEAR-6 no issue left to attempt returns none, and an issue moved to review is not attempted again', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([issue()], []);
  const runFn = () => ({ pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1', needsReview: false, worktree: '/wt' });
  const first = (await poll({ repo: dir, project: 'x', client, config: {}, runFn }))[0];
  assert.equal(first.outcome, 'inReview');
  const second = (await poll({ repo: dir, project: 'x', client, config: {}, runFn: () => assert.fail('should not run again') }))[0];
  assert.equal(second.outcome, 'none');
  assert.deepEqual(attemptedIssueIds(dir), new Set(['BUI-1']));
});

test('REQ-LINEAR-8 --limit caps how many issues are attempted per invocation', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient([issue({ id: 'BUI-1' }), issue({ id: 'BUI-2', priority: 3 })], []);
  let count = 0;
  const runFn = () => {
    count += 1;
    return { pass: true, tier: 0, attempt: 1, branch: `keel/x${count}`, needsReview: false, worktree: '/wt' };
  };
  const results = await poll({ repo: dir, project: 'x', client, config: {}, runFn, limit: 2 });
  assert.equal(results.length, 2);
  assert.equal(count, 2);
});

test('REQ-LINEAR-10 resolveProject prefers --project, then keel.json linearProject, else fails naming both', async () => {
  const { resolveProject } = await import('../src/poll.js');
  assert.equal(resolveProject('cli-proj', { linearProject: null }), 'cli-proj');
  assert.equal(resolveProject(undefined, { linearProject: 'cfg-proj' }), 'cfg-proj');
  assert.throws(() => resolveProject(undefined, { linearProject: null }), /--project.*linearProject|linearProject.*--project/);
});

test('REQ-LINEAR-10 keel.json linearProject defaults to none and must be a non-empty string', async () => {
  const { DEFAULTS, loadConfig } = await import('../src/config.js');
  const { commit, fixtureRepo } = await import('./helpers.js');
  assert.equal(DEFAULTS.linearProject, null);
  const { dir } = fixtureRepo();
  const at = (extra) => {
    commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true', ...extra }) }, 'cfg');
    return 'HEAD';
  };
  assert.throws(() => loadConfig(dir, at({ linearProject: '' })), /linearProject/);
  assert.throws(() => loadConfig(dir, at({ linearProject: 7 })), /linearProject/);
  assert.equal(loadConfig(dir, at({ linearProject: 'keel' })).linearProject, 'keel');
});

test('REQ-LINEAR-10 keel poll with no project anywhere is a usage error, not a stack trace', async () => {
  const { spawnSync } = await import('node:child_process');
  const { commit, fixtureRepo } = await import('./helpers.js');
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': JSON.stringify({ checks: { test: 'true' }, testCommand: 'true' }) }, 'cfg');
  const r = spawnSync(process.execPath, [new URL('../bin/keel.js', import.meta.url).pathname, 'poll', '--repo', dir], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^keel: .*linearProject/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('REQ-LINEAR-15 a blocked card comments the worker reason, leaves the issue open, and is outcome blocked', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = fakeClient([issue()], comments);
  const runFn = () => ({ pass: false, stopped: 'blocked', failure: 'schema has no such column', worktree: '/wt' });
  const [result] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(result.outcome, 'blocked');
  assert.equal(comments.length, 1, 'one comment, no state change');
  assert.match(comments[0].body, /worker reported the card blocked/);
  assert.match(comments[0].body, /schema has no such column/);
  assert.match(comments[0].body, /\/wt/);
});

test('REQ-LINEAR-16 an issue closed while Keel ran is not moved: one comment, outcome closedMeanwhile', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = { ...fakeClient([issue()], comments), stateType: async () => 'completed' };
  const runFn = () => ({ pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1', needsReview: false, worktree: '/wt' });
  const [result] = await poll({ repo: dir, project: 'x', client, config: {}, runFn });
  assert.equal(result.outcome, 'closedMeanwhile');
  assert.deepEqual(
    comments.map((c) => c.action),
    [undefined],
    'commented once, never moved to review',
  );
  assert.match(comments[0].body, /closed while keel ran/i);
  assert.match(comments[0].body, /keel\/BUI-1/);
});

test('REQ-LINEAR-44 a path marked new in the paths line does not defer the card', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const description = [
    '- REQ-1: When sub runs, it shall subtract.',
    '',
    '```keel',
    'kind: feature',
    'paths: src/add.js, src/sub.js (new), ./test/sub.test.js (new)',
    '```',
  ].join('\n');
  const ran = [];
  const runFn = ({ card }) => {
    ran.push(card.paths);
    return { pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-1', needsReview: false, worktree: '/wt' };
  };
  const results = await poll({ repo: dir, project: 'x', client: fakeClient([issue({ description })], comments), config: {}, runFn });
  assert.equal(results[0].outcome, 'inReview');
  assert.deepEqual(ran, [['src/add.js', 'src/sub.js', './test/sub.test.js']], 'the builder scope holds real paths');
  assert.ok(!comments.some((c) => /not on the base/.test(c.body ?? '')));
  assert.deepEqual(cardFromIssue(issue({ description })).newPaths, ['src/sub.js', './test/sub.test.js']);

  // Without the marker the same new file still defers the card.
  const unmarked = description.replace(/ \(new\)/g, '');
  const again = await poll({
    repo: dir,
    project: 'x',
    client: fakeClient([issue({ id: 'BUI-2', description: unmarked })], comments),
    config: {},
    runFn,
  });
  assert.equal(again[0].outcome, 'deferred');
});

/**
 * A repo whose origin (a bare repo) holds `main` and a Dependabot PR head at `refs/pull/30/head`, and a fake gh that
 * answers the PR list, branch protection, and statuses from `gh`, and logs every call.
 */
async function dependabotSetup({
  required = true,
  contexts = [],
  statusFails = false,
  statusesFail = false,
  pullsFail = false,
  movedHead = null,
  msg = 'chore(deps): bump next from 16.4.3 to 16.4.5',
} = {}) {
  const { chmodSync, existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { commit, g, FIXTURE_TEST } = await import('./helpers.js');
  const { dir } = fixtureRepo();
  const remote = tmp('keel-remote-');
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  commit(
    dir,
    { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: false }) },
    'chore: configure keel',
  );
  g(dir, 'push', '-q', 'origin', 'main');
  g(dir, 'checkout', '-q', '-b', 'dependabot/npm_and_yarn/next-16.4.5');
  const head = commit(dir, { 'package.json': '{"type":"module","dependencies":{"next":"16.4.5"}}\n' }, msg);
  g(dir, 'push', '-q', 'origin', `HEAD:refs/pull/30/head`);
  g(dir, 'checkout', '-q', 'main');
  g(dir, 'branch', '-q', '-D', 'dependabot/npm_and_yarn/next-16.4.5');
  const other = g(dir, 'rev-parse', 'main');
  const prs = [
    { number: 30, login: 'dependabot[bot]', base: 'main', head },
    { number: 31, login: 'someone', base: 'main', head: other },
  ];
  const bin = tmp('keel-bin-');
  const log = join(bin, 'calls.jsonl');
  if (movedHead) prs[0].head = movedHead;
  const answers = { prs, required, contexts, statusFails, statusesFail, pullsFail };
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const { prs, required, contexts, statusFails, statusesFail, pullsFail } = ${JSON.stringify(answers)};
const path = a.find((x) => x.startsWith('repos/')) ?? '';
if (pullsFail && path.startsWith('repos/{owner}/{repo}/pulls')) { console.error('HTTP 502'); process.exit(1); }
else if (statusesFail && path.endsWith('/statuses')) { console.error('HTTP 502'); process.exit(1); }
else if (a[0] === 'api' && path.startsWith('repos/{owner}/{repo}/pulls')) for (const p of prs) console.log(JSON.stringify(p));
else if (path.endsWith('/protection/required_status_checks')) console.log(String(required));
else if (path.startsWith('repos/{owner}/{repo}/rules/branches/')) console.log('false');
else if (/\\/commits\\/[0-9a-f]+\\/statuses$/.test(path)) for (const c of contexts) console.log(c);
else if (a.includes('POST') && path.startsWith('repos/{owner}/{repo}/statuses/') && statusFails) { console.error('HTTP 403'); process.exit(1); }
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  const refs = () => g(remote, 'for-each-ref', '--format=%(refname) %(objectname)');
  return { dir, head, bin, calls, refs };
}

async function pollWith(setup, gateFn) {
  const old = process.env.PATH;
  process.env.PATH = `${setup.bin}:${old}`;
  const lines = [];
  try {
    const results = await poll({
      repo: setup.dir,
      project: 'x',
      client: fakeClient([], []),
      config: {},
      runFn: () => assert.fail('no issue to run'),
      gateFn,
      log: (m) => lines.push(m),
    });
    return { results, lines };
  } finally {
    process.env.PATH = old;
  }
}

const receipt = (head, pass, results) => ({ head, pass, results: results ?? [{ name: 'tests', pass: true, problems: [] }] });

test('REQ-LINEAR-53 an ungated Dependabot head is gated in a checkout of that head with a chore card, and its status posted', async () => {
  const { pollExitCode } = await import('../src/poll.js');
  const { g } = await import('./helpers.js');
  const setup = await dependabotSetup();
  const gated = [];
  const gateFn = ({ repo, base, card }) => {
    gated.push({ head: g(repo, 'rev-parse', 'HEAD'), base, kind: card.kind, id: card.id, dirty: g(repo, 'status', '--porcelain') });
    return { receipt: receipt(setup.head, true) };
  };
  const { results } = await pollWith(setup, gateFn);
  assert.deepEqual(gated, [
    { head: setup.head, base: 'origin/main', kind: 'chore', id: `dependabot-30-${setup.head.slice(0, 12)}`, dirty: '' },
  ]);
  const posts = setup.calls().filter((a) => a.includes('POST'));
  assert.equal(posts.length, 1, 'one status, and only on the Dependabot head');
  assert.ok(posts[0].includes(`repos/{owner}/{repo}/statuses/${setup.head}`));
  assert.ok(posts[0].includes('state=success'));
  assert.ok(posts[0].includes('context=keel/gate'));
  assert.ok(!setup.calls().some((a) => a[0] === 'pr' && a[1] === 'comment'), 'a passing gate comments nothing');
  assert.deepEqual(
    results.filter((r) => r.issue === 'PR #30').map((r) => r.outcome),
    ['dependabotGated'],
  );
  assert.ok(!results.some((r) => r.issue === 'PR #31'), 'a PR by anyone else is not gated');
  assert.equal(pollExitCode(results), 0);
});

test('REQ-LINEAR-53 Dependabot gating stays enabled when the Linear issue builder is injected', async () => {
  const setup = await dependabotSetup();
  const { results } = await pollWith(setup);
  const posts = setup.calls().filter((a) => a.includes('POST'));
  assert.equal(posts.length, 1);
  assert.ok(posts[0].includes(`repos/{owner}/{repo}/statuses/${setup.head}`));
  assert.equal(results.find((r) => r.issue === 'PR #30')?.outcome, 'dependabotGated');
});

test('REQ-LINEAR-53 a Dependabot head with no conventional commit type gets a chore card; "build(deps)" keeps its own kind', async () => {
  for (const [msg, kind] of [
    ['Bump next from 16.4.3 to 16.4.5', 'chore'],
    ['build(deps): bump next from 16.4.3 to 16.4.5', 'infra'],
  ]) {
    const setup = await dependabotSetup({ msg });
    const kinds = [];
    await pollWith(setup, ({ card }) => (kinds.push(card.kind), { receipt: receipt(setup.head, true) }));
    assert.deepEqual(kinds, [kind], msg);
  }
});

test('REQ-LINEAR-53 no gate when the base does not require keel/gate, and a status that cannot post fails the poll', async () => {
  const { pollExitCode } = await import('../src/poll.js');
  const off = await dependabotSetup({ required: false });
  await pollWith(off, () => assert.fail('the base does not require keel/gate'));
  assert.ok(!off.calls().some((a) => a.includes('POST')));

  const denied = await dependabotSetup({ statusFails: true });
  const { results, lines } = await pollWith(denied, () => ({ receipt: receipt(denied.head, true) }));
  const [row] = results.filter((r) => r.issue === 'PR #30');
  assert.equal(row.outcome, 'dependabotFailed');
  assert.match(row.detail, /keel\/gate status not posted: HTTP 403/);
  assert.ok(lines.some((l) => /PR #30: keel\/gate status not posted/.test(l)));
  assert.equal(pollExitCode(results), 1);

  const broken = await dependabotSetup();
  const crashed = await pollWith(broken, () => ({ error: 'keel gate exited 2: boom' }));
  assert.equal(crashed.results.find((r) => r.issue === 'PR #30').outcome, 'dependabotFailed');
  assert.ok(!broken.calls().some((a) => a.includes('POST')), 'no gate result, no status');

  const threw = await dependabotSetup();
  const thrown = await pollWith(threw, () => {
    throw new Error('receipt was malformed');
  });
  assert.equal(thrown.results.find((r) => r.issue === 'PR #30').outcome, 'dependabotFailed');
  assert.ok(thrown.lines.some((l) => /PR #30: gate could not run: receipt was malformed/.test(l)));
  assert.ok(!threw.calls().some((a) => a.includes('POST')), 'a thrown gate posts no status');
});

test('REQ-LINEAR-54 a failing Dependabot gate posts failure, comments the failing stage, and pushes nothing', async () => {
  const setup = await dependabotSetup();
  const before = setup.refs();
  const failed = receipt(setup.head, false, [
    { name: 'static', pass: true, problems: [] },
    { name: 'tests', pass: false, problems: [{ rule: 'tests-failed' }] },
  ]);
  const { results } = await pollWith(setup, () => ({ receipt: failed }));
  const posts = setup.calls().filter((a) => a.includes('POST'));
  assert.equal(posts.length, 1);
  assert.ok(posts[0].includes('state=failure'));
  const comments = setup.calls().filter((a) => a[0] === 'pr' && a[1] === 'comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0][2], '30');
  const body = comments[0][comments[0].indexOf('--body') + 1];
  assert.match(body, /failed at tests: tests-failed/);
  assert.match(body, /- tests: tests-failed/);
  assert.match(body, /stays open/);
  assert.doesNotMatch(body, /@/, 'no mention, so no Dependabot command or notification');
  assert.ok(!setup.calls().some((a) => ['close', 'merge', 'edit'].includes(a[1])), 'the PR is left open');
  assert.equal(setup.refs(), before, 'nothing was pushed to origin');
  assert.equal(results.find((r) => r.issue === 'PR #30').outcome, 'dependabotGated');
});

test('REQ-LINEAR-55 a Dependabot head that already has a keel/gate status is not gated again', async () => {
  for (const contexts of [['keel/gate'], ['test', 'keel/gate']]) {
    const setup = await dependabotSetup({ contexts });
    const { results } = await pollWith(setup, () => assert.fail('a gated head is not gated again'));
    assert.ok(!setup.calls().some((a) => a.includes('POST')));
    assert.ok(!results.some((r) => r.issue === 'PR #30'));
  }
  // Another context alone is not keel/gate, so the head is gated.
  const other = await dependabotSetup({ contexts: ['test'] });
  let ran = 0;
  await pollWith(other, () => ((ran += 1), { receipt: receipt(other.head, true) }));
  assert.equal(ran, 1);
});

test('REQ-LINEAR-53 gateHead runs keel gate on the checkout at the head and returns its receipt', async () => {
  const { gateHead } = await import('../src/poll.js');
  const { commit, g, FIXTURE_TEST } = await import('./helpers.js');
  const { dir } = fixtureRepo();
  const base = commit(
    dir,
    { 'keel.json': JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, review: false }) },
    'cfg',
  );
  const head = commit(dir, { 'package.json': '{"type":"module","dependencies":{"x":"2"}}\n' }, 'chore(deps): bump x');
  const { receipt: r, error } = gateHead({ repo: dir, base, card: { id: 'dependabot-30-abc', kind: 'chore', size: 'S' } });
  assert.equal(error, undefined);
  assert.equal(r.head, head);
  assert.equal(r.pass, true, JSON.stringify(r.results));
  assert.equal(g(dir, 'status', '--porcelain'), '', 'the card file is outside the checkout');
  const bad = gateHead({ repo: dir, base: 'no-such-ref', card: { id: 'dependabot-30-abc', kind: 'chore', size: 'S' } });
  assert.match(bad.error, /keel gate exited/);
});

test('REQ-LINEAR-55 REQ-LINEAR-53 no gate when GitHub cannot list the PRs or the head statuses, or the head moved', async () => {
  const cases = [
    [{ pullsFail: true }, /dependabot check skipped: gh api pulls failed: HTTP 502/],
    [{ statusesFail: true }, /PR #30: could not read the statuses of [0-9a-f]+; not gated this poll/],
    [{ movedHead: 'f'.repeat(40) }, /PR #30: head f{40} moved before it was fetched/],
  ];
  for (const [over, line] of cases) {
    const setup = await dependabotSetup(over);
    const { results, lines } = await pollWith(setup, () => assert.fail('nothing to gate'));
    assert.ok(
      lines.some((l) => line.test(l)),
      `${JSON.stringify(over)}: ${lines.join(' | ')}`,
    );
    assert.ok(!setup.calls().some((a) => a.includes('POST')));
    assert.ok(!results.some((r) => r.issue === 'PR #30'));
  }
});

/** An in-memory Linear that records each created issue; every source is closed, so no relation is added. */
function followUpClient() {
  const created = [];
  return {
    created,
    listIssues: async () => [],
    comment: async () => {},
    stateType: async () => 'completed',
    createIssue: async (sourceId, fields) => {
      created.push({ sourceId, fields });
      return `BUI-${800 + created.length}`;
    },
  };
}

const noRunFollowUp = () => assert.fail('no issue should run');
const CITED_BASE = {
  'lib/automation/publish-tools.ts': 'export const publish = 1;\n',
  'mcp/server.ts': 'export const server = 1;\n',
  'test/basic.test.js': 'ok\n',
};

/** File one finding from the repo's HEAD; returns the filed card's keel block and parsed card. */
async function fileFollowUp(dir, finding) {
  queueFollowUps(dir, 'BUI-7', [finding], g(dir, 'rev-parse', 'HEAD'));
  const client = followUpClient();
  await poll({ repo: dir, project: 'keel', client, config: { ...DEFAULTS }, runFn: noRunFollowUp, limit: 0 });
  assert.equal(client.created.length, 1, 'one follow-up filed');
  const description = client.created[0].fields.description;
  const card = cardFromIssue({ id: 'BUI-801', title: 't', description, labels: [], estimate: null });
  return { block: /```keel\n([\s\S]*?)\n```/.exec(description)[1], card, description };
}

test('REQ-LINEAR-56 a follow-up allows every existing file its finding names, not only the cited one', async () => {
  const { dir } = fixtureRepo(CITED_BASE);
  const { card } = await fileFollowUp(dir, {
    kind: 'bug',
    title: 'publish_site reports no build progress',
    detail: 'lib/automation/publish-tools.ts:118 never calls the progress hook that `mcp/server.ts publish_site` passes.',
  });
  assert.ok(card.paths.includes('lib/automation/**'), card.paths.join(', '));
  assert.ok(card.paths.includes('mcp/server.ts'), card.paths.join(', '));
  assert.equal(card.paths.filter((p) => p === 'mcp/server.ts').length, 1);
});

test('REQ-LINEAR-56 a named file the gate locks is also an allowed edit; one a glob covers is not repeated', async () => {
  const { dir } = fixtureRepo({ ...CITED_BASE, '.github/workflows/ci.yml': 'name: ci\n', 'docs/guide.md': 'guide\n' });
  const { card, description } = await fileFollowUp(dir, {
    kind: 'bug',
    title: 'the publish job skips a step',
    detail: 'lib/automation/publish-tools.ts:3 must match `.github/workflows/ci.yml` and docs/guide.md.',
  });
  assert.ok(card.paths.includes('.github/workflows/ci.yml'));
  assert.deepEqual(card.allowEdits, ['.github/workflows/ci.yml']);
  assert.match(
    description,
    /The fix edits `\.github\/workflows\/ci\.yml`, a file the gate locks[^\n]*must not remove or weaken any check, job, or test step/,
  );
  assert.ok(!card.paths.includes('docs/guide.md'), '**/*.md already covers it');
});

test('REQ-LINEAR-56 a follow-up adds the traceability file a new test must be mapped in', async () => {
  const { dir } = fixtureRepo({ ...CITED_BASE, 'docs/traceability.json': '{}\n' });
  const { card, description } = await fileFollowUp(dir, {
    kind: 'bug',
    title: 'publish fails',
    detail: 'lib/automation/publish-tools.ts:1',
  });
  assert.ok(card.paths.includes('docs/traceability.json'), card.paths.join(', '));
  const lines = [];
  const issues = async () => [{ id: 'BUI-801', title: 't', description, labels: [], estimate: null }];
  const code = await checkCard({ repo: dir, base: 'HEAD', target: 'BUI-801', issues, log: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
});

test('REQ-LINEAR-56 a chore follow-up adds no traceability file, as check-card asks for none', async () => {
  const { dir } = fixtureRepo({ ...CITED_BASE, 'docs/traceability.json': '{}\n' });
  const { card } = await fileFollowUp(dir, { kind: 'chore', title: 'tidy publish', detail: 'lib/automation/publish-tools.ts:1' });
  assert.ok(!card.paths.includes('docs/traceability.json'), card.paths.join(', '));
});

test('REQ-LINEAR-56 a named path that is not at base is left out and the card passes check-card', async () => {
  const { dir } = fixtureRepo(CITED_BASE);
  const { card, description } = await fileFollowUp(dir, {
    kind: 'bug',
    title: 'publish_site reports no build progress',
    detail: 'lib/automation/publish-tools.ts:118 needs `mcp/missing.ts` and mcp/server.ts to agree.',
  });
  assert.ok(card.paths.includes('mcp/server.ts'));
  assert.ok(!card.paths.includes('mcp/missing.ts'), card.paths.join(', '));
  const lines = [];
  const issues = async () => [{ id: 'BUI-801', title: 't', description, labels: [], estimate: null }];
  const code = await checkCard({ repo: dir, base: 'HEAD', target: 'BUI-801', issues, log: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
});
