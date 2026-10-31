import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DEFAULTS, parseCard } from '../src/config.js';
import { linearHttpClient } from '../src/linear-http.js';
import { poll, pollExitCode } from '../src/poll.js';
import { buildPrompt, run } from '../src/run.js';
import { fileURLToPath } from 'node:url';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));

const card = () => parseCard('# BUI-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n');

/** A builder that fixes add(), adds its test, and leaves KEEL_FOLLOWUP with `lines`. */
const builder = (lines) => ({
  provider: 'exec',
  family: 'claude',
  model: 'exec-follow',
  effort: 'low',
  command: [
    'node',
    '-e',
    `const fs = require('fs'); fs.readFileSync(0);
fs.writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\\n');
fs.mkdirSync('test', { recursive: true });
fs.writeFileSync('test/add.test.js', "import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n");
fs.writeFileSync('KEEL_FOLLOWUP', ${JSON.stringify(lines.join('\n'))});
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
  ],
});

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

test('REQ-RUN-26 the builder prompt tells the worker to write work outside the card to KEEL_FOLLOWUP, not to do it', () => {
  const prompt = buildPrompt(card(), fixtureConfig(), null);
  assert.match(
    prompt,
    /outside this card[^\n]*do not do it[^\n]*KEEL_FOLLOWUP[^\n]*<bug\|feature\|chore>: <title> — <why, with path:line>/,
  );
});

test('REQ-RUN-26 Keel reads and removes KEEL_FOLLOWUP: at most 5 distinct items, 300 characters each, unknown kind is chore', () => {
  const { dir } = fixtureRepo();
  const lines = [
    'bug: sub() subtracts in the wrong order — src/sub.js:1',
    'feature: add a mul() helper — src/add.js has no product',
    'BUG: sub() subtracts in the wrong order — src/sub.js:1',
    `chore: ${'x'.repeat(400)}`,
    'tidy the README — README.md:1',
    '',
    'bug: one — a:1',
    'bug: two — b:1',
  ];
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [builder(lines)] }) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.followUps.length, 5);
  assert.deepEqual(r.followUps[0], { kind: 'bug', title: 'sub() subtracts in the wrong order', detail: 'src/sub.js:1' });
  assert.deepEqual(r.followUps[1], { kind: 'feature', title: 'add a mul() helper', detail: 'src/add.js has no product' });
  assert.ok(r.followUps.every((f) => `${f.kind}: ${f.title} — ${f.detail}`.length <= 300 + 20));
  assert.equal(r.followUps[2].kind, 'chore');
  assert.deepEqual(r.followUps[3], { kind: 'chore', title: 'tidy the README', detail: 'README.md:1' });
  assert.equal(g(r.worktree, 'ls-files', 'KEEL_FOLLOWUP'), '', 'never committed');
});

test('REQ-RUN-27 on a pass, non-blocking review notes on changed files become bug follow-ups', () => {
  const { dir } = fixtureRepo();
  const reviewer = {
    provider: 'exec',
    family: 'codex',
    model: 'exec-review',
    effort: 'high',
    command: [
      'node',
      '-e',
      "require('fs').readFileSync(0); console.log('FINDING low src/add.js:1 add(-0, 0) returns 0, not -0'); console.log('VERDICT: pass')",
    ],
  };
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ review: true, tiers: [builder([]), reviewer] }) });
  assert.equal(r.pass, true, r.failure);
  assert.deepEqual(r.followUps, [{ kind: 'bug', title: 'Review: add(-0, 0) returns 0, not -0', detail: 'low src/add.js:1' }]);
});

const issue = {
  id: 'BUI-7',
  title: 't',
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: [],
  estimate: null,
};

function fakeClient(open = [issue]) {
  const created = [];
  const comments = [];
  let next = 100;
  return {
    created,
    comments,
    listIssues: async () => [...open, ...created.map((c) => c.issue)],
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
    createIssue: async (sourceId, fields) => {
      const id = `BUI-${next++}`;
      created.push({
        sourceId,
        fields,
        issue: {
          id,
          title: fields.title,
          description: fields.description,
          priority: 4,
          createdAt: '2026-10-12',
          labels: [],
          estimate: null,
        },
      });
      return id;
    },
  };
}

const passing = (followUps) => () => ({ pass: true, tier: 0, attempt: 1, branch: 'keel/BUI-7', worktree: '/tmp/x', followUps });
const F = [
  { kind: 'bug', title: 'sub() subtracts in the wrong order', detail: 'src/sub.js:1' },
  { kind: 'feature', title: 'add a mul() helper', detail: 'src/add.js' },
];

test('REQ-LINEAR-22 poll files each follow-up as a Low issue that names its source and carries a keel kind block', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: passing(F) });
  assert.equal(client.created.length, 2);
  const [first] = client.created;
  assert.equal(first.sourceId, 'BUI-7');
  assert.equal(first.fields.title, 'sub() subtracts in the wrong order');
  assert.equal(first.fields.priority, 4);
  assert.match(first.fields.description, /Found by keel while building BUI-7/);
  assert.match(first.fields.description, /- sub\(\) subtracts in the wrong order \(src\/sub\.js:1\)/);
  assert.match(first.fields.description, /```keel\nkind: bug\nsize: S\npaths: [^\n]+\n```/);
  assert.match(client.comments.at(-1).body, /follow-ups filed: BUI-100, BUI-101/);
});

test('REQ-LINEAR-22 a filed follow-up is not marked attempted, so the next poll builds it', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: passing(F.slice(0, 1)) });
  const seen = [];
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: ({ card: c }) => (seen.push(c.id), passing([])()) });
  assert.deepEqual(seen, ['BUI-100']);
});

test('REQ-LINEAR-22 a follow-up whose title matches an open issue is skipped, and followUpsPerDay caps filing per repo per day', async () => {
  const { dir } = fixtureRepo();
  const dup = { ...issue, id: 'BUI-50', title: 'SUB() subtracts in the wrong order', priority: 4 };
  const client = fakeClient([issue, dup]);
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS, followUpsPerDay: 1 }, runFn: passing(F) });
  assert.deepEqual(
    client.created.map((c) => c.fields.title),
    ['add a mul() helper'],
  );
  await poll({
    repo: dir,
    project: 'x',
    client,
    config: { ...DEFAULTS, followUpsPerDay: 1 },
    runFn: passing([{ kind: 'bug', title: 'another', detail: 'c:1' }]),
  });
  assert.equal(client.created.length, 1, 'cap reached for today');
  const off = fakeClient();
  await poll({ repo: fixtureRepo().dir, project: 'x', client: off, config: { ...DEFAULTS, followUpsPerDay: 0 }, runFn: passing(F) });
  assert.equal(off.created.length, 0);
});

test('REQ-LINEAR-22 a deferred run queues and files its follow-ups too, so a resumed run loses none', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  const wt = `${tmp('keel-wt-')}/wt`;
  g(dir, 'worktree', 'add', '-q', '-b', 'keel/BUI-7', wt);
  const runFn = () => ({ pass: false, stopped: 'quota', branch: 'keel/BUI-7', worktree: wt, failure: 'limit', followUps: F });
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn });
  assert.equal(client.created.length, 2);
});

test('REQ-LINEAR-22 follow-ups over the daily cap wait in the queue and are filed on a later day', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  const config = { ...DEFAULTS, followUpsPerDay: 1 };
  await poll({ repo: dir, project: 'x', client, config, runFn: passing(F) });
  assert.equal(client.created.length, 1);
  const file = join(process.env.KEEL_STATE_DIR, 'poll-ledger.jsonl');
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.stringify({ ...JSON.parse(l), at: yesterday }))
      .join('\n') + '\n',
  );
  await poll({ repo: dir, project: 'x', client, config, runFn: passing([]) });
  assert.deepEqual(
    client.created.map((c) => c.fields.title),
    ['sub() subtracts in the wrong order', 'add a mul() helper'],
  );
});

test('REQ-LINEAR-22 when listing issues fails, the queued follow-ups stay queued', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  const list = client.listIssues;
  let calls = 0;
  client.listIssues = async (p) => {
    if (++calls === 2) throw new Error('Linear API error: 502');
    return list(p);
  };
  const first = await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: passing(F) });
  assert.match(first.at(-1).detail, /502/);
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: passing([]) });
  assert.equal(client.created.length, 2);
});

test('REQ-LINEAR-22 followUpsPerDay defaults to 20, a fuse (REQ-LINEAR-42)', () => {
  assert.equal(DEFAULTS.followUpsPerDay, 20);
});

let calls;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINEAR_API_KEY;
});

test('REQ-LINEAR-22 listIssues reads every page, so dedupe sees issues past the first 100', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const node = (id) => ({
    identifier: id,
    title: id,
    description: 'd',
    priority: 3,
    createdAt: '2026-10-01',
    estimate: null,
    labels: { nodes: [] },
  });
  const pages = [
    { data: { issues: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node('BUI-1')] } } },
    { data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node('BUI-2')] } } },
  ];
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body).variables);
    return { ok: true, json: async () => pages[sent.length - 1] };
  };
  const issues = await linearHttpClient().listIssues('x');
  assert.deepEqual(
    issues.map((i) => i.id),
    ['BUI-1', 'BUI-2'],
  );
  assert.equal(sent[1].after, 'c1');
});

test('REQ-LINEAR-22 a failed filing comments what was filed, then fails visibly', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  const create = client.createIssue;
  client.createIssue = async (source, fields) => {
    if (client.created.length) throw new Error('Linear API error: rate limited');
    return create(source, fields);
  };
  const failed = await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: passing(F) });
  assert.equal(failed.at(-1).outcome, 'followUpsFailed');
  assert.match(failed.at(-1).detail, /rate limited/);
  assert.equal(pollExitCode(failed), 1);
  assert.match(client.comments.at(-1).body, /follow-ups filed: BUI-100; filing the rest failed/);
});

test('REQ-LINEAR-22 createIssue files in the source issue team and project and returns the new identifier', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  calls = [];
  const responses = [
    { data: { issue: { team: { id: 'team-1' }, project: { id: 'proj-1' } } } },
    { data: { issueCreate: { success: true, issue: { identifier: 'BUI-200' } } } },
  ];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => responses[calls.length - 1] };
  };
  const id = await linearHttpClient().createIssue('BUI-7', { title: 'T', description: 'D', priority: 4 });
  assert.equal(id, 'BUI-200');
  assert.deepEqual(calls[0].variables, { id: 'BUI-7' });
  assert.deepEqual(calls[1].variables, { input: { teamId: 'team-1', projectId: 'proj-1', title: 'T', description: 'D', priority: 4 } });
});

test('REQ-RUN-26 an auth stop returns the follow-ups found by earlier attempts', () => {
  const { dir } = fixtureRepo();
  const finder = {
    provider: 'exec',
    family: 'claude',
    model: 'exec-find',
    effort: 'low',
    command: [
      'node',
      '-e',
      `require('fs').readFileSync(0); require('fs').writeFileSync('KEEL_FOLLOWUP', 'bug: found it — a.js:1\\n'); console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }));`,
    ],
  };
  const authFail = { ...finder, model: 'exec-auth', command: ['node', FAKE, 'auth'] };
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ tiers: [finder, authFail] }) });
  assert.equal(r.stopped, 'auth');
  assert.deepEqual(r.followUps, [{ kind: 'bug', title: 'found it', detail: 'a.js:1' }]);
});

test('REQ-RUN-27 review notes have their own cap, so five builder items do not crowd them out', () => {
  const { dir } = fixtureRepo();
  const reviewer = {
    provider: 'exec',
    family: 'codex',
    model: 'exec-review',
    effort: 'high',
    command: [
      'node',
      '-e',
      "require('fs').readFileSync(0); console.log('FINDING low src/add.js:1 note one'); console.log('VERDICT: pass')",
    ],
  };
  const lines = ['bug: a — x:1', 'bug: b — x:2', 'bug: c — x:3', 'bug: d — x:4', 'bug: e — x:5'];
  const r = run({ repo: dir, card: card(), config: fixtureConfig({ review: true, tiers: [builder(lines), reviewer] }) });
  assert.equal(r.pass, true, r.failure);
  assert.equal(r.followUps.length, 6);
  assert.equal(r.followUps.at(-1).title, 'Review: note one');
});

test('REQ-LINEAR-22 follow-ups whose filing failed are filed by the next poll', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  const create = client.createIssue;
  let fail = true;
  client.createIssue = async (source, fields) => {
    if (fail && client.created.length) throw new Error('Linear API error: rate limited');
    return create(source, fields);
  };
  const failed = await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: passing(F) });
  assert.equal(failed.at(-1).outcome, 'followUpsFailed');
  assert.match(failed.at(-1).detail, /rate limited/);
  assert.equal(pollExitCode(failed), 1);
  fail = false;
  const seen = [];
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: ({ card: c }) => (seen.push(c.id), passing([])()) });
  assert.deepEqual(
    client.created.map((c) => c.fields.title),
    ['sub() subtracts in the wrong order', 'add a mul() helper'],
  );
  assert.ok(client.comments.some((c) => c.id === 'BUI-7' && /follow-ups filed: BUI-101\./.test(c.body)));
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: passing([]) });
  assert.equal(client.created.length, 2, 'filed once');
});

test('REQ-LINEAR-22 a follow-up Linear rejects three times leaves the queue with a comment, and never blocks a poll', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  client.createIssue = async () => {
    throw new Error('Linear API error: title invalid');
  };
  const seen = [];
  const runFn = ({ card: c }) => (seen.push(c.id), passing(F.slice(0, 1))());
  const other = { ...issue, id: 'BUI-8', createdAt: '2026-09-02' };
  client.listIssues = async () => [issue, other];
  for (let i = 0; i < 3; i++) await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn });
  assert.deepEqual(seen, ['BUI-7', 'BUI-8'], 'filing errors did not stop the runs');
  assert.ok(
    client.comments.some(
      (c) =>
        c.id === 'BUI-7' &&
        /could not file follow-up "sub\(\) subtracts in the wrong order" after 3 tries: Linear API error: title invalid/.test(c.body),
    ),
  );
  const after = await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn });
  assert.ok(!after.some((r) => r.outcome === 'followUpsFailed'), 'no longer tried');
});

test('REQ-LINEAR-22 with --issue, a start-of-poll filing error is in the results', async () => {
  const { dir } = fixtureRepo();
  const client = fakeClient();
  await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS, followUpsPerDay: 0 }, runFn: passing(F) });
  client.createIssue = async () => {
    throw new Error('Linear API error: down');
  };
  const r = await poll({ repo: dir, project: 'x', client, config: { ...DEFAULTS }, runFn: passing([]), issue: 'BUI-7' });
  assert.equal(r[0].outcome, 'followUpsFailed');
  assert.equal(pollExitCode(r), 1);
});
