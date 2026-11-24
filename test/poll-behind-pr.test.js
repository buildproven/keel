import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { cardFromIssue, recordPollAttempt } from '../src/linear.js';
import { pendingSelfMerges } from '../src/merge.js';
import { poll } from '../src/poll.js';
import { commit, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const issue = (id) => ({
  id,
  title: id,
  description: '- REQ-1: it shall work.',
  priority: 2,
  createdAt: '2026-09-01',
  labels: [],
  estimate: null,
});

const armed = { enabledAt: '2026-11-23T10:00:00Z' };

/**
 * A repo with an origin, a `keel/BUI-7` branch with one commit, and a base that moved on after it. The fake `gh` lists
 * `prs`, makes `pr update-branch` merge origin's base into the branch on origin (or fails when `updateFails`), and logs
 * every call.
 */
function setup({ prs, updateFails = false, statusFails = false }) {
  const { dir } = fixtureRepo();
  const remote = tmp('keel-remote-');
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  g(dir, 'push', '-q', 'origin', 'main');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-7');
  commit(dir, { 'src/feature.js': 'export const f = 1;\n' }, 'fix(BUI-7): the fix');
  g(dir, 'push', '-q', 'origin', 'keel/BUI-7');
  g(dir, 'checkout', '-q', 'main');
  g(dir, 'branch', '-q', '-D', 'keel/BUI-7');
  commit(dir, { 'src/other.js': 'export const o = 1;\n' }, 'feat: another merge');
  g(dir, 'push', '-q', 'origin', 'main');
  recordPollAttempt(dir, { issue: 'BUI-7', outcome: 'autoMerge' });
  const bin = tmp('keel-bin-');
  const log = join(bin, 'calls.jsonl');
  const clone = join(tmp('keel-clone-'), 'c');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
const fs = require('fs');
const { execFileSync } = require('child_process');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const git = (...x) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...x], { cwd: ${JSON.stringify(clone)}, stdio: 'pipe' });
if (a[0] === 'api' && a[1] === 'graphql') for (const p of ${JSON.stringify(prs)}) console.log(JSON.stringify(p));
else if (a[0] === 'pr' && a[1] === 'update-branch') {
  if (${JSON.stringify(updateFails)}) { console.error('HTTP 422: merge conflict between base and head'); process.exit(1); }
  execFileSync('git', ['clone', '-q', ${JSON.stringify(remote)}, ${JSON.stringify(clone)}], { stdio: 'pipe' });
  git('checkout', '-q', 'keel/BUI-7');
  git('merge', '-q', '--no-edit', 'origin/main');
  git('push', '-q', 'origin', 'keel/BUI-7');
} else if (a[0] === 'api' && a.includes('POST') && ${JSON.stringify(statusFails)}) { console.error('HTTP 403'); process.exit(1); }
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
  return { dir, bin, calls, remote };
}

async function pollWith(s, { gateFn, issues = [issue('BUI-7')] } = {}) {
  const comments = [];
  const built = [];
  const client = {
    listIssues: async () => issues,
    comment: async (id, body) => comments.push({ id, body }),
    review: async () => {},
    stateType: async () => 'started',
  };
  const runFn = ({ card }) => (built.push(card.id), { pass: true, tier: 0, attempt: 1, branch: `keel/${card.id}`, worktree: '/tmp/x' });
  const old = process.env.PATH;
  process.env.PATH = `${s.bin}:${old}`;
  try {
    await poll({ repo: s.dir, project: 'x', client, config: {}, runFn, gateFn });
  } finally {
    process.env.PATH = old;
  }
  return { comments, built };
}

const behindPr = {
  number: 5,
  headRefName: 'keel/BUI-7',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BEHIND',
  autoMergeRequest: armed,
};
const passing = (repo) => ({
  receipt: { head: g(repo, 'rev-parse', 'HEAD'), pass: true, results: [{ name: 'tests', pass: true, problems: [] }] },
});
const closes = (s) => s.calls().filter((a) => a[0] === 'pr' && a[1] === 'close');

