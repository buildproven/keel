import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeEach, test } from 'node:test';
import { audit } from '../src/audit.js';
import { pendingFollowUps } from '../src/linear.js';
import { FIXED_SRC, FIXTURE_TEST, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const BIN = resolve('bin/keel.js');

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const reviewer = (script) => ({
  provider: 'exec',
  family: 'codex',
  model: 'exec-codex',
  effort: 'high',
  command: ['node', '-e', `require('fs').readFileSync(0); ${script}`],
});
const blocks = reviewer("console.log('FINDING medium src/add.js:1 add ignores NaN'); console.log('VERDICT: block')");
const passes = reviewer("console.log('VERDICT: pass')");
const down = reviewer('');

/** A repo with two merges on main: #1 reviewed by a fallback, #2 by the cross-family reviewer; and a fake gh. */
function setup() {
  const { dir } = fixtureRepo();
  const m1 = commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add numbers (#1)');
  const m2 = commit(dir, { 'README.md': 'docs\n' }, 'docs: readme (#2)');
  const prs = [
    { number: 2, title: 'docs: readme', body: 'Closes BUI-8', headRefOid: 'h2', mergeCommit: { oid: m2 } },
    { number: 1, title: 'fix: add numbers', body: 'Fix add.\n\nCloses BUI-7', headRefOid: 'h1', mergeCommit: { oid: m1 } },
  ];
  const statuses = {
    h1: [{ context: 'keel/gate', description: 'passed; review by claude/claude-opus-5-5/high (fallback: exec/exec-codex/high quota)' }],
    h2: [{ context: 'keel/gate', description: 'passed; review by exec/exec-codex/high' }],
  };
  const bin = tmp('keel-bin-');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'list') { console.log(${JSON.stringify(JSON.stringify(prs))}); process.exit(0); }
const m = a.join(' ').match(/commits\\/(\\w+)\\/statuses/);
if (a[0] === 'api' && m) { console.log(JSON.stringify((${JSON.stringify(statuses)})[m[1]] ?? [])); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { dir, m1, bin };
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

test('REQ-CLI-11 keel audit re-reviews only fallback-reviewed merges, with the reviewer that was out', () => {
  const { dir, m1, bin } = setup();
  const results = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [blocks] }), limit: 20 }));
  assert.equal(results.length, 1);
  const [r] = results;
  assert.equal(r.pr, 1);
  assert.equal(r.sha, m1);
  assert.equal(r.outcome, 'findings');
  assert.equal(r.reviewer, 'exec/exec-codex/high');
  assert.deepEqual(
    r.findings.map((f) => f.text),
    ['add ignores NaN'],
  );
});

test('REQ-CLI-11 audit findings join the found-work queue under the closed issue, and an audited merge is not reviewed again', () => {
  const { dir, bin } = setup();
  withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [blocks] }), limit: 20 }));
  const queued = pendingFollowUps(dir);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].source, 'BUI-7');
  assert.equal(queued[0].kind, 'bug');
  assert.match(queued[0].title, /^Audit #1: add ignores NaN/);
  assert.equal(queued[0].detail, 'medium src/add.js:1');
  const again = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [blocks] }), limit: 20 }));
  assert.deepEqual(again, []);
});

test('REQ-CLI-11 a clean audit passes; an unavailable reviewer audits nothing and is retried next time', () => {
  const { dir, bin } = setup();
  const out = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [down] }), limit: 20 }));
  assert.equal(out[0].outcome, 'unavailable');
  const ok = withPath(bin, () => audit({ repo: dir, config: fixtureConfig({ tiers: [passes] }), limit: 20 }));
  assert.equal(ok[0].outcome, 'pass');
  assert.equal(pendingFollowUps(dir).length, 0);
});

test('REQ-CLI-11 keel audit prints one line per merge and exits 1 on findings, 3 when the reviewer is out', () => {
  const { dir, bin } = setup();
  const keelJson = (tiers) => JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, tiers });
  const run = (tiers) => {
    writeFileSync(join(dir, 'keel.json'), keelJson(tiers));
    g(dir, 'add', 'keel.json');
    g(dir, 'commit', '-q', '-m', 'chore: keel');
    return spawnSync(process.execPath, [BIN, 'audit'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  };
  const outage = run([down]);
  assert.equal(outage.status, 3, outage.stderr);
  assert.match(outage.stderr, /^keel: audit #1 [0-9a-f]{7}: unavailable/m);
  const found = run([blocks]);
  assert.equal(found.status, 1, found.stderr);
  assert.match(found.stderr, /^keel: audit #1 [0-9a-f]{7}: 1 finding\(s\) by exec\/exec-codex\/high; queued under BUI-7/m);
  assert.ok(existsSync(join(process.env.KEEL_STATE_DIR, 'audit.jsonl')));
  assert.ok(readFileSync(join(process.env.KEEL_STATE_DIR, 'audit.jsonl'), 'utf8').includes('"pr":1'));
});
