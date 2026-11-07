import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { checkCard, missingOnBase } from '../src/check-card.js';
import { DEFAULTS } from '../src/config.js';
import { cardFromIssue } from '../src/linear.js';
import { poll } from '../src/poll.js';
import { UsageError } from '../src/usage.js';
import { fixtureRepo, tmp } from './helpers.js';

const BIN = new URL('../bin/keel.js', import.meta.url).pathname;

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

function keel(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env } });
}

/** A card file outside the repo, as the cards skill drafts one. */
function cardFile(text) {
  const file = join(tmp('keel-card-'), 'BUI-9.md');
  writeFileSync(file, text);
  return file;
}

const card = (paths, body = '- REQ-1: When add runs, it shall add.') =>
  `# BUI-9: add numbers\nkind: bug\nsize: S\npaths: ${paths}\n\n## Requirements\n\n${body}\n`;

test('REQ-CARD-7 check-card lists each unmarked missing path with the fix and exits 1', () => {
  const { dir } = fixtureRepo();
  const file = cardFile(card('src/add.js, ./src/gone.js, src/fresh.js (new), src/**'));
  const r = keel(['check-card', file, '--repo', dir, '--base', 'HEAD']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /src\/gone\.js/);
  assert.ok(r.stderr.includes('mark it `src/gone.js (new)`'), r.stderr);
  assert.doesNotMatch(r.stderr, /src\/fresh\.js/, 'a path marked new is not listed');
  assert.doesNotMatch(r.stderr, /src\/add\.js/, 'a path on base is not listed');
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
});

test('REQ-CARD-7 check-card lists every unmarked missing path, one line each', () => {
  const { dir } = fixtureRepo();
  const file = cardFile(card('lib/a.js, lib/b.js'));
  const r = keel(['check-card', file, '--repo', dir, '--base', 'HEAD']);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes('mark it `lib/a.js (new)`'), r.stderr);
  assert.ok(r.stderr.includes('mark it `lib/b.js (new)`'), r.stderr);
});

test('REQ-CARD-8 check-card prints one passing line and exits 0 when every exact path is on base or marked new', () => {
  const { dir } = fixtureRepo();
  const file = cardFile(card('src/add.js, src/fresh.js (new), test/add.test.js, lib/**', 'Put it in the new file `test/add.test.js`.'));
  const r = keel(['check-card', file, '--repo', dir, '--base', 'HEAD']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^keel: check-card BUI-9: pass/);
});

test('REQ-CARD-8 check-card defaults its base to HEAD when origin has no default branch', () => {
  const { dir } = fixtureRepo();
  const r = keel(['check-card', cardFile(card('src/add.js')), '--repo', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /pass/);
});

test('REQ-CARD-8 check-card with a base that is not a commit is a usage error, not a pass', () => {
  const { dir } = fixtureRepo();
  const r = keel(['check-card', cardFile(card('src/fresh.js (new)')), '--repo', dir, '--base', 'no-such-ref']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--base no-such-ref/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
});

test('REQ-CARD-9 check-card prints the parser message and exits 1 without reading git', () => {
  const notGit = tmp('keel-not-git-'); // any git read here would fail: the parse error must come first
  const cases = [
    ['# BUI-9: t\nkind: bug\nsize: S\npaths: src/a.js\nallowEdits: test/a.test.js (new)\n\n## Requirements\n\nx\n', /allowEdits/],
    ['# BUI-9: t\nkind: rewrite\nsize: S\n', /kind "rewrite"/],
  ];
  for (const [text, reason] of cases) {
    const file = cardFile(text);
    const r = keel(['check-card', file, '--repo', notGit, '--base', 'HEAD']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, reason);
    assert.doesNotMatch(r.stderr, /git |not a git|\n\s+at /, r.stderr);
  }
});

test('REQ-CARD-9 a missing card file is reported in one line with exit 1', () => {
  const { dir } = fixtureRepo();
  const file = join(tmp('keel-card-'), 'missing.md');
  const r = keel(['check-card', file, '--repo', dir]);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(file), r.stderr);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
});

test('REQ-CARD-7 check-card with no argument is a usage error', () => {
  const { dir } = fixtureRepo();
  const r = keel(['check-card', '--repo', dir]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /check-card needs a card file or an issue ID/);
});

const issue = (id, description) => ({ id, title: id, description, priority: 1, createdAt: '2026-10-01', labels: ['Bug'], estimate: 2 });
const keelBlock = (paths, body = '- REQ-1: When add runs, it shall add.') => `${body}\n\n\`\`\`keel\npaths: ${paths}\n\`\`\``;

test('REQ-CARD-7 check-card on an issue ID reads the issue from Linear and reports its missing paths', async () => {
  const { dir } = fixtureRepo();
  const lines = [];
  const issues = async () => [issue('BUI-7', keelBlock('src/add.js, lib/gone.js, lib/fresh.js (new)'))];
  const status = await checkCard({ repo: dir, base: 'HEAD', target: 'BUI-7', issues, log: (m) => lines.push(m) });
  assert.equal(status, 1);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0].includes('mark it `lib/gone.js (new)`'), lines[0]);
});