test('REQ-LINEAR-58 a behind PR is updated from its base, its new head gated with the issue card, and kept open', async () => {
  const s = setup({ prs: [behindPr] });
  const gated = [];
  const gateFn = (args) => {
    const head = g(args.repo, 'rev-parse', 'HEAD');
    gated.push({
      head,
      base: args.base,
      id: args.card.id,
      text: args.text,
      parents: g(args.repo, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length - 1,
    });
    return passing(args.repo);
  };
  const { comments, built } = await pollWith(s, { gateFn });
  const calls = s.calls();
  assert.ok(
    calls.some((a) => a[0] === 'pr' && a[1] === 'update-branch' && a[2] === '5'),
    'the branch is updated from its base',
  );
  assert.deepEqual(closes(s), [], 'a behind PR with no conflict is never closed');
  assert.ok(!calls.some((a) => a[0] === 'pr' && a[1] === 'merge' && a.includes('--disable-auto')), 'auto-merge stays armed');
  const originHead = g(s.remote, 'rev-parse', 'keel/BUI-7');
  assert.equal(gated.length, 1);
  assert.equal(gated[0].head, originHead, 'the head gated is the one the update pushed');
  assert.equal(gated[0].parents, 2, 'the update is a merge of the base into the branch');
  assert.equal(gated[0].base, 'origin/main');
  assert.equal(gated[0].id, 'BUI-7');
  assert.match(gated[0].text, /REQ-1: it shall work/, 'the gate reads the issue card');
  const post = calls.find((a) => a.includes('POST'));
  assert.ok(post.includes(`repos/{owner}/{repo}/statuses/${originHead}`), 'keel/gate is posted on the new head');
  assert.ok(post.includes('state=success'));
  assert.deepEqual(built, [], 'nothing is built again');
  assert.deepEqual(comments, []);
});

/** The held-out directory `keel run` keeps for BUI-7 in `repo`, with `hash` as the card hash it was authored for. */
function heldOutFor(repo, hash) {
  const key = `${basename(repo)}-${createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 8)}-BUI-7`;
  const held = join(process.env.KEEL_STATE_DIR, 'heldout', key);
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, 'held.test.js'), '// held out\n');
  writeFileSync(`${held}.card-hash`, `${hash}\n`);
  return held;
}

const cardHashOf = (card) => createHash('sha256').update(JSON.stringify(card)).digest('hex');

