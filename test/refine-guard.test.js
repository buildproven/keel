import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { readJsonl } from '../src/ledger.js';
import { pollLedgerFile } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { parseRefine } from '../src/refine.js';
import { learnedStart } from '../src/run.js';
import { commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-refine-guard-');
});

const card = (block) =>
  `## Requirements\n\n- REQ-A-1: When a runs, the tool shall print b.\n\n## Acceptance\n\n- [ ] a new test of a\n\n\`\`\`keel\n${block}\n\`\`\``;
const issue = (over = {}) => ({ id: 'BUI-9', title: 'a is off', description: 'a is off', labels: ['Bug'], estimate: null, ...over });

test('REQ-LINEAR-33 a refined card may not drop a bug to a kind without red proof, nor add allowEdits the issue lacks', () => {
  const chore = parseRefine(`CARD\n${card('kind: chore\nsize: S\npaths: src/**')}`, issue());
  assert.equal(chore.kind, 'unparsed');
  assert.match(chore.why, /kind chore would drop the red proof/);
  const edits = parseRefine(`CARD\n${card('kind: bug\nsize: S\npaths: src/**\nallowEdits: .github/workflows/ci.yml')}`, issue());
  assert.equal(edits.kind, 'unparsed');
  assert.match(edits.why, /allowEdits \.github\/workflows\/ci\.yml is not in the issue's own keel block/);
  const own = issue({ description: '```keel\nallowEdits: test/a.test.js\n```\na is off' });
  assert.equal(parseRefine(`CARD\n${card('kind: bug\nsize: S\npaths: src/**\nallowEdits: test/a.test.js')}`, own).kind, 'card');
  assert.equal(parseRefine(`CARD\n${card('kind: bug\nsize: S\npaths: src/**')}`, issue({ labels: [] })).kind, 'card');
});

test('REQ-LINEAR-33 a refined card whose paths an open branch holds waits for the lease and is not recorded as an attempt', async () => {
  const { dir } = fixtureRepo();
  g(dir, 'checkout', '-q', '-b', 'keel/A');
  commit(dir, { 'src/x.js': 'export const x = 1;\n' }, 'feat: x');
  g(dir, 'checkout', '-q', 'main');
  const key = `${basename(dir)}-test-A`;
  const wt = join(process.env.KEEL_STATE_DIR, 'worktrees', key);
  if (!existsSync(wt)) g(dir, 'worktree', 'add', '-q', wt, 'keel/A');
  mkdirSync(join(process.env.KEEL_STATE_DIR, 'locks', key), { recursive: true });
  writeFileSync(join(process.env.KEEL_STATE_DIR, 'locks', key, 'pid'), String(process.pid));
  const free = issue({ id: 'BUI-10', description: '- REQ-B-1: When b runs, the tool shall print c.\n\n```keel\npaths: lib/**\n```' });
  const client = {
    listIssues: async () => [issue({ priority: 1 }), { ...free, priority: 2 }],
    comment: async () => {},
    review: async () => {},
    stateType: async () => 'started',
    setDescription: async () => {},
  };
  const refineFn = () => ({ tier: 0, parsed: { kind: 'card', body: card('kind: bug\nsize: S\npaths: src/**') } });
  const logs = [];
  const ran = [];
  const results = await poll({
    repo: dir,
    project: 'p',
    client,
    config: fixtureConfig(),
    runFn: ({ card: c }) => {
      ran.push(c.id);
      return { pass: true, tier: 0, attempt: 1, branch: `keel/${c.id}`, worktree: '/nonexistent', followUps: [] };
    },
    refineFn,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(ran, ['BUI-10'], 'the leased card uses no limit slot: the next issue is built');
  assert.equal(results.at(-1).outcome, 'inReview');
  assert.match(logs.join('\n'), /BUI-9 waits for path lease: keel\/A \(src\/x\.js\)/);
  const rows = readJsonl(pollLedgerFile()).filter((r) => r.issue === 'BUI-9');
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ['refined'],
    'only the refine step is recorded, not an attempt',
  );
});

test('REQ-LINEAR-33 when the split comment fails after the sub-issues are filed, the split is still recorded', async () => {
  const { dir } = fixtureRepo();
  const client = {
    listIssues: async () => [issue()],
    comment: async () => {
      throw new Error('Linear down');
    },
    stateType: async () => 'started',
    capacity: async () => ({ open: 0, teams: [] }), // room in the workspace: no hold (REQ-LINEAR-37)
    createIssue: async (source, fields) => `BUI-${fields.title.length}`,
  };
  const cards = [
    { title: 'one', body: card('kind: bug\nsize: S\npaths: src/**') },
    { title: 'three', body: card('kind: bug\nsize: S\npaths: src/**') },
  ];
  const refineFn = () => ({ tier: 0, parsed: { kind: 'split', cards } });
  await assert.rejects(
    poll({ repo: dir, project: 'p', client, config: fixtureConfig(), runFn: () => assert.fail(), refineFn }),
    /Linear down/,
  );
  const [row] = readJsonl(pollLedgerFile()).filter((r) => r.outcome === 'split');
  assert.deepEqual(row.detail.children, ['BUI-3', 'BUI-5']);
});

test('REQ-LED-17 learned routing ignores refine rows when it prices a tier', () => {
  const config = fixtureConfig({
    tiers: [
      { provider: 'exec', model: 'cheap', effort: 'high', command: ['x'] },
      { provider: 'exec', model: 'strong', effort: 'high', command: ['y'] },
    ],
  });
  const at = (i) => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
  const rows = [];
  // Five runs that started on tier 0, two passed first; tier 0 costs $0.10 and tier 1 $1: starting cheap pays.
  for (let i = 0; i < 5; i++)
    rows.push({ repo: '/r', run: `r${i}`, attempt: 1, tier: 0, cost: 0.1, attemptPass: i < 2, workerStatus: 'ok', at: at(i) });
  for (let i = 2; i < 5; i++)
    rows.push({ repo: '/r', run: `r${i}`, attempt: 2, tier: 1, cost: 1, attemptPass: true, workerStatus: 'ok', at: at(i) });
  const plain = learnedStart(rows, '/r', 0, config);
  assert.equal(plain.tier, 0);
  // Many expensive refine turns on tier 0 must not change that.
  const refines = Array.from({ length: 20 }, (_, i) => ({
    repo: '/r',
    run: `f${i}`,
    role: 'refine',
    attempt: 0,
    tier: 0,
    cost: 50,
    at: at(10 + i),
  }));
  assert.deepEqual(learnedStart([...rows, ...refines], '/r', 0, config), plain);
});
