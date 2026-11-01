import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { cardFromIssue } from '../src/linear.js';
import { poll, queueFollowUps } from '../src/poll.js';
import { commit, fixtureRepo, g, tmp } from './helpers.js';

// BUI-1474 named this REQ-LINEAR-38, an ID REQ-LINEAR-38 (findings cards) already held; DESIGN §5 IDs are unique.

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-fupaths-state-');
});

/** An in-memory Linear that records each created issue; every source is closed, so no relation is added. */
function fakeClient() {
  const created = [];
  let next = 700;
  return {
    created,
    listIssues: async () => [],
    comment: async () => {},
    stateType: async () => 'completed',
    createIssue: async (sourceId, fields) => {
      const id = `BUI-${next++}`;
      created.push({ id, sourceId, fields });
      return id;
    },
  };
}

const noRun = () => assert.fail('no issue should run');
const SUB = { 'src/sub.js': 'export const sub = (a, b) => b - a;\n', 'test/basic.test.js': 'ok\n' };
const FINDING = { kind: 'bug', title: 'sub() subtracts in the wrong order', detail: 'src/sub.js:1' };

/** File one finding on src/sub.js from the repo's HEAD; returns the filed description's keel block lines. */
async function keelBlock(dir) {
  queueFollowUps(dir, 'BUI-7', [FINDING], g(dir, 'rev-parse', 'HEAD'));
  const client = fakeClient();
  await poll({ repo: dir, project: 'keel', client, config: { ...DEFAULTS }, runFn: noRun, limit: 0 });
  assert.equal(client.created.length, 1, 'one follow-up filed');
  const d = client.created[0].fields.description;
  const issue = { id: 'BUI-700', title: 't', description: d, labels: [], estimate: null };
  return { block: /```keel\n([\s\S]*?)\n```/.exec(d)[1], card: cardFromIssue(issue) };
}

const UNCHANGED = 'kind: bug\nsize: S\npaths: src/**, test/**, **/*.md';

test('REQ-LINEAR-43 a follow-up names the file every test-adding card also changed', async () => {
  const { dir } = fixtureRepo(SUB);
  // Older than the last 20 test-adding Keel cards: it did not change the files, and it does not count.
  commit(dir, { 'test/old.test.js': 'ok\n', 'src/old.js': 'x\n' }, 'BUI-1: an old card');
  for (let i = 2; i <= 21; i++) {
    const subject = i % 2 ? `BUI-${i}: card ${i}` : `chore(BUI-${i}): keel attempt 1 leftovers`;
    commit(
      dir,
      {
        [`test/c${i}.test.js`]: 'ok\n',
        [`src/c${i}.js`]: `${i}\n`,
        'docs/traceability.json': `{"n":${i}}\n`,
        'vitest.workspace.js': `export default ${i};\n`,
        'docs/DESIGN.md': `${i}\n`, // every card changed it, but `**/*.md` already covers it
      },
      subject,
    );
  }
  // Neither a hand commit nor a Keel card that added no test breaks the pattern.
  commit(dir, { 'test/hand.test.js': 'ok\n' }, 'fix: a hand-made test');
  commit(dir, { 'README.md': 'docs\n' }, 'BUI-30: docs only');
  const { block, card } = await keelBlock(dir);
  assert.equal(
    block,
    'kind: bug\nsize: S\npaths: src/**, test/**, **/*.md, docs/traceability.json, vitest.workspace.js\nallowEdits: vitest.workspace.js',
  );
  assert.deepEqual(card.allowEdits, ['vitest.workspace.js'], 'the locked test list is an allowed edit');
  assert.ok(card.paths.includes('docs/traceability.json'), 'the card parses with the generated file in scope');
});

test('REQ-LINEAR-43 a repo with no such file keeps the paths unchanged', async () => {
  // No Keel card at all.
  assert.equal((await keelBlock(fixtureRepo(SUB).dir)).block, UNCHANGED);

  // Test-adding Keel cards with no file in common; hand commits share one, and they do not count.
  const none = fixtureRepo(SUB).dir;
  commit(none, { 'test/a.test.js': 'ok\n', 'src/a.js': 'a\n' }, 'BUI-1: card a');
  commit(none, { 'test/b.test.js': 'ok\n', 'lib/b.js': 'b\n' }, 'chore(BUI-2): keel attempt 2 leftovers');
  commit(none, { 'test/h1.test.js': 'ok\n', 'gen.json': '1\n' }, 'feat: by hand');
  commit(none, { 'test/h2.test.js': 'ok\n', 'gen.json': '2\n' }, 'feat: by hand again');
  assert.equal((await keelBlock(none)).block, UNCHANGED);

  // One test-adding card is not a pattern: its own files are not every card's.
  const one = fixtureRepo(SUB).dir;
  commit(one, { 'test/a.test.js': 'ok\n', 'gen.json': '1\n' }, 'BUI-1: card a');
  assert.equal((await keelBlock(one)).block, UNCHANGED);

  // A file every card changed that is gone from the base is not named.
  const gone = fixtureRepo(SUB).dir;
  commit(gone, { 'test/a.test.js': 'ok\n', 'gen.json': '1\n' }, 'BUI-1: card a');
  commit(gone, { 'test/b.test.js': 'ok\n', 'gen.json': '2\n' }, 'BUI-2: card b');
  commit(gone, { 'gen.json': null }, 'chore: drop gen.json');
  assert.equal((await keelBlock(gone)).block, UNCHANGED);
});

test('REQ-LINEAR-43 a card merged as a merge commit of keel/<ID> counts as its whole branch', async () => {
  const { dir } = fixtureRepo(SUB);
  for (const id of ['BUI-1', 'BUI-2']) {
    g(dir, 'checkout', '-q', '-b', `keel/${id}`);
    commit(dir, { [`test/${id}.test.js`]: 'ok\n' }, `test: ${id}`);
    commit(dir, { 'docs/traceability.json': `"${id}"\n` }, 'chore: regenerate');
    g(dir, 'checkout', '-q', 'main');
    commit(dir, { [`src/${id}.js`]: 'x\n' }, `fix: main moves on before ${id}`);
    g(dir, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${id.slice(4)} from o/keel/${id}`, `keel/${id}`);
  }
  assert.equal((await keelBlock(dir)).block, `${UNCHANGED}, docs/traceability.json`);
});
