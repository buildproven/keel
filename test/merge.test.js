import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { mergeReadiness } from '../src/doctor.js';
import { poll } from '../src/poll.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const builder = { provider: 'exec', family: 'claude', model: 'exec-good', effort: 'low', command: ['node', FAKE, 'good'] };
const reviewer = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-review',
  effort: 'high',
  command: ['node', '-e', "require('fs').readFileSync(0); console.log('VERDICT: pass')"],
};
const card = (header = 'kind: bug\nsize: S') => parseCard(`# BUI-9: fix add\n${header}\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n`);
let ghLog;
let oldPath;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

/** A fake `gh`: `api` prints FAKE_GH_CHECKS (required-check count), `pr create` prints a URL, `pr merge` exits FAKE_GH_MERGE_EXIT. */
function withFakeGh(fn, { checks = '1', mergeExit = '0' } = {}) {
  const bin = tmp('keel-bin-');
  ghLog = join(bin, 'calls.jsonl');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(a) + '\\n');
if (a[0] === 'api') { console.log(${JSON.stringify(checks)}); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'create') { console.log('https://example.test/pr/1'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'merge') process.exit(${mergeExit});
process.exit(0);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = oldPath;
  }
}
const ghCalls = () =>
  existsSync(ghLog)
    ? readFileSync(ghLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const call = (verb) => ghCalls().find((a) => a[0] === 'pr' && a[1] === verb);

function repoWithRemote() {
  const { dir } = fixtureRepo();
  const remote = tmp('keel-remote-');
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

test('REQ-RUN-20 --merge enables GitHub auto-merge of exactly the certified SHA once the gate, review included, passed', () => {
  const dir = repoWithRemote();
  const r = withFakeGh(() =>
    run({ repo: dir, card: card(), config: fixtureConfig({ review: true, tiers: [builder, reviewer] }), pr: true, merge: true }),
  );
  assert.equal(r.pass, true, r.failure);
  assert.deepEqual(r.merge, { state: 'auto', reason: null });
  assert.deepEqual(call('merge'), [
    'pr',
    'merge',
    'https://example.test/pr/1',
    '--auto',
    '--squash',
    '--match-head-commit',
    r.receipt.head,
  ]);
  const create = call('create');
  assert.ok(!create.includes('--draft'));
  assert.match(create[create.indexOf('--body') + 1], /Auto-merge: on/);
});

test('REQ-RUN-20 no auto-merge without review, and a protected change needs held-out tests (draft PR with the reason)', () => {
  const off = withFakeGh(() =>
    run({ repo: repoWithRemote(), card: card(), config: fixtureConfig({ tiers: [builder, reviewer] }), pr: true, merge: true }),
  );
  assert.equal(off.merge.state, 'off');
  assert.match(off.merge.reason, /review is off/);
  assert.equal(call('merge'), undefined);

  const prot = withFakeGh(() =>
    run({
      repo: repoWithRemote(),
      card: card(),
      config: fixtureConfig({ review: true, protected: ['src/**'], tiers: [builder, reviewer] }),
      pr: true,
      merge: true,
    }),
  );
  assert.equal(prot.merge.state, 'off');
  assert.match(prot.merge.reason, /held-out/);
  const create = call('create');
  assert.ok(create.includes('--draft'));
  assert.match(create[create.indexOf('--body') + 1], /Auto-merge: off — protected change without held-out tests/);

  const held = tmp('keel-held-');
  mkdirSync(join(held, 'test'));
  writeFileSync(
    join(held, 'test', 'held.test.js'),
    "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n",
  );
  const proven = withFakeGh(() =>
    run({
      repo: repoWithRemote(),
      card: card(`kind: bug\nsize: S\nheldOut: ${held}`),
      config: fixtureConfig({ review: true, protected: ['src/**'], tiers: [builder, reviewer] }),
      pr: true,
      merge: true,
    }),
  );
  assert.equal(proven.merge.state, 'auto', proven.merge.reason);
});

test('REQ-CLI-4 REQ-RUN-20 no required status checks on the base branch means no auto-merge; a failed merge call is reported', () => {
  const none = withFakeGh(
    () =>
      run({
        repo: repoWithRemote(),
        card: card(),
        config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
        pr: true,
        merge: true,
      }),
    { checks: '0' },
  );
  assert.equal(none.merge.state, 'off');
  assert.match(none.merge.reason, /no required status checks/);
  assert.equal(call('merge'), undefined);
  const failed = withFakeGh(
    () =>
      run({
        repo: repoWithRemote(),
        card: card(),
        config: fixtureConfig({ review: true, tiers: [builder, reviewer] }),
        pr: true,
        merge: true,
      }),
    { mergeExit: '1' },
  );
  assert.equal(failed.merge.state, 'failed');
});

test('REQ-CLI-4 keel doctor reports merge readiness: review on and required checks on the base branch', () => {
  const dir = repoWithRemote();
  assert.deepEqual(
    withFakeGh(() => mergeReadiness({ repo: dir, branch: 'main', config: fixtureConfig({ review: true }) })),
    { ready: true, reason: null },
  );
  assert.match(withFakeGh(() => mergeReadiness({ repo: dir, branch: 'main', config: fixtureConfig() })).reason, /review is off/);
  assert.match(
    withFakeGh(() => mergeReadiness({ repo: dir, branch: 'main', config: fixtureConfig({ review: true }) }), { checks: '0' }).reason,
    /no required status checks on main/,
  );
});

test('REQ-RUN-20 keel poll --merge passes merge to the run and reports an auto-merge on the issue', async () => {
  const { dir } = fixtureRepo();
  const comments = [];
  const client = {
    listIssues: async () => [
      {
        id: 'BUI-1',
        title: 't',
        description: '- REQ-1: it shall work.',
        priority: 2,
        createdAt: '2026-09-01',
        labels: ['Bug'],
        estimate: null,
      },
    ],
    comment: async (id, body) => comments.push({ id, body }),
    review: async (id) => comments.push({ id, action: 'review' }),
    stateType: async () => 'started',
  };
  let seen;
  const runFn = (args) => {
    seen = args;
    return {
      pass: true,
      tier: 0,
      attempt: 1,
      branch: 'keel/BUI-1',
      needsReview: true,
      worktree: '/wt',
      pr: { ok: true, out: 'https://example.test/pr/1' },
      merge: { state: 'auto', reason: null },
    };
  };
  const [result] = await poll({ repo: dir, project: 'x', client, config: {}, runFn, pr: true, merge: true });
  assert.equal(seen.merge, true);
  assert.equal(result.outcome, 'autoMerge');
  assert.match(comments[0].body, /auto-merge is on/);
  assert.equal(comments[1].action, 'review');
});
