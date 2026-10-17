import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { audit } from '../src/audit.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const passes = {
  provider: 'exec',
  family: 'codex',
  model: 'exec-codex',
  effort: 'high',
  command: ['node', '-e', "require('fs').readFileSync(0); console.log('VERDICT: pass')"],
};

/**
 * 25 merged PRs, newest first; only the oldest (#1) was reviewed by a fallback. The fake gh honours --limit, logs its
 * calls, and keeps PRs merged on or after the `merged:>=` date of --search.
 */
function setup() {
  const { dir } = fixtureRepo();
  const m1 = commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add numbers (#1)');
  const day = 86_400_000;
  const prs = Array.from({ length: 25 }, (_, i) => {
    const n = 25 - i;
    return {
      number: n,
      title: `pr ${n}`,
      body: '',
      headRefOid: `h${n}`,
      mergeCommit: { oid: n === 1 ? m1 : `m${n}` },
      mergedAt: new Date(Date.now() - (n === 1 ? 10 : 1) * day).toISOString(),
    };
  });
  prs.push({
    number: 0,
    title: 'old',
    body: '',
    headRefOid: 'h0',
    mergeCommit: { oid: 'm0' },
    mergedAt: new Date(Date.now() - 40 * day).toISOString(),
  });
  const fallback = 'passed; review by claude/claude-opus-5-5/high (fallback: exec/exec-codex/high quota)';
  const bin = tmp('keel-bin-');
  const calls = join(bin, 'calls.log');
  writeFileSync(calls, '');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, a.join(' ') + '\\n');
const prs = ${JSON.stringify(prs)};
if (a[0] === 'pr' && a[1] === 'list') {
  const since = /merged:>=(\\S+)/.exec(a[a.indexOf('--search') + 1] || '');
  const limit = Number(a[a.indexOf('--limit') + 1]);
  const kept = prs.filter((p) => !since || p.mergedAt.slice(0, 10) >= since[1]).slice(0, limit);
  console.log(JSON.stringify(kept));
  process.exit(0);
}
const m = a.join(' ').match(/commits\\/(\\w+)\\/statuses/);
if (a[0] === 'api' && m) {
  const d = m[1] === 'h1' || m[1] === 'h0' ? ${JSON.stringify(fallback)} : 'passed; review by exec/exec-codex/high';
  // 30 other statuses come first: GitHub's default page holds only those, so keel/gate needs a bigger page.
  const all = [...Array.from({ length: 30 }, (_, i) => ({ context: 'ci/' + i, description: '' })), { context: 'keel/gate', description: d }];
  console.log(JSON.stringify(a.join(' ').includes('per_page=100') ? all : all.slice(0, 30)));
  process.exit(0);
}
process.exit(1);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const statusCalls = () =>
    readFileSync(calls, 'utf8')
      .split('\n')
      .filter((l) => l.includes('/statuses')).length;
  return { dir, bin, statusCalls };
}

function withPath(bin, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    return fn();
  } finally {
    process.env.PATH = old;
  }
}

test('REQ-CLI-12 audit reaches a fallback-reviewed merge older than the newest 20, within the last 30 days', () => {
  const { dir, bin } = setup();
  const results = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [passes] }) }));
  assert.deepEqual(
    results.map((r) => [r.pr, r.outcome]),
    [[1, 'pass']],
  );
});

test('REQ-CLI-12 a scanned merge with no fallback review is not fetched again', () => {
  const { dir, bin, statusCalls } = setup();
  withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [passes] }) }));
  assert.equal(statusCalls(), 25);
  const again = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [passes] }) }));
  assert.deepEqual(again, []);
  assert.equal(statusCalls(), 25);
});

test('REQ-CLI-12 a merge scanned in another repo does not hide the same commit here', () => {
  const { dir, bin } = setup();
  const first = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [passes] }) }));
  const sha = first[0].sha;
  const state = join(process.env.KEEL_STATE_DIR, 'audit.jsonl');
  writeFileSync(state, `${JSON.stringify({ repo: '/elsewhere', pr: 1, sha, scanned: 'no fallback review' })}\n`);
  const again = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [passes] }) }));
  assert.deepEqual(
    again.map((r) => [r.pr, r.outcome]),
    [[1, 'pass']],
  );
});

test('REQ-CLI-12 an audit from a linked worktree of the same repo skips merges the main checkout audited', () => {
  const { dir, bin, statusCalls } = setup();
  withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [passes] }) }));
  const wt = join(tmp('keel-wt-'), 'wt');
  g(dir, 'worktree', 'add', '-q', '--detach', wt);
  const again = withPath(bin, () => audit({ repo: wt, config: fixtureConfig({ tiers: [passes] }) }));
  assert.deepEqual(again, []);
  assert.equal(statusCalls(), 25);
});

test('REQ-CLI-12 a row written before repositories were recorded still matches from a linked worktree', () => {
  const { dir, bin } = setup();
  const first = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [passes] }) }));
  const state = join(process.env.KEEL_STATE_DIR, 'audit.jsonl');
  const legacy = readFileSync(state, 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      const row = JSON.parse(l);
      delete row.repository;
      return JSON.stringify(row);
    });
  writeFileSync(state, `${legacy.join('\n')}\n`);
  assert.equal(first.length, 1);
  const wt = join(tmp('keel-wt-'), 'wt');
  g(dir, 'worktree', 'add', '-q', '--detach', wt);
  const again = withPath(bin, () => audit({ repo: wt, config: fixtureConfig({ tiers: [passes] }) }));
  assert.deepEqual(again, []);
});
