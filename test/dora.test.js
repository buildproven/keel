import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';
import { dora, formatDora } from '../src/dora.js';
import { fixtureRepo, g, tmp, write } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-dora-');
});

/** Commit with fixed author and committer dates, so lead time and restore time are exact. */
function commitAt(dir, files, msg, at) {
  write(dir, files);
  g(dir, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  return g(dir, 'rev-parse', 'HEAD');
}

/** A Keel branch for one file, squash-merged onto main at `at`. Returns the certified head. */
function keelChange(dir, base, name, at) {
  g(dir, 'checkout', '-q', '-b', `keel/${name}`, base);
  const head = commitAt(dir, { [`src/${name}.js`]: `export const ${name} = 1;\n` }, `feat: ${name}`, '2026-10-01T00:00:00Z');
  g(dir, 'checkout', '-q', 'main');
  g(dir, 'merge', '-q', '--squash', `keel/${name}`);
  const merge = commitAt(dir, {}, `${name} change (#1)`, at);
  return { head, merge };
}

const row = (card, repo, base, head, at) => ({
  run: card,
  card,
  repo,
  base,
  head,
  attempt: 1,
  tier: 0,
  attemptPass: true,
  at,
  durationMs: 3600000,
  gateMs: 0,
});

test('REQ-LED-7 keel report --dora: merge frequency, lead time, change failure rate, and time to restore per repo', () => {
  const { dir, base } = fixtureRepo();
  const a = keelChange(dir, base, 'a', '2026-10-02T04:00:00Z');
  keelChange(dir, base, 'b', '2026-10-03T06:00:00Z');
  const c = keelChange(dir, base, 'c', '2026-10-04T08:00:00Z');
  commitAt(dir, { 'src/a.js': 'export const a = 2;\n' }, 'fix: a off by one', '2026-10-05T06:00:00Z');
  execFileSync('git', ['revert', '--no-edit', c.merge], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-04T09:00:00Z', GIT_COMMITTER_DATE: '2026-10-04T09:00:00Z' },
  });
  const rows = [
    row('a', dir, base, a.head, '2026-10-02T01:00:00Z'), // started 00:00, merged 04:00 → 4 h
    row('b', dir, base, g(dir, 'rev-parse', 'keel/b'), '2026-10-03T01:00:00Z'), // started 00:00, merged 06:00 → 6 h
    row('c', dir, base, c.head, '2026-10-04T01:00:00Z'), // started 00:00, merged 08:00 → 8 h
  ];
  const [repo] = dora(rows, { now: new Date('2026-10-10T00:00:00Z') });
  assert.equal(repo.repo, dir);
  assert.equal(repo.merged, 3);
  assert.equal(repo.perWeek.toFixed(2), (3 / (30 / 7)).toFixed(2));
  assert.equal(repo.leadTimeMs, 6 * 3600000, 'median of 4 h, 6 h, 8 h');
  assert.deepEqual(repo.failures.map((f) => f.card).sort(), ['a', 'c'], 'a by a later fix: on its file, c by a revert');
  assert.equal(repo.failureRate.toFixed(2), '0.67');
  assert.equal(repo.restoreMs, (3 * 24 * 3600000 + 2 * 3600000 + 3600000) / 2, 'median of a: 3 d 2 h and c: 1 h');
  const text = formatDora([repo]);
  assert.match(text, /merged 3 \(0\.7\/week\); lead time 6h; change failure rate 67% \(2\/3\); time to restore 1\.6d/);
});

test('REQ-LED-7 only merges inside the window count; a repo with none says so', () => {
  const { dir, base } = fixtureRepo();
  const a = keelChange(dir, base, 'a', '2026-08-01T04:00:00Z');
  const [repo] = dora([row('a', dir, base, a.head, '2026-08-01T01:00:00Z')], { now: new Date('2026-10-10T00:00:00Z') });
  assert.equal(repo.merged, 0);
  assert.match(formatDora([repo]), /no Keel change merged in the last 30 days/);
});