test('REQ-LINEAR-58 the gate of an updated head gets the held-out directory authored for the card', async () => {
  const s = setup({ prs: [behindPr] });
  const held = heldOutFor(s.dir, cardHashOf(cardFromIssue(issue('BUI-7'))));
  const texts = [];
  await pollWith(s, { gateFn: (a) => (texts.push(a.text), passing(a.repo)) });
  assert.equal(texts.length, 1);
  assert.match(texts[0], new RegExp(`^heldOut: ${held.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.deepEqual(closes(s), []);
});

test('REQ-LINEAR-58 held-out tests authored for other card text are not given to the gate', async () => {
  const s = setup({ prs: [behindPr] });
  heldOutFor(s.dir, cardHashOf(cardFromIssue({ ...issue('BUI-7'), description: '- REQ-1: an older card text.' })));
  const texts = [];
  await pollWith(s, { gateFn: (a) => (texts.push(a.text), passing(a.repo)) });
  assert.equal(texts.length, 1);
  assert.doesNotMatch(texts[0], /heldOut:/);
  assert.deepEqual(closes(s), []);
});

test('REQ-LINEAR-58 a pending self-merge of the PR waits on the new certified head', async () => {
  const s = setup({ prs: [behindPr] });
  const prUrl = 'https://github.com/o/r/pull/5';
  const { recordSelfMerge } = await import('../src/merge.js');
  recordSelfMerge(s.dir, { issue: 'BUI-7', pr: prUrl, sha: 'old'.padEnd(40, '0') });
  await pollWith(s, { gateFn: (a) => passing(a.repo) });
  const [pending] = pendingSelfMerges(s.dir).filter((m) => m.issue === 'BUI-7');
  assert.equal(pending.sha, g(s.remote, 'rev-parse', 'keel/BUI-7'));
});

test('REQ-LINEAR-58 a failed update closes the PR and builds again, naming the update step', async () => {
  const s = setup({ prs: [behindPr], updateFails: true });
  let gated = 0;
  const { comments, built } = await pollWith(s, { gateFn: (a) => (gated++, passing(a.repo)) });
  assert.equal(gated, 0, 'no head is gated when the update failed');
  const [close] = closes(s);
  assert.equal(close[2], '5');
  assert.ok(close.includes('--delete-branch'));
  const text = close[close.indexOf('--comment') + 1];
  assert.match(text, /behind the base branch/);
  assert.match(text, /update step/);
  assert.match(text, /merge conflict/);
  assert.deepEqual(built, ['BUI-7']);
  assert.ok(
    comments.some((c) => c.id === 'BUI-7' && /PR #5 was behind the base branch; building again/.test(c.body) && /update step/.test(c.body)),
  );
});

test('REQ-LINEAR-58 a failed gate of the updated head closes the PR and builds again, naming the gate step', async () => {
  const s = setup({ prs: [behindPr] });
  const gateFn = (a) => ({
    receipt: {
      head: g(a.repo, 'rev-parse', 'HEAD'),
      pass: false,
      results: [{ name: 'tests', pass: false, problems: [{ rule: 'test-failed' }] }],
    },
  });
  const { comments, built } = await pollWith(s, { gateFn });
  const [close] = closes(s);
  assert.match(close[close.indexOf('--comment') + 1], /gate step/);
  assert.match(close[close.indexOf('--comment') + 1], /tests: test-failed/);
  assert.ok(!s.calls().some((a) => a.includes('POST')), 'a failing head gets no status');
  assert.deepEqual(built, ['BUI-7']);
  assert.ok(comments.some((c) => /gate step/.test(c.body)));
});

test('REQ-LINEAR-58 a gate that cannot run, one that judged another head, and a status that is not posted each close the PR', async () => {
  const cases = [
    ['gate', { gateFn: () => ({ error: 'keel gate exited 2: usage' }), re: /gate step.*usage/ }],
    ['gate', { gateFn: () => ({ receipt: { head: 'f'.repeat(40), pass: true, results: [] } }), re: /not [0-9a-f]{40}/ }],
    [
      'gate',
      {
        gateFn: () => {
          throw new Error('boom');
        },
        re: /could not run: boom/,
      },
    ],
    ['status', { gateFn: (a) => passing(a.repo), re: /status step.*keel\/gate not posted/, statusFails: true }],
  ];
  for (const [, c] of cases) {
    const s = setup({ prs: [behindPr], statusFails: Boolean(c.statusFails) });
    const { built } = await pollWith(s, { gateFn: c.gateFn });
    const [close] = closes(s);
    assert.match(close[close.indexOf('--comment') + 1], c.re);
    assert.deepEqual(built, ['BUI-7']);
  }
});

test('REQ-LINEAR-58 a behind PR whose issue is not open is closed at the card step, without an update', async () => {
  const s = setup({ prs: [behindPr] });
  await pollWith(s, { gateFn: (a) => passing(a.repo), issues: [] });
  assert.ok(!s.calls().some((a) => a[1] === 'update-branch'));
  assert.match(closes(s)[0].at(-1), /card step/);
});

test('REQ-LINEAR-58 a conflicting PR is closed and rebuilt without an update, as REQ-LINEAR-23 says', async () => {
  const s = setup({ prs: [{ ...behindPr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }] });
  let gated = 0;
  const { comments, built } = await pollWith(s, { gateFn: (a) => (gated++, passing(a.repo)) });
  assert.equal(gated, 0);
  assert.ok(!s.calls().some((a) => a[1] === 'update-branch'));
  const [close] = closes(s);
  assert.match(close[close.indexOf('--comment') + 1], /conflicts with the base branch/);
  assert.doesNotMatch(close[close.indexOf('--comment') + 1], /step/);
  assert.deepEqual(built, ['BUI-7']);
  assert.ok(comments.some((c) => /PR #5 conflicted with the base branch; building again/.test(c.body)));
});

test('REQ-LINEAR-58 a behind PR without auto-merge armed is left alone: no update, no close', async () => {
  const s = setup({ prs: [{ ...behindPr, autoMergeRequest: null }] });
  await pollWith(s, { gateFn: (a) => passing(a.repo) });
  assert.ok(!s.calls().some((a) => a[1] === 'update-branch' || a[1] === 'close'));
});

test('REQ-LINEAR-58 an issue card that names its own held-out tests is gated with them, as keel run does', async () => {
  const s = setup({ prs: [behindPr] });
  const own = tmp('keel-own-held-');
  writeFileSync(join(own, 'own.test.js'), '// held out by the card\n');
  const withHeld = { ...issue('BUI-7'), description: `- REQ-1: it shall work.\n\n\`\`\`keel\nheldOut: ${own}\n\`\`\`\n` };
  const gated = [];
  await pollWith(s, { gateFn: (a) => (gated.push(a), passing(a.repo)), issues: [withHeld] });
  assert.equal(gated.length, 1);
  assert.equal(gated[0].card.heldOut, own);
  assert.equal(parseCard(gated[0].text).heldOut, own, 'the card file the gate reads keeps its heldOut line');
  assert.match(gated[0].text, new RegExp(`heldOut: ${own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.deepEqual(closes(s), []);
});
