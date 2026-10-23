import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { formatReport, readJsonl, readLedger, report } from '../src/ledger.js';
import { linearHttpClient } from '../src/linear-http.js';
import { pollLedgerFile } from '../src/linear.js';
import { poll, pollExitCode } from '../src/poll.js';
import { parseRefine, refineIssue, refinePrompt, refineReason } from '../src/refine.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = new URL('./fake-worker.js', import.meta.url).pathname;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-refine-state-');
});

const scriptFile = (modes) => {
  const file = join(tmp('keel-refine-script-'), 'script.json');
  writeFileSync(file, JSON.stringify(modes));
  return file;
};

/** A fixture config whose only tier is the fake worker answering `answers` in turn; KEEL_FAKE_LOG records each call. */
function setup(answers) {
  const script = scriptFile(answers.map((a) => `say:${a}`));
  const log = join(tmp('keel-refine-log-'), 'calls.jsonl');
  process.env.KEEL_FAKE_LOG = log;
  const config = fixtureConfig({
    tiers: [{ provider: 'exec', model: 'cheap', effort: 'high', command: ['node', FAKE, 'script', script] }],
  });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return { config, calls };
}

const VAGUE = 'The add helper is wrong sometimes. Please make it right.';

const issueOf = (description, over = {}) => ({
  id: 'BUI-7',
  title: 'add is wrong',
  description,
  priority: 2,
  createdAt: '2026-10-01',
  labels: ['Bug'],
  estimate: null,
  blockedBy: [],
  ...over,
});

/** An in-memory Linear: issues by id, comments, description updates, created sub-issues, and closed issues. */
function fakeClient(issues) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  let next = 400;
  const c = {
    comments: [],
    descriptions: [],
    created: [],
    closed: [],
    listIssues: async () => [...byId.values()],
    comment: async (id, body) => c.comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
    done: async (id) => c.closed.push(id),
    setDescription: async (id, description) => {
      c.descriptions.push({ id, description });
      byId.set(id, { ...byId.get(id), description });
    },
    createIssue: async (sourceId, fields, project) => {
      const id = `BUI-${next++}`;
      c.created.push({ id, sourceId, fields, project });
      return id;
    },
  };
  return c;
}

/** A build that passes, recording the card it was given. */
function recorder() {
  const cards = [];
  const fn = ({ card }) => {
    cards.push(card);
    return { pass: true, tier: 0, attempt: 1, branch: `keel/${card.id}`, worktree: '/nonexistent', followUps: [] };
  };
  return { fn, cards };
}

const CARD_BODY = [
  'The calculator page sums with add; a wrong sum shows a wrong total.',
  '',
  '## Requirements',
  '',
  '- REQ-ADD-1: When add(2, 3) is called, the add helper shall return 5.',
  '',
  '## Acceptance',
  '',
  '- [ ] A new test in test/add-sum.test.js calls add(2, 3) and expects 5.',
  '',
  '```keel',
  'kind: bug',
  'size: S',
  'paths: src/**, test/**',
  '```',
].join('\n');

const pollRows = (outcome) => readJsonl(pollLedgerFile()).filter((r) => r.outcome === outcome);
const refineRows = () => readLedger().filter((r) => r.role === 'refine');