test('REQ-CARD-9 check-card on an issue that does not map to a card prints why and exits 1', async () => {
  const { dir } = fixtureRepo();
  const lines = [];
  const issues = async () => [issue('BUI-7', null), issue('BUI-8', keelBlock('src/add.js\nallowEdits: test/a.test.js (new)'))];
  assert.equal(await checkCard({ repo: dir, base: 'HEAD', target: 'BUI-7', issues, log: (m) => lines.push(m) }), 1);
  assert.match(lines.join('\n'), /no description/);
  lines.length = 0;
  assert.equal(await checkCard({ repo: dir, base: 'HEAD', target: 'BUI-8', issues, log: (m) => lines.push(m) }), 1);
  assert.match(lines.join('\n'), /BUI-8.*allowEdits/);
});

test('REQ-CARD-9 check-card on an issue whose keel block holds a YAML list prints the parser message without reading git', async () => {
  const notGit = tmp('keel-not-git-');
  const lines = [];
  const description = '- REQ-1: When add runs, it shall add.\n\n```keel\npaths:\n- src/add.js\n```';
  const issues = async () => [issue('BUI-6', description)];
  assert.equal(await checkCard({ repo: notGit, base: 'HEAD', target: 'BUI-6', issues, log: (m) => lines.push(m) }), 1);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /BUI-6.*YAML list is not read/);
});

test('REQ-CARD-7 check-card on an issue ID that is not an open issue of the project is a usage error', async () => {
  const { dir } = fixtureRepo();
  await assert.rejects(
    checkCard({ repo: dir, base: 'HEAD', target: 'BUI-404', issues: async () => [], log: () => {} }),
    (e) => e instanceof UsageError && /BUI-404 is not an open issue/.test(e.message),
  );
});

test('REQ-CARD-10 check-card and keel poll report the same missing paths for the same card and base', async () => {
  const { dir } = fixtureRepo();
  const paths = 'src/add.js, ./lib/gone.js, docs/gone.md/, lib/fresh.js (new), src/**, test/a.test.js';
  const one = issue('BUI-5', keelBlock(paths, '- REQ-1: When add runs, it shall add. Put it in the new file `test/a.test.js`.'));
  const fake = {
    listIssues: async () => [one],
    comment: async () => {},
    review: async () => {},
    stateType: async () => 'started',
    createIssue: async () => assert.fail('no follow-ups'),
  };
  const results = await poll({
    repo: dir,
    project: 'p',
    client: fake,
    config: { ...DEFAULTS },
    runFn: () => assert.fail('a card with a missing path is not built'),
    issue: 'BUI-5',
  });
  const polled = results.find((r) => r.issue === 'BUI-5');
  assert.equal(polled.outcome, 'deferred');
  assert.deepEqual(missingOnBase(dir, 'HEAD', cardFromIssue(one)).missing, polled.detail.missing);
  const lines = [];
  assert.equal(await checkCard({ repo: dir, base: 'HEAD', target: 'BUI-5', issues: async () => [one], log: (m) => lines.push(m) }), 1);
  assert.deepEqual(polled.detail.missing, ['lib/gone.js', 'docs/gone.md']);
  for (const p of polled.detail.missing)
    assert.ok(
      lines.some((l) => l.includes(`mark it \`${p} (new)\``)),
      lines.join('\n'),
    );
  assert.equal(lines.length, polled.detail.missing.length);
});