test('REQ-LINEAR-33 a CARD answer is written above the original description, commented, and built', async () => {
  const { dir } = fixtureRepo();
  const { config } = setup([`CARD\n${CARD_BODY}`]);
  const client = fakeClient([issueOf(VAGUE)]);
  const build = recorder();
  const results = await poll({ repo: dir, project: 'keel', client, config, runFn: build.fn, refineFn: refineIssue });
  assert.equal(results[0].outcome, 'inReview');
  const [update] = client.descriptions;
  assert.equal(update.id, 'BUI-7');
  assert.match(update.description, /^## Refined by keel\n\n/);
  assert.ok(update.description.indexOf(CARD_BODY) < update.description.indexOf(VAGUE), 'the refined card comes first');
  assert.ok(update.description.includes(VAGUE), 'the original text is kept below');
  const [card] = build.cards;
  assert.equal(card.kind, 'bug');
  assert.deepEqual(card.paths, ['src/**', 'test/**']);
  assert.match(card.text, /the add helper shall return 5/);
  assert.match(client.comments[0].body, /^keel: refined this issue before building/);
  assert.match(client.comments[0].body, /REQ-ADD-1: When add\(2, 3\) is called/);
  assert.equal(pollRows('refined').length, 1);
});

test('REQ-LINEAR-33 an ALREADY_DONE answer goes to the already-done verification and closes the issue without a build', async () => {
  const { dir, base } = fixtureRepo();
  const { config } = setup([`ALREADY_DONE commit ${base.slice(0, 10)}`]);
  const client = fakeClient([issueOf(VAGUE)]);
  const build = recorder();
  const results = await poll({ repo: dir, project: 'keel', client, config, runFn: build.fn, refineFn: refineIssue });
  assert.equal(results[0].outcome, 'alreadyDone');
  assert.equal(build.cards.length, 0, 'nothing is built');
  assert.deepEqual(client.closed, ['BUI-7']);
  assert.match(client.comments.at(-1).body, /already done/);
  assert.match(client.comments.at(-1).body, new RegExp(`commit ${base.slice(0, 10)} is on base`));
  assert.equal(pollRows('alreadyDone').length, 1);
});

test('REQ-LINEAR-33 an ALREADY_DONE answer whose evidence does not hold builds the issue as written', async () => {
  const { dir } = fixtureRepo();
  const { config } = setup(['ALREADY_DONE commit 0123456789abcdef']);
  const client = fakeClient([issueOf(VAGUE)]);
  const build = recorder();
  const results = await poll({ repo: dir, project: 'keel', client, config, runFn: build.fn, refineFn: refineIssue });
  assert.equal(results[0].outcome, 'inReview');
  assert.equal(build.cards.length, 1);
  assert.deepEqual(client.closed, []);
  assert.match(client.comments[0].body, /evidence did not hold/);
});

test('REQ-LINEAR-33 a SPLIT answer files ordered sub-issues and builds none of them this pass', async () => {
  const { dir } = fixtureRepo();
  const second = CARD_BODY.replace('add(2, 3)', 'add(-2, -3)').replace('return 5', 'return -5').replace('expects 5', 'expects -5');
  const { config } = setup([`SPLIT\nTITLE: add sums two positive numbers\n${CARD_BODY}\nTITLE: add sums two negative numbers\n${second}`]);
  const client = fakeClient([issueOf(VAGUE)]);
  const build = recorder();
  const results = await poll({ repo: dir, project: 'keel', client, config, runFn: build.fn, refineFn: refineIssue, limit: 1 });
  assert.equal(results[0].outcome, 'split');
  assert.deepEqual(results[0].children, ['BUI-400', 'BUI-401']);
  assert.equal(build.cards.length, 0, 'nothing is built this pass');
  const [a, b] = client.created;
  assert.equal(a.fields.title, 'add sums two positive numbers');
  assert.equal(a.fields.parent, 'BUI-7');
  assert.equal(a.sourceId, 'BUI-7');
  assert.deepEqual(a.fields.blockedBy, []);
  assert.deepEqual(b.fields.blockedBy, ['BUI-400'], 'the second waits for the first');
  assert.match(a.fields.description, /^Split by keel from BUI-7\./);
  assert.match(a.fields.description, /```keel\nkind: bug\nsize: S/);
  assert.match(client.comments[0].body, /split into BUI-400, BUI-401/);
  assert.equal(pollRows('split').length, 1, 'the parent is recorded, so the next poll does not pick it again');
});

test('REQ-LINEAR-33 a NEEDS_HUMAN answer stops with that question as the human stop reason', async () => {
  const { dir } = fixtureRepo();
  const question = 'braces has no patched version: accept the risk or replace the dependency?';
  const { config } = setup([`NEEDS_HUMAN ${question}`]);
  const client = fakeClient([issueOf(VAGUE)]);
  const build = recorder();
  const results = await poll({ repo: dir, project: 'keel', client, config, runFn: build.fn, refineFn: refineIssue });
  assert.equal(results[0].outcome, 'needsHuman');
  assert.equal(results[0].question, question);
  assert.equal(build.cards.length, 0);
  assert.match(client.comments[0].body, /needs your answer before it can be built/);
  assert.ok(client.comments[0].body.includes(question));
  assert.equal(pollRows('needsHuman')[0].detail.question, question);
  assert.equal(pollExitCode(results), 1);
});

test('REQ-LINEAR-33 an unparseable answer is a visible failure that builds the original issue', async () => {
  const { dir } = fixtureRepo();
  const { config } = setup(['I looked at it and it seems fine to me.']);
  const client = fakeClient([issueOf(VAGUE)]);
  const build = recorder();
  const logs = [];
  const results = await poll({
    repo: dir,
    project: 'keel',
    client,
    config,
    runFn: build.fn,
    refineFn: refineIssue,
    log: (m) => logs.push(m),
  });
  assert.equal(results[0].outcome, 'inReview');
  assert.equal(build.cards.length, 1);
  assert.ok(build.cards[0].text.includes(VAGUE), 'the original issue is built');
  assert.equal(client.descriptions.length, 0);
  assert.match(client.comments[0].body, /did not parse/);
  assert.ok(logs.some((l) => /refine output did not parse/.test(l)));
  assert.equal(refineRows()[0].outcome, 'unparsed');
});

test('REQ-LINEAR-33 a CARD answer that is not a buildable card is unparseable', () => {
  const issue = issueOf(VAGUE);
  assert.equal(parseRefine(`CARD\n${CARD_BODY.replace('size: S', 'size: L')}`, issue).kind, 'unparsed');
  assert.equal(parseRefine(`CARD\n${CARD_BODY.replace(/## Acceptance[\s\S]*?```keel/, '```keel')}`, issue).kind, 'unparsed');
  assert.equal(parseRefine(`CARD\n${CARD_BODY.replace('paths: src/**, test/**\n', '')}`, issue).kind, 'unparsed');
  assert.equal(parseRefine(`Sure! CARD\n${CARD_BODY}`, issue).kind, 'unparsed');
  assert.equal(parseRefine('SPLIT\nTITLE: one\n' + CARD_BODY, issue).kind, 'unparsed', 'a split of one card');
  assert.equal(parseRefine('NEEDS_HUMAN', issue).kind, 'unparsed');
  assert.deepEqual(parseRefine('ALREADY_DONE #12', issue), { kind: 'done', evidence: 'PR #12' });
  assert.deepEqual(parseRefine(`CARD\n${CARD_BODY}\n{"is_error":false}`, issue), { kind: 'card', body: CARD_BODY });
});

test('REQ-LINEAR-32 no refine turn runs for an issue that is already clear or has testable requirements', async () => {
  const { dir } = fixtureRepo();
  const { config, calls } = setup([`CARD\n${CARD_BODY}`]);
  const clear = issueOf(
    `Vague words.\n\n## Requirements\n\n- it should work\n\n## Acceptance\n\n- tested\n\n\`\`\`keel\nkind: bug\n\`\`\``,
    { id: 'BUI-1' },
  );
  const shall = issueOf('- REQ-1: When add(1, 1) runs, it shall return 2.', { id: 'BUI-2' });
  const followUp = issueOf(
    'Found by keel while building BUI-9.\n\n## Problem\n\n- x\n\n## Requirements\n\n- When x, the code shall y.\n\n## Acceptance\n\n- [ ] A new test\n\n```keel\nkind: bug\nsize: S\n```',
    { id: 'BUI-3' },
  );
  const client = fakeClient([clear, shall, followUp]);
  const build = recorder();
  await poll({ repo: dir, project: 'keel', client, config, runFn: build.fn, refineFn: refineIssue, limit: 3 });
  assert.equal(build.cards.length, 3);
  assert.equal(calls().length, 0, 'no refine turn ran');
  assert.equal(refineRows().length, 0);
  assert.equal(client.descriptions.length, 0);
});

test('REQ-LINEAR-32 refineReason names a missing testable requirement or a too-big issue, and is null for a buildable one', () => {
  assert.match(refineReason(issueOf(VAGUE)), /no testable requirements/);
  assert.equal(refineReason(issueOf('- [ ] add(2, 3) returns 5')), null);
  assert.equal(refineReason(issueOf('- REQ-1: the helper shall sum.')), null);
  assert.match(refineReason(issueOf('- REQ-1: it shall sum.', { estimate: 8 })), /too big.*estimate 8/);
  const many = Array.from({ length: 9 }, (_, i) => `- REQ-${i}: it shall do ${i}.`).join('\n');
  assert.match(refineReason(issueOf(many)), /too big.*9 "shall" lines/);
  assert.equal(refineReason(issueOf(`## Refined by keel\n\n${VAGUE}`)), null, 'a refined issue is not refined again');
});

test('REQ-LINEAR-32 with refineIssues off, an unclear issue is built as written with no refine turn', async () => {
  const { dir } = fixtureRepo();
  const { config, calls } = setup([`CARD\n${CARD_BODY}`]);
  const client = fakeClient([issueOf(VAGUE)]);
  const build = recorder();
  await poll({ repo: dir, project: 'keel', client, config: { ...config, refineIssues: false }, runFn: build.fn, refineFn: refineIssue });
  assert.equal(build.cards.length, 1);
  assert.equal(calls().length, 0);
});

test('REQ-LINEAR-32 refineIssues defaults to true and must be true or false', () => {
  const { dir } = fixtureRepo();
  const withChecks = { checks: { test: 'true' }, testCommand: 'true' };
  assert.equal(loadConfig(dir, commit(dir, { 'keel.json': JSON.stringify(withChecks) })).refineIssues, true);
  assert.throws(
    () => loadConfig(dir, commit(dir, { 'keel.json': JSON.stringify({ ...withChecks, refineIssues: 'yes' }) })),
    /"refineIssues" must be true or false/,
  );
});

test('REQ-LINEAR-32 the refine turn is read-only on a temporary checkout of base and gets the issue, keel.json, and the cards format', () => {
  const { dir } = fixtureRepo();
  commit(dir, { 'keel.json': '{"checks":{"t":"true"},"testCommand":"true"}\n' });
  const { config, calls } = setup([`CARD\n${CARD_BODY}`]);
  const r = refineIssue({ repo: dir, base: 'HEAD', config, issue: issueOf(VAGUE), why: 'no testable requirements' });
  assert.equal(r.parsed.kind, 'card');
  const [call] = calls();
  assert.match(call.prompt, /Do not edit, create, or delete any file/);
  assert.match(call.prompt, /"testCommand":"true"/);
  assert.ok(call.prompt.includes(VAGUE));
  assert.match(call.prompt, /When <trigger>, the <system> shall <observable response>/);
  assert.match(call.prompt, /NEEDS_HUMAN <one specific question/);
  assert.equal(g(dir, 'worktree', 'list').split('\n').length, 1, 'the temporary checkout is gone');
  assert.equal(g(dir, 'status', '--porcelain'), '');
  assert.match(refinePrompt(issueOf(VAGUE), null, 'x'), /\(none: Keel defaults apply\)/);
});

test('REQ-LED-17 a refine turn appends a ledger row with role refine, its usage and cost, and the report shows it apart from runs', async () => {
  const { dir } = fixtureRepo();
  const { config } = setup([`CARD\n${CARD_BODY}`]);
  const client = fakeClient([issueOf(VAGUE)]);
  await poll({ repo: dir, project: 'keel', client, config, runFn: recorder().fn, refineFn: refineIssue });
  const [row] = refineRows();
  assert.equal(row.card, 'BUI-7');
  assert.equal(row.outcome, 'card');
  assert.equal(row.cost, 0.01);
  assert.deepEqual(row.usage, { in: 100, out: 10, cached: 50 });
  const rep = report(readLedger());
  assert.equal(rep.total, 0, 'a refine turn is not a run');
  assert.deepEqual(rep.refineTurns, { n: 1, card: 1, done: 0, split: 0, human: 0, unparsed: 0, tokens: 110, cost: 0.01, unpriced: 0 });
  assert.match(
    formatReport(rep),
    /^refine turns: 1 \(card 1, already done 0, split 0, needs human 0, unparsed 0\); tokens 110; cost \$0\.01$/m,
  );
});

test('REQ-LINEAR-33 the HTTP client files a split card as a sub-issue and writes a refined description', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_test';
  const calls = [];
  const responses = [
    { data: { issue: { team: { id: 'team-1' }, project: { id: 'proj-1' } } } },
    { data: { issue: { id: 'uuid-7' } } },
    { data: { issueCreate: { success: true, issue: { identifier: 'BUI-201' } } } },
    { data: { issueUpdate: { success: true } } },
    { data: { issueUpdate: { success: false } } },
  ];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => responses[calls.length - 1] };
  };
  try {
    const client = linearHttpClient();
    assert.equal(await client.createIssue('BUI-7', { title: 'T', description: 'D', priority: 2, parent: 'BUI-7' }), 'BUI-201');
    assert.deepEqual(calls[1].variables, { id: 'BUI-7' });
    assert.deepEqual(calls[2].variables.input, {
      teamId: 'team-1',
      projectId: 'proj-1',
      title: 'T',
      description: 'D',
      priority: 2,
      parentId: 'uuid-7',
    });
    await client.setDescription('BUI-7', 'new text');
    assert.match(calls[3].query, /issueUpdate/);
    assert.deepEqual(calls[3].variables, { id: 'BUI-7', description: 'new text' });
    await assert.rejects(client.setDescription('BUI-7', 'x'), /did not update the description of BUI-7/);
  } finally {
    globalThis.fetch = saved;
    delete process.env.LINEAR_API_KEY;
  }
});
